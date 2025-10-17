// Client.jsx
import React, { useState, useRef, useEffect } from "react";

const Client = () => {
  const [code, setCode] = useState<File | null>(null);
  const [dataset, setDataset] = useState<File | null>(null);
  const [requirement, setRequirement] = useState<File | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [responseNumber, setResponseNumber] = useState("");
  const [serverLive, setServerLive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [update, setUpdate] = useState<string>("");

  const updatesEndRef = useRef<HTMLDivElement | null>(null);
  const baseurl = "http://localhost:5000";

  // --- Check server availability ---
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

  // --- Poll updates every 3 seconds ---
  useEffect(() => {
    if (!serverLive) return;

    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`${baseurl}/whatsTheupdate`);
        const data = await resp.json();
        setUpdate(data.updates || "No updates yet");
        updatesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      } catch (err) {
        console.error("Polling failed:", err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [serverLive]);

  // --- Handle form submission ---
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendFile();
  };

  // --- Send files with progress ---
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
              alert(`File sent successfully! Your Customer ID: ${respData.customerId}`);
              console.log("Customer ID:", respData.customerId);
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

  return (
    <div className="max-w-3xl mx-auto p-6 bg-white shadow-lg rounded-lg mt-8">
      <h2 className="text-2xl font-bold mb-6 text-center">Send Package</h2>

      {/* Server status */}
      <div className="flex items-center mb-6 gap-4">
        <button
          onClick={checkServerAvailability}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition"
        >
          Check Server
        </button>
        <span
          className={`font-semibold ${
            serverLive ? "text-green-600" : "text-red-600"
          }`}
        >
          {serverLive ? "Server: live" : "Server: unknown"}
        </span>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block mb-1 font-medium">Code file</label>
          <input
            type="file"
            accept=".js,.py,.txt,.zip"
            onChange={(e) => setCode(e.target.files?.[0] ?? null)}
            className="w-full border rounded px-3 py-2"
          />
          {code && <p className="mt-1 text-sm text-gray-500">{code.name}</p>}
        </div>

        <div>
          <label className="block mb-1 font-medium">Dataset file (optional)</label>
          <input
            type="file"
            accept=".csv,.json,.zip"
            onChange={(e) => setDataset(e.target.files?.[0] ?? null)}
            className="w-full border rounded px-3 py-2"
          />
          {dataset && <p className="mt-1 text-sm text-gray-500">{dataset.name}</p>}
        </div>

        <div>
          <label className="block mb-1 font-medium">Requirement file (optional)</label>
          <input
            type="file"
            accept=".txt,.pdf,.doc,.docx"
            onChange={(e) => setRequirement(e.target.files?.[0] ?? null)}
            className="w-full border rounded px-3 py-2"
          />
          {requirement && <p className="mt-1 text-sm text-gray-500">{requirement.name}</p>}
        </div>

        <div>
          <label className="block mb-1 font-medium">Customer Name</label>
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Customer name"
            className="w-full border rounded px-3 py-2"
          />
        </div>

        <div>
          <label className="block mb-1 font-medium">Response Number</label>
          <input
            type="text"
            value={responseNumber}
            onChange={(e) => setResponseNumber(e.target.value)}
            placeholder="Response number"
            className="w-full border rounded px-3 py-2"
          />
        </div>

        {uploadProgress > 0 && (
          <div>
            <p className="text-sm mb-1">Upload Progress: {uploadProgress}%</p>
            <div className="w-full bg-gray-200 rounded h-3">
              <div
                className="bg-green-500 h-3 rounded"
                style={{ width: `${uploadProgress}%` }}
              ></div>
            </div>
          </div>
        )}

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={!serverLive}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition disabled:opacity-50"
          >
            Send Files
          </button>
          <button
            type="button"
            onClick={() =>
              console.log({ code, dataset, requirement, customerName, responseNumber })
            }
            className="px-4 py-2 bg-gray-300 rounded hover:bg-gray-400 transition"
          >
            Debug: Show state
          </button>
        </div>
      </form>

      {/* Server updates */}
      <div className="mt-8">
        <h3 className="text-lg font-semibold mb-2">Server Updates:</h3>
        <div className="max-h-64 overflow-y-auto border rounded p-3 bg-gray-50">
          {update ? (
            <p>{update}</p>
          ) : (
            <p className="text-gray-500">No updates yet.</p>
          )}
          <div ref={updatesEndRef} />
        </div>
      </div>
    </div>
  );
};

export default Client;
