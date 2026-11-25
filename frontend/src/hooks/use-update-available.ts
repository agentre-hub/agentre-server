import { useSyncExternalStore } from "react";

/**
 * 新版本提示的页面一侧（规格 2026-11-25 决策 B1）。
 *
 * 外壳是缓存优先的（public/sw.js）：打开时给的是缓存里那一版，服务器上有没有更新由
 * SW 回答。页面在**启动后**与**每次回到前台**发一条 `check-update`，带上自己正在跑
 * 的入口脚本；SW 取一次服务器上的外壳，入口不同就回 `update-available`（同时已把新
 * 外壳存进缓存，所以重新加载拿到的就是新版本）。
 *
 * 提示条可关闭；关掉之后下一次回到前台再出——页面仍是旧的，提示仍然成立。
 * **不强制刷新**：只在人点「重新加载」时 reload。草稿与未发出的消息由各自的本地存储
 * 在重新加载后恢复，这里不管。
 */

/** 页面 → SW：查一下有没有新版本。 */
export const CHECK_UPDATE = "check-update";
/** SW → 页面：服务器上的入口与这个页面跑的不同。 */
export const UPDATE_AVAILABLE = "update-available";

interface UpdateState {
  /** SW 说过有新版本：这个页面在 reload 之前一直是旧的。 */
  detected: boolean;
  /** 人关掉了提示条；回到前台时复位。 */
  dismissed: boolean;
}

const INITIAL: UpdateState = { detected: false, dismissed: false };
let state: UpdateState = INITIAL;
const listeners = new Set<() => void>();

function publish(next: Partial<UpdateState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;

export interface UpdateWatchPorts {
  /** 缺省 navigator.serviceWorker。 */
  container?: ServiceWorkerContainer;
  /** 缺省 document：读前后台与入口脚本。 */
  doc?: Document;
}

/**
 * 开始盯新版本：立即问一次，之后每次回到前台再问。返回退订；退订同时忘掉已知的
 * 新版本（测试之间复位用，生产上从不退订）。
 *
 * 页面还没被 SW 接管（首次安装那一趟）时 `controller` 为空：不问——此时页面就是刚从
 * 网络拿的，谈不上旧。
 */
export function startUpdateWatch(ports: UpdateWatchPorts = {}): () => void {
  const container =
    ports.container ??
    (typeof navigator !== "undefined" ? navigator.serviceWorker : undefined);
  const doc = ports.doc ?? document;
  if (!container) return () => {};

  const entry =
    doc.querySelector('script[type="module"][src]')?.getAttribute("src") ??
    null;

  const check = () => {
    container.controller?.postMessage({ type: CHECK_UPDATE, entry });
  };

  const onMessage = (event: Event) => {
    const data = (event as MessageEvent).data as { type?: unknown } | null;
    if (data?.type === UPDATE_AVAILABLE) {
      publish({ detected: true, dismissed: false });
    }
  };

  const onVisibility = () => {
    if (doc.visibilityState !== "visible") return;
    if (state.dismissed) publish({ dismissed: false });
    check();
  };

  container.addEventListener("message", onMessage);
  // addEventListener 不会自动开启消息队列（只有 onmessage 赋值会）：不开的话 SW 的
  // 回答要排到 DOMContentLoaded 之后。
  container.startMessages?.();
  doc.addEventListener("visibilitychange", onVisibility);
  check();

  return () => {
    container.removeEventListener("message", onMessage);
    doc.removeEventListener("visibilitychange", onVisibility);
    state = INITIAL;
    for (const listener of listeners) listener();
  };
}

/** 重新加载整页。提出来是为了让提示条、分包失败与版本不符横幅用同一个动作。 */
export function reloadPage(): void {
  window.location.reload();
}

export function useUpdateAvailable(): {
  available: boolean;
  reload: () => void;
  dismiss: () => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    available: snapshot.detected && !snapshot.dismissed,
    reload: reloadPage,
    dismiss: () => publish({ dismissed: true }),
  };
}
