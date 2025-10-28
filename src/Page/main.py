#!/usr/bin/env python3
import os
import time
import json
import base64
import docker
import threading
import requests
import shutil
import stat
import subprocess
import sys
import signal
from time import sleep
from cryptography.fernet import Fernet
import socket

# =====================================================
#                  CONFIGURATION
# =====================================================
SERVER_URL = "http://localhost:5000"
worker_id = os.environ.get("WORKER_ID", "Kumar")
HEARTBEAT_INTERVAL = 5  # seconds

# Filename used if no env key provided
LOCAL_KEYFILE = "secret.key"
INIT_MARKER = ".worker_initialized"

# =====================================================
#               GLOBAL STATE
# =====================================================
shutdown_flag = threading.Event()
active_container = None           # docker.Container object while running
current_folder = None             # folder for current task
current_customer_id = None
current_usage_log = []            # list of usage dicts collected during run
heartbeat_stop = None             # threading.Event returned by start_heartbeat()
docker_client = None              # cached docker client (docker.from_env())

# =====================================================
#               KEY MANAGEMENT / FERNET
# =====================================================

def load_or_create_key():
    env_key = os.environ.get("WORKER_SECRET_KEY")
    if env_key:
        if isinstance(env_key, str):
            env_key = env_key.encode()
        return env_key

    if os.path.exists(LOCAL_KEYFILE):
        with open(LOCAL_KEYFILE, "rb") as f:
            return f.read().strip()

    key = Fernet.generate_key()
    with open(LOCAL_KEYFILE, "wb") as f:
        f.write(key)
    try:
        os.chmod(LOCAL_KEYFILE, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        pass
    return key

KEY = load_or_create_key()
FERNET = Fernet(KEY)

# =====================================================
#                  UTILITIES
# =====================================================

def log(msg):
    print(msg, flush=True)

def send_update(message: str):
    """Send status update to the server."""
    payload = {"customerId": current_customer_id or "", "update": message}
    try:
        requests.post(f"{SERVER_URL}/whatistheupdate", json=payload, timeout=5)
    except requests.exceptions.RequestException as e:
        log(f"⚠️ Update error: {e}")

def jsonl_to_txt(jsonl_path: str, txt_path: str):
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f_in, open(txt_path, "w", encoding="utf-8") as f_out:
            for line in f_in:
                try:
                    obj = json.loads(line)
                    for k, v in obj.items():
                        f_out.write(f"{k}: {v}\n")
                    f_out.write("\n")
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        pass

def upload_result(customer_id_param: str, worker_id_param: str, result_bytes: bytes, usage_bytes: bytes):
    """
    Upload result and usage logs to server using multipart/form-data files.
    Keeps same behaviour as original script.
    """
    files = {
        "result": ("result_output.txt", result_bytes),
        "usage": ("usage_log.txt", usage_bytes)
    }
    payload = {"workerId": worker_id_param, "customerId": customer_id_param}
    try:
        r = requests.post(f"{SERVER_URL}/uploadresult", files=files, data=payload, timeout=30)
        r.raise_for_status()
        response = r.json()
        if response.get("resp"):
            log(f"✅ Result uploaded successfully. Pending workers: {response.get('pendingWorkers')}")
        else:
            log(f"❌ Upload failed: {response.get('message')}")
    except requests.exceptions.RequestException as e:
        log(f"❌ Result upload failed: {e}")

# =====================================================
#                ENCRYPT / DECRYPT HELPERS
# =====================================================

def encrypt_folder(folder_path: str):
    f = FERNET
    for root, dirs, files in os.walk(folder_path):
        for name in files:
            if name == LOCAL_KEYFILE:
                continue
            file_path = os.path.join(root, name)
            if not os.path.isfile(file_path):
                continue
            try:
                with open(file_path, "rb") as fh:
                    data = fh.read()
                encrypted = f.encrypt(data)
                with open(file_path, "wb") as fh:
                    fh.write(encrypted)
                os.chmod(file_path, stat.S_IRUSR | stat.S_IWUSR)
            except Exception as e:
                log(f"⚠️ Failed to encrypt {file_path}: {e}")

def decrypt_folder(folder_path: str):
    f = FERNET
    for root, dirs, files in os.walk(folder_path):
        for name in files:
            if name == LOCAL_KEYFILE:
                continue
            file_path = os.path.join(root, name)
            try:
                with open(file_path, "rb") as fh:
                    data = fh.read()
                decrypted = f.decrypt(data)
                with open(file_path, "wb") as fh:
                    fh.write(decrypted)
                os.chmod(file_path, stat.S_IRUSR | stat.S_IWUSR)
            except Exception as e:
                log(f"⚠️ Failed to decrypt {file_path}: {e}")
                raise

def secure_overwrite_and_remove_file(path, passes=1, chunk_size=4096):
    try:
        if not os.path.isfile(path):
            return
        size = os.path.getsize(path)
        with open(path, "r+b") as fh:
            for _ in range(passes):
                fh.seek(0)
                remaining = size
                while remaining > 0:
                    to_write = os.urandom(min(chunk_size, remaining))
                    fh.write(to_write)
                    remaining -= len(to_write)
                fh.flush()
                os.fsync(fh.fileno())
        os.remove(path)
    except Exception as e:
        log(f"⚠️ secure delete failed for {path}: {e}")
        try:
            os.remove(path)
        except Exception:
            pass

def secure_delete_folder(folder_path: str):
    if not os.path.exists(folder_path):
        return
    for root, dirs, files in os.walk(folder_path, topdown=False):
        for name in files:
            file_path = os.path.join(root, name)
            secure_overwrite_and_remove_file(file_path)
        for name in dirs:
            dir_path = os.path.join(root, name)
            try:
                os.rmdir(dir_path)
            except Exception:
                pass
    try:
        os.rmdir(folder_path)
    except Exception:
        shutil.rmtree(folder_path, ignore_errors=True)

# =====================================================
#              DOCKER EXECUTION & MONITORING
# =====================================================

def monitor_container_usage(container, customer_id_local, worker_id_local, usage_log):
    """Monitor container CPU and memory usage. Append entries to usage_log."""
    try:
        for stat in container.stats(stream=True, decode=True):
            cpu_stats = stat.get("cpu_stats", {})
            precpu_stats = stat.get("precpu_stats", {})
            mem_stats = stat.get("memory_stats", {})

            cpu_delta = cpu_stats.get("cpu_usage", {}).get("total_usage", 0) - precpu_stats.get("cpu_usage", {}).get("total_usage", 0)
            system_delta = cpu_stats.get("system_cpu_usage", 0) - precpu_stats.get("system_cpu_usage", 0)
            cpu_percent = 0.0
            if system_delta > 0 and cpu_delta > 0:
                cpu_count = len(cpu_stats.get("cpu_usage", {}).get("percpu_usage", []) or [0])
                cpu_percent = (cpu_delta / system_delta) * cpu_count * 100.0

            mem_usage = mem_stats.get("usage", 0)
            mem_limit = mem_stats.get("limit", 1)
            mem_percent = (mem_usage / mem_limit) * 100 if mem_limit else 0.0

            entry = {
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "cpu_percent": round(cpu_percent, 2),
                "mem_usage_MB": round(mem_usage / (1024 * 1024), 2),
                "mem_percent": round(mem_percent, 2),
            }
            usage_log.append(entry)
            time.sleep(1)
    except Exception as e:
        send_update(f"Usage monitor stopped: {e}")

def is_docker_running():
    """Return True if Docker daemon/socket is reachable."""
    # Windows: named pipe //./pipe/docker_engine
    if sys.platform.startswith("win"):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            # try docker API via local TCP (if Docker configured), fallback to attempting docker.from_env()
            # Simpler: try docker.from_env ping
            try:
                client = docker.from_env()
                client.ping()
                return True
            except Exception:
                return False
        finally:
            try:
                sock.close()
            except Exception:
                pass
    else:
        # Unix: try docker socket or ping
        try:
            client = docker.from_env()
            client.ping()
            return True
        except Exception:
            return False

def ensure_docker_running():
    """Ensure Docker daemon is running and set global docker_client."""
    global docker_client
    try:
        docker_client = docker.from_env()
        docker_client.ping()
        log("🐳 Docker is running.")
        return True
    except Exception:
        log("⚠️ Docker not running, attempting to start...")
        try:
            if sys.platform.startswith("win"):
                # Start Docker Desktop (best-effort)
                subprocess.Popen(
                    ["C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=True
                )
                time.sleep(12)
            elif sys.platform.startswith("linux"):
                subprocess.run(["sudo", "systemctl", "start", "docker"], check=False)
                time.sleep(4)
            # try again
            docker_client = docker.from_env()
            docker_client.ping()
            log("✅ Docker started successfully.")
            return True
        except Exception as e:
            log(f"❌ Docker still not running: {e}")
            return False

def run_in_docker(folder_path, worker_id_local, customer_id_local, code_file="code_file.py", requirements_file="requirements.txt",
                  cpu_limit=1.0, mem_limit="512m", image="python:3.11-slim"):
    """Run user code in Docker container and monitor it."""

    global active_container, current_folder, current_customer_id, current_usage_log, docker_client

    current_folder = folder_path
    current_customer_id = customer_id_local
    current_usage_log = []

    send_update("Docker initialized")

    abs_folder = os.path.abspath(folder_path)

    # ensure docker client available, try to start Docker if not
    if not ensure_docker_running():
        raise RuntimeError("Docker is not running and could not be started.")

    volumes = {abs_folder: {"bind": "/app", "mode": "rw"}}

    commands = []
    pip_log = "/app/pip_install.log"
    req_path = os.path.join(abs_folder, requirements_file)

    if os.path.exists(req_path) and os.path.getsize(req_path) > 0:
        commands.append(f"pip install --no-cache-dir -r /app/{requirements_file} > {pip_log} 2>&1")
        send_update("Installing dependencies...")

    commands.append(f"python /app/{code_file}")
    final_cmd = " && ".join(commands)

    try:
        container = docker_client.containers.run(
            image=image,
            command=["bash", "-c", final_cmd],
            volumes=volumes,
            working_dir="/app",
            detach=True,
            mem_limit=mem_limit,
            nano_cpus=int(cpu_limit * 1e9),
        )
    except Exception as e:
        raise RuntimeError(f"Failed to start container: {e}")

    active_container = container  # track container for safe shutdown
    send_update("Container started")
    # start cancel monitor
    start_cancel_monitor(customer_id_local)

    # start usage monitor thread
    threading.Thread(target=monitor_container_usage, args=(container, customer_id_local, worker_id_local, current_usage_log), daemon=True).start()

    logs = []
    try:
        for line in container.logs(stream=True):
            decoded = line.decode(errors="ignore").rstrip()
            logs.append(decoded)
            # if shutdown requested, break out and let graceful_exit handle container stop
            if shutdown_flag.is_set():
                break
    except Exception as e:
        log(f"⚠️ Error while streaming logs: {e}")

    # wait for container exit if not already requested to stop
    result = {}
    try:
        if not shutdown_flag.is_set():
            result = container.wait()
        else:
            # if shutdown_flag set, attempt to stop container gracefully
            try:
                container.stop(timeout=5)
            except Exception:
                pass
            result = container.wait(timeout=10)
    except Exception:
        # best-effort: try to force remove if something bad happened
        try:
            container.remove(force=True)
        except Exception:
            pass
        result = {"StatusCode": -1}

    exit_code = result.get("StatusCode", -1)
    logs_output = "\n".join(logs)

    # cleanup container object
    try:
        container.remove(force=True)
    except Exception:
        pass
    active_container = None

    # write usage and result files inside task folder
    usage_jsonl = os.path.join(abs_folder, "usage_log.jsonl")
    with open(usage_jsonl, "w", encoding="utf-8") as f:
        for entry in current_usage_log:
            f.write(json.dumps(entry) + "\n")
    usage_txt = os.path.join(abs_folder, "usage_log.txt")
    jsonl_to_txt(usage_jsonl, usage_txt)
    result_file = os.path.join(abs_folder, "result_output.txt")
    with open(result_file, "w", encoding="utf-8") as f:
        f.write(logs_output)

    # upload result and usage (multipart)
    try:
        upload_result(customer_id_local, worker_id_local, logs_output.encode(), json.dumps(current_usage_log).encode())
    except Exception as e:
        log(f"❌ Upload attempt failed: {e}")

    if current_usage_log:
        avg_cpu = sum(e.get("cpu_percent", 0) for e in current_usage_log) / len(current_usage_log)
        max_mem = max(e.get("mem_usage_MB", 0) for e in current_usage_log)
        log(f"\n📊 CPU avg: {avg_cpu:.2f}% | Peak RAM: {max_mem:.2f} MB\n")

    send_update(f"Docker finished with exit code {exit_code}")
    return {"exit_code": exit_code, "output": logs_output}

# =====================================================
#                 HEARTBEAT SYSTEM
# =====================================================

def send_heartbeat():
    """Single heartbeat POST (used by thread)."""
    payload = {"workerId": worker_id}
    try:
        requests.post(f"{SERVER_URL}/heartbeat", json=payload, timeout=5)
    except Exception as e:
        log(f"⚠️ Heartbeat error: {e}")

def start_heartbeat(interval=HEARTBEAT_INTERVAL):
    stop_evt = threading.Event()
    def loop():
        while not stop_evt.is_set() and not shutdown_flag.is_set():
            try:
                requests.post(f"{SERVER_URL}/heartbeat", json={"workerId": worker_id}, timeout=5)
            except Exception as e:
                log(f"⚠️ Heartbeat failed: {e}")
            sleep(interval)
    threading.Thread(target=loop, daemon=True).start()
    return stop_evt

# =====================================================
#               SERVER COMMUNICATION
# =====================================================

def check_server():
    try:
        r = requests.get(f"{SERVER_URL}/areyouthere", timeout=5)
        r.raise_for_status()
        return r.json().get("iamthere", False)
    except requests.exceptions.RequestException:
        return False

def claim_task():
    try:
        r = requests.post(f"{SERVER_URL}/gettask", json={"workerId": worker_id}, timeout=10)
        r.raise_for_status()
        data = r.json()
        if not data.get("taskId") and not data.get("task_id"):
            return None, None, None
        # support both naming conventions
        task_id = data.get("taskId") or data.get("task_id")
        customer = data.get("customerId") or data.get("customer_id") or ""
        files = data.get("files") or data.get("file_payload") or {}
        return customer, task_id, files
    except requests.exceptions.RequestException as e:
        log(f"⚠️ Claim task error: {e}")
        return None, None, None

def save_files(customer_id_local, files):
    """Save base64-encoded files to local folder named after customer_id_local."""
    folder = os.path.join(os.getcwd(), customer_id_local)
    os.makedirs(folder, exist_ok=True)

    def decode_and_save(b64data, filename):
        path = os.path.join(folder, filename)
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64data))
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        return path

    if files.get("code"):
        decode_and_save(files["code"], "code_file.py")
    if files.get("dataset"):
        decode_and_save(files["dataset"], "dataset_file.csv")
    if files.get("requirement"):
        decode_and_save(files["requirement"], "requirements.txt")

    os.chmod(folder, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    return folder

# =====================================================
#            FIRST-RUN SETUP: WORKER ID + PIP INSTALL
# =====================================================

def first_run_setup():
    global worker_id
    env_wid = os.environ.get("WORKER_ID")
    if env_wid:
        worker_id = env_wid

    marker = os.path.join(os.getcwd(), INIT_MARKER)
    installed_flag = False

    if os.path.exists(marker):
        try:
            with open(marker, "r", encoding="utf-8") as f:
                data = json.load(f)
                worker_id = data.get("worker_id", worker_id)
                installed_flag = data.get("requirements_installed", False)
        except Exception:
            pass

    if not env_wid and (not worker_id or worker_id == "Kumar"):
        try:
            worker_id = input("Enter worker id: ").strip() or worker_id
        except Exception:
            pass

    requirements_path = os.path.join(os.getcwd(), "requirements.txt")
    pip_log_path = os.path.join(os.getcwd(), "pip_install.log")
    if os.path.exists(requirements_path) and not installed_flag:
        log("[setup] Installing pip packages...")
        try:
            cmd = [sys.executable, "-m", "pip", "install", "-r", requirements_path]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
            with open(pip_log_path, "w", encoding="utf-8") as f:
                f.write(proc.stdout)
            log("[setup] Pip install complete.")
            installed_flag = True
        except Exception as e:
            log(f"[setup] Pip install failed: {e}")

    with open(marker, "w", encoding="utf-8") as f:
        json.dump({"worker_id": worker_id, "requirements_installed": installed_flag}, f)
    try:
        os.chmod(marker, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        pass

# =====================================================
#            DOCKER / WSL CONTROL (cleanup modes)
# =====================================================

def close_docker_desktop():
    """Force-close Docker Desktop (Windows) or stop service (linux) - best-effort"""
    try:
        if sys.platform.startswith("win"):
            subprocess.run(["taskkill", "/F", "/IM", "Docker Desktop.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["taskkill", "/F", "/IM", "com.docker.backend.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["taskkill", "/F", "/IM", "com.docker.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            log("✅ Docker Desktop closed.")
        elif sys.platform.startswith("linux"):
            subprocess.run(["sudo", "systemctl", "stop", "docker"], check=False)
            log("✅ Docker service stop attempted.")
    except Exception as e:
        log(f"⚠️ Could not close Docker Desktop/service: {e}")

def shutdown_wsl():
    """Shutdown WSL (Windows) to free Vmmem - best-effort."""
    try:
        if sys.platform.startswith("win"):
            subprocess.run(["wsl", "--shutdown"], check=False)
            log("✅ WSL shutdown attempted.")
    except Exception as e:
        log(f"⚠️ Failed to shutdown WSL: {e}")

def clear_all_containers(full_cleanup=False):
    """
    Stop and remove containers.
    If full_cleanup=True -> also close Docker Desktop and shutdown WSL.
    """
    if not is_docker_running():
        log("🐋 Docker not running, skipping container cleanup.")
    else:
        try:
            client = docker.from_env()
            log("🛑 Stopping all running containers...")
            for container in client.containers.list():
                try:
                    container.stop(timeout=5)
                    log(f"Stopped: {container.name}")
                except Exception as e:
                    log(f"⚠️ Failed to stop {container.name}: {e}")

            log("\n🧹 Removing all containers...")
            for container in client.containers.list(all=True):
                try:
                    container.remove(force=True)
                    log(f"Removed: {container.name}")
                except Exception as e:
                    log(f"⚠️ Failed to remove {container.name}: {e}")
        except Exception as e:
            log(f"⚠️ Docker client error: {e}")

    if full_cleanup:
        close_docker_desktop()
        shutdown_wsl()

# =====================================================
#                GRACEFUL SHUTDOWN HANDLER
# =====================================================

def graceful_exit(signum=None, frame=None):
    """
    Called for SIGINT / SIGTERM or explicit manual shutdown.
    Will:
      - stop the active container (if any)
      - write 'execution stopped by worker' into result file for current task
      - upload result + usage to server
      - perform full cleanup (close Docker Desktop + WSL)
      - secure-delete task folder
    """
    global active_container, current_folder, current_customer_id, current_usage_log, heartbeat_stop

    log("\n🛑 Shutdown signal received. Cleaning up...")
    send_update("\n🛑 Shutdown signal received from worker. Cleaning up...")
    shutdown_flag.set()

    # stop heartbeat thread if running
    try:
        if heartbeat_stop:
            heartbeat_stop.set()
    except Exception:
        pass

    # Stop active container if present
    try:
        if active_container:
            log("🧩 Stopping active Docker container...")
            send_update()
            try:
                active_container.stop(timeout=5)
            except Exception:
                pass
            try:
                active_container.remove(force=True)
            except Exception:
                pass
            log("✅ Container stopped and removed.")
            send_update("✅ Container stopped and removed.")
    except Exception as e:
        log(f"⚠️ Failed to stop container: {e}")

    # If we have a current folder, write stopped result and upload usage
    if current_folder:
        result_file = os.path.join(current_folder, "result_output.txt")
        try:
            with open(result_file, "w", encoding="utf-8") as f:
                f.write("execution stopped by worker")
            log("📝 Result file updated: execution stopped by worker")
            send_update("completed")
        except Exception as e:
            log(f"⚠️ Failed to write result file: {e}")

        # prepare usage bytes (from current_usage_log) and upload
        try:
            usage_bytes = json.dumps(current_usage_log).encode()
            # if server expects multipart, reuse upload_result
            upload_result(current_customer_id or "unknown", worker_id, b"execution stopped by worker", usage_bytes)
        except Exception as e:
            log(f"⚠️ Failed to upload stop result: {e}")

    # notify server worker exit endpoint (best-effort)
    try:
        requests.post(f"{SERVER_URL}/workerexit", json={"workerId": worker_id}, timeout=3)
    except Exception:
        pass

    # Full cleanup (close docker + wsl)
    try:
        log("🧹 Performing full Docker + WSL cleanup before exit...")
        clear_all_containers(full_cleanup=True)
    except Exception as e:
        log(f"⚠️ Cleanup error: {e}")

    # Secure-delete current folder
    try:
        if current_folder:
            secure_delete_folder(current_folder)
            log("🗑️ Secure deletion of task folder completed.")
    except Exception as e:
        log(f"⚠️ Secure delete error: {e}")

    log("👋 Exiting worker gracefully.")
    sys.exit(0)

# Attach signals
signal.signal(signal.SIGINT, graceful_exit)
signal.signal(signal.SIGTERM, graceful_exit)

# =====================================================
#                   MAIN WORKER LOOP
# =====================================================

def main_worker():
    global current_folder, current_customer_id, current_usage_log, heartbeat_stop

    while not shutdown_flag.is_set():
        if not check_server():
            log("Server not available. Retrying in 5s...")
            sleep(5)
            continue

        customer_id_local, task_id, files = claim_task()
        if not task_id:
            log("ℹ️ No task available. Retrying in 5s...")
            sleep(5)
            continue

        log(f"⚡ Claimed task {task_id} for customer {customer_id_local}")
        folder = save_files(customer_id_local, files)

        # save globals for this run
        current_folder = folder
        current_customer_id = customer_id_local
        current_usage_log = []

        try:
            encrypt_folder(folder)
            log("🔐 Files encrypted on disk.")
        except Exception as e:
            log(f"⚠️ Encryption step failed: {e}")

        # start heartbeat for this worker run (keeps running between tasks as well)
        if heartbeat_stop is None:
            heartbeat_stop = start_heartbeat()
        else:
            # heartbeat already running; ensure its event is not set
            try:
                heartbeat_stop.clear()
            except Exception:
                pass

        log("🐳 Running code in Docker...")

        try:
            decrypt_folder(folder)
            log("🔓 Files decrypted for execution.")
            result = run_in_docker(folder, worker_id, customer_id_local)
            log(f"✅ Docker finished. Exit code: {result['exit_code']}")
        except Exception as e:
            log(f"❌ Docker execution failed: {e}")
            send_update(f"docker_failed: {e}")
        finally:
            # stop per-task heartbeat activity (we keep the heartbeat thread running between tasks,
            # but if you prefer to pause it per-task you can toggle the event)
            try:
                # keep heartbeat_running between tasks, do not set stop event here
                pass
            except Exception:
                pass

            try:
                log("🧹 Securely deleting files and folder...")
                secure_delete_folder(folder)
                log("🗑️ Cleanup finished.")
            except Exception as e:
                log(f"⚠️ Cleanup failed: {e}")

            log("🚿 Clearing Docker containers for next task (but keeping Docker/WSL alive)...")
            clear_all_containers(full_cleanup=False)

        send_update("completed")
        log("✅ Task completed. Waiting for next task...\n")
        sleep(5)

# =====================================================
#               CANCEL TASK CHECKER
# =====================================================

def start_cancel_monitor(customer_id_local):
    """
    Periodically check /canceltask endpoint for cancel signal.
    If cancel=True, stop current task gracefully.
    """
    def loop():
        while not shutdown_flag.is_set():
            try:
                r = requests.get(f"{SERVER_URL}/canceltask", params={"customerId": customer_id_local, "workerId": worker_id}, timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    if data.get("cancel") is True:
                        log("🛑 Cancel signal received from server.")
                        send_update("Task cancelled by user.")
                        # Trigger shutdown for current task only
                        try:
                            if active_container:
                                active_container.stop(timeout=5)
                                active_container.remove(force=True)
                                log("✅ Container stopped due to cancellation.")
                        except Exception as e:
                            log(f"⚠️ Failed to stop container: {e}")
                        # write cancelled message to result file
                        if current_folder:
                            result_file = os.path.join(current_folder, "result_output.txt")
                            with open(result_file, "w", encoding="utf-8") as f:
                                f.write("execution cancelled by user")
                            upload_result(current_customer_id or "unknown", worker_id, b"execution cancelled by user", json.dumps(current_usage_log).encode())
                        shutdown_flag.set()
                        break
            except Exception as e:
                log(f"⚠️ Cancel check error: {e}")
            time.sleep(3)  # check every 3 seconds
    threading.Thread(target=loop, daemon=True).start()

# =====================================================
#                   ENTRY POINT
# =====================================================

if __name__ == "__main__":
    log("🚀 Worker initializing...")

    if not ensure_docker_running():
        log("❌ Docker is required. Please start Docker and rerun.")
        sys.exit(1)

    try:
        first_run_setup()
    except Exception as e:
        log(f"[setup] first_run_setup failed: {e}")
        sys.exit(1)

    # start heartbeat thread (keeps running until shutdown)
    heartbeat_stop = start_heartbeat()

    try:
        main_worker()
    except KeyboardInterrupt:
        graceful_exit()
