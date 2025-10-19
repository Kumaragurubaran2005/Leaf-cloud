import { useState } from "react";
import { useNavigate } from "react-router-dom";

const LoginPage = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const navigate = useNavigate();
  const baseurl = "http://localhost:5000";

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const resp = await fetch(`${baseurl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await resp.json();

      if (data.success && data.token) {
        localStorage.setItem("authToken", data.token);
        navigate("/client");
      } else {
        setError(data.message || "Invalid credentials");
      }
    } catch (err) {
      console.error(err);
      setError("Server error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="w-full max-w-md bg-white/60 backdrop-blur-md rounded-3xl p-10 shadow-2xl border border-gray-200/30">
        <h2 className="text-3xl font-semibold text-gray-900 text-center mb-8">Login</h2>

        {error && <div className="mb-4 text-red-600 font-medium text-center">{error}</div>}

        <form onSubmit={handleLogin} className="space-y-5">
          <div className="space-y-2">
            <label className="font-medium text-gray-700">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full p-3 border border-gray-300 rounded-xl hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="font-medium text-gray-700">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-3 border border-gray-300 rounded-xl hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
              required
            />
          </div>

          <button
            type="submit"
            className="w-full px-6 py-3 bg-blue-600 text-white font-medium rounded-xl shadow-lg hover:bg-blue-700 hover:scale-105 transition transform"
            disabled={loading}
          >
            {loading ? "Logging in..." : "Login"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
