import requests

SERVER_URL = "http://localhost:5000"

def send_update(customerId, message,workerId):
    payload = {"workerId": workerId, "customerId": customerId, "update": message}
    try:
        requests.post(f"{SERVER_URL}/updates", json=payload)
    except requests.exceptions.RequestException as e:
        print("⚠️ Update error:", e)