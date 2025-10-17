import docker
import os
from updateSender import sendUpdate

def run_in_docker(
    folder_path: str,
    workerId: str,
    code_file: str = "code_file.py",
    requirements_file: str = "requirements.txt",
    cpu_limit: float = 1.0,
    mem_limit: str = "512m",
    env_vars: dict = None,
    image: str = "python"
) -> dict:
    """
    Run Python code inside a Docker container with optional CPU/memory limits.
    Automatically installs requirements.txt if available.
    Sends progress updates via sendUpdate().
    Returns the output as a dict: {"exit_code": int, "output": str}.
    """
    sendUpdate("Docker initialized")

    # --- Validate folder ---
    abs_folder = os.path.abspath(folder_path)
    
    if not os.path.isdir(abs_folder):
        raise ValueError(f"Folder '{abs_folder}' not found!")
    
    sendUpdate(f"Validated folder: {abs_folder}")
    
    try:
        client = docker.from_env()
        print("Docker client initialized successfully!")
    except Exception as e:
        print("Docker is not running or not accessible:", e)
        exit
    
    sendUpdate("Docker client created")
    
    # --- Mount folder inside container ---
    volumes = {abs_folder: {"bind": "/app", "mode": "rw"}}
    
    sendUpdate("Mounted folder into container")

    # --- Build command ---
    commands = []

    # Install requirements if present
    req_path = os.path.join(abs_folder, requirements_file)
    if os.path.exists(req_path) and os.path.getsize(req_path) > 0:
        commands.append(
            f"pip install --no-cache-dir -r /app/{requirements_file} > /dev/null 2>&1"
        )
    
        sendUpdate("requirements.txt found — will install dependencies")
    else:
        sendUpdate("No requirements.txt found — skipping dependency install")

    # Run main code file
    commands.append(f"python /app/{code_file}")
    final_command = " && ".join(commands)
    sendUpdate(f"Prepared command: {final_command}")

    # --- Run Docker container ---
    try:
        container = client.containers.run(
            image=image,
            command=["bash", "-c", final_command],
            volumes=volumes,
            environment=env_vars or {},
            working_dir="/app",
            detach=True,
            mem_limit=mem_limit,
            nano_cpus=int(cpu_limit * 1e9)
        )
        sendUpdate("Container started")

        # --- Capture logs in real-time ---
        logs = []
        for line in container.logs(stream=True):
            decoded = line.decode().strip()
            logs.append(decoded)

        # Wait for container to finish
        result = container.wait()
        exit_code = result.get("StatusCode", -1)
        sendUpdate(f"Docker execution completed with exit code {exit_code}")

    except docker.errors.DockerException as e:
        sendUpdate(f"Docker error: {str(e)}")
        return {"exit_code": -1, "output": str(e)}

    finally:
        try:
            container.remove(force=True)
            sendUpdate("Container removed")
        except Exception:
            pass

    return {"exit_code": exit_code, "output": "\n".join(logs)}
