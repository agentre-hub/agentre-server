import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Device from "./pages/Device";
import DeviceSuccess from "./pages/DeviceSuccess";
import DeviceDenied from "./pages/DeviceDenied";
import DeviceExpired from "./pages/DeviceExpired";
import Devices from "./pages/Devices";
import NotFound from "./pages/NotFound";
import ComingSoon from "./pages/ComingSoon";
import RequireAuth from "./components/RequireAuth";

export default function App() {
  return (
    <BrowserRouter>
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
        <Route path="/device/denied" element={<DeviceDenied />} />
        <Route path="/device/expired" element={<DeviceExpired />} />
        <Route path="/terms" element={<ComingSoon page="terms" />} />
        <Route path="/privacy" element={<ComingSoon page="privacy" />} />
        <Route path="/status" element={<ComingSoon page="status" />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
