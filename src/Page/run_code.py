import docker
import os
import time
import threading
import json
import requests
import signal
import ctypes
from updateSender import send_update as sendUpdate

SERVER_URL = "http://localhost:5000"  # Change to your server URL

# Track running containers globally
active_containers = []
stop_event = threading.Event()

# -------------------------- Windows Close Handler --------------------------
def windows_close_handler(event):
    """
    Called when user closes the terminal (X button) in Windows.
    """
    print("\n🛑 Window close detected — stopping Docker containers...")
    stop_all_containers()
    stop_event.set()
    return True  # signal handled

# -------------------------- Cleanup --------------------------
def stop_all_containers():
    """
    Stop and remove all tracked containers.
    """
    try:
        client = docker.from_env()
        for c in active_containers:
            try:
                container = client.containers.get(c.id)
                print(f"🛑 Killing container {container.short_id}...")
                container.remove(force=True)
            except Exception as e:
                print(f"⚠️ Error stopping container: {e}")
        active_containers.clear()
    except Exception as e:
        print("⚠️ Error in stop_all_containers:", e)

# Register Ctrl+C and system signals
def setup_signal_handlers():
    def handle_signal(signum, frame):
        print("\n🛑 Signal received — cleaning up containers...")
        stop_all_containers()
        stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    # Handle window close (Windows only)
    if os.name == "nt":
        kernel32 = ctypes.windll.kernel32
        kernel32.SetConsoleCtrlHandler(ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_uint)(windows_close_handler), True)

setup_signal_handlers()

# -------------------------- Monitor Usage --------------------------
def monitor_container_usage(container, customerId, workerId, usage_log):
    """
    Monitors container CPU and memory usage every second.
    Stores stats in usage_log list and sends periodic updates.
    """
    try:
        for stat in container.stats(stream=True, decode=True):
            if stop_event.is_set():
                break

            cpu_stats = stat.get("cpu_stats", {})
            precpu_stats = stat.get("precpu_stats", {})
            mem_stats = stat.get("memory_stats", {})

            # Safely calculate CPU %
            try:
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
                    cpu_percent = (cpu_delta / system_delta) * cpu_count * 100.0
            except Exception:
                cpu_percent = 0.0

            # Memory usage
            mem_usage = mem_stats.get("usage", 0)
            mem_limit = mem_stats.get("limit", 1)
            mem_percent = (mem_usage / mem_limit) * 100

            # Prepare entry
            entry = {
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "cpu_percent": round(cpu_percent, 2),
                "mem_usage_MB": round(mem_usage / (1024 * 1024), 2),
                "mem_percent": round(mem_percent, 2),
            }
            usage_log.append(entry)

            sendUpdate(customerId, f"CPU: {entry['cpu_percent']}%, RAM: {entry['mem_usage_MB']} MB", workerId)
            time.sleep(1)
    except Exception as e:
        sendUpdate(customerId, f"Usage monitor stopped: {e}", workerId)

# -------------------------- JSONL to TXT --------------------------
def jsonl_to_txt(jsonl_path, txt_path):
    with open(jsonl_path, "r", encoding="utf-8") as f_in, open(txt_path, "w", encoding="utf-8") as f_out:
        for line in f_in:
            try:
                obj = json.loads(line)
                for k, v in obj.items():
                    f_out.write(f"{k}: {v}\n")
                f_out.write("\n")
            except json.JSONDecodeError:
                continue

# -------------------------- Upload Result --------------------------
def upload_result(customerId, workerId, result_file_path, usage_file_path):
    try:
        with open(result_file_path, "rb") as result_file, open(usage_file_path, "rb") as usage_file:
            files = {"result": result_file, "usage": usage_file}
            payload = {"workerId": workerId, "customerId": customerId}
            r = requests.post(f"{SERVER_URL}/uploadresult", files=files, data=payload)
            r.raise_for_status()
            response = r.json()
            if response.get("resp"):
                print(f"✅ Result uploaded successfully. Pending workers: {response.get('pendingWorkers')}")
            else:
                print("❌ Upload failed:", response.get("message"))
    except Exception as e:
        print("❌ Result upload failed:", e)

# -------------------------- Run in Docker --------------------------
def run_in_docker(
    folder_path: str,
    workerId: str,
    customerId: str,
    code_file: str = "code_file.py",
    requirements_file: str = "requirements.txt",
    cpu_limit: float = 1.0,
    mem_limit: str = "512m",
    env_vars: dict = None,
    image: str = "python",
) -> dict:
    sendUpdate(customerId, "Docker initialized", workerId)

    abs_folder = os.path.abspath(folder_path)
    if not os.path.isdir(abs_folder):
        raise ValueError(f"Folder '{abs_folder}' not found!")

    sendUpdate(customerId, "Validated folder", workerId)

    try:
        client = docker.from_env()
    except Exception as e:
        sendUpdate(customerId, f"Docker not accessible: {str(e)}", workerId)
        return {"exit_code": -1, "output": str(e)}

    volumes = {abs_folder: {"bind": "/app", "mode": "rw"}}

    # ---------------- Build command ----------------
    commands = []
    pip_log_file = "/app/pip_install.log"
    req_path = os.path.join(abs_folder, requirements_file)
    if os.path.exists(req_path) and os.path.getsize(req_path) > 0:
        commands.append(f"pip install --no-cache-dir -r /app/{requirements_file} > {pip_log_file} 2>&1")
        sendUpdate(customerId, "Installing requirements...", workerId)
    commands.append(f"python /app/{code_file}")
    final_command = " && ".join(commands)

    try:
        container = client.containers.run(
            image=image,
            command=["bash", "-c", final_command],
            volumes=volumes,
            environment=env_vars or {},
            working_dir="/app",
            detach=True,
            mem_limit=mem_limit,
            nano_cpus=int(cpu_limit * 1e9),
        )
        active_containers.append(container)
        sendUpdate(customerId, "Container started", workerId)

        usage_log = []
        monitor_thread = threading.Thread(
            target=monitor_container_usage,
            args=(container, customerId, workerId, usage_log),
            daemon=True,
        )
        monitor_thread.start()

        logs = []
        for line in container.logs(stream=True):
            if stop_event.is_set():
                break
            decoded = line.decode().strip()
            logs.append(decoded)

        result = container.wait()
        exit_code = result.get("StatusCode", -1)
        logs_output = "\n".join(logs)

        # ---------------- Pip logs ----------------
        pip_log_host_path = os.path.join(abs_folder, "pip_install.log")
        if os.path.exists(pip_log_host_path):
            with open(pip_log_host_path, "r", encoding="utf-8") as f:
                pip_output = f.read()
            if pip_output.strip():
                logs_output = f"--- Pip install output ---\n{pip_output}\n\n--- Program output ---\n{logs_output}"

        # ---------------- Save logs ----------------
        result_file = os.path.join(abs_folder, "result_output.txt")
        with open(result_file, "w", encoding="utf-8") as f:
            f.write(logs_output)

        usage_jsonl_file = os.path.join(abs_folder, "usage_log.jsonl")
        with open(usage_jsonl_file, "w", encoding="utf-8") as f:
            for entry in usage_log:
                f.write(json.dumps(entry) + "\n")

        usage_txt_file = os.path.join(abs_folder, "usage_log.txt")
        jsonl_to_txt(usage_jsonl_file, usage_txt_file)

        upload_result(customerId, workerId, result_file, usage_txt_file)

        container.remove(force=True)
        active_containers.remove(container)

        return {"exit_code": exit_code, "output": logs_output}

    except docker.errors.DockerException as e:
        sendUpdate(customerId, f"Docker error: {str(e)}", workerId)
        stop_all_containers()
        return {"exit_code": -1, "output": str(e)}
