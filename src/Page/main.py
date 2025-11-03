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
worker_id = os.environ.get("WORKER_ID", "")
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
current_task_id = None
current_usage_log = []            # list of usage dicts collected during run
heartbeat_stop = None             # threading.Event returned by start_heartbeat()
docker_client = None              # cached docker client (docker.from_env())
original_filenames = {}           # NEW: Store original filenames from server

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

def collect_output_files(folder_path):
    """Collect all output files created by the user's code."""
    output_files = {}
    
    # Common output file extensions to look for
    output_extensions = {'.csv', '.txt', '.json', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.pdf', '.out', '.log', '.result'}
    
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            file_path = os.path.join(root, file)
            # Skip system files and our own log files
            if (file.startswith('.') or 
                file in ['usage_log.jsonl', 'usage_log.txt', 'result_output.txt', 'pip_install.log'] or
                file == LOCAL_KEYFILE):
                continue
                
            # Check if it's likely an output file (not input file)
            if (file.endswith(tuple(output_extensions)) and 
                not file.startswith(('code_file', 'dataset_file', 'requirements'))):
                try:
                    with open(file_path, 'rb') as f:
                        output_files[file] = f.read()
                    log(f"📁 Collected output file: {file}")
                except Exception as e:
                    log(f"⚠️ Failed to read output file {file}: {e}")
    
    return output_files

def upload_result(customer_id_param: str, worker_id_param: str, result_bytes: bytes, usage_bytes: bytes, output_files: dict = None):
    """
    Upload result, usage logs, and output files to server using multipart/form-data.
    """
    files = {
        "result": ("result_output.txt", result_bytes),
        "usage": ("usage_log.txt", usage_bytes)
    }
    
    # Add output files to the upload
    if output_files:
        for filename, file_content in output_files.items():
            files[f"output_{filename}"] = (filename, file_content)
    
    payload = {"workerId": worker_id_param, "customerId": customer_id_param}
    try:
        r = requests.post(f"{SERVER_URL}/uploadresult", files=files, data=payload, timeout=30)
        r.raise_for_status()
        response = r.json()
        if response.get("resp"):
            log(f"✅ Result uploaded successfully. Pending workers: {response.get('pendingWorkers')}")
            log(f"📊 Progress: {response.get('progress', {}).get('submitted', 0)}/{response.get('progress', {}).get('total', 0)} workers completed")
            
            # Log output files that were uploaded
            if output_files:
                log(f"📦 Uploaded {len(output_files)} output files: {', '.join(output_files.keys())}")
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

def run_in_docker(folder_path, worker_id_local, customer_id_local, code_filename="code_file.py", requirements_filename="requirements.txt",
                  cpu_limit=1.0, mem_limit="512m", image="python:3.11-slim"):
    """Run user code in Docker container and monitor it."""

    global active_container, current_folder, current_customer_id, current_usage_log, docker_client, original_filenames

    current_folder = folder_path
    current_customer_id = customer_id_local
    current_usage_log = []

    send_update(f"🔧 Worker {worker_id_local} started processing")

    abs_folder = os.path.abspath(folder_path)

    # ensure docker client available, try to start Docker if not
    if not ensure_docker_running():
        raise RuntimeError("Docker is not running and could not be started.")

    volumes = {abs_folder: {"bind": "/app", "mode": "rw"}}

    commands = []
    pip_log = "/app/pip_install.log"
    req_path = os.path.join(abs_folder, requirements_filename)

    if os.path.exists(req_path) and os.path.getsize(req_path) > 0:
        commands.append(f"pip install --no-cache-dir -r /app/{requirements_filename} > {pip_log} 2>&1")
        send_update("📦 Installing dependencies...")

    # Use the original code filename for execution
    commands.append(f"python /app/{code_filename}")
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
    send_update("🐳 Container started - processing data...")
    
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

    # Collect output files BEFORE container cleanup
    output_files = collect_output_files(abs_folder)

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

    # upload result, usage, and output files
    try:
        upload_result(customer_id_local, worker_id_local, logs_output.encode(), json.dumps(current_usage_log).encode(), output_files)
    except Exception as e:
        log(f"❌ Upload attempt failed: {e}")

    if current_usage_log:
        avg_cpu = sum(e.get("cpu_percent", 0) for e in current_usage_log) / len(current_usage_log)
        max_mem = max(e.get("mem_usage_MB", 0) for e in current_usage_log)
        log(f"\n📊 CPU avg: {avg_cpu:.2f}% | Peak RAM: {max_mem:.2f} MB\n")

    send_update(f"✅ Worker {worker_id_local} completed processing with exit code {exit_code}")
    return {"exit_code": exit_code, "output": logs_output, "output_files": output_files}

# =====================================================
#                 HEARTBEAT SYSTEM
# =====================================================

def send_heartbeat():
    """Single heartbeat POST (used by thread)."""
    payload = {"workerId": worker_id, "customerId": current_customer_id or "idle"}
    try:
        requests.post(f"{SERVER_URL}/heartbeat", json=payload, timeout=5)
    except Exception as e:
        log(f"⚠️ Heartbeat error: {e}")

def start_heartbeat(interval=HEARTBEAT_INTERVAL):
    stop_evt = threading.Event()
    def loop():
        while not stop_evt.is_set() and not shutdown_flag.is_set():
            try:
                payload = {"workerId": worker_id, "customerId": current_customer_id or "idle"}
                requests.post(f"{SERVER_URL}/heartbeat", json=payload, timeout=5)
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
        
        if not data.get("taskAvailable", False):
            return None, None, None, None, None
            
        # Get task details with new server response format
        task_id = data.get("taskId")
        customer_id = data.get("customerId")
        files = data.get("files", {})
        assignment = data.get("assignment", {})
        original_filenames = data.get("originalFilenames", {})  # NEW: Get original filenames
        
        log(f"📥 Received task: customer={customer_id}, task={task_id}, worker_index={assignment.get('workerIndex')}/{assignment.get('totalWorkers')}")
        
        # Log original filenames if available
        if original_filenames:
            log(f"📁 Original filenames: Code={original_filenames.get('code', 'N/A')}, Dataset={original_filenames.get('dataset', 'N/A')}, Requirement={original_filenames.get('requirement', 'N/A')}")
        
        return customer_id, task_id, files, assignment, original_filenames
        
    except requests.exceptions.RequestException as e:
        log(f"⚠️ Claim task error: {e}")
        return None, None, None, None, None

def save_files(customer_id_local, files, original_filenames):
    """Save base64-encoded files to local folder using original filenames."""
    folder = os.path.join(os.getcwd(), customer_id_local)
    os.makedirs(folder, exist_ok=True)

    def decode_and_save(b64data, filename, original_filename=None):
        if not b64data:
            return None
            
        # Use original filename if provided, otherwise use default
        if original_filename:
            filename = original_filename
            
        path = os.path.join(folder, filename)
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64data))
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        return path

    # Save code file (required) - use original filename
    code_filename = original_filenames.get('code', 'code_file.py')
    if files.get("code"):
        decode_and_save(files["code"], "code_file.py", code_filename)
        log(f"📄 Code file saved as: {code_filename}")
    else:
        raise ValueError("No code file provided in task")

    # Save dataset file (optional) - use original filename
    dataset_filename = original_filenames.get('dataset')
    if files.get("dataset") and dataset_filename:
        decode_and_save(files["dataset"], "dataset_file.csv", dataset_filename)
        log(f"📁 Dataset file saved as: {dataset_filename}")
    elif files.get("dataset"):
        decode_and_save(files["dataset"], "dataset_file.csv")
        log("📁 Dataset file saved (using default name)")

    # Save requirements file (optional) - use original filename
    requirement_filename = original_filenames.get('requirement')
    if files.get("requirement") and requirement_filename:
        decode_and_save(files["requirement"], "requirements.txt", requirement_filename)
        log(f"📋 Requirements file saved as: {requirement_filename}")
    elif files.get("requirement"):
        decode_and_save(files["requirement"], "requirements.txt")
        log("📋 Requirements file saved (using default name)")

    os.chmod(folder, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    
    # Return the actual filenames used for execution
    execution_filenames = {
        'code': code_filename,
        'dataset': dataset_filename,
        'requirement': requirement_filename or 'requirements.txt'
    }
    
    return folder, execution_filenames

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
    """
    global active_container, current_folder, current_customer_id, current_usage_log, heartbeat_stop

    log("\n🛑 Shutdown signal received. Cleaning up...")
    send_update("🛑 Worker shutdown initiated")
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
            try:
                active_container.stop(timeout=5)
            except Exception:
                pass
            try:
                active_container.remove(force=True)
            except Exception:
                pass
            log("✅ Container stopped and removed.")
    except Exception as e:
        log(f"⚠️ Failed to stop container: {e}")

    # If we have a current folder, write stopped result and upload usage
    if current_folder:
        result_file = os.path.join(current_folder, "result_output.txt")
        try:
            with open(result_file, "w", encoding="utf-8") as f:
                f.write("execution stopped by worker")
            log("📝 Result file updated: execution stopped by worker")
            
            # Collect any output files before upload
            output_files = collect_output_files(current_folder)
            
            # Upload final result
            usage_bytes = json.dumps(current_usage_log).encode()
            upload_result(current_customer_id or "unknown", worker_id, b"execution stopped by worker", usage_bytes, output_files)
        except Exception as e:
            log(f"⚠️ Failed to write result file: {e}")

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
    global current_folder, current_customer_id, current_task_id, current_usage_log, heartbeat_stop, original_filenames

    while not shutdown_flag.is_set():
        if not check_server():
            log("❌ Server not available. Retrying in 5s...")
            sleep(5)
            continue

        # Check if tasks are available first
        try:
            r = requests.get(f"{SERVER_URL}/askfortask", timeout=5)
            if r.status_code == 200:
                data = r.json()
                if not data.get("tasksAvailable", False):
                    log("💤 No tasks available. Retrying in 5s...")
                    sleep(5)
                    continue
        except Exception as e:
            log(f"⚠️ Task availability check failed: {e}")
            sleep(5)
            continue

        customer_id_local, task_id, files, assignment, original_filenames = claim_task()
        if not task_id:
            log("ℹ️ No task claimed. Retrying in 5s...")
            sleep(5)
            continue

        log(f"⚡ Claimed task {task_id} for customer {customer_id_local}")
        if assignment:
            log(f"📊 Assignment: Worker {assignment.get('workerIndex', 0) + 1} of {assignment.get('totalWorkers', 1)}")
        
        try:
            folder, execution_filenames = save_files(customer_id_local, files, original_filenames or {})
        except Exception as e:
            log(f"❌ Failed to save files: {e}")
            sleep(5)
            continue

        # save globals for this run
        current_folder = folder
        current_customer_id = customer_id_local
        current_task_id = task_id
        current_usage_log = []

        try:
            encrypt_folder(folder)
            log("🔐 Files encrypted on disk.")
        except Exception as e:
            log(f"⚠️ Encryption step failed: {e}")

        # start heartbeat for this worker run
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
            
            # Use the actual filenames for execution
            code_filename = execution_filenames['code']
            requirements_filename = execution_filenames['requirement']
            
            result = run_in_docker(folder, worker_id, customer_id_local, 
                                 code_filename=code_filename, 
                                 requirements_filename=requirements_filename)
            log(f"✅ Docker finished. Exit code: {result['exit_code']}")
            
            # Log output files info
            if result.get('output_files'):
                log(f"📦 Generated {len(result['output_files'])} output files")
        except Exception as e:
            log(f"❌ Docker execution failed: {e}")
            send_update(f"❌ Docker execution failed: {e}")
        finally:
            # Cleanup current task
            try:
                log("🧹 Securely deleting files and folder...")
                secure_delete_folder(folder)
                log("🗑️ Cleanup finished.")
            except Exception as e:
                log(f"⚠️ Cleanup failed: {e}")

            # Reset current task state
            current_folder = None
            current_customer_id = None
            current_task_id = None
            current_usage_log = []
            original_filenames = {}

            log("🚿 Clearing Docker containers for next task...")
            clear_all_containers(full_cleanup=False)

        log("✅ Task completed. Waiting for next task...\n")
        sleep(2)

# =====================================================
#               CANCEL TASK CHECKER
# =====================================================

def start_cancel_monitor(customer_id_local):
    """
    Periodically check /canceltask endpoint for cancel signal.
    If cancel=True, stop current task gracefully.
    """
    def loop():
        while not shutdown_flag.is_set() and current_customer_id == customer_id_local:
            try:
                r = requests.get(f"{SERVER_URL}/canceltask", params={"customerId": customer_id_local, "workerId": worker_id}, timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    if data.get("cancel") is True:
                        log("🛑 Cancel signal received from server.")
                        send_update("🛑 Task cancelled by user")
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
                            
                            # Collect output files before upload
                            output_files = collect_output_files(current_folder)
                            upload_result(current_customer_id or "unknown", worker_id, b"execution cancelled by user", json.dumps(current_usage_log).encode(), output_files)
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
    except Exception as e:
        log(f"❌ Unexpected error in main worker: {e}")
        graceful_exit()