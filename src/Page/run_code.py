import docker
import os
import time
import threading
import json
from updateSender import send_update as sendUpdate


def monitor_container_usage(container, customerId, workerId, usage_log):
    """
    Monitors container CPU and memory usage every second.
    Stores stats in usage_log list.
    """
    try:
        for stat in container.stats(stream=True, decode=True):
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

            # Send occasional updates
            sendUpdate(customerId, f"CPU: {entry['cpu_percent']}%, RAM: {entry['mem_usage_MB']} MB", workerId)
            time.sleep(1)
    except Exception as e:
        sendUpdate(customerId, f"Usage monitor stopped: {e}", workerId)


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
    """
    Run Python code inside a Docker container with optional CPU/memory limits.
    Tracks live resource usage and logs it after execution.
    """
    sendUpdate(customerId, "Docker initialized", workerId)

    abs_folder = os.path.abspath(folder_path)
    if not os.path.isdir(abs_folder):
        raise ValueError(f"Folder '{abs_folder}' not found!")

    sendUpdate(customerId, "Validated folder", workerId)

    try:
        client = docker.from_env()
        print("Docker client initialized successfully!")
    except Exception as e:
        sendUpdate(customerId, f"Docker not accessible: {str(e)}", workerId)
        return {"exit_code": -1, "output": str(e)}

    sendUpdate(customerId, "Docker client created", workerId)

    volumes = {abs_folder: {"bind": "/app", "mode": "rw"}}
    sendUpdate(customerId, "Mounted folder into container", workerId)

    # Build command
    commands = []
    req_path = os.path.join(abs_folder, requirements_file)
    if os.path.exists(req_path) and os.path.getsize(req_path) > 0:
        commands.append(f"pip install --no-cache-dir -r /app/{requirements_file} > /dev/null 2>&1")
        sendUpdate(customerId, "requirements.txt found — installing dependencies", workerId)
    else:
        sendUpdate(customerId, "No requirements.txt — skipping install", workerId)

    commands.append(f"python /app/{code_file}")
    final_command = " && ".join(commands)
    sendUpdate(customerId, f"Prepared command: {final_command}", workerId)

    # Run container
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
        sendUpdate(customerId, "Container started", workerId)

        # Start monitoring thread
        usage_log = []
        monitor_thread = threading.Thread(
            target=monitor_container_usage,
            args=(container, customerId, workerId, usage_log),
            daemon=True,
        )
        monitor_thread.start()

        logs = []
        for line in container.logs(stream=True):
            decoded = line.decode().strip()
            logs.append(decoded)

        # Wait for completion
        result = container.wait()
        exit_code = result.get("StatusCode", -1)

        sendUpdate(customerId, f"Docker finished with exit code {exit_code}", workerId)

        # Stop container & remove
        try:
            container.remove(force=True)
            sendUpdate(customerId, "Container removed", workerId)
        except Exception:
            pass

        # --- Save usage logs ---
        usage_file = os.path.join(abs_folder, "usage_log.jsonl")
        with open(usage_file, "w", encoding="utf-8") as f:
            for entry in usage_log:
                f.write(json.dumps(entry) + "\n")

        sendUpdate(customerId, f"Usage log saved to {usage_file}", workerId)

        # Print summary
        if usage_log:
            avg_cpu = sum(e["cpu_percent"] for e in usage_log) / len(usage_log)
            max_mem = max(e["mem_usage_MB"] for e in usage_log)
            print(f"\n📊 CPU avg: {avg_cpu:.2f}% | Peak RAM: {max_mem:.2f} MB\n")

        return {"exit_code": exit_code, "output": "\n".join(logs)}

    except docker.errors.DockerException as e:
        sendUpdate(customerId, f"Docker error: {str(e)}", workerId)
        return {"exit_code": -1, "output": str(e)}
