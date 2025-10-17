import os
import base64
import requests
from time import sleep
from run_code import run_in_docker  # Ensure run_in_docker includes workerId parameter
from updateSender import sendUpdate
workerId = 123
SERVER_URL = "http://localhost:5000"


# --- Function to send progress updates ---
def sendUpdate(update):
    payload = {"update": update}
    try:
        response = requests.post(f"{SERVER_URL}/updates", json=payload)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print("Error sending update:", e)

# --- Check if server is available ---
def check_server():
    try:
        response = requests.get(f"{SERVER_URL}/areyouthere")
        response.raise_for_status()
        data = response.json()
        return data.get("iamthere", False)
    except requests.exceptions.RequestException as e:
        print("Error checking server:", e)
        return False

# --- Check if a task is available ---
def ask_for_task():
    try:
        response = requests.get(f"{SERVER_URL}/askfortask")
        response.raise_for_status()
        data = response.json()
        return data.get("isTaskThere", False)
    except requests.exceptions.RequestException as e:
        print("Error asking for task:", e)
        return False

# --- Request permission to execute a task ---
def request_task_permission():
    payload = {"workerId": workerId}
    try:
        response = requests.post(f"{SERVER_URL}/iamin", json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("isaccepted", False)
    except requests.exceptions.RequestException as e:
        print("Error requesting permission:", e)
        return False

# --- Fetch code, dataset, and requirements from server ---
def get_files():
    payload = {"workerId": workerId}
    try:
        response = requests.post(f"{SERVER_URL}/getfiles", json=payload)
        response.raise_for_status()
        data = response.json()

        customer_name = data.get("customerName", f"customer_{workerId}")

        if "code" in data:
            # Decode base64 data safely
            code_bytes = base64.b64decode(data["code"])
            dataset_bytes = (
                base64.b64decode(data["dataset"]) if data.get("dataset") else None
            )
            requirement_bytes = (
                base64.b64decode(data["requirement"]) if data.get("requirement") else None
            )

            # Create folder for customer
            folder_path = os.path.join(os.getcwd(), customer_name)
            os.makedirs(folder_path, exist_ok=True)

            # Save required code file
            code_file_path = os.path.join(folder_path, "code_file.py")
            with open(code_file_path, "wb") as f:
                f.write(code_bytes)

            # Save dataset if provided
            if dataset_bytes:
                dataset_file_path = os.path.join(folder_path, "dataset_file.csv")
                with open(dataset_file_path, "wb") as f:
                    f.write(dataset_bytes)

            # Save requirements if provided
            if requirement_bytes:
                requirements_file_path = os.path.join(folder_path, "requirements.txt")
                with open(requirements_file_path, "wb") as f:
                    f.write(requirement_bytes)

            print(f"✅ Files downloaded successfully in folder: {folder_path}")
            return folder_path
        else:
            print("❌ Code file missing in server response")
            return None
    except requests.exceptions.RequestException as e:
        print("Error fetching files:", e)
        return None

# --- Main worker loop ---
def main_worker():
    while True:
        if check_server():
            if ask_for_task():
                print("⚡ Task available!")
                if request_task_permission():
                    print("✅ Permission granted. Fetching files...")
                    folder_path = get_files()
                    if folder_path:
                        # Determine if requirements.txt exists
                        req_file_path = os.path.join(folder_path, "requirements.txt")
                        has_requirements = os.path.exists(req_file_path)

                        print("🐳 Starting Docker execution...")
                        try:
                            result = run_in_docker(
                                folder_path,
                                workerId=workerId,
                                code_file="code_file.py",
                                requirements_file="requirements.txt" if has_requirements else "",
                                cpu_limit=1.0,
                                mem_limit="512m"
                            )
                            print(f"✅ Docker execution finished. Exit code: {result['exit_code']}")
                        except Exception as e:
                            print(f"❌ Docker execution failed: {e}")

                        print(f"📝 Execution finished. Exit code: {result['output']}")
                        sendUpdate("completed")
                    else:
                        print("❌ Failed to fetch files.")
                else:
                    print("❌ Task permission denied.")
            else:
                print("ℹ️ No task available.")
        else:
            print("⚠️ Server not available. Retrying in 5s...")

        sleep(5)

if __name__ == "__main__":
    main_worker()
