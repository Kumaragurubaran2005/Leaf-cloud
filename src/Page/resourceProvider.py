import os
import base64
import requests
import threading
from time import sleep
from run_code import run_in_docker  # Ensure this accepts workerId parameter
from updateSender import send_update

# -------------------- CONFIG --------------------
workerId = "worker123"
SERVER_URL = "http://localhost:5000"
HEARTBEAT_INTERVAL = 5  # seconds

# -------------------- FUNCTIONS --------------------

# Send heartbeat to server to indicate worker is alive
def send_heartbeat(customerId):
    payload = {"workerId": workerId, "customerId": customerId}
    try:
        requests.post(f"{SERVER_URL}/heartbeat", json=payload)
    except requests.exceptions.RequestException as e:
        print("⚠️ Heartbeat error:", e)

# Start periodic heartbeat in background
def start_heartbeat(customerId, interval=HEARTBEAT_INTERVAL):
    stop_event = threading.Event()

    def heartbeat_loop():
        while not stop_event.is_set():
            send_heartbeat(customerId)
            sleep(interval)

    thread = threading.Thread(target=heartbeat_loop, daemon=True)
    thread.start()
    return stop_event  # call stop_event.set() to stop heartbeats

# Check if server is available
def check_server():
    try:
        response = requests.get(f"{SERVER_URL}/areyouthere")
        response.raise_for_status()
        data = response.json()
        return data.get("iamthere", False)
    except requests.exceptions.RequestException as e:
        print("⚠️ Server check error:", e)
        return False

# Ask for a task and claim it
def claim_task():
    try:
        payload = {"workerId": workerId}
        response = requests.post(f"{SERVER_URL}/gettask", json=payload)
        response.raise_for_status()
        data = response.json()
        if not data.get("taskId"):
            return None, None, None
        return data["customerId"], data["taskId"], data["files"]
    except requests.exceptions.RequestException as e:
        print("⚠️ Claim task error:", e)
        return None, None, None

# Save base64-encoded files locally
def save_files(customerId, files):
    folder_path = os.path.join(os.getcwd(), customerId)
    os.makedirs(folder_path, exist_ok=True)

    # Code
    code_bytes = base64.b64decode(files["code"])
    code_file_path = os.path.join(folder_path, "code_file.py")
    with open(code_file_path, "wb") as f:
        f.write(code_bytes)

    # Dataset
    if files.get("dataset"):
        dataset_bytes = base64.b64decode(files["dataset"])
        dataset_file_path = os.path.join(folder_path, "dataset_file.csv")
        with open(dataset_file_path, "wb") as f:
            f.write(dataset_bytes)

    # Requirements
    if files.get("requirement"):
        req_bytes = base64.b64decode(files["requirement"])
        req_file_path = os.path.join(folder_path, "requirements.txt")
        with open(req_file_path, "wb") as f:
            f.write(req_bytes)

    return folder_path

# Upload result to server
def upload_result(customerId, result_file_path):
    with open(result_file_path, "rb") as f:
        files = {"result": f}
        payload = {"workerId": workerId, "customerId": customerId}
        try:
            response = requests.post(f"{SERVER_URL}/uploadresult", files=files, data=payload)
            response.raise_for_status()
            print("✅ Result uploaded successfully")
            
        except requests.exceptions.RequestException as e:
            print("❌ Result upload failed:", e)

# -------------------- MAIN WORKER LOOP --------------------
def main_worker():
    while True:
        if not check_server():
            print("⚠️ Server not available. Retrying in 5s...")
            sleep(5)
            continue

        customerId, taskId, files = claim_task()
        if not taskId:
            print("ℹ️ No task available. Retrying in 5s...")
            sleep(5)
            continue

        print(f"⚡ Claimed task {taskId} for customer {customerId}")

        folder_path = save_files(customerId, files)
        req_file_path = os.path.join(folder_path, "requirements.txt")
        has_requirements = os.path.exists(req_file_path)

        # Start background heartbeat for this task
        heartbeat_stop = start_heartbeat(customerId)

        print("🐳 Starting Docker execution...")
        try:
            result = run_in_docker(
                folder_path,
                workerId=workerId,
                customerId=customerId,
                code_file="code_file.py",
                requirements_file="requirements.txt" if has_requirements else "",
                cpu_limit=1.0,
                mem_limit="512m"
            )
            print(f"✅ Docker execution finished. Exit code: {result['exit_code']}")
        except Exception as e:
            print(f"❌ Docker execution failed: {e}")
            send_update(customerId, f"docker_failed: {e}", workerId)
            heartbeat_stop.set()  # stop heartbeats for this task
            continue

        # Save Docker output as result file
        result_file_path = os.path.join(folder_path, "result_output.txt")
        with open(result_file_path, "w") as f:
            f.write(result.get("output", ""))

        # Upload result to server
        upload_result(customerId, result_file_path)
        send_update(customerId, "completed", workerId)

        # Stop heartbeat after task finished
        heartbeat_stop.set()

        print("✅ Task completed. Waiting for next task...")
        sleep(5)

if __name__ == "__main__":
    main_worker()
