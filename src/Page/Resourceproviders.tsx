import React, { useEffect, useState } from "react";
import axios from "axios";

interface WorkerStats {
  WORKERID: string;
  TASKCOMPLETED: number;
  TASKPENDING: number;
  TASKFAILED: number;
  TASKRUNNING: number;
}

const ResourceProviders = () => {
  const [workers, setWorkers] = useState<WorkerStats[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  // Fetch worker stats
  const fetchWorkerStats = async () => {
  setLoading(true);
  setError("");
  try {
    const response = await axios.get<{ workers: WorkerStats[] }>(
      "http://localhost:5000/allworkerstats"
    );

    const sanitizedWorkers = (response.data.workers || []).map((worker) => ({
      ...worker,
      TASKCOMPLETED: Math.max(worker.TASKCOMPLETED, 0),
      TASKPENDING: Math.max(worker.TASKPENDING, 0),
      TASKRUNNING: Math.max(worker.TASKRUNNING, 0),
      TASKFAILED: Math.max(worker.TASKFAILED, 0),
    }));

    setWorkers(sanitizedWorkers);
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
      {!loading && workers.length === 0 && <div>No workers found.</div>}

      {workers.length > 0 && (
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
            {workers.map((worker) => (
              <tr key={worker.WORKERID} className="text-center hover:bg-gray-50">
                <td className="border px-4 py-2">{worker.WORKERID}</td>
                <td className="border px-4 py-2">{worker.TASKCOMPLETED}</td>
                <td className="border px-4 py-2">{worker.TASKPENDING}</td>
                <td className="border px-4 py-2">{worker.TASKRUNNING}</td>
                <td className="border px-4 py-2">{worker.TASKFAILED}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default ResourceProviders;
