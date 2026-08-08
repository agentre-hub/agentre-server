import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AppControls from "./components/AppControls";
import Login from "./pages/Login";
import Device from "./pages/Device";
import DeviceSuccess from "./pages/DeviceSuccess";
import Devices from "./pages/Devices";
import NotFound from "./pages/NotFound";
import RequireAuth from "./components/RequireAuth";

export default function App() {
  return (
    <BrowserRouter>
      <AppControls />
      <Routes>
        <Route path="/" element={<Navigate to="/device" replace />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/device"
          element={
            <RequireAuth>
              <Device />
            </RequireAuth>
          }
        />
        <Route
          path="/devices"
          element={
            <RequireAuth>
              <Devices />
            </RequireAuth>
          }
        />
        <Route path="/device/success" element={<DeviceSuccess />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
