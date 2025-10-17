// Client.jsx
import React, { useState, useRef } from "react";

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
      if (data.iamthere) {
        setServerLive(true);
        alert("Server is live");
      } else {
        setServerLive(false);
        alert(`Server responded with ${resp.status}`);
      }
    } catch (err) {
      setServerLive(false);
      alert("Server not available");
    }
  };

  // --- Fetch latest update from server ---
  const fetchUpdate = async () => {
    try {
      const resp = await fetch(`${baseurl}/whatsTheupdate`);
      const data = await resp.json();
      setUpdate(data.update); // server should send { update: "..." }
      // Auto-scroll
      updatesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      console.error("Failed to fetch update:", err);
      setUpdate("Failed to fetch update");
    }
  };

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
          alert("File sent successfully");
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
        {/* Code file */}
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

        {/* Dataset file */}
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

        {/* Requirement file */}
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

        {/* Customer name */}
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

        {/* Response number */}
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

        {/* Upload progress */}
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

        {/* Buttons */}
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
          <button
            type="button"
            onClick={fetchUpdate}
            disabled={!serverLive}
            className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 transition disabled:opacity-50"
          >
            Get Latest Update
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
