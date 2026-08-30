import { api } from "@/lib/api";
import { randomId } from "@/lib/randomId";

const CLIENT_ID_KEY = "agentre.browserClientId";

export function browserClientId(): string {
  const existing = storedBrowserClientId();
  if (existing) return existing;
  const created = randomId();
  localStorage.setItem(CLIENT_ID_KEY, created);
  return created;
}

export function storedBrowserClientId(): string | null {
  const current = localStorage.getItem(CLIENT_ID_KEY);
  return current;
}

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
  clientId: string;
  clientName: string;
}

export async function ensureRelayTicket(): Promise<RelayTicket> {
  const response = await api<{ access_token: string; expires_in: number }>(
    "/v1/relay/ticket",
    { method: "POST" },
  );
  return {
    accessToken: response.access_token,
    clientId: browserClientId(),
    clientName: browserDisplayName(),
  };
}
