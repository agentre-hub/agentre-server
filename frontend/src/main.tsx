import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
// i18n 必须在 App 之前 import：初始化要先于任何 useTranslation 的首次求值
import i18n from "./i18n";
import App from "./App";
import "./styles/globals.css";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { loadCsrfToken } from "./lib/api";
import { registerServiceWorker } from "./lib/service-worker";

loadCsrfToken();
// 生产才注册 PWA service worker：dev 下 vite 的 HMR 客户端会与 SW 抢资源。
// 注册失败只在模块里落一条 warn，绝不阻塞应用启动。
void registerServiceWorker({ enabled: import.meta.env.PROD });
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 显式挂 I18nextProvider，而不是依赖 initReactI18next 设的全局默认实例：
        依赖全局实例时，useTranslation 的订阅时机取决于模块求值顺序，
        表现是 changeLanguage 之后 <html lang> 变了、localStorage 变了，
        但组件树不重渲染——界面文案纹丝不动。 */}
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </I18nextProvider>
  </StrictMode>,
);
