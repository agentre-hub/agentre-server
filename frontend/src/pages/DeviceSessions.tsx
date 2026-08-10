import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

const ACTIVE = 1;

function loadErrorText(e: unknown, t: (k: string) => string): string {
  return e instanceof ApiError ? e.message : t("device.manage.loadError");
}

export default function DeviceSessions() {
  const { deviceId } = useParams();
  const id = Number(deviceId);
  const { t } = useTranslation();
  const nav = useNavigate();

  const [device, setDevice] = useState<DeviceItem | null>(null);
  const [deviceError, setDeviceError] = useState<unknown>(null);
  const [agents, setAgents] = useState<SessionAgent[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [machineOnline, setMachineOnline] = useState<boolean | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [meValid, setMeValid] = useState(true);
  const probedRef = useRef(false);

  const { client, relayState, webDeviceError } = useRelayMachine(
    device?.fingerprint ?? null,
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
        setSessionsLoaded(true);
      })
      .catch(() => {
        // 列表失败不打断重连；下一次重连 / 手动操作再试。
      });
    return () => {
      alive = false;
    };
  }, [client, relayState]);

  // 首次进入 reconnecting（= 连接失败）时探测原因：机器离线 / 设备被解除授权 /
  // 账号登出。只探一次（ref 守门，不触发重渲染）。
  const probe = useCallback(() => {
    if (probedRef.current) return;
    probedRef.current = true;
    api<{ devices: DeviceItem[] }>("/v1/devices")
      .then((res) => {
        const my = res.devices.find(
          (d) => d.fingerprint === device?.fingerprint,
        );
        const machine = res.devices.find((d) => d.id === id);
        if (my && my.status !== ACTIVE) {
          markWebDeviceRevoked();
          setRevoked(true);
          return;
        }
        setMachineOnline(machine?.online ?? null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setMeValid(false);
      });
  }, [device?.fingerprint, id]);

  useEffect(() => {
    if (relayState === "reconnecting") probe();
  }, [relayState, probe]);

  // ensureWebDevice 直接抛「已被解除授权」时同样进入 revoked 态。
  const revokedNow = revoked || webDeviceError instanceof WebDeviceRevokedError;
  const status: SessionViewStatus = deriveSessionViewStatus({
    relayState,
    meValid,
    webDeviceRevoked: revokedNow,
    machineOnline,
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
    <AppShell>
      <div className="mx-auto w-full max-w-3xl space-y-5">
        {/* 机器语境放顶栏（决策 11，mockup 45a）。移动是下钻三联的中间一页
            （屏 48b）：返回箭头 + 机器名 + 在线态；桌面保留完整面包屑 + 换机器。 */}
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
              <span className="truncate font-semibold text-foreground">
                {device?.name ?? ""}
              </span>
              <span
                className={
                  machineOnline === false
                    ? "text-destructive"
                    : "text-status-waiting"
                }
              >
                {machineOnline === false
                  ? t("session.breadcrumb.offline")
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
              <span aria-hidden="true" className="text-subtle-foreground">
                /
              </span>
              <span className="font-semibold text-foreground">
                {device?.name ?? ""}
              </span>
              <span
                className={
                  machineOnline === false
                    ? "text-destructive"
                    : "text-status-waiting"
                }
              >
                {machineOnline === false
                  ? t("session.breadcrumb.offline")
                  : t("session.breadcrumb.online")}
              </span>
              {count > 0 && (
                <span className="text-xs text-subtle-foreground">
                  {t("session.breadcrumb.count", { count })}
                </span>
              )}
              <span className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => nav("/devices")}
              >
                {t("session.breadcrumb.switchMachine")}
              </Button>
            </>
          )}
        </nav>

        <SessionStatusBanner
          status={status}
          machineLastSeenMs={device?.last_seen_at}
        />

        {status === "connected" &&
          (sessionsLoaded ? (
            <SessionList
              sessions={sessions}
              agents={agents}
              sessionPath={(sid) => `/devices/${id}/sessions/${sid}`}
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
