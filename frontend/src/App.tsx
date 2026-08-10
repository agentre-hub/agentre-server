import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Device from "./pages/Device";
import DeviceSuccess from "./pages/DeviceSuccess";
import DeviceDenied from "./pages/DeviceDenied";
import DeviceExpired from "./pages/DeviceExpired";
import Devices from "./pages/Devices";
import DeviceSessions from "./pages/DeviceSessions";
import SessionDetail from "./pages/SessionDetail";
import Overview from "./pages/Overview";
import WorkspaceComingSoon from "./pages/WorkspaceComingSoon";
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
        <Route
          path="/devices/:deviceId/sessions"
          element={
            <RequireAuth>
              <DeviceSessions />
            </RequireAuth>
          }
        />
        <Route
          path="/devices/:deviceId/sessions/:sessionId"
          element={
            <RequireAuth>
              <SessionDetail />
            </RequireAuth>
          }
        />
        <Route
          path="/overview"
          element={
            <RequireAuth>
              <Overview />
            </RequireAuth>
          }
        />
        <Route
          path="/chat"
          element={
            <RequireAuth>
              <WorkspaceComingSoon bodyKey="workspaceComingSoon.chatBody" />
            </RequireAuth>
          }
        />
        <Route
          path="/audit"
          element={
            <RequireAuth>
              <WorkspaceComingSoon bodyKey="workspaceComingSoon.auditBody" />
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
