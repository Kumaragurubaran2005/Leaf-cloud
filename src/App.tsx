
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Client from "./Page/Client";
import LoginPage from "./Page/login";
import ResourceProviders from "./Page/Resourceproviders";
import ClientDocumentsPage from "./Page/clientDoc";
function App() {

  return (
      <Router>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/client" element={<Client/>} />
          <Route path="/resource_provider" element={<ResourceProviders/>} />
          <Route path="/client-documents" element={<ClientDocumentsPage/>}/>
        </Routes>
      </Router>
    )
}

export default App
