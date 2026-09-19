/**
 * PWA service worker 的注册入口。
 *
 * 注册本身是"锦上添花"的那一类：失败最坏也只是没有离线页，绝不能反过来把应用启动
 * 打断。所以这里把所有失败都吞成一条 warn，并且留了两个可注入的缝合面
 * （register / warn），好让单测不必真的碰 navigator.serviceWorker。
 *
 * 注册只在生产路径发生：dev 下 vite 的 HMR 客户端与 SW 会互相抢资源，热更新会
 * 莫名其妙地拿到缓存副本。调用方把 `import.meta.env.PROD` 传进来，模块本身不认识
 * vite 的环境变量。
 *
 * sw.js 的内部行为不在这里——它是一份 public/ 下的纯 JS，由真浏览器验证。
 */

/** 与 navigator.serviceWorker.register 同形，便于注入。 */
export type ServiceWorkerRegister = (
  scriptURL: string,
  options?: RegistrationOptions,
) => Promise<ServiceWorkerRegistration>;

export interface RegisterServiceWorkerOptions {
  /** 生产才注册；dev 传 false。 */
  enabled: boolean;
  /** 测试注入用；缺省走 navigator.serviceWorker。 */
  register?: ServiceWorkerRegister;
  /** 测试注入用；缺省 console.warn。 */
  warn?: (message: string, error: unknown) => void;
}

/** 默认注册器；浏览器没有 serviceWorker 时返回 undefined。 */
function defaultRegister(): ServiceWorkerRegister | undefined {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return undefined;
  }
  const container = navigator.serviceWorker;
  if (!container || typeof container.register !== "function") return undefined;
  return (scriptURL, options) => container.register(scriptURL, options);
}

/**
 * 注册 `/sw.js`（scope 为根）。返回 registration；未注册或失败时为 null。
 *
 * 失败不抛：一条 warn 之后照常返回，应用启动不受影响。
 */
export async function registerServiceWorker({
  enabled,
  register,
  warn,
}: RegisterServiceWorkerOptions): Promise<ServiceWorkerRegistration | null> {
  if (!enabled) return null;
  const doRegister = register ?? defaultRegister();
  if (!doRegister) return null;
  try {
    return await doRegister("/sw.js", { scope: "/" });
  } catch (error) {
    (warn ?? console.warn)("[pwa] service worker registration failed", error);
    return null;
  }
}
