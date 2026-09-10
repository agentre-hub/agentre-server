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
   * 这张票什么时候作废（本机时钟的毫秒数）。
   *
   * 票只活两分钟（服务端的 relayTicketTTL），而通道握手会一次次重做，所以「手上
   * 这张还能不能用」必须问得出来——问不出来就只能一直用建通道那一刻那张，几分钟
   * 之后它就是一句 `account credential expired`。
   */
  expiresAt: number;
  /**
   * 这个账号的网页对端身份，由服务端从账号派生并签在票的 pfp claim 里（决策 8/9）。
   * 浏览器只读不写。被否掉的是「浏览器自己生成一个存 localStorage 的随机数」：
   * 那样清一次站点数据就换人，此前从网页发起的对话会在账号镜像里当场成为孤儿。
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
    expiresAt: Date.now() + response.expires_in * 1000,
    clientId: response.client_id,
    clientName: browserDisplayName(),
  };
}
