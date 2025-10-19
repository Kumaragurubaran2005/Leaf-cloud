
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Client from "./Page/Client";
import LoginPage from "./Page/login";

function App() {

  return (
      <Router>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/client" element={<Client/>} />
        </Routes>
      </Router>
    )
}

export default App
