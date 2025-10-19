import requests  # External library (must be installed)
import json

def main():
    print("Fetching data from an API...")
    response = requests.get("https://api.github.com")
    
    if response.status_code == 200:
        data = response.json()
        print("Successfully fetched GitHub API data!")
        print("GitHub current user URL:", data.get("current_user_url"))
    else:
        print(" Failed to fetch data, status code:", response.status_code)

if __name__ == "__main__":
    main()
