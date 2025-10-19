import { useState, useEffect } from "react";

const ClientPage = () => {
  const [code, setCode] = useState<File | null>(null);
  const [dataset, setDataset] = useState<File | null>(null);
  const [requirement, setRequirement] = useState<File | null>(null);

  const [customerName, setCustomerName] = useState("");
  const [responseNumber, setResponseNumber] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [serverLive, setServerLive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [latestUpdate, setLatestUpdate] = useState("");

  const baseurl = "http://localhost:5000";
  const token = localStorage.getItem("authToken") || "";

  const checkServerAvailability = async () => {
    try {
      const resp = await fetch(`${baseurl}/areyouthere`);
      const data = await resp.json();
      setServerLive(!!data.iamthere);
    } catch {
      setServerLive(false);
      alert("Server not available");
    }
  };

  useEffect(() => {
    checkServerAvailability();
  }, []);

  useEffect(() => {
    if (!serverLive || !customerId) return;
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`${baseurl}/getUpdate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ customerId }),
        });
        const data = await resp.json();
        if (Array.isArray(data.updates) && data.updates.length > 0) {
          const lastUpdate = data.updates[data.updates.length - 1].update;
          setLatestUpdate(lastUpdate);
        }
      } catch (err) {
        console.error("Polling failed:", err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [serverLive, customerId, token]);

  const sendFile = async () => {
    if (!serverLive) return alert("Server is not live.");
    if (!token) return alert("You must login first.");

    try {
      const files = new FormData();
      if (code) files.append("code", code);
      if (dataset) files.append("dataset", dataset);
      if (requirement) files.append("requirement", requirement);
      files.append("customername", customerName);
      files.append("respn", responseNumber);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${baseurl}/sendingpackage`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        setUploadProgress(0);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const respData = JSON.parse(xhr.responseText);
            if (respData.customerId) setCustomerId(respData.customerId);
            alert("Files sent successfully!");
          } catch (err) {
            console.error(err);
          }
        } else {
          alert(`Upload failed: ${xhr.status}`);
        }
      };
      xhr.send(files);
    } catch (err) {
      console.error(err);
    }
  };

  // Download ZIP of all results & usage
  const downloadResultsZip = async () => {
    if (!customerId) return alert("Please send files first.");
    try {
      const resp = await fetch(`${baseurl}/getresults/${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error("Failed to fetch ZIP");

      const blob = await resp.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `results_${customerId}.zip`;
      link.click();
    } catch (err) {
      console.error(err);
      alert("Failed to download ZIP");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="relative w-full max-w-3xl bg-white/60 backdrop-blur-md rounded-3xl p-10 shadow-2xl border border-gray-200/30 hover:shadow-3xl transition-all duration-300">
        <h2 className="text-3xl font-semibold text-gray-900 text-center mb-8">Send Package</h2>

        {/* Server Status */}
        <div className="flex items-center justify-between mb-6 p-4 bg-gray-50/50 rounded-xl border border-gray-200/40 shadow-sm">
          <button
            onClick={checkServerAvailability}
            className="px-5 py-2 bg-blue-600 text-white rounded-xl shadow-lg hover:bg-blue-700 hover:scale-105 transition transform"
          >
            Check Server
          </button>
          <span className={`font-medium ${serverLive ? "text-green-600" : "text-red-600"}`}>
            {serverLive ? "Server: Live" : "Server: Unknown"}
          </span>
        </div>

        {/* Form */}
        <form onSubmit={(e) => { e.preventDefault(); sendFile(); }} className="space-y-5">
          {["Code", "Dataset (Optional)", "Requirement (Optional)"].map((label, idx) => (
            <div key={idx} className="space-y-3">
              <label className="font-medium text-gray-700">{label} File</label>
              <input
                type="file"
                accept={
                  label.includes("Code") ? ".js,.py,.txt,.zip" :
                  label.includes("Dataset") ? ".csv,.json,.zip" : ".txt,.pdf,.doc,.docx"
                }
                onChange={(e) =>
                  idx === 0 ? setCode(e.target.files?.[0] ?? null) :
                  idx === 1 ? setDataset(e.target.files?.[0] ?? null) :
                  setRequirement(e.target.files?.[0] ?? null)
                }
                className="w-full p-3 border border-gray-300 rounded-xl hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
              />
            </div>
          ))}

          {["Customer Name", "Response Number"].map((label, idx) => (
            <div key={idx} className="space-y-3">
              <label className="font-medium text-gray-700">{label}</label>
              <input
                type="text"
                value={idx === 0 ? customerName : responseNumber}
                onChange={(e) => idx === 0 ? setCustomerName(e.target.value) : setResponseNumber(e.target.value)}
                className="w-full p-3 border border-gray-300 rounded-xl hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
              />
            </div>
          ))}

          {uploadProgress > 0 && (
            <div className="w-full bg-gray-200/30 h-3 rounded-xl overflow-hidden">
              <div
                className="bg-blue-600 h-3 transition-all duration-300 rounded-xl"
                style={{ width: `${uploadProgress}%` }}
              ></div>
            </div>
          )}

          <div className="flex gap-4 justify-center mt-3">
            <button
              type="submit"
              disabled={!serverLive}
              className="px-6 py-3 bg-green-600 text-white font-medium rounded-xl shadow-lg hover:bg-green-700 hover:scale-105 transition transform disabled:opacity-50"
            >
              Send Files
            </button>
            <button
              type="button"
              onClick={downloadResultsZip}
              className="px-6 py-3 bg-indigo-600 text-white font-medium rounded-xl shadow-lg hover:bg-indigo-700 hover:scale-105 transition transform"
            >
              Download All Results (ZIP)
            </button>
          </div>

        </form>

        {/* Latest Update */}
        <div className="mt-10 p-4 bg-gray-50/50 rounded-xl border border-gray-200/40 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-2">Latest Update:</h3>
          <p className="text-gray-600">{latestUpdate || "No updates yet."}</p>
        </div>
      </div>
    </div>
  );
};

export default ClientPage;
