import { useState, useEffect, useCallback } from "react";

interface Update {
  update: string;
  timestamp?: string;
  status?: "pending" | "completed" | "error";
}

const ClientPage = () => {
  const [code, setCode] = useState<File | null>(null);
  const [dataset, setDataset] = useState<File | null>(null);
  const [requirement, setRequirement] = useState<File | null>(null);

  const [customerName, setCustomerName] = useState("");
  const [responseNumber, setResponseNumber] = useState("1");
  const [customerId, setCustomerId] = useState("");
  const [serverLive, setServerLive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);

  const baseurl = "http://localhost:5000";
  const token = localStorage.getItem("authToken") || "";

  // Initialize customer name
  useEffect(() => {
    const cn = localStorage.getItem("username") || "";
    setCustomerName(cn);
  }, []);

  // Check server availability
  const checkServerAvailability = async () => {
    try {
      const resp = await fetch(`${baseurl}/areyouthere`);
      const data = await resp.json();
      setServerLive(!!data.iamthere);
    } catch {
      setServerLive(false);
      console.warn("Server not available");
    }
  };

  useEffect(() => {
    checkServerAvailability();
  }, []);

  // Fetch updates from server
  const fetchUpdates = useCallback(async () => {
    if (!serverLive || !customerId) return;

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
      if (Array.isArray(data.updates)) {
        setUpdates((prev) => {
          const newUpdates = data.updates.filter(
            (u: Update) => !prev.some((p) => p.update === u.update)
          );
          return [...prev, ...newUpdates];
        });

        const lastUpdate = data.updates[data.updates.length - 1];
        if (lastUpdate && lastUpdate.update.toLowerCase() === "completed") {
          setIsCompleted(true);
        }
      }
    } catch (err) {
      console.error("Polling failed:", err);
    }
  }, [serverLive, customerId, token]);

  // Poll updates every 3 seconds
  useEffect(() => {
    if (!serverLive || !customerId) return;
    const interval = setInterval(fetchUpdates, 3000);
    return () => clearInterval(interval);
  }, [serverLive, customerId, fetchUpdates]);

  // Upload files
  const sendFile = async () => {
    if (!serverLive) return alert("Server is not live.");
    if (!token) return alert("You must login first.");

    const files = new FormData();
    if (code) files.append("code", code);
    if (dataset) files.append("dataset", dataset);
    if (requirement) files.append("requirement", requirement);
    files.append("customername", customerName);
    files.append("respn", responseNumber);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${baseurl}/sendingpackage`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    setIsUploading(true);
    setIsCompleted(false);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        setUploadProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      setUploadProgress(0);
      setIsUploading(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const respData = JSON.parse(xhr.responseText);
          if (respData.customerId) setCustomerId(respData.customerId);
          alert("Files sent successfully!");
          setCode(null);
          setDataset(null);
          setRequirement(null);
        } catch (err) {
          console.error(err);
        }
      } else {
        alert(`Upload failed: ${xhr.status}`);
      }
    };

    xhr.onerror = () => {
      setIsUploading(false);
      alert("Upload failed due to network error");
    };

    xhr.send(files);
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-4xl p-8 bg-white rounded-3xl shadow-2xl border border-gray-200/30">
        <h2 className="text-3xl font-semibold text-center mb-6">Send Package</h2>

        {/* Server Status */}
        <div className="flex items-center justify-between mb-6 p-4 bg-gray-100 rounded-xl border border-gray-200">
          <button
            onClick={checkServerAvailability}
            className="px-5 py-2 bg-blue-600 text-white rounded-xl shadow hover:bg-blue-700 transition"
          >
            Check Server
          </button>
          <span
            className={`font-medium ${
              serverLive ? "text-green-600" : "text-red-600"
            }`}
          >
            {serverLive ? "Server: Live" : "Server: Unknown"}
          </span>
        </div>

        {/* Upload Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendFile();
          }}
          className="space-y-5"
        >
          {["Code", "Dataset (Optional)", "Requirement (Optional)"].map(
            (label, idx) => (
              <div key={idx} className="space-y-2">
                <label className="font-medium">{label} File</label>
                <input
                  type="file"
                  accept={
                    label.includes("Code")
                      ? ".js,.py,.txt,.zip"
                      : label.includes("Dataset")
                      ? ".csv,.json,.zip"
                      : ".txt,.pdf,.doc,.docx"
                  }
                  onChange={(e) =>
                    idx === 0
                      ? setCode(e.target.files?.[0] ?? null)
                      : idx === 1
                      ? setDataset(e.target.files?.[0] ?? null)
                      : setRequirement(e.target.files?.[0] ?? null)
                  }
                  className="w-full p-3 border rounded-xl focus:ring-2 focus:ring-blue-300"
                />
              </div>
            )
          )}

          <div className="space-y-2">
            <label className="font-medium">No. of Responders</label>
            <input
              type="number"
              min={1}
              value={responseNumber}
              onChange={(e) =>
                setResponseNumber(e.target.value.replace(/\D/g, ""))
              }
              className="w-full p-3 border rounded-xl focus:ring-2 focus:ring-blue-300"
            />
          </div>

          {uploadProgress > 0 && (
            <div className="w-full bg-gray-200 h-3 rounded-xl overflow-hidden">
              <div
                className="bg-blue-600 h-3 rounded-xl transition-all"
                style={{ width: `${uploadProgress}%` }}
              ></div>
            </div>
          )}

          <div className="flex gap-4 justify-center mt-4">
            <button
              type="submit"
              disabled={!serverLive || isUploading}
              className="px-6 py-3 bg-green-600 text-white rounded-xl hover:bg-green-700 transition disabled:opacity-50"
            >
              {isUploading ? "Uploading..." : "Send Files"}
            </button>
            <button
              type="button"
              onClick={downloadResultsZip}
              disabled={!isCompleted}
              className={`px-6 py-3 text-white rounded-xl transition ${
                isCompleted
                  ? "bg-indigo-600 hover:bg-indigo-700"
                  : "bg-gray-400 cursor-not-allowed"
              }`}
            >
              Download All Results (ZIP)
            </button>
          </div>
        </form>

        {/* Updates List */}
        <div className="mt-8 p-4 bg-gray-100 rounded-xl border border-gray-200 max-h-64 overflow-y-auto">
          <h3 className="font-semibold mb-3">Updates:</h3>
          {updates.length === 0 ? (
            <p className="text-gray-600">No updates yet.</p>
          ) : (
            <ul className="space-y-2">
              {[...updates].reverse().map((u, idx) => (
                <li
                  key={idx}
                  className="p-2 bg-white rounded-xl shadow-sm border border-gray-200"
                >
                  <p className="text-gray-700">{u.update}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default ClientPage;
