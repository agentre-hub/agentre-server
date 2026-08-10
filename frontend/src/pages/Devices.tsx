import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { deviceKindLabel } from "@/lib/deviceKind";

interface DeviceItem {
  id: number;
  name: string;
  kind: string;
  platform: string;
  version: string;
  fingerprint: string;
  last_seen_at: number;
  status: number;
  online: boolean;
  is_this_device: boolean;
}

interface RunnableAgentItem {
  sync_id: string;
  name: string;
  rank: number;
}

interface ProjectItem {
  sync_id: string;
  name: string;
  configured: boolean;
}

interface DeviceDetail {
  device_id: number;
  kind: string;
  runnable_agents?: RunnableAgentItem[];
  projects: ProjectItem[];
}

const ACTIVE = 1;
const KIND_AGENTRED = "agentred";

// 只有 ApiError 才带可展示的服务端文案；其余(代理返回非 JSON 的 502 → SyntaxError、
// 离线 → TypeError)同样是失败，必须说出来 —— 静默吞掉会让页面渲染成「还没有任何
// 设备」，而用户名下的设备一台没少。
function loadErrorText(e: unknown, t: (key: string) => string): string {
  return e instanceof ApiError ? e.message : t("device.manage.loadError");
}

function detailErrorText(e: unknown, t: (key: string) => string): string {
  return e instanceof ApiError ? e.message : t("device.manage.detailLoadError");
}

function formatLastActive(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

/**
 * 设备行展开的详情：agentred 列「能跑的 Agent」（带档位）、「已配置的项目」与
 * 「对话」一节（R4 下钻入口，mockup 帧 47）；桌面端只列「项目」。
 * 对话一节：在线的 agentred 给「查看这台机器的对话」入口；离线的不可进入，
 * 就地标明离线与最后在线时间（R4）。
 */
function DeviceExpandDetail({
  state,
  device,
  t,
}: {
  state: { loading: boolean; error: unknown; data: DeviceDetail | null };
  device: DeviceItem;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (state.loading) {
    return (
      <p className="pl-6 text-sm text-muted-foreground">
        {t("common.loading")}
      </p>
    );
  }
  if (state.error) {
    return (
      <Alert variant="destructive" className="ml-6">
        {detailErrorText(state.error, t)}
      </Alert>
    );
  }
  const detail = state.data;
  if (!detail) return null;
  const isAgentred = detail.kind === KIND_AGENTRED;

  return (
    <div className="flex flex-col gap-2 border-t border-border pl-6 pt-2.5">
      {isAgentred && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] font-medium text-subtle-foreground">
            {t("device.manage.runnableAgents")}
          </span>
          {(detail.runnable_agents ?? []).length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("device.manage.noRunnableAgents")}
            </span>
          ) : (
            (detail.runnable_agents ?? []).map((a) => (
              <span
                key={a.sync_id}
                className="inline-flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {a.name}
                <span className="font-mono text-[9px] text-subtle-foreground">
                  {t("device.manage.rankLabel", { rank: a.rank })}
                </span>
              </span>
            ))
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] font-medium text-subtle-foreground">
          {t("device.manage.projects")}
        </span>
        {detail.projects.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("device.manage.noProjectsReported")}
          </span>
        ) : (
          detail.projects.map((p) => (
            <span
              key={p.sync_id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs",
                p.configured
                  ? "bg-muted text-muted-foreground"
                  : "bg-status-waiting-bg text-status-waiting",
              )}
            >
              {p.name}
              <span className="font-mono text-[9px]">
                {p.configured
                  ? t("device.manage.configured")
                  : t("device.manage.notConfigured")}
              </span>
            </span>
          ))
        )}
      </div>
      <p className="font-mono text-[9.5px] text-subtle-foreground">
        {t("device.manage.projectsNote")}
      </p>
      {!isAgentred && (
        <p className="font-mono text-[9.5px] text-subtle-foreground">
          {t("device.manage.agentsAccountNote")}
        </p>
      )}
      {isAgentred && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
          <span className="font-mono text-[10px] font-medium text-subtle-foreground">
            {t("device.manage.sessions")}
          </span>
          {device.online ? (
            <Link
              to={`/devices/${device.id}/sessions`}
              className="inline-flex w-fit items-center text-xs font-medium text-primary-text hover:underline"
            >
              {t("device.manage.viewSessions")}
            </Link>
          ) : (
            <p className="text-xs text-destructive">
              {t("device.manage.offlineNotEnterable")}
              {device.last_seen_at > 0
                ? ` ${new Date(device.last_seen_at).toLocaleString()}`
                : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Devices() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 存住失败本身，渲染时才翻译成文案：effect 里不碰 t，就不必把它拉进依赖数组
  // （语言切换不该重新拉一次设备列表）。
  const [loadError, setLoadError] = useState<unknown>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<DeviceItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [details, setDetails] = useState<
    Record<
      number,
      { loading: boolean; error: unknown; data: DeviceDetail | null }
    >
  >({});

  // 只负责取数据，不碰状态；由调用方决定怎么落状态。
  async function fetchDevices(): Promise<DeviceItem[]> {
    const got = await api<{ devices: DeviceItem[] }>("/v1/devices");
    return got.devices;
  }

  function applyList(list: DeviceItem[]) {
    setDevices(list);
    setLoadError(null);
  }

  useEffect(() => {
    let alive = true;
    fetchDevices()
      .then((list) => {
        if (alive) applyList(list);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e ?? new Error("device list load failed"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  function toggleExpand(d: DeviceItem) {
    const collapsing = expanded.has(d.id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(d.id)) {
        next.delete(d.id);
        return next;
      }
      next.add(d.id);
      return next;
    });
    if (collapsing) return;
    // 已经取到过就不重复取——展开/收起只是显示态切换。
    //
    // 「取到过」不包含取失败：页面上没有重试按钮，把失败也缓存住等于这一行的详情
    // 在整个页面生命周期里永久坏掉，只能整页刷新。失败后再展开就重试一次。
    const cached = details[d.id];
    if (cached && (cached.loading || !cached.error)) return;
    setDetails((prev) => ({
      ...prev,
      [d.id]: { loading: true, error: null, data: null },
    }));
    api<DeviceDetail>(`/v1/workspace/device-detail?device_id=${d.id}`)
      .then((data) => {
        setDetails((prev) => ({
          ...prev,
          [d.id]: { loading: false, error: null, data },
        }));
      })
      .catch((e: unknown) => {
        setDetails((prev) => ({
          ...prev,
          [d.id]: {
            loading: false,
            error: e ?? new Error("device detail load failed"),
            data: null,
          },
        }));
      });
  }

  async function onRevoke() {
    if (!revoking) return;
    setSubmitting(true);
    setRevokeError(null);
    try {
      await api(`/v1/oauth/token/revoke`, {
        method: "POST",
        body: JSON.stringify({ device_id: revoking.id }),
      });
      setRevoking(null);
    } catch {
      setRevokeError(t("device.manage.revokeError"));
      setSubmitting(false);
      return;
    }
    try {
      applyList(await fetchDevices());
    } catch (e: unknown) {
      setLoadError(e ?? new Error("device list load failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{t("device.manage.title")}</h1>
        </div>

        {loadError !== null && (
          <Alert variant="destructive">{loadErrorText(loadError, t)}</Alert>
        )}

        {/* 加载失败时只留上面那条错误：不得改口说「还没有任何设备」——
            那是一句我们此刻答不上来的断言。 */}
        {loading ? (
          <p className="text-muted-foreground">{t("common.loading")}</p>
        ) : loadError !== null &&
          devices.length === 0 ? null : devices.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground">
              {t("device.manage.empty")}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {devices.map((d) => {
              const isExpanded = expanded.has(d.id);
              return (
                <Card key={d.id} className="py-4">
                  <CardHeader className="px-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="truncate">{d.name}</CardTitle>
                        <CardDescription className="mt-1">
                          {deviceKindLabel(d.kind, t)}
                          {d.platform ? ` · ${d.platform}` : ""}
                          {d.version ? ` ${d.version}` : ""}
                          {d.is_this_device
                            ? ` · ${t("device.manage.thisDevice")}`
                            : ""}
                        </CardDescription>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? t("device.manage.collapse")
                              : t("device.manage.expand")
                          }
                          onClick={() => toggleExpand(d)}
                        >
                          {isExpanded ? <ChevronUp /> : <ChevronDown />}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            setRevokeError(null);
                            setRevoking(d);
                          }}
                        >
                          {t("device.manage.revoke")}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 text-sm text-muted-foreground">
                    <span>
                      {t("device.manage.colLastActive")}:{" "}
                      {formatLastActive(d.last_seen_at)}
                    </span>
                    <span>
                      {t("device.manage.colStatus")}:{" "}
                      {d.status !== ACTIVE
                        ? t("device.manage.statusRevoked")
                        : d.online
                          ? t("device.manage.statusOnline")
                          : t("device.manage.statusOffline")}
                    </span>
                  </CardContent>
                  {isExpanded && (
                    <CardContent className="px-5">
                      <DeviceExpandDetail
                        state={
                          details[d.id] ?? {
                            loading: true,
                            error: null,
                            data: null,
                          }
                        }
                        device={d}
                        t={t}
                      />
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        <Dialog
          open={!!revoking}
          onOpenChange={(o) => {
            if (!o && !submitting) {
              setRevokeError(null);
              setRevoking(null);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("device.manage.revokeConfirmTitle")}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogDescription className="text-[13px] leading-relaxed">
                {t("device.manage.revokeConfirmBody")}
              </DialogDescription>
              {revokeError && (
                <Alert variant="destructive" className="mt-3">
                  {revokeError}
                </Alert>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => setRevoking(null)}
              >
                {t("device.manage.revokeCancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={submitting}
                onClick={onRevoke}
              >
                {t("device.manage.revokeConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}
