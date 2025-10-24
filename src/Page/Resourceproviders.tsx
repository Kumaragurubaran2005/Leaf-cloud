import { useEffect, useState } from "react";
import axios from "axios";

interface WorkerStats {
  WORKERID: string;
  TASKCOMPLETED: number;
  TASKPENDING: number;
  TASKFAILED: number;
  TASKRUNNING: number;
}

const ResourceProviders = () => {
  const [workers, setWorkers] = useState<WorkerStats>();
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  const workerId = localStorage.getItem("username")
  // Fetch worker stats
  const fetchWorkerStats = async () => {
  setLoading(true);
  setError("");
  try {
    const response = await axios.post<WorkerStats>("http://localhost:5000/workerstats", { workerId });

    setWorkers(response.data)  


  } catch (err: any) {
    console.error(err);
    setError("Failed to fetch worker stats");
  } finally {
    setLoading(false);
  }
};

  useEffect(() => {
    fetchWorkerStats();

    // Poll every 10 seconds
    const interval = setInterval(fetchWorkerStats, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Resource Providers</h2>
        <button
          onClick={fetchWorkerStats}
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
        >
          Refresh
        </button>
      </div>

      {loading && <div>Loading worker stats...</div>}
      {error && <div className="text-red-600 mb-4">{error}</div>}
      {!loading && workers?.WORKERID===null && <div>No workers found.</div>}

      {workers && (
        <table className="min-w-full border border-gray-300">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-4 py-2">Worker ID</th>
              <th className="border px-4 py-2">Tasks Completed</th>
              <th className="border px-4 py-2">Tasks Pending</th>
              <th className="border px-4 py-2">Tasks Running</th>
              <th className="border px-4 py-2">Tasks Failed</th>
            </tr>
          </thead>
          <tbody>
            
              <tr key={workers.WORKERID} className="text-center hover:bg-gray-50">
                <td className="border px-4 py-2">{workers.WORKERID}</td>
                <td className="border px-4 py-2">{workers.TASKCOMPLETED}</td>
                <td className="border px-4 py-2">{workers.TASKPENDING}</td>
                <td className="border px-4 py-2">{workers.TASKRUNNING}</td>
                <td className="border px-4 py-2">{workers.TASKFAILED}</td>
              </tr>
            
          </tbody>
        </table>
      )}
    </div>
  );
};

export default ResourceProviders;
