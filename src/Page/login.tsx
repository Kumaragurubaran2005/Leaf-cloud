import { useState } from "react";
import { useNavigate } from "react-router-dom";

interface User {
  username: string;
  password: string;
  feild: "client" | "resource_provider";
}

const LoginPage = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  
  // Registration form state
  const [registerData, setRegisterData] = useState<User>({
    username: "",
    password: "",
    feild: "client"
  });
  const [confirmPassword, setConfirmPassword] = useState("");

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
        localStorage.setItem("username", username);
        if (data.togo === "client") {
          navigate("/client");
        } else if (data.togo === "resource_provider") {
          navigate("/resource_provider");
        }
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

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    // Validation
    if (registerData.password !== confirmPassword) {
      setError("Passwords do not match");
      setLoading(false);
      return;
    }

    if (registerData.password.length < 6) {
      setError("Password must be at least 6 characters long");
      setLoading(false);
      return;
    }

    if (registerData.username.length > 20) {
      setError("Username must be 20 characters or less");
      setLoading(false);
      return;
    }

    if (registerData.password.length > 20) {
      setError("Password must be 20 characters or less");
      setLoading(false);
      return;
    }

    try {
      const resp = await fetch(`${baseurl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerData),
      });

      const data = await resp.json();

      if (data.success) {
        setError("");
        setIsRegistering(false);
        // Clear registration form
        setRegisterData({
          username: "",
          password: "",
          feild: "client"
        });
        setConfirmPassword("");
        // Show success message
        setError("Registration successful! Please login.");
      } else {
        setError(data.message || "Registration failed");
      }
    } catch (err) {
      console.error(err);
      setError("Server error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const updateRegisterField = (field: keyof User, value: string) => {
    setRegisterData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const toggleMode = () => {
    setIsRegistering(!isRegistering);
    setError("");
    setUsername("");
    setPassword("");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="w-full max-w-md bg-white/80 backdrop-blur-md rounded-3xl p-8 shadow-2xl border border-gray-200/30">
        <h2 className="text-3xl font-bold text-gray-900 text-center mb-2">
          {isRegistering ? "Create Account" : "Welcome Back"}
        </h2>
        <p className="text-gray-600 text-center mb-8">
          {isRegistering ? "Join us today" : "Sign in to your account"}
        </p>

        {error && (
          <div className={`mb-4 p-3 rounded-xl text-center font-medium ${
            error.includes("successful") 
              ? "bg-green-100 text-green-700 border border-green-200" 
              : "bg-red-100 text-red-700 border border-red-200"
          }`}>
            {error}
          </div>
        )}

        {!isRegistering ? (
          // Login Form
          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
              <label className="font-medium text-gray-700">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-3 border border-gray-300 rounded-xl hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
                required
                maxLength={20}
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
                maxLength={20}
              />
            </div>

            <button
              type="submit"
              className="w-full px-6 py-3 bg-blue-600 text-white font-medium rounded-xl shadow-lg hover:bg-blue-700 hover:scale-105 transition transform disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={loading}
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={toggleMode}
                className="text-blue-600 hover:text-blue-700 font-medium"
              >
                Don't have an account? Sign up
              </button>
            </div>
          </form>
        ) : (
          // Registration Form
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-2">
              <label className="font-medium text-gray-700">Username</label>
              <input
                type="text"
                value={registerData.username}
                onChange={(e) => updateRegisterField("username", e.target.value)}
                className="w-full p-3 border border-gray-300 rounded-xl hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
                placeholder="Choose a username (max 20 chars)"
                required
                maxLength={20}
              />
            </div>

            <div className="space-y-2">
              <label className="font-medium text-gray-700">Account Type</label>
              <div className="flex space-x-4">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="radio"
                    name="feild"
                    value="client"
                    checked={registerData.feild === "client"}
                    onChange={(e) => updateRegisterField("feild", e.target.value)}
                    className="text-blue-600 focus:ring-blue-300"
                  />
                  <span className="text-gray-700">Client</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="radio"
                    name="feild"
                    value="resource_provider"
                    checked={registerData.feild === "resource_provider"}
                    onChange={(e) => updateRegisterField("feild", e.target.value)}
                    className="text-blue-600 focus:ring-blue-300"
                  />
                  <span className="text-gray-700">Resource Provider</span>
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <label className="font-medium text-gray-700">Password</label>
              <input
                type="password"
                value={registerData.password}
                onChange={(e) => updateRegisterField("password", e.target.value)}
                className="w-full p-3 border border-gray-300 rounded-xl hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
                placeholder="Create a password (max 20 chars)"
                required
                maxLength={20}
              />
            </div>

            <div className="space-y-2">
              <label className="font-medium text-gray-700">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full p-3 border border-gray-300 rounded-xl hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
                placeholder="Confirm your password"
                required
                maxLength={20}
              />
            </div>

            <button
              type="submit"
              className="w-full px-6 py-3 bg-green-600 text-white font-medium rounded-xl shadow-lg hover:bg-green-700 hover:scale-105 transition transform disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={loading}
            >
              {loading ? "Creating Account..." : "Create Account"}
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={toggleMode}
                className="text-blue-600 hover:text-blue-700 font-medium"
              >
                Already have an account? Sign in
              </button>
            </div>
          </form>
        )}

        {/* Info boxes */}
        <div className="mt-8 space-y-3">
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <h4 className="font-semibold text-blue-800 mb-1">Client Account</h4>
            <p className="text-blue-700 text-sm">Submit tasks and manage your distributed computing jobs</p>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-xl p-4">
            <h4 className="font-semibold text-green-800 mb-1">Resource Provider</h4>
            <p className="text-green-700 text-sm">Offer computing resources and earn by processing tasks</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;