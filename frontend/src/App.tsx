import { useAutoHideScrollbars, useTheme } from "@agentre-hub/agentre-ui";
import { useEffect } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useParams,
} from "react-router-dom";
import { Toaster } from "sonner";
import Login from "./pages/Login";
import Account from "./pages/Account";
import Device from "./pages/Device";
import DeviceSuccess from "./pages/DeviceSuccess";
import DeviceDenied from "./pages/DeviceDenied";
import DeviceExpired from "./pages/DeviceExpired";
import Devices from "./pages/Devices";
import Overview from "./pages/Overview";
import Issues from "./pages/Issues";
import Org from "./pages/Org";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";
import ComingSoon from "./pages/ComingSoon";
import RequireAuth from "./components/RequireAuth";
import { lazyPage, warmPages } from "./lib/lazyPage";

// 会话那两页背后是整套转录渲染，切出入口 chunk（见 lazyPage）。导出是给
// app-routes 的接线用例认预热这条线用的，路由本身只用它们当 element。
export const SessionDetailPage = lazyPage(
  () => import("./pages/SessionDetail"),
);
export const ChatPage = lazyPage(() => import("./pages/Chat"));

/**
 * 设备下钻的会话列表页并入统一索引（规格 2026-08-17 决策 1）：它与索引渲染的是
 * 同一批会话，差别只是范围，而范围正是「轴」能表达的东西。因此这条旧地址重定向到
 * 机器轴——那台机器就是索引里的一组，落地的形态仍是它上报的全量会话加行尾「保存」。
 *
 * **范围随地址一起过去**：`:deviceId` 落成 `?machine=<设备标识>`，索引因此只列那
 * 一台。入口那句话是「查看这台机器的对话」，丢掉这一段就名不副实——落地看到的是
 * 账号下每一台在线机器。机器轴本身（不带 `?machine=`）仍是每台各一组，两者是
 * 「这一台」与「全部」的关系，不是两套东西。
 */
function DeviceSessionsRedirect() {
  const { deviceId } = useParams<{ deviceId: string }>();
  const params = new URLSearchParams({ axis: "machine" });
  if (deviceId) params.set("machine", deviceId);
  return <Navigate to={`/chat?${params.toString()}`} replace />;
}

export default function App() {
  const { effectiveTheme } = useTheme();

  // 滚动条的另一半：base.css 把滑块颜色绑到 --sb-thumb 并默认透明，这里在滚动时
  // 改值、停手 900ms 后清掉。只 import 样式不调它，滚动条恒为透明（滚动仍可用）。
  useAutoHideScrollbars();

  // 切出去的那两页趁空闲先取回来：不预热的话，第一次从别的页切到 /chat 要等
  // ~308 KB（gzip）下完才有第一帧，而那一帧空的是整个视口（见 warmPages）。
  useEffect(() => warmPages([ChatPage, SessionDetailPage]), []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
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
              <DeviceSessionsRedirect />
            </RequireAuth>
          }
        />
        <Route
          path="/devices/:deviceId/sessions/:conversationId"
          element={
            <RequireAuth>
              <SessionDetailPage />
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
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route
          path="/issues"
          element={
            <RequireAuth>
              <Issues />
            </RequireAuth>
          }
        />
        <Route
          // 选中哪一行写在地址里：移动端下钻靠它让手机的返回键有用，深链接也因此
          // 白拿（与会话详情 /devices/:did/sessions/:conversationId 同一条做法）。
          // 两段是**可选段**而不是另开一条 Route —— 分成两条的话，在「没选中」与
          // 「选中了」之间导航会换掉 element，整个页面卸载重挂：useOrgData 重拉一遍，
          // 并且闪一下 loading。一条路由则只是 params 变了。
          path="/org/:kind?/:syncId?"
          element={
            <RequireAuth>
              <Org />
            </RequireAuth>
          }
        />
        {/* /account 只从左下角用户菜单进（规格「用户菜单与 /account」）：受
            RequireAuth 保护，但刻意不进 AppShell 的四项主导航。 */}
        <Route
          path="/account"
          element={
            <RequireAuth>
              <Account />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <Settings />
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
      {/*
        `mobileOffset` 让开移动端底栏：sonner 在窄视口下把 bottom-* 拍成贴底全宽，
        而 MobileTabBar 是 74px 的正常流元素、就贴在同一条边上（Chat 页那颗 FAB
        在 bottom-24 也在这一带）。默认 16px 会把导航整条盖掉 —— 而出错时用户
        最需要的正是换个地方看看。74 + 16 = 90。
      */}
      <Toaster
        position="bottom-right"
        richColors
        theme={effectiveTheme}
        mobileOffset={{ bottom: "90px" }}
      />
    </BrowserRouter>
  );
}
