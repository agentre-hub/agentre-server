/**
 * WEB FULL-CHAIN e2e 的共用接缝:run-e2e-web.mjs 播种什么,这里就读什么。
 *
 * 只有 run-e2e-web.mjs 编排出来的那一次运行才有这些环境变量(一次性账号、
 * 已认领的 agentred、Redis 里的浏览器 session)。直接 `playwright test` 跑
 * web/ 会在第一个 requiredEnv 上明确失败,而不是在半路上莫名其妙地红。
 */
import { test as base } from "@playwright/test";

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set — run this suite through \`pnpm web\` (e2e/run-e2e-web.mjs)`,
    );
  }
  return v;
}

export const serverURL = requiredEnv("WEBE2E_SERVER_URL");
export const sessionSID = requiredEnv("WEBE2E_SESSION_SID");
export const cookieName = requiredEnv("WEBE2E_COOKIE_NAME");
/** 浏览器的固定设备指纹,与播种会话的 peer 指纹一致 → 这条会话归本浏览器所有。 */
export const webFP = requiredEnv("WEBE2E_WEB_FINGERPRINT");
export const agentredDB = requiredEnv("WEBE2E_AGENTRED_DB");
export const agentredFP = requiredEnv("WEBE2E_AGENTRED_FINGERPRINT");

/**
 * 播种进开发者数据库的那份工作区(账号级 Agent 与项目路径),由 webe2e seed 生成、
 * runner 原样透传。名字与同步标识只有一份来源:webe2e/main.go。
 */
export interface SeededWorkspace {
  /** 执行目标链是「本机档(浏览器语境下应跳过)→ 在线 agentred」的 Agent。 */
  agent_ready_sync_id: string;
  agent_ready_name: string;
  /** 执行目标链一档可用的都没有(本机 / 未配对 / 离线)的 Agent。 */
  agent_blocked_name: string;
  project_name: string;
  /** 该项目在那台在线 agentred 上的绝对路径(= 新对话的 cwd)。 */
  project_path: string;
  agentred_device_name: string;
  offline_device_name: string;
}

/** 播种的工作区。在测试体内调用:没播种时只让用到它的用例红,不牵连别的文件。 */
export function seededWorkspace(): SeededWorkspace {
  return JSON.parse(requiredEnv("WEBE2E_WORKSPACE")) as SeededWorkspace;
}

export const test = base.extend<{ seededContext: void }>({
  seededContext: [
    async ({ context }, use) => {
      // 登录:把播种的浏览器 session cookie 放进本上下文(身份 = 一次性账号)。
      await context.addCookies([
        { name: cookieName, value: sessionSID, url: serverURL },
      ]);
      // 固定浏览器设备指纹:ensureWebDevice 会按它幂等注册 kind=web 设备。
      await context.addInitScript((fp: string) => {
        window.localStorage.setItem("agentre.deviceFingerprint", fp);
      }, webFP);
      await use();
    },
    { auto: true },
  ],
});
