import requests

SERVER_URL = "http://localhost:5000"

def sendUpdate(info: str):
    """Send status update to server."""
    payload = {"update": info} 
    
    try:
        response = requests.post(f"{SERVER_URL}/updates", json=payload)
        data = response.json()
        print(data.get("isReceived"))
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print("Error sending update:", e)