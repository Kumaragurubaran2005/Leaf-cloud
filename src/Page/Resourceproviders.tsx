import { useEffect, useState } from "react";
import axios from "axios";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from "recharts";

interface WorkerStats {
  WORKERID: string;
  TASKCOMPLETED: number;
  TASKPENDING: number;
  TASKFAILED: number;
  TASKRUNNING: number;
}

interface UsageData {
  usageId: number;
  workerId: string;
  customerId: string;
  taskId: string;
  cpuUsage: number;
  memoryUsage: number;
  executionTime: number;
  timestamp: string;
  rawUsageData: string;
}

interface PerformanceData {
  workerId: string;
  totalTasks: number;
  averages: {
    cpu: number;
    memory: number;
    executionTime: number;
  };
  maximums: {
    cpu: number;
    memory: number;
    executionTime: number;
  };
  timeline: {
    firstTask: string;
    lastTask: string;
  };
  efficiency: {
    cpuEfficiency: number;
    memoryEfficiency: number;
    speedEfficiency: number;
  };
}

// Interface for pie chart data
interface PieChartData {
  name: string;
  value: number;
}

// Interface for usage chart data
interface UsageChartData {
  timestamp: string;
  cpu?: number;
  memory?: number;
  executionTime?: number;
  task: string;
}

// Interface for efficiency data
interface EfficiencyData {
  name: string;
  value: number;
}

const ResourceProviders = () => {
  const [workers, setWorkers] = useState<WorkerStats>();
  const [usageData, setUsageData] = useState<UsageData[]>([]);
  const [performanceData, setPerformanceData] = useState<PerformanceData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [usageLoading, setUsageLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"stats" | "usage" | "performance">("stats");

  const workerId = localStorage.getItem("username");

  // Colors for charts
  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8'];

  // Fetch worker stats - CORRECTED TO USE GET ENDPOINT
  const fetchWorkerStats = async () => {
    if (!workerId) return;
    
    setLoading(true);
    setError("");
    try {
      const response = await axios.get<WorkerStats>(
        `http://localhost:5000/workerstats/${workerId}`,
        { 
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      setWorkers(response.data);
    } catch (err: any) {
      console.error("Error fetching worker stats:", err);
      setError("Failed to fetch worker statistics");
    } finally {
      setLoading(false);
    }
  };

  // Fetch usage data for graphs
  const fetchUsageData = async () => {
    if (!workerId) return;
    
    setUsageLoading(true);
    try {
      const response = await axios.get<{ usageStats: UsageData[] }>(
        `http://localhost:5000/worker/usage/${workerId}`,
        { 
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      setUsageData(response.data.usageStats || []);
    } catch (err: any) {
      console.error("Error fetching usage data:", err);
      setError("Failed to fetch usage data");
    } finally {
      setUsageLoading(false);
    }
  };

  // Fetch performance data
  const fetchPerformanceData = async () => {
    if (!workerId) return;
    
    try {
      const response = await axios.get<{ performance: PerformanceData }>(
        `http://localhost:5000/worker/performance/${workerId}`,
        { 
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      setPerformanceData(response.data.performance);
    } catch (err: any) {
      console.error("Error fetching performance data:", err);
      setError("Failed to fetch performance data");
    }
  };

  // Download usage data as CSV
  const downloadUsageData = async () => {
    if (!workerId) return;
    
    try {
      const response = await axios.get<Blob>(
        `http://localhost:5000/worker/usage/${workerId}/download`,
        {
          responseType: 'blob',
          timeout: 10000
        }
      );
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `usage_${workerId}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      
      console.log("Usage data downloaded successfully");
    } catch (err: any) {
      console.error("Failed to download usage data:", err);
      setError("Failed to download usage data");
    }
  };

  // Initialize all data
  const initializeData = async () => {
    try {
      await fetchWorkerStats();
      await fetchUsageData();
      await fetchPerformanceData();
    } catch (err) {
      console.error("Error initializing data:", err);
      setError("Failed to initialize dashboard data");
    }
  };

  // Refresh all data
  const refreshAllData = async () => {
    setLoading(true);
    setError("");
    await initializeData();
  };

  useEffect(() => {
    initializeData();

    // Set up polling for real-time updates
    const pollInterval = setInterval(() => {
      fetchWorkerStats();
    }, 15000); // Poll every 15 seconds

    return () => clearInterval(pollInterval);
  }, []);

  // Prepare data for charts with proper typing
  const cpuUsageData: UsageChartData[] = usageData.map(usage => ({
    timestamp: new Date(usage.timestamp).toLocaleTimeString(),
    cpu: usage.cpuUsage,
    task: usage.taskId
  })).reverse();

  const memoryUsageData: UsageChartData[] = usageData.map(usage => ({
    timestamp: new Date(usage.timestamp).toLocaleTimeString(),
    memory: usage.memoryUsage,
    task: usage.taskId
  })).reverse();

  const executionTimeData: UsageChartData[] = usageData.map(usage => ({
    timestamp: new Date(usage.timestamp).toLocaleTimeString(),
    executionTime: usage.executionTime,
    task: usage.taskId
  })).reverse();

  const taskDistributionData: PieChartData[] = [
    { name: 'Completed', value: workers?.TASKCOMPLETED || 0 },
    { name: 'Pending', value: workers?.TASKPENDING || 0 },
    { name: 'Running', value: workers?.TASKRUNNING || 0 },
    { name: 'Failed', value: workers?.TASKFAILED || 0 },
  ];

  const efficiencyData: EfficiencyData[] = performanceData ? [
    { name: 'CPU Efficiency', value: performanceData.efficiency.cpuEfficiency },
    { name: 'Memory Efficiency', value: performanceData.efficiency.memoryEfficiency },
    { name: 'Speed Efficiency', value: performanceData.efficiency.speedEfficiency },
  ] : [];

  // Calculate some summary statistics
  const totalTasks = (workers?.TASKCOMPLETED || 0) + (workers?.TASKPENDING || 0) + 
                    (workers?.TASKRUNNING || 0) + (workers?.TASKFAILED || 0);
  
  const successRate = totalTasks > 0 ? ((workers?.TASKCOMPLETED || 0) / totalTasks * 100) : 0;

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Resource Provider Dashboard</h2>
          <p className="text-gray-600">Worker ID: {workerId || "Not logged in"}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={downloadUsageData}
            className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 transition-colors"
            disabled={usageData.length === 0}
          >
            Download Usage Data
          </button>
          <button
            onClick={refreshAllData}
            className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors flex items-center"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh All
          </button>
        </div>
      </div>

      {/* Quick Stats Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-2xl font-bold text-blue-600">{workers?.TASKCOMPLETED || 0}</div>
          <div className="text-gray-600">Completed Tasks</div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-2xl font-bold text-green-600">{successRate.toFixed(1)}%</div>
          <div className="text-gray-600">Success Rate</div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-2xl font-bold text-orange-600">{usageData.length}</div>
          <div className="text-gray-600">Usage Records</div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-2xl font-bold text-purple-600">{totalTasks}</div>
          <div className="text-gray-600">Total Tasks</div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="mb-6">
        <div className="flex border-b">
          <button
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === "stats"
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => setActiveTab("stats")}
          >
            Worker Statistics
          </button>
          <button
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === "usage"
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => setActiveTab("usage")}
          >
            Usage Analytics
          </button>
          <button
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === "performance"
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => setActiveTab("performance")}
          >
            Performance
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          <div className="flex items-center">
            <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <span>{error}</span>
          </div>
        </div>
      )}

      {loading && activeTab === "stats" && (
        <div className="text-center py-8">
          <div className="inline-flex items-center">
            <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Loading worker stats...
          </div>
        </div>
      )}

      {/* Worker Statistics Tab */}
      {activeTab === "stats" && workers && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Task Distribution Pie Chart */}
            <div className="bg-white p-4 rounded-lg shadow">
              <h3 className="text-lg font-semibold mb-4">Task Distribution</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={taskDistributionData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percent }: { name: string; percent: number }) => 
                      `${name} ${(percent * 100).toFixed(0)}%`
                    }
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {taskDistributionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => [value, 'Tasks']} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Worker Stats Table */}
            <div className="bg-white p-4 rounded-lg shadow">
              <h3 className="text-lg font-semibold mb-4">Worker Details</h3>
              <table className="min-w-full">
                <tbody>
                  <tr className="border-b">
                    <td className="py-2 font-semibold">Worker ID:</td>
                    <td className="py-2 font-mono">{workers.WORKERID}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 font-semibold">Tasks Completed:</td>
                    <td className="py-2">
                      <span className="font-medium">{workers.TASKCOMPLETED}</span>
                      <span className="text-sm text-gray-500 ml-2">
                        ({((workers.TASKCOMPLETED / totalTasks) * 100).toFixed(1)}%)
                      </span>
                    </td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 font-semibold">Tasks Pending:</td>
                    <td className="py-2">
                      <span className="font-medium">{workers.TASKPENDING}</span>
                      <span className="text-sm text-gray-500 ml-2">
                        ({((workers.TASKPENDING / totalTasks) * 100).toFixed(1)}%)
                      </span>
                    </td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 font-semibold">Tasks Running:</td>
                    <td className="py-2">
                      <span className="font-medium">{workers.TASKRUNNING}</span>
                      <span className="text-sm text-gray-500 ml-2">
                        ({((workers.TASKRUNNING / totalTasks) * 100).toFixed(1)}%)
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 font-semibold">Tasks Failed:</td>
                    <td className="py-2">
                      <span className="font-medium">{workers.TASKFAILED}</span>
                      <span className="text-sm text-gray-500 ml-2">
                        ({((workers.TASKFAILED / totalTasks) * 100).toFixed(1)}%)
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Usage Analytics Tab */}
      {activeTab === "usage" && (
        <div className="space-y-6">
          {usageLoading && (
            <div className="text-center py-8">
              <div className="inline-flex items-center">
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Loading usage data...
              </div>
            </div>
          )}
          
          {usageData.length === 0 && !usageLoading && (
            <div className="text-center py-8 text-gray-500">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <p className="mt-2">No usage data available.</p>
              <p className="text-sm">Complete some tasks to see analytics.</p>
            </div>
          )}

          {usageData.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* CPU Usage Over Time */}
              <div className="bg-white p-4 rounded-lg shadow">
                <h3 className="text-lg font-semibold mb-4">CPU Usage Over Time</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={cpuUsageData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="timestamp" />
                    <YAxis label={{ value: 'CPU %', angle: -90, position: 'insideLeft' }} />
                    <Tooltip formatter={(value: number) => [`${value}%`, 'CPU Usage']} />
                    <Legend />
                    <Line 
                      type="monotone" 
                      dataKey="cpu" 
                      stroke="#0088FE" 
                      strokeWidth={2} 
                      dot={{ r: 3 }} 
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Memory Usage Over Time */}
              <div className="bg-white p-4 rounded-lg shadow">
                <h3 className="text-lg font-semibold mb-4">Memory Usage Over Time</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={memoryUsageData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="timestamp" />
                    <YAxis label={{ value: 'Memory (MB)', angle: -90, position: 'insideLeft' }} />
                    <Tooltip formatter={(value: number) => [`${value} MB`, 'Memory Usage']} />
                    <Legend />
                    <Line 
                      type="monotone" 
                      dataKey="memory" 
                      stroke="#00C49F" 
                      strokeWidth={2} 
                      dot={{ r: 3 }} 
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Execution Time Over Time */}
              <div className="bg-white p-4 rounded-lg shadow">
                <h3 className="text-lg font-semibold mb-4">Execution Time Over Time</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={executionTimeData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="timestamp" />
                    <YAxis label={{ value: 'Time (seconds)', angle: -90, position: 'insideLeft' }} />
                    <Tooltip formatter={(value: number) => [`${value} seconds`, 'Execution Time']} />
                    <Legend />
                    <Bar dataKey="executionTime" fill="#FF8042" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Recent Usage Stats */}
              <div className="bg-white p-4 rounded-lg shadow">
                <h3 className="text-lg font-semibold mb-4">Recent Usage Statistics</h3>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {usageData.slice(0, 10).map((usage, index) => (
                    <div key={usage.usageId || index} className="border-b pb-3 last:border-b-0">
                      <div className="flex justify-between items-start">
                        <div>
                          <span className="font-medium">Task: {usage.taskId}</span>
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded ml-2">
                            {usage.customerId}
                          </span>
                        </div>
                        <span className="text-sm text-gray-500">
                          {new Date(usage.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-sm mt-2">
                        <div className="text-center">
                          <div className="font-semibold text-blue-600">{usage.cpuUsage}%</div>
                          <div className="text-xs text-gray-500">CPU</div>
                        </div>
                        <div className="text-center">
                          <div className="font-semibold text-green-600">{usage.memoryUsage}MB</div>
                          <div className="text-xs text-gray-500">Memory</div>
                        </div>
                        <div className="text-center">
                          <div className="font-semibold text-orange-600">{usage.executionTime}s</div>
                          <div className="text-xs text-gray-500">Time</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Performance Tab */}
      {activeTab === "performance" && (
        <div className="space-y-6">
          {!performanceData ? (
            <div className="text-center py-8 text-gray-500">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              <p className="mt-2">Loading performance data...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Efficiency Metrics */}
              <div className="bg-white p-4 rounded-lg shadow">
                <h3 className="text-lg font-semibold mb-4">Efficiency Metrics</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={efficiencyData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis label={{ value: 'Efficiency %', angle: -90, position: 'insideLeft' }} domain={[0, 100]} />
                    <Tooltip formatter={(value: number) => [`${value}%`, 'Efficiency']} />
                    <Bar dataKey="value" fill="#8884D8">
                      {efficiencyData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Performance Summary */}
              <div className="bg-white p-4 rounded-lg shadow">
                <h3 className="text-lg font-semibold mb-4">Performance Summary</h3>
                <div className="space-y-6">
                  <div>
                    <h4 className="font-semibold text-gray-700 mb-3">Averages</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-blue-50 p-3 rounded">
                        <div className="text-sm text-blue-600">CPU Usage</div>
                        <div className="text-xl font-bold">{performanceData.averages.cpu}%</div>
                      </div>
                      <div className="bg-green-50 p-3 rounded">
                        <div className="text-sm text-green-600">Memory Usage</div>
                        <div className="text-xl font-bold">{performanceData.averages.memory}MB</div>
                      </div>
                      <div className="bg-orange-50 p-3 rounded col-span-2">
                        <div className="text-sm text-orange-600">Execution Time</div>
                        <div className="text-xl font-bold">{performanceData.averages.executionTime}s</div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-semibold text-gray-700 mb-3">Maximums</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-red-50 p-3 rounded">
                        <div className="text-sm text-red-600">Max CPU</div>
                        <div className="text-xl font-bold">{performanceData.maximums.cpu}%</div>
                      </div>
                      <div className="bg-purple-50 p-3 rounded">
                        <div className="text-sm text-purple-600">Max Memory</div>
                        <div className="text-xl font-bold">{performanceData.maximums.memory}MB</div>
                      </div>
                      <div className="bg-yellow-50 p-3 rounded col-span-2">
                        <div className="text-sm text-yellow-600">Max Time</div>
                        <div className="text-xl font-bold">{performanceData.maximums.executionTime}s</div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-semibold text-gray-700 mb-3">Timeline</h4>
                    <div className="space-y-3">
                      <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                        <span>First Task:</span>
                        <span className="font-medium">
                          {new Date(performanceData.timeline.firstTask).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                        <span>Last Task:</span>
                        <span className="font-medium">
                          {new Date(performanceData.timeline.lastTask).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                        <span>Total Tasks:</span>
                        <span className="font-medium text-lg">{performanceData.totalTasks}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ResourceProviders;