import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import AppShell from "@/components/AppShell";
import SessionList, {
  type SessionAgent,
} from "@/components/session/SessionList";
import SessionStatusBanner from "@/components/session/SessionStatusBanner";
import { useIsMobile } from "@/components/use-is-mobile";
import { useRelayMachine } from "@/hooks/use-relay";
import { api, ApiError } from "@/lib/api";
import {
  deriveSessionViewStatus,
  type SessionViewStatus,
} from "@/lib/sessionView";
import { WebDeviceRevokedError, markWebDeviceRevoked } from "@/lib/webDevice";
import {
  decodeSessionListResult,
  MethodSessionList,
  type SessionSummary,
} from "@/lib/wire";

interface DeviceItem {
  id: number;
  name: string;
  kind: string;
  fingerprint: string;
  last_seen_at: number;
  status: number;
  online: boolean;
}

interface FollowItem {
  device_fingerprint: string;
  session_id: string;
}

function loadErrorText(e: unknown, t: (k: string) => string): string {
  return e instanceof ApiError ? e.message : t("device.manage.loadError");
}

export default function DeviceSessions() {
  const { deviceId } = useParams();
  const id = Number(deviceId);
  const { t } = useTranslation();
  const nav = useNavigate();

  const [device, setDevice] = useState<DeviceItem | null>(null);
  // 账号下全部可下钻目标：面包屑行尾的「换机器」就地切换要用。
  const [machines, setMachines] = useState<DeviceItem[]>([]);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [deviceError, setDeviceError] = useState<unknown>(null);
  const [agents, setAgents] = useState<SessionAgent[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  // 未升级的 agentred 的 session.list 应答里没有 supportsSessionMetadata（兼容性）。
  const [needsUpgrade, setNeedsUpgrade] = useState(false);
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  const [machineOnline, setMachineOnline] = useState<boolean | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [meValid, setMeValid] = useState(true);
  const probedRef = useRef(false);

  const { client, relayState, webDevice, webDeviceError } = useRelayMachine(
    device?.online ? device.fingerprint : null,
  );
  const isMobile = useIsMobile();

  // 取设备与账号级 Agent 清单（块 1 的 /v1/workspace/agents）。
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ devices: DeviceItem[] }>("/v1/devices"),
      api<{ agents: SessionAgent[] }>("/v1/workspace/agents"),
    ])
      .then(([devRes, agentRes]) => {
        if (!alive) return;
        // 浏览器不是可下钻目标；agentred 与桌面端复用同一套列表/详情页面。
        setMachines(
          devRes.devices.filter(
            (d) => d.kind === "agentred" || d.kind === "desktop",
          ),
        );
        const found = devRes.devices.find((d) => d.id === id);
        if (found) {
          setDevice(found);
          setMachineOnline(found.online);
        } else {
          setDeviceError(new Error("device not found"));
        }
        setAgents(agentRes.agents);
      })
      .catch((e: unknown) => {
        if (alive) setDeviceError(e);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // 账号级关注名单（R14：在哪一端打开这一页读到的都是同一份）。它与列表本身
  // 相互独立——名单取不到只是开关暂时显示为「未关注」，不该让整页读不出来。
  useEffect(() => {
    const fp = device?.fingerprint;
    if (!fp) return;
    let alive = true;
    api<{ items: FollowItem[] }>("/v1/follows")
      .then((res) => {
        if (!alive) return;
        setFollowed(
          new Set(
            (res.items ?? [])
              .filter((f) => f.device_fingerprint === fp)
              .map((f) => Number(f.session_id)),
          ),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [device?.fingerprint]);

  // 已连接 → 列会话。
  useEffect(() => {
    if (!client || relayState !== "connected") return;
    let alive = true;
    client
      .request(MethodSessionList)
      .then((raw) => {
        if (!alive) return;
        const res = decodeSessionListResult(raw);
        setSessions(res.sessions);
        // 老 agentred 不认识这个字段；桌面端清单由本轮实现，始终是完整形态。
        setNeedsUpgrade(
          device?.kind === "agentred" && !res.supportsSessionMetadata,
        );
        setSessionsLoaded(true);
      })
      .catch(() => {
        // 列表失败不打断重连；下一次重连 / 手动操作再试。
      });
    return () => {
      alive = false;
    };
  }, [client, relayState, device?.kind]);

  // 首次进入 reconnecting（= 连接失败）时探测原因：机器离线 / 设备被解除授权 /
  // 账号登出。只探一次（ref 守门，不触发重渲染）。
  const probe = useCallback(() => {
    if (probedRef.current) return;
    probedRef.current = true;
    api<{ devices: DeviceItem[] }>("/v1/devices")
      .then((res) => {
        // R2 / R11：/v1/devices 只回**活跃**设备，被解除授权的行直接不在里面。
        // 因此判据是「自己这台还在不在清单里」，不是它的 status——按 status 判
        // 永远判不出来，那个分支不可达。指纹还没取到时不判（避免误报）。
        const myFingerprint = webDevice?.fingerprint;
        if (
          myFingerprint &&
          !res.devices.some((d) => d.fingerprint === myFingerprint)
        ) {
          markWebDeviceRevoked();
          setRevoked(true);
          return;
        }
        const machine = res.devices.find((d) => d.id === id);
        setMachineOnline(machine?.online ?? null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setMeValid(false);
      });
  }, [webDevice?.fingerprint, id]);

  useEffect(() => {
    if (relayState === "reconnecting") probe();
  }, [relayState, probe]);

  // R12：关注 / 取消关注一条会话。名单是账号级的（R14），因此写的是 server 上的
  // 那一份；本地集合乐观更新，失败则回滚（开关不能说谎）。
  const toggleFollow = useCallback(
    (sessionId: number) => {
      const fp = device?.fingerprint;
      if (!fp) return;
      const wasFollowed = followed.has(sessionId);
      setFollowed((prev) => {
        const next = new Set(prev);
        if (wasFollowed) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
      api(wasFollowed ? "/v1/follows/unfollow" : "/v1/follows", {
        method: "POST",
        body: JSON.stringify({
          device_fingerprint: fp,
          session_id: String(sessionId),
        }),
      }).catch(() => {
        setFollowed((prev) => {
          const next = new Set(prev);
          if (wasFollowed) next.add(sessionId);
          else next.delete(sessionId);
          return next;
        });
      });
    },
    [device?.fingerprint, followed],
  );

  // ensureWebDevice 直接抛「已被解除授权」时同样进入 revoked 态。
  const revokedNow = revoked || webDeviceError instanceof WebDeviceRevokedError;
  const status: SessionViewStatus = deriveSessionViewStatus({
    relayState,
    meValid,
    webDeviceRevoked: revokedNow,
    machineOnline,
    targetKind: device?.kind,
  });

  if (deviceError) {
    return (
      <AppShell>
        <Alert variant="destructive">{loadErrorText(deviceError, t)}</Alert>
      </AppShell>
    );
  }

  const count = sessions.length;
  return (
    <AppShell title={device?.name}>
      <div className="mx-auto w-full max-w-3xl space-y-5">
        {/* 机器语境放顶栏（决策 11，mockup 45a）：机器名已在 TopBar title 槽。
            移动是下钻三联的中间一页（屏 48b）：返回箭头 + 在线态；桌面保留完整面包屑 + 换机器。 */}
        <nav
          aria-label={t("session.breadcrumb.devices")}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          {isMobile ? (
            <>
              <Link
                to="/devices"
                aria-label={t("session.breadcrumb.back")}
                className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="size-5" aria-hidden="true" />
              </Link>
              <span
                className={
                  machineOnline === false
                    ? "text-destructive"
                    : "text-status-waiting"
                }
              >
                {machineOnline === false
                  ? t(
                      device?.kind === "desktop"
                        ? "device.manage.desktopAppNotRunningShort"
                        : "session.breadcrumb.offline",
                    )
                  : t("session.breadcrumb.online")}
              </span>
            </>
          ) : (
            <>
              <Link
                to="/devices"
                className="font-medium text-muted-foreground hover:text-foreground"
              >
                {t("session.breadcrumb.devices")}
              </Link>
              <span
                className={
                  machineOnline === false
                    ? "text-destructive"
                    : "text-status-waiting"
                }
              >
                {machineOnline === false
                  ? t(
                      device?.kind === "desktop"
                        ? "device.manage.desktopAppNotRunningShort"
                        : "session.breadcrumb.offline",
                    )
                  : t("session.breadcrumb.online")}
              </span>
              {count > 0 && (
                <span className="text-xs text-subtle-foreground">
                  {t("session.breadcrumb.count", { count })}
                </span>
              )}
              <span className="flex-1" />
              {/* 决策 11 / 帧 45a：行尾一个「换机器」入口**就地切换** —— 不把人
                  送回设备页从头下钻一次。离线的机器就地标明离线、不可进入（R4）。 */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSwitchOpen(true)}
              >
                {t("session.breadcrumb.switchMachine")}
              </Button>
            </>
          )}
        </nav>

        <Dialog open={switchOpen} onOpenChange={setSwitchOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("session.breadcrumb.switchMachine")}</DialogTitle>
            </DialogHeader>
            <ul className="flex flex-col gap-1">
              {machines.map((m) => (
                <li key={m.id}>
                  {m.online ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                      onClick={() => {
                        setSwitchOpen(false);
                        nav(`/devices/${m.id}/sessions`);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {m.name}
                      </span>
                      <span className="shrink-0 text-xs text-status-waiting">
                        {t("session.breadcrumb.online")}
                      </span>
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm opacity-60">
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {m.name}
                      </span>
                      <span className="shrink-0 text-xs text-destructive">
                        {t(
                          m.kind === "desktop"
                            ? "device.manage.desktopAppNotRunningShort"
                            : "session.breadcrumb.offline",
                        )}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>

        <SessionStatusBanner
          status={status}
          machineLastSeenMs={device?.last_seen_at}
        />

        {/* 兼容性：未升级的 agentred 照常工作，但会话只能按 R5 退化显示、R9 的
            发消息不可用——如实说明它需要升级，不静默失败。 */}
        {status === "connected" && sessionsLoaded && needsUpgrade && (
          <Alert role="status">{t("session.needsUpgrade")}</Alert>
        )}

        {status === "connected" &&
          (sessionsLoaded ? (
            <SessionList
              sessions={sessions}
              agents={agents}
              sessionPath={(sid) => `/devices/${id}/sessions/${sid}`}
              followedSessionIds={followed}
              onToggleFollow={toggleFollow}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("common.loading")}
            </p>
          ))}
        {status === "connecting" && (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        )}
      </div>
    </AppShell>
  );
}
