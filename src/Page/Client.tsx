// Client.tsx
import React, { useState, useEffect } from "react";

const Client = () => {
  // File states
  const [code, setCode] = useState<File | null>(null);
  const [dataset, setDataset] = useState<File | null>(null);
  const [requirement, setRequirement] = useState<File | null>(null);

  // Customer info
  const [customerName, setCustomerName] = useState("");
  const [responseNumber, setResponseNumber] = useState("");
  const [customerId, setCustomerId] = useState("");

  // Server and progress states
  const [serverLive, setServerLive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Latest update state
  const [latestUpdate, setLatestUpdate] = useState("");

  // Results from server
  const [results, setResults] = useState<{ workerId: string; result: string }[]>([]);

  const baseurl = "http://localhost:5000";

  // ---------------- SERVER CHECK ----------------
  const checkServerAvailability = async () => {
    try {
      const resp = await fetch(`${baseurl}/areyouthere`);
      const data = await resp.json();
      setServerLive(!!data.iamthere);
    } catch (err) {
      setServerLive(false);
      alert("Server not available");
    }
  };

  // ---------------- POLL LATEST UPDATES ----------------
  useEffect(() => {
    if (!serverLive || !customerId) return;

    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`${baseurl}/getUpdate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId }),
        });

        const data = await resp.json();
        if (Array.isArray(data.updates) && data.updates.length > 0) {
          const lastUpdate = data.updates[data.updates.length - 1].update;
          setLatestUpdate(lastUpdate);
          console.log("Latest update:", lastUpdate);
        }
      } catch (err) {
        console.error("Polling failed:", err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [serverLive, customerId]);

  // ---------------- SEND FILES ----------------
  const sendFile = async () => {
    if (!serverLive) {
      alert("Server is not live. Cannot send files.");
      return;
    }

    try {
      const files = new FormData();
      if (code) files.append("code", code);
      if (dataset) files.append("dataset", dataset);
      if (requirement) files.append("requirement", requirement);
      files.append("customername", customerName);
      files.append("respn", responseNumber);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${baseurl}/sendingpackage`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          setUploadProgress(percent);
        }
      };

      xhr.onload = () => {
        setUploadProgress(0);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const respData = JSON.parse(xhr.responseText);
            if (respData.customerId) {
              alert(`File sent successfully! Customer ID: ${respData.customerId}`);
              setCustomerId(respData.customerId);
            } else {
              alert("File sent successfully, but no customer ID returned.");
            }
          } catch (err) {
            alert("File sent, but failed to parse server response");
            console.error(err);
          }
        } else {
          alert(`Server error: ${xhr.status}`);
        }
      };

      xhr.onerror = () => {
        setUploadProgress(0);
        alert("Upload failed (network error)");
      };

      xhr.send(files);
    } catch (err) {
      console.error(err);
      alert("Failed to send files");
    }
  };

  // ---------------- GET RESULTS ----------------
  const getResults = async () => {
    if (!customerId) {
      alert("Please send files first to get a Customer ID.");
      return;
    }

    try {
      const resp = await fetch(`${baseurl}/getresults`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId }),
      });

      const data = await resp.json();
      if (Array.isArray(data.results)) {
        setResults(data.results);
      } else {
        alert("No results available yet.");
      }
    } catch (err) {
      console.error(err);
      alert("Failed to fetch results");
    }
  };

  // ---------------- DOWNLOAD FILE ----------------
  const downloadFile = (workerId: string, base64: string) => {
    const link = document.createElement("a");
    link.href = `data:text/plain;base64,${base64}`; // Use text/plain
    link.download = `result_${workerId}.txt`; // Save as .txt
    link.click();
  };


  // ---------------- RENDER ----------------
  return (
    <div className="max-w-3xl mx-auto p-6 bg-white shadow-lg rounded-lg mt-8">
      <h2 className="text-2xl font-bold mb-6 text-center">Send Package</h2>

      {/* Server Status */}
      <div className="flex items-center mb-6 gap-4">
        <button
          onClick={checkServerAvailability}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition"
        >
          Check Server
        </button>
        <span className={`font-semibold ${serverLive ? "text-green-600" : "text-red-600"}`}>
          {serverLive ? "Server: live" : "Server: unknown"}
        </span>
      </div>

      {/* File Upload Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendFile();
        }}
        className="space-y-4"
      >
        <div>
          <label>Code file</label>
          <input type="file" accept=".js,.py,.txt,.zip" onChange={(e) => setCode(e.target.files?.[0] ?? null)} />
        </div>

        <div>
          <label>Dataset file (optional)</label>
          <input type="file" accept=".csv,.json,.zip" onChange={(e) => setDataset(e.target.files?.[0] ?? null)} />
        </div>

        <div>
          <label>Requirement file (optional)</label>
          <input type="file" accept=".txt,.pdf,.doc,.docx" onChange={(e) => setRequirement(e.target.files?.[0] ?? null)} />
        </div>

        <div>
          <label>Customer Name</label>
          <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
        </div>

        <div>
          <label>Response Number</label>
          <input type="text" value={responseNumber} onChange={(e) => setResponseNumber(e.target.value)} />
        </div>

        {uploadProgress > 0 && <p>Upload Progress: {uploadProgress}%</p>}

        <div className="flex gap-4">
          <button type="submit" disabled={!serverLive} className="px-4 py-2 bg-green-500 text-white rounded">
            Send Files
          </button>
          <button type="button" onClick={getResults} className="px-4 py-2 bg-indigo-500 text-white rounded">
            Get Results
          </button>
        </div>
      </form>

      {/* Latest Server Update */}
      <div className="mt-8">
        <h3>Latest Update:</h3>
        <p>{latestUpdate || "No updates yet."}</p>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="mt-6">
          <h3>Results:</h3>
          <ul className="space-y-2">
            {results.map((r) => (
              <li key={r.workerId}>
                <button
                  onClick={() => downloadFile(r.workerId, r.result)}
                  className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 transition"
                >
                  Download result from {r.workerId}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default Client;
