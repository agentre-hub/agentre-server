import { api } from "@/lib/api";

function browserName(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Safari/")) return "Safari";
  return "Browser";
}

function platformName(): string {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  const platform = navigator.platform;
  if (/Mac/.test(platform)) return "macOS";
  if (/Win/.test(platform)) return "Windows";
  if (/Linux/.test(platform)) return "Linux";
  return platform || "Web";
}

export function browserDisplayName(): string {
  return `${browserName()} · ${platformName()}`;
}

export interface RelayTicket {
  accessToken: string;
  /**
   * 这个账号的网页对端身份，由服务端从账号派生并签在票的 pfp claim 里（决策 8/9）。
   * 浏览器只读不写：自己生成一个存 localStorage 的随机数，清一次站点数据就换人，
   * 此前从网页发起的对话在账号镜像里当场失去身份键的一半。
   */
  clientId: string;
  clientName: string;
}

export async function ensureRelayTicket(): Promise<RelayTicket> {
  const response = await api<{
    access_token: string;
    expires_in: number;
    client_id: string;
  }>("/v1/relay/ticket", { method: "POST" });
  return {
    accessToken: response.access_token,
    clientId: response.client_id,
    clientName: browserDisplayName(),
  };
}
