
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Client from "./Page/Client";

function App() {

  return (
      <Router>
        <Routes>
          <Route path="/" element={<Client />} />
        </Routes>
      </Router>
    )
}

export default App
