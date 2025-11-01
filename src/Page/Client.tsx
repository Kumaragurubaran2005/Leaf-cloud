import { useState, useEffect, useCallback, useRef } from "react";

interface Update {
  update: string;
  timestamp?: string;
  status?: "pending" | "completed" | "error" | "cancelled";
  isCompletion?: boolean;
  progress?: {
    submitted: number;
    total: number;
    percentage: number;
  };
}

interface FileValidationResult {
  isValid: boolean;
  error?: string;
}

type FileType = 'code' | 'dataset' | 'requirement';

// Custom hook for timer
const useTimer = (isActive: boolean) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isActive) {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    setElapsedSeconds(0);
    timerRef.current = window.setInterval(() => {
      setElapsedSeconds(s => s + 1);
    }, 1000);

    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isActive]);

  const reset = useCallback(() => {
    setElapsedSeconds(0);
  }, []);

  return { elapsedSeconds, reset };
};

// Custom hook for file validation
const useFileValidation = () => {
  const validateFile = useCallback((file: File, type: FileType): FileValidationResult => {
    const maxSize = 50 * 1024 * 1024; // 50MB
    
    if (file.size > maxSize) {
      return { isValid: false, error: `File size must be less than 50MB` };
    }
    
    const fileExtension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    
    switch (type) {
      case 'code':
        const codeExtensions = ['.js', '.py', '.txt', '.zip', '.java', '.cpp', '.c', '.html', '.css', '.php'];
        if (!codeExtensions.includes(fileExtension)) {
          return { isValid: false, error: `Invalid file type for code. Allowed: ${codeExtensions.join(', ')}` };
        }
        break;
        
      case 'dataset':
        const datasetExtensions = ['.csv', '.json', '.zip', '.xlsx', '.xls', '.tsv'];
        if (!datasetExtensions.includes(fileExtension)) {
          return { isValid: false, error: `Invalid file type for dataset. Allowed: ${datasetExtensions.join(', ')}` };
        }
        break;
        
      case 'requirement':
        const requirementExtensions = ['.txt', '.pdf', '.doc', '.docx', '.md'];
        if (!requirementExtensions.includes(fileExtension)) {
          return { isValid: false, error: `Invalid file type for requirements. Allowed: ${requirementExtensions.join(', ')}` };
        }
        break;
    }
    
    return { isValid: true };
  }, []);

  return { validateFile };
};

// Utility functions
const formatElapsedTime = (secs: number): string => {
  const h = Math.floor(secs / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((secs % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(secs % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
};

const createFormData = (
  code: File | null,
  dataset: File | null,
  requirement: File | null,
  customerName: string,
  responseNumber: string
): FormData => {
  const formData = new FormData();
  if (code) formData.append("code", code);
  if (dataset) formData.append("dataset", dataset);
  if (requirement) formData.append("requirement", requirement);
  formData.append("customername", customerName);
  formData.append("respn", responseNumber);
  return formData;
};

const getBaseUrl = (): string => {
  return "http://localhost:5000";
};

// API Service class
class ApiService {
  private baseurl: string;
  private token: string;

  constructor(baseurl: string, token: string) {
    this.baseurl = baseurl;
    this.token = token;
  }

  async checkServer(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseurl}/areyouthere`);
      const data = await resp.json();
      return !!data.iamthere;
    } catch {
      return false;
    }
  }

  async sendFiles(formData: FormData): Promise<{ customerId: string }> {
    const resp = await fetch(`${this.baseurl}/sendingpackage`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: formData,
    });
    
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Upload failed: ${resp.status}`);
    }
    
    return resp.json();
  }

  async getUpdates(customerId: string): Promise<{ updates: Update[], hasUpdates: boolean, isCompleted?: boolean, progress?: any }> {
    const resp = await fetch(`${this.baseurl}/getUpdate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ customerId }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Failed to fetch updates: ${resp.status}`);
    }

    return resp.json();
  }

  async cancelJob(customerId: string): Promise<void> {
    const resp = await fetch(`${this.baseurl}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ cancel: true, customerId }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Cancel failed: ${resp.status}`);
    }
  }

  async downloadResults(customerId: string): Promise<Blob> {
    const resp = await fetch(`${this.baseurl}/getresults/${customerId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Download failed: ${resp.status}`);
    }

    return resp.blob();
  }

  async getTaskStatus(customerId: string): Promise<{ 
    isCompleted: boolean; 
    isCancelled: boolean; 
    progress: { submitted: number; total: number; percentage: number };
    isReadyForDownload: boolean;
  }> {
    const resp = await fetch(`${this.baseurl}/taskstatus/${customerId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Failed to fetch task status: ${resp.status}`);
    }

    return resp.json();
  }
}

// Subcomponents
const FileUploadForm: React.FC<{
  code: File | null;
  dataset: File | null;
  requirement: File | null;
  responseNumber: string;
  onFileChange: (file: File | null, type: FileType) => void;
  onResponseNumberChange: (value: string) => void;
  onValidateFile: (file: File, type: FileType) => FileValidationResult;
}> = ({ code, dataset, requirement, responseNumber, onFileChange, onResponseNumberChange, onValidateFile }) => {
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>, type: FileType) => {
    const file = event.target.files?.[0] || null;
    
    if (file) {
      const validation = onValidateFile(file, type);
      if (!validation.isValid) {
        alert(validation.error);
        event.target.value = '';
        return;
      }
    }
    
    onFileChange(file, type);
  };

  const getAcceptString = (type: FileType): string => {
    switch (type) {
      case 'code':
        return '.js,.py,.txt,.zip,.java,.cpp,.c,.html,.css,.php';
      case 'dataset':
        return '.csv,.json,.zip,.xlsx,.xls,.tsv';
      case 'requirement':
        return '.txt,.pdf,.doc,.docx,.md';
      default:
        return '';
    }
  };

  const getLabel = (type: FileType): string => {
    switch (type) {
      case 'code':
        return 'Code File';
      case 'dataset':
        return 'Dataset (Optional)';
      case 'requirement':
        return 'Requirement (Optional)';
      default:
        return '';
    }
  };

  return (
    <div className="space-y-5">
      {(['code', 'dataset', 'requirement'] as FileType[]).map((type) => (
        <div key={type} className="space-y-2">
          <label className="font-medium text-gray-700">{getLabel(type)}</label>
          <input
            type="file"
            accept={getAcceptString(type)}
            onChange={(e) => handleFileChange(e, type)}
            className="w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-300 focus:border-blue-500 transition-colors"
          />
          {type === 'code' && !code && (
            <p className="text-sm text-red-500">Code file is required</p>
          )}
        </div>
      ))}

      <div className="space-y-2">
        <label className="font-medium text-gray-700">No. of Responders</label>
        <input
          type="number"
          min={1}
          max={10}
          value={responseNumber}
          onChange={(e) => onResponseNumberChange(e.target.value.replace(/\D/g, ""))}
          className="w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-300 focus:border-blue-500 transition-colors"
          placeholder="Enter number of responders"
        />
      </div>
    </div>
  );
};

const ControlButtons: React.FC<{
  isUploading: boolean;
  isCompleted: boolean;
  isCancelling: boolean;
  isCancelled: boolean;
  hasCustomerId: boolean;
  serverLive: boolean;
  onSendFiles: () => void;
  onCancel: () => void;
  onDownload: () => void;
}> = ({
  isUploading,
  isCompleted,
  isCancelling,
  isCancelled,
  hasCustomerId,
  serverLive,
  onSendFiles,
  onCancel,
  onDownload,
}) => {
  return (
    <div className="flex gap-3 flex-wrap">
      <button
        type="button"
        onClick={onSendFiles}
        disabled={!serverLive || isUploading}
        className="px-6 py-3 bg-green-600 text-white rounded-xl hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-md"
      >
        {isUploading ? "Uploading..." : "Send Files"}
      </button>

      <button
        type="button"
        onClick={onCancel}
        disabled={!hasCustomerId || isCompleted || isUploading || isCancelling || isCancelled}
        className="px-6 py-3 bg-red-600 text-white rounded-xl hover:bg-red-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-md"
      >
        {isCancelling ? "Cancelling..." : "Cancel"}
      </button>

      <button
        type="button"
        onClick={onDownload}
        disabled={!isCompleted || isCancelled}
        className="px-6 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-md"
      >
        Download All Results (ZIP)
      </button>
    </div>
  );
};

const UpdatesList: React.FC<{
  updates: Update[];
  currentProgress?: { submitted: number; total: number; percentage: number };
}> = ({ updates, currentProgress }) => {
  return (
    <div className="mt-8 p-6 bg-gray-50 rounded-xl border border-gray-200">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-lg text-gray-800">Job Updates:</h3>
        {currentProgress && (
          <div className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium">
            Progress: {currentProgress.submitted}/{currentProgress.total} ({currentProgress.percentage}%)
          </div>
        )}
      </div>
      
      <div className="max-h-64 overflow-y-auto">
        {updates.length === 0 ? (
          <p className="text-gray-600 text-center py-4">No updates yet. Updates will appear here once the job starts.</p>
        ) : (
          <ul className="space-y-3">
            {[...updates].reverse().map((update, idx) => (
              <li 
                key={`${update.timestamp}-${idx}`} 
                className={`p-4 rounded-xl shadow-sm border transition-shadow ${
                  update.isCompletion 
                    ? 'bg-green-50 border-green-200 hover:shadow-md' 
                    : update.status === 'cancelled'
                    ? 'bg-red-50 border-red-200 hover:shadow-md'
                    : 'bg-white border-gray-200 hover:shadow-md'
                }`}
              >
                <div className="flex items-start gap-3">
                  {update.isCompletion && (
                    <div className="text-green-500 text-xl mt-1">🎉</div>
                  )}
                  {update.status === 'cancelled' && (
                    <div className="text-red-500 text-xl mt-1">❌</div>
                  )}
                  <div className="flex-1">
                    <p className={`font-medium ${
                      update.isCompletion ? 'text-green-800' : 
                      update.status === 'cancelled' ? 'text-red-800' : 
                      'text-gray-700'
                    }`}>
                      {update.update}
                    </p>
                    {update.timestamp && (
                      <p className="text-xs text-gray-400 mt-2">
                        {new Date(update.timestamp).toLocaleString()}
                      </p>
                    )}
                    {update.progress && (
                      <div className="mt-2">
                        <div className="w-full bg-gray-200 rounded-full h-2">
                          <div 
                            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${update.progress.percentage}%` }}
                          ></div>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          {update.progress.submitted}/{update.progress.total} workers completed
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const ServerStatus: React.FC<{
  serverLive: boolean;
  isCheckingServer: boolean;
  onCheckServer: () => void;
}> = ({
  serverLive,
  isCheckingServer,
  onCheckServer,
}) => {
  return (
    <div className="flex items-center justify-between mb-6 p-4 bg-gray-100 rounded-xl border border-gray-200">
      <button
        onClick={onCheckServer}
        disabled={isCheckingServer}
        className="px-5 py-2 bg-blue-600 text-white rounded-xl shadow hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {isCheckingServer ? "Checking..." : "Check Server"}
      </button>
      <div className="flex items-center gap-3">
        <div className={`w-3 h-3 rounded-full ${serverLive ? 'bg-green-500' : 'bg-red-500'} animate-pulse`}></div>
        <span className={`font-medium ${serverLive ? "text-green-600" : "text-red-600"}`}>
          {serverLive ? "Server: Live" : "Server: Offline"}
        </span>
      </div>
    </div>
  );
};

// Main ClientPage Component
const ClientPage = () => {
  // State
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
  const [isCheckingServer, setIsCheckingServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEndedPopup, setShowEndedPopup] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const [currentProgress, setCurrentProgress] = useState<{ submitted: number; total: number; percentage: number } | null>(null);

  // Hooks
  const { elapsedSeconds, reset: resetTimer } = useTimer(!!customerId && !isCompleted && !isCancelled);
  const { validateFile } = useFileValidation();

  // Refs
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Constants
  const baseurl = getBaseUrl();
  const token = localStorage.getItem("authToken") || "";
  const apiService = new ApiService(baseurl, token);

  // Initialize customer name
  useEffect(() => {
    const cn = localStorage.getItem("username") || "";
    setCustomerName(cn);
  }, []);

  // Check server availability
  const checkServerAvailability = async () => {
    setIsCheckingServer(true);
    setError(null);
    try {
      const isLive = await apiService.checkServer();
      setServerLive(isLive);
    } catch (err) {
      setServerLive(false);
      setError("Failed to connect to server");
      console.error("Server check failed:", err);
    } finally {
      setIsCheckingServer(false);
    }
  };

  useEffect(() => {
    checkServerAvailability();
  }, []);

  // Fetch updates from server - ENHANCED
  const fetchUpdates = useCallback(async () => {
    if (!serverLive || !customerId) return;

    try {
      const data = await apiService.getUpdates(customerId);
      
      if (Array.isArray(data.updates)) {
        setUpdates((prev) => {
          const newUpdates = data.updates.filter(
            (u: Update) => !prev.some((p) => p.update === u.update && p.timestamp === u.timestamp)
          );
          
          // Check for completion updates
          const hasCompletionUpdate = newUpdates.some(u => u.isCompletion || u.update.includes('TASK COMPLETED'));
          if (hasCompletionUpdate) {
            setIsCompleted(true);
          }
          
          return [...prev, ...newUpdates];
        });
      }

      // Update progress from response
      if (data.progress) {
        setCurrentProgress(data.progress);
      }

      // Update completion status from response
      if (data.isCompleted) {
        setIsCompleted(true);
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }

    } catch (err) {
      console.error("Polling failed:", err);
      setError("Failed to fetch updates");
    }
  }, [serverLive, customerId]);

  // Check task status independently
  const checkTaskStatus = useCallback(async () => {
    if (!customerId) return;
    
    try {
      const status = await apiService.getTaskStatus(customerId);
      setIsCompleted(status.isCompleted);
      setIsCancelled(status.isCancelled);
      setCurrentProgress(status.progress);
      
      if (status.isCompleted && pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    } catch (err) {
      console.error("Status check failed:", err);
    }
  }, [customerId]);

  // Start polling when customerId is set
  useEffect(() => {
    if (customerId && !isCompleted && !isCancelled) {
      // Clear any existing polling
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
      
      // Execute immediately
      fetchUpdates();
      checkTaskStatus();
      
      // Then set interval for updates
      pollingRef.current = setInterval(() => {
        fetchUpdates();
      }, 3000);
      
      // Check status less frequently
      const statusInterval = setInterval(checkTaskStatus, 10000);
      
      return () => {
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
        clearInterval(statusInterval);
      };
    }
    
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [customerId, isCompleted, isCancelled, fetchUpdates, checkTaskStatus]);

  // Upload files
  const sendFile = async () => {
    if (!serverLive) {
      alert("Server is not live.");
      return;
    }
    
    if (!token) {
      alert("You must login first.");
      return;
    }

    if (!code) {
      alert("Code file is required.");
      return;
    }

    const files = createFormData(code, dataset, requirement, customerName, responseNumber);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${baseurl}/sendingpackage`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    
    setIsUploading(true);
    setIsCompleted(false);
    setIsCancelled(false);
    setError(null);
    setUpdates([]);
    setCurrentProgress(null);
    setCustomerId("");
    resetTimer();

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUploadProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      setUploadProgress(0);
      setIsUploading(false);
      
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const respData = JSON.parse(xhr.responseText);
          if (respData.customerId) {
            setCustomerId(respData.customerId);
          }
          alert("Files sent successfully! The job is now processing.");
          
          // Clear form
          setCode(null);
          setDataset(null);
          setRequirement(null);
          setResponseNumber("1");
        } catch (err) {
          console.error("Parse error:", err);
          setError("Failed to parse server response");
        }
      } else {
        setError(`Upload failed: ${xhr.status}`);
        alert(`Upload failed: ${xhr.status}`);
      }
    };

    xhr.onerror = () => {
      setIsUploading(false);
      setUploadProgress(0);
      setError("Upload failed due to network error");
      alert("Upload failed due to network error");
    };

    xhr.send(files);
  };

  // Cancel handler
  const handleCancel = async () => {
    if (!customerId) {
      alert("No active job to cancel.");
      return;
    }
    
    if (!serverLive) {
      alert("Server not available.");
      return;
    }

    if (!token) {
      alert("You must login first.");
      return;
    }

    if (!confirm("Are you sure you want to cancel this job?")) return;

    setIsCancelling(true);
    setError(null);
    
    try {
      await apiService.cancelJob(customerId);

      // Mark cancelled
      setIsCancelled(true);
      setIsCompleted(false);
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }

      // Update updates list - FIXED: Now uses proper Update type
      setUpdates((prev) => [
        ...prev,
        { 
          update: "❌ TASK CANCELLED by user. No results will be available.", 
          timestamp: new Date().toISOString(), 
          status: "cancelled" as const
        },
      ]);

      setShowEndedPopup(true);
    } catch (err) {
      console.error("Cancel failed:", err);
      const errorMessage = err instanceof Error ? err.message : "Cancel failed";
      setError(errorMessage);
      alert(`Cancel failed: ${errorMessage}`);
    } finally {
      setIsCancelling(false);
    }
  };

  // Download ZIP of all results & usage
  const downloadResultsZip = async () => {
    if (!customerId) {
      alert("Please send files first.");
      return;
    }
    
    if (isCancelled) {
      alert("Job was cancelled — no results to download.");
      return;
    }
    
    try {
      const blob = await apiService.downloadResults(customerId);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `results_${customerId}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      console.error("Download failed:", err);
      const errorMessage = err instanceof Error ? err.message : "Download failed";
      setError(errorMessage);
      alert(`Failed to download ZIP: ${errorMessage}`);
    }
  };

  // Handle file change
  const handleFileChange = (file: File | null, type: FileType) => {
    switch (type) {
      case 'code':
        setCode(file);
        break;
      case 'dataset':
        setDataset(file);
        break;
      case 'requirement':
        setRequirement(file);
        break;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-8">
      <div className="w-full max-w-4xl p-8 bg-white rounded-3xl shadow-2xl border border-gray-200/30">
        <h2 className="text-3xl font-bold text-center mb-2 text-gray-800">Send Package</h2>
        <p className="text-center text-gray-600 mb-8">Upload your code and data for processing</p>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl">
            <p className="text-red-700 font-medium">Error: {error}</p>
          </div>
        )}

        {/* Completion Banner */}
        {isCompleted && !isCancelled && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-xl animate-pulse">
            <div className="flex items-center gap-3">
              <div className="text-green-500 text-2xl">🎉</div>
              <div>
                <p className="text-green-800 font-semibold">Task Completed Successfully!</p>
                <p className="text-green-600 text-sm">Your results are ready for download.</p>
              </div>
            </div>
          </div>
        )}

        {/* Cancellation Banner */}
        {isCancelled && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="text-red-500 text-2xl">❌</div>
              <div>
                <p className="text-red-800 font-semibold">Task Cancelled</p>
                <p className="text-red-600 text-sm">The job has been cancelled. No results will be available.</p>
              </div>
            </div>
          </div>
        )}

        {/* Server Status */}
        <ServerStatus
          serverLive={serverLive}
          isCheckingServer={isCheckingServer}
          onCheckServer={checkServerAvailability}
        />

        {/* Upload Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendFile();
          }}
          className="space-y-6"
        >
          <FileUploadForm
            code={code}
            dataset={dataset}
            requirement={requirement}
            responseNumber={responseNumber}
            onFileChange={handleFileChange}
            onResponseNumberChange={setResponseNumber}
            onValidateFile={validateFile}
          />

          {/* Upload Progress */}
          {uploadProgress > 0 && (
            <div className="w-full bg-gray-200 h-3 rounded-xl overflow-hidden">
              <div 
                className="bg-blue-600 h-3 rounded-xl transition-all duration-300" 
                style={{ width: `${uploadProgress}%` }}
              ></div>
              <p className="text-sm text-gray-600 mt-2 text-center">
                Uploading: {uploadProgress}%
              </p>
            </div>
          )}

          {/* Job Info & Controls */}
          <div className="flex items-center justify-between gap-4 mt-6 p-4 bg-blue-50 rounded-xl border border-blue-200">
            <div className="space-y-2">
              <p className="text-sm text-gray-700">
                <span className="font-semibold">Job ID:</span>{" "}
                <span className="font-mono bg-white px-2 py-1 rounded border">
                  {customerId || "—"}
                </span>
              </p>
              <p className="text-sm text-gray-700">
                <span className="font-semibold">Elapsed Time:</span>{" "}
                <span className="font-mono bg-white px-2 py-1 rounded border">
                  {formatElapsedTime(elapsedSeconds)}
                </span>
              </p>
              {currentProgress && (
                <p className="text-sm text-gray-700">
                  <span className="font-semibold">Progress:</span>{" "}
                  <span className="font-mono bg-white px-2 py-1 rounded border">
                    {currentProgress.submitted}/{currentProgress.total} workers
                  </span>
                </p>
              )}
            </div>

            <ControlButtons
              isUploading={isUploading}
              isCompleted={isCompleted}
              isCancelling={isCancelling}
              isCancelled={isCancelled}
              hasCustomerId={!!customerId}
              serverLive={serverLive}
              onSendFiles={sendFile}
              onCancel={handleCancel}
              onDownload={downloadResultsZip}
            />
          </div>
        </form>

        {/* Updates List */}
        <UpdatesList updates={updates} currentProgress={currentProgress || undefined} />
      </div>

      {/* Ended Popup */}
      {showEndedPopup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 text-center shadow-2xl">
            <h4 className="text-xl font-semibold mb-4 text-gray-800">Job Ended</h4>
            <p className="mb-4 text-gray-600">
              {isCancelled ? "The job has been cancelled." : "The job has been completed."}
            </p>
            <button
              onClick={() => setShowEndedPopup(false)}
              className="px-5 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-medium"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ClientPage;