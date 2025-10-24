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
from time import sleep
from cryptography.fernet import Fernet

# =====================================================
#                  CONFIGURATION
# =====================================================
SERVER_URL = "http://localhost:5000"
customer_id = ""
worker_id = "Kumar"
HEARTBEAT_INTERVAL = 5  # seconds

# Filename used if no env key provided
LOCAL_KEYFILE = "secret.key"
INIT_MARKER = ".worker_initialized"

# =====================================================
#               KEY MANAGEMENT / FERNET
# =====================================================

def load_or_create_key():
    """
    Load Fernet key from environment variable WORKER_SECRET_KEY (preferred).
    If not present, load from LOCAL_KEYFILE, or generate & save a new key.
    """
    env_key = os.environ.get("WORKER_SECRET_KEY")
    if env_key:
        if isinstance(env_key, str):
            env_key = env_key.encode()
        return env_key

    # Try loading local file
    if os.path.exists(LOCAL_KEYFILE):
        with open(LOCAL_KEYFILE, "rb") as f:
            key = f.read().strip()
            return key

    # Generate and save key with restricted perms
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

def send_update(message: str):
    """Send status update to the server."""
    payload = {"customerId": customer_id, "update": message}
    try:
        requests.post(f"{SERVER_URL}/whatistheupdate", json=payload, timeout=5)
    except requests.exceptions.RequestException as e:
        print(f"⚠️ Update error: {e}")


def jsonl_to_txt(jsonl_path: str, txt_path: str):
    """Convert JSONL log file to plain text."""
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


def upload_result(customer_id: str, worker_id: str, result_bytes: bytes, usage_bytes: bytes):
    """Upload result and usage logs to server using in-memory bytes."""
    files = {
        "result": ("result_output.txt", result_bytes),
        "usage": ("usage_log.txt", usage_bytes)
    }
    prepared_files = {
        k: (v[0], v[1]) for k, v in files.items()
    }
    payload = {"workerId": worker_id, "customerId": customer_id}
    try:
        r = requests.post(f"{SERVER_URL}/uploadresult", files=prepared_files, data=payload, timeout=30)
        r.raise_for_status()
        response = r.json()
        if response.get("resp"):
            print(f"✅ Result uploaded successfully. Pending workers: {response.get('pendingWorkers')}")
        else:
            print(f"❌ Upload failed: {response.get('message')}")
    except requests.exceptions.RequestException as e:
        print(f"❌ Result upload failed: {e}")

# =====================================================
#                ENCRYPT / DECRYPT HELPERS
# =====================================================

def encrypt_folder(folder_path: str):
    """Encrypt all regular files inside folder_path in place (except the key file)."""
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
                try:
                    os.chmod(file_path, stat.S_IRUSR | stat.S_IWUSR)
                except Exception:
                    pass
            except Exception as e:
                print(f"⚠️ Failed to encrypt {file_path}: {e}")


def decrypt_folder(folder_path: str):
    """Decrypt all files in folder_path in place (except the key file)."""
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
                decrypted = f.decrypt(data)
                with open(file_path, "wb") as fh:
                    fh.write(decrypted)
                try:
                    os.chmod(file_path, stat.S_IRUSR | stat.S_IWUSR)
                except Exception:
                    pass
            except Exception as e:
                print(f"⚠️ Failed to decrypt {file_path}: {e}")
                raise


def secure_overwrite_and_remove_file(path, passes=1, chunk_size=4096):
    """Overwrite file contents with random data then remove file."""
    try:
        if not os.path.isfile(path):
            return
        size = os.path.getsize(path)
        with open(path, "r+b") as fh:
            fh.seek(0)
            remaining = size
            while remaining > 0:
                to_write = os.urandom(min(chunk_size, remaining))
                fh.write(to_write)
                remaining -= len(to_write)
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except Exception:
                pass
        os.remove(path)
    except Exception as e:
        print(f"⚠️ secure delete failed for {path}: {e}")
        try:
            os.remove(path)
        except Exception:
            pass


def secure_delete_folder(folder_path: str):
    """Securely overwrite files inside folder and remove the folder."""
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
        try:
            shutil.rmtree(folder_path, ignore_errors=True)
        except Exception:
            pass

# =====================================================
#              DOCKER EXECUTION & MONITORING
# =====================================================

def monitor_container_usage(container, customer_id, worker_id, usage_log):
    """Monitor container CPU and memory usage."""
    try:
        for stat in container.stats(stream=True, decode=True):
            cpu_stats = stat.get("cpu_stats", {})
            precpu_stats = stat.get("precpu_stats", {})
            mem_stats = stat.get("memory_stats", {})

            cpu_delta = (
                cpu_stats.get("cpu_usage", {}).get("total_usage", 0)
                - precpu_stats.get("cpu_usage", {}).get("total_usage", 0)
            )
            system_delta = (
                cpu_stats.get("system_cpu_usage", 0)
                - precpu_stats.get("system_cpu_usage", 0)
            )

            cpu_percent = 0.0
            if system_delta > 0 and cpu_delta > 0:
                cpu_count = len(cpu_stats.get("cpu_usage", {}).get("percpu_usage", []) or [0])
                try:
                    cpu_percent = (cpu_delta / system_delta) * cpu_count * 100.0
                except Exception:
                    cpu_percent = 0.0

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


def run_in_docker(
    folder_path: str,
    worker_id: str,
    customer_id: str,
    code_file: str = "code_file.py",
    requirements_file: str = "requirements.txt",
    cpu_limit: float = 1.0,
    mem_limit: str = "512m",
    image: str = "python:3.11-slim"
):
    """Run user code in Docker container and monitor it."""
    send_update("Docker initialized")

    abs_folder = os.path.abspath(folder_path)
    if not os.path.isdir(abs_folder):
        raise ValueError(f"Folder '{abs_folder}' not found!")

    client = docker.from_env()
    volumes = {abs_folder: {"bind": "/app", "mode": "rw"}}

    commands = []
    pip_log = "/app/pip_install.log"
    req_path = os.path.join(abs_folder, requirements_file)

    if os.path.exists(req_path) and os.path.getsize(req_path) > 0:
        commands.append(f"pip install --no-cache-dir -r /app/{requirements_file} > {pip_log} 2>&1")
        send_update("Installing dependencies...")

    commands.append(f"python /app/{code_file}")
    final_cmd = " && ".join(commands)

    container = client.containers.run(
        image=image,
        command=["bash", "-c", final_cmd],
        volumes=volumes,
        working_dir="/app",
        detach=True,
        mem_limit=mem_limit,
        nano_cpus=int(cpu_limit * 1e9),
    )

    send_update("Container started")

    usage_log = []
    threading.Thread(
        target=monitor_container_usage,
        args=(container, customer_id, worker_id, usage_log),
        daemon=True
    ).start()

    logs = []
    try:
        for line in container.logs(stream=True):
            try:
                decoded = line.decode().rstrip()
            except Exception:
                decoded = str(line)
            logs.append(decoded)
    except Exception as e:
        print(f"⚠️ Error while streaming logs: {e}")

    result = container.wait()
    exit_code = result.get("StatusCode", -1)
    logs_output = "\n".join(logs)

    try:
        container.remove(force=True)
    except Exception:
        pass

    usage_jsonl = []
    for entry in usage_log:
        usage_jsonl.append(entry)

    usage_txt_bytes = json.dumps(usage_jsonl, indent=2).encode("utf-8")
    result_bytes = logs_output.encode("utf-8")

    try:
        usage_jsonl_path = os.path.join(abs_folder, "usage_log.jsonl")
        with open(usage_jsonl_path, "w", encoding="utf-8") as f:
            for entry in usage_log:
                f.write(json.dumps(entry) + "\n")
        usage_txt = os.path.join(abs_folder, "usage_log.txt")
        jsonl_to_txt(usage_jsonl_path, usage_txt)
        result_file = os.path.join(abs_folder, "result_output.txt")
        with open(result_file, "w", encoding="utf-8") as f:
            f.write(logs_output)
    except Exception:
        pass

    try:
        upload_result(customer_id, worker_id, result_bytes, usage_txt_bytes)
    except Exception as e:
        print(f"⚠️ Upload (in-memory) failed: {e}")

    if usage_log:
        try:
            avg_cpu = sum(e["cpu_percent"] for e in usage_log) / len(usage_log)
            max_mem = max(e["mem_usage_MB"] for e in usage_log)
            print(f"\n📊 CPU avg: {avg_cpu:.2f}% | Peak RAM: {max_mem:.2f} MB\n")
        except Exception:
            pass

    send_update(f"Docker finished with exit code {exit_code}")
    return {"exit_code": exit_code, "output": logs_output}

# =====================================================
#                 HEARTBEAT SYSTEM
# =====================================================

def send_heartbeat():
    payload = {"workerId": worker_id, "customerId": customer_id}
    try:
        requests.post(f"{SERVER_URL}/heartbeat", json=payload, timeout=5)
    except requests.exceptions.RequestException as e:
        print(f"⚠️ Heartbeat error: {e}")


def start_heartbeat(interval=HEARTBEAT_INTERVAL):
    stop_event = threading.Event()

    def loop():
        while not stop_event.is_set():
            send_heartbeat()
            sleep(interval)

    threading.Thread(target=loop, daemon=True).start()
    return stop_event

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
        if not data.get("taskId"):
            return None, None, None
        return data["customerId"], data["taskId"], data["files"]
    except requests.exceptions.RequestException as e:
        print(f"⚠️ Claim task error: {e}")
        return None, None, None


def save_files(customer_id_local, files):
    """
    Save base64-encoded files to a local folder named after customer_id_local.
    Returns the folder path.
    """
    folder = os.path.join(os.getcwd(), customer_id_local)
    os.makedirs(folder, exist_ok=True)

    def decode_and_save(b64data, filename):
        path = os.path.join(folder, filename)
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64data))
        try:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        except Exception:
            pass
        return path

    decode_and_save(files["code"], "code_file.py")
    if files.get("dataset"):
        decode_and_save(files["dataset"], "dataset_file.csv")
    if files.get("requirement"):
        decode_and_save(files["requirement"], "requirements.txt")

    try:
        os.chmod(folder, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    except Exception:
        pass

    return folder

# =====================================================
#           FIRST-RUN SETUP: WORKER ID + PIP INSTALL
# =====================================================

def first_run_setup():
    """
    On first run: prompt for worker id (if not set via env) and install pip requirements if present.
    Stores marker file to avoid repeating.
    """
    global worker_id

    # Respect env override
    env_wid = os.environ.get("WORKER_ID")
    if env_wid:
        worker_id = env_wid

    marker = os.path.join(os.getcwd(), INIT_MARKER)
    installed_flag = False

    # If marker file exists, load saved worker_id and flags
    if os.path.exists(marker):
        try:
            with open(marker, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("worker_id"):
                    worker_id = data.get("worker_id")
                installed_flag = data.get("requirements_installed", False)
        except Exception:
            pass

    # If worker_id still default, prompt user
    if not env_wid and (not worker_id or worker_id == "Kumar"):
        try:
            inp = input("Enter worker id (this identifies this worker to the server): ").strip()
            if inp:
                worker_id = inp
        except Exception:
            # if input() not possible (service mode), keep default or env var
            pass

    # If requirements.txt exists and not yet installed, try to install
    requirements_path = os.path.join(os.getcwd(), "requirements.txt")
    pip_log_path = os.path.join(os.getcwd(), "pip_install.log")
    if os.path.exists(requirements_path) and not installed_flag:
        print("[setup] requirements.txt found — installing pip packages. This may take a while...")
        try:
            # Run pip install using the current Python interpreter
            cmd = [sys.executable, "-m", "pip", "install", "-r", requirements_path]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
            with open(pip_log_path, "w", encoding="utf-8") as f:
                f.write(proc.stdout)
            print(f"[setup] pip install finished — log at {pip_log_path}")
            installed_flag = True
        except Exception as e:
            print(f"[setup] pip install failed: {e}")

    # Save marker file with worker id and installed flag
    try:
        data = {"worker_id": worker_id, "requirements_installed": installed_flag}
        with open(marker, "w", encoding="utf-8") as f:
            json.dump(data, f)
        try:
            os.chmod(marker, stat.S_IRUSR | stat.S_IWUSR)
        except Exception:
            pass
    except Exception:
        pass

# =====================================================
#                   MAIN WORKER LOOP
# =====================================================

def main_worker():
    global customer_id
    while True:
        if not check_server():
            print("Server not available. Retrying in 5s...")
            sleep(5)
            continue

        customer_id, task_id, files = claim_task()
        if not task_id:
            print("ℹ️ No task available. Retrying in 5s...")
            sleep(5)
            continue

        print(f"⚡ Claimed task {task_id} for customer {customer_id}")
        folder = save_files(customer_id, files)

        try:
            encrypt_folder(folder)
            print("🔐 Files encrypted on disk.")
        except Exception as e:
            print(f"⚠️ Encryption step failed: {e}")

        heartbeat_stop = start_heartbeat()
        print("🐳 Running code in Docker...")

        try:
            try:
                decrypt_folder(folder)
                print("🔓 Files decrypted for execution.")
            except Exception as e:
                print(f"❌ Decryption failed: {e}")
                send_update(f"decryption_failed: {e}")
                raise

            result = run_in_docker(folder, worker_id, customer_id)
            print(f"✅ Docker finished. Exit code: {result['exit_code']}")
        except Exception as e:
            print(f"❌ Docker execution failed: {e}")
            send_update(f"docker_failed: {e}")
        finally:
            heartbeat_stop.set()
            try:
                print("🧹 Securely deleting files and folder...")
                secure_delete_folder(folder)
                print("🗑️ Cleanup finished.")
            except Exception as e:
                print(f"⚠️ Cleanup failed: {e}")

        send_update("completed")
        print("✅ Task completed. Waiting for next task...\n")
        sleep(5)

# =====================================================
#                   ENTRY POINT
# =====================================================

if __name__ == "__main__":
    # Run first-run setup: prompt worker id and install requirements if needed
    try:
        first_run_setup()
    except Exception as e:
        print(f"[setup] first_run_setup failed: {e}")

    start_heartbeat()
    main_worker()
