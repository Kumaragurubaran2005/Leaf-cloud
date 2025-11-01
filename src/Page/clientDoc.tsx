import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

interface ClientDocument {
  customerId: string;
  customerName: string;
  numWorkers: number;
  documents: {
    inputFiles: {
      code: {
        available: boolean;
        size: number;
        downloadUrl: string;
      };
      dataset: {
        available: boolean;
        size: number;
        downloadUrl: string;
      };
      requirement: {
        available: boolean;
        size: number;
        downloadUrl: string;
      };
    };
    usageStats: {
      totalRecords: number;
      workers: string[];
      summary: {
        avgCpu: number;
        avgMemory: number;
        avgExecutionTime: number;
      };
      data: Array<{
        workerId: string;
        taskId: string;
        cpuUsage: number;
        memoryUsage: number;
        executionTime: number;
        timestamp: string;
        rawUsageData: string;
      }>;
    };
    outputFiles: Array<{
      workerId: string;
      files: Array<{
        name: string;
        size: number;
      }>;
    }>;
    taskStatus: any;
  };
  downloadOptions: {
    allFiles: string;
    inputFilesOnly: string;
    resultsOnly: string;
    usageReport: string;
  };
}

interface ClientSummary {
  customerId: string;
  customerName: string;
  numWorkers: number;
  files: {
    code: boolean;
    dataset: boolean;
    requirement: boolean;
  };
  totalSize: number;
  documentsUrl: string;
  downloadUrl: string;
}

class ApiService {
  private baseurl: string;
  private token: string;

  constructor(baseurl: string, token: string) {
    this.baseurl = baseurl;
    this.token = token;
  }

  async getAllClients(): Promise<{ clients: ClientSummary[] }> {
    const resp = await fetch(`${this.baseurl}/admin/clients`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Failed to fetch clients: ${resp.status}`);
    }

    return resp.json();
  }

  async getClientDocuments(customerId: string): Promise<ClientDocument> {
    const resp = await fetch(`${this.baseurl}/client/documents/${customerId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Failed to fetch client documents: ${resp.status}`);
    }

    return resp.json();
  }

  async deleteClientDocuments(customerId: string): Promise<{ success: boolean; message: string }> {
    const resp = await fetch(`${this.baseurl}/client/documents/${customerId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Failed to delete client documents: ${resp.status}`);
    }

    return resp.json();
  }

  async downloadAllDocuments(customerId: string): Promise<Blob> {
    const resp = await fetch(`${this.baseurl}/client/documents/${customerId}/download/all`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Download failed: ${resp.status}`);
    }

    return resp.blob();
  }

  async downloadInputFiles(customerId: string): Promise<Blob> {
    const resp = await fetch(`${this.baseurl}/client/documents/${customerId}/download/inputs`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Download failed: ${resp.status}`);
    }

    return resp.blob();
  }

  async downloadUsageReport(customerId: string, format: string = 'csv'): Promise<Blob> {
    const resp = await fetch(`${this.baseurl}/client/documents/${customerId}/download/usage?format=${format}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(errorText || `Download failed: ${resp.status}`);
    }

    return resp.blob();
  }
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const getBaseUrl = (): string => {
  return "http://localhost:5000";
};

// Delete Confirmation Modal Component
const DeleteConfirmationModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  clientName: string;
  clientId: string;
  loading: boolean;
}> = ({ isOpen, onClose, onConfirm, clientName, clientId, loading }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
            <span className="text-red-600 text-xl">⚠️</span>
          </div>
          <h3 className="text-lg font-semibold text-gray-800">Delete Client Documents</h3>
        </div>
        
        <div className="mb-6">
          <p className="text-gray-600 mb-2">
            Are you sure you want to delete all documents for <strong>{clientName}</strong>?
          </p>
          <p className="text-sm text-gray-500">Client ID: {clientId}</p>
          <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700 font-medium">⚠️ This action cannot be undone!</p>
            <p className="text-xs text-red-600 mt-1">
              All uploaded files, usage data, and results will be permanently deleted.
            </p>
          </div>
        </div>

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Deleting...
              </>
            ) : (
              'Delete Documents'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// Client List Component
const ClientList: React.FC<{
  clients: ClientSummary[];
  onSelectClient: (clientId: string) => void;
  onDeleteClient: (clientId: string, clientName: string) => void;
  loading: boolean;
  deletingClientId: string | null;
}> = ({ clients, onSelectClient, onDeleteClient, loading, deletingClientId }) => {
  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="text-gray-600 mt-4">Loading clients...</p>
      </div>
    );
  }

  if (clients.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="text-gray-400 text-6xl mb-4">📁</div>
        <h3 className="text-xl font-semibold text-gray-600 mb-2">No Clients Found</h3>
        <p className="text-gray-500">No client documents have been uploaded yet.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {clients.map((client) => (
        <div key={client.customerId} className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
          <div className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-semibold text-gray-800 truncate">{client.customerName}</h3>
                <p className="text-sm text-gray-500 mt-1">ID: {client.customerId}</p>
              </div>
              <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-medium">
                {client.numWorkers} workers
              </span>
            </div>

            <div className="space-y-3 mb-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Code File</span>
                <span className={`px-2 py-1 rounded text-xs ${
                  client.files.code ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  {client.files.code ? 'Available' : 'Missing'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Dataset</span>
                <span className={`px-2 py-1 rounded text-xs ${
                  client.files.dataset ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  {client.files.dataset ? 'Available' : 'Missing'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Requirements</span>
                <span className={`px-2 py-1 rounded text-xs ${
                  client.files.requirement ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  {client.files.requirement ? 'Available' : 'Missing'}
                </span>
              </div>
            </div>

            <div className="flex justify-between items-center pt-4 border-t border-gray-200">
              <span className="text-sm text-gray-500">
                Total: {formatFileSize(client.totalSize)}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => onSelectClient(client.customerId)}
                  className="px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium"
                >
                  View
                </button>
                <button
                  onClick={() => onDeleteClient(client.customerId, client.customerName)}
                  disabled={deletingClientId === client.customerId}
                  className="px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm font-medium disabled:opacity-50 flex items-center gap-1"
                >
                  {deletingClientId === client.customerId ? (
                    <>
                      <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      Deleting...
                    </>
                  ) : (
                    'Delete'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// Client Details Component
const ClientDetails: React.FC<{
  clientId: string;
  clientName: string;
  onBack: () => void;
  onDelete: (clientId: string, clientName: string) => void;
  apiService: ApiService;
  deleting: boolean;
}> = ({ clientId, clientName, onBack, onDelete, apiService, deleting }) => {
  const [documents, setDocuments] = useState<ClientDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    loadDocuments();
  }, [clientId]);

  const loadDocuments = async () => {
    setLoading(true);
    setError(null);
    try {
      const docs = await apiService.getClientDocuments(clientId);
      setDocuments(docs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
      console.error('Error loading documents:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    try {
      await onDelete(clientId, clientName);
      setShowDeleteModal(false);
      onBack(); // Go back to list after successful deletion
    } catch (err) {
      // Error is handled in the parent component
      setShowDeleteModal(false);
    }
  };

  const downloadAllDocuments = async () => {
    try {
      const blob = await apiService.downloadAllDocuments(clientId);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `client_documents_${clientId}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      alert(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const downloadInputFiles = async () => {
    try {
      const blob = await apiService.downloadInputFiles(clientId);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `input_files_${clientId}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      alert(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const downloadUsageReport = async (format: string) => {
    try {
      const blob = await apiService.downloadUsageReport(clientId, format);
      const extension = format === 'json' ? 'json' : 'csv';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `usage_report_${clientId}.${extension}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      alert(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="text-gray-600 mt-4">Loading client documents...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <div className="text-red-400 text-6xl mb-4">❌</div>
        <h3 className="text-xl font-semibold text-red-600 mb-2">Error Loading Documents</h3>
        <p className="text-red-500 mb-4">{error}</p>
        <button
          onClick={onBack}
          className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition"
        >
          Back to List
        </button>
      </div>
    );
  }

  if (!documents) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-800 transition mb-4"
          >
            <span>←</span>
            <span>Back to Clients</span>
          </button>
          <h2 className="text-2xl font-bold text-gray-800">{documents.customerName}</h2>
          <p className="text-gray-600">Client ID: {documents.customerId}</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={loadDocuments}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowDeleteModal(true)}
            disabled={deleting}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm disabled:opacity-50 flex items-center gap-2"
          >
            {deleting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Deleting...
              </>
            ) : (
              'Delete All'
            )}
          </button>
          <button
            onClick={downloadAllDocuments}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm"
          >
            Download All
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-blue-50 p-4 rounded-lg">
          <div className="text-2xl font-bold text-blue-600">{documents.numWorkers}</div>
          <div className="text-sm text-blue-800">Workers</div>
        </div>
        <div className="bg-green-50 p-4 rounded-lg">
          <div className="text-2xl font-bold text-green-600">
            {Object.values(documents.documents.inputFiles).filter(f => f.available).length}/3
          </div>
          <div className="text-sm text-green-800">Input Files</div>
        </div>
        <div className="bg-purple-50 p-4 rounded-lg">
          <div className="text-2xl font-bold text-purple-600">
            {documents.documents.usageStats.totalRecords}
          </div>
          <div className="text-sm text-purple-800">Usage Records</div>
        </div>
        <div className="bg-orange-50 p-4 rounded-lg">
          <div className="text-2xl font-bold text-orange-600">
            {documents.documents.outputFiles.length}
          </div>
          <div className="text-sm text-orange-800">Workers with Output</div>
        </div>
      </div>

      {/* Input Files Section */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-800">Input Files</h3>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Object.entries(documents.documents.inputFiles).map(([key, fileInfo]) => (
              <div key={key} className="border border-gray-200 rounded-lg p-4">
                <div className="flex justify-between items-start mb-2">
                  <span className="font-medium text-gray-700 capitalize">{key}</span>
                  <span className={`px-2 py-1 rounded text-xs ${
                    fileInfo.available ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {fileInfo.available ? 'Available' : 'Not Available'}
                  </span>
                </div>
                
              </div>
            ))}
          </div>
          <div className="mt-4">
            <button
              onClick={downloadInputFiles}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition text-sm"
            >
              Download All Input Files as ZIP
            </button>
          </div>
        </div>
      </div>

      {/* Usage Statistics Section */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-800">Usage Statistics</h3>
        </div>
        <div className="p-6">
          {documents.documents.usageStats.totalRecords > 0 ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                <div className="text-center p-3 bg-blue-50 rounded-lg">
                  <p className="text-2xl font-bold text-blue-600">{documents.documents.usageStats.totalRecords}</p>
                  <p className="text-sm text-gray-600">Total Records</p>
                </div>
                <div className="text-center p-3 bg-green-50 rounded-lg">
                  <p className="text-2xl font-bold text-green-600">{documents.documents.usageStats.workers.length}</p>
                  <p className="text-sm text-gray-600">Workers</p>
                </div>
                <div className="text-center p-3 bg-purple-50 rounded-lg">
                  <p className="text-2xl font-bold text-purple-600">
                    {documents.documents.usageStats.summary.avgCpu.toFixed(1)}%
                  </p>
                  <p className="text-sm text-gray-600">Avg CPU</p>
                </div>
                <div className="text-center p-3 bg-orange-50 rounded-lg">
                  <p className="text-2xl font-bold text-orange-600">
                    {documents.documents.usageStats.summary.avgMemory.toFixed(1)} MB
                  </p>
                  <p className="text-sm text-gray-600">Avg Memory</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => downloadUsageReport('csv')}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm"
                >
                  Download CSV Report
                </button>
                <button
                  onClick={() => downloadUsageReport('json')}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm"
                >
                  Download JSON Report
                </button>
              </div>
            </>
          ) : (
            <p className="text-gray-600 text-center py-4">No usage data available</p>
          )}
        </div>
      </div>

      {/* Output Files Section */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-800">Output Files</h3>
        </div>
        <div className="p-6">
          {documents.documents.outputFiles.length > 0 ? (
            <div className="space-y-4">
              {documents.documents.outputFiles.map((worker) => (
                <div key={worker.workerId} className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-700 mb-3">Worker: {worker.workerId}</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                    {worker.files.map((file) => (
                      <div key={file.name} className="flex items-center justify-between p-3 bg-gray-50 rounded border">
                        <span className="text-sm text-gray-700 truncate flex-1">{file.name}</span>
                        <span className="text-xs text-gray-500 ml-2">{formatFileSize(file.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-600 text-center py-4">No output files available</p>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handleDelete}
        clientName={documents.customerName}
        clientId={documents.customerId}
        loading={deleting}
      />
    </div>
  );
};

// Main Client Documents Page
const ClientDocumentsPage = () => {
  const navigate = useNavigate();
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedClientName, setSelectedClientName] = useState<string>("");
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const baseurl = getBaseUrl();
  const token = localStorage.getItem("authToken") || "";
  const apiService = new ApiService(baseurl, token);

  useEffect(() => {
    if (!token) {
      navigate('/login');
      return;
    }
    loadClients();
  }, []);

  const loadClients = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiService.getAllClients();
      setClients(data.clients);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clients');
      console.error('Error loading clients:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectClient = (clientId: string) => {
    const client = clients.find(c => c.customerId === clientId);
    setSelectedClientId(clientId);
    setSelectedClientName(client?.customerName || "");
  };

  const handleBackToList = () => {
    setSelectedClientId(null);
    setSelectedClientName("");
    loadClients(); // Refresh the list when going back
  };

  const handleDeleteClient = async (clientId: string, clientName: string) => {
    setDeletingClientId(clientId);
    setDeleteError(null);

    try {
      const result = await apiService.deleteClientDocuments(clientId);
      
      if (result.success) {
        // Remove the client from the list
        setClients(prev => prev.filter(client => client.customerId !== clientId));
        
        // Show success message
        alert(`Successfully deleted all documents for ${clientName}`);
        
        // If we're currently viewing the deleted client, go back to list
        if (selectedClientId === clientId) {
          handleBackToList();
        }
      } else {
        throw new Error(result.message || 'Failed to delete documents');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete documents';
      setDeleteError(errorMessage);
      alert(`Delete failed: ${errorMessage}`);
    } finally {
      setDeletingClientId(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Client Documents</h1>
              <p className="text-gray-600 mt-2">View and download all uploaded files and documents</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={loadClients}
                disabled={loading}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={() => navigate('/client')}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition"
              >
                Back to Upload
              </button>
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-red-700 font-medium">Error: {error}</p>
              </div>
              <button
                onClick={loadClients}
                className="px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700 transition"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Delete Error Display */}
        {deleteError && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-red-700 font-medium">Delete Error: {deleteError}</p>
              </div>
              <button
                onClick={() => setDeleteError(null)}
                className="px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700 transition"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Content */}
        {selectedClientId ? (
          <ClientDetails
            clientId={selectedClientId}
            clientName={selectedClientName}
            onBack={handleBackToList}
            onDelete={handleDeleteClient}
            apiService={apiService}
            deleting={deletingClientId === selectedClientId}
          />
        ) : (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold text-gray-800">
                All Clients ({clients.length})
              </h2>
              <div className="text-sm text-gray-600">
                Total storage: {formatFileSize(clients.reduce((sum, client) => sum + client.totalSize, 0))}
              </div>
            </div>
            <ClientList
              clients={clients}
              onSelectClient={handleSelectClient}
              onDeleteClient={handleDeleteClient}
              loading={loading}
              deletingClientId={deletingClientId}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ClientDocumentsPage;