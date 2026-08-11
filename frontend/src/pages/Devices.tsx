import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Cpu, MonitorX } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, RowMenu, StatusMark } from "@/components/console";
import type { StatusTone } from "@/components/console";
import AppShell from "@/components/AppShell";
import { useIsMobile } from "@/components/use-is-mobile";
import { useRelayMachine } from "@/hooks/use-relay";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { decodeSessionListResult, MethodSessionList } from "@/lib/wire";
import { DEVICE_KIND_ICONS, deviceKindLabel } from "@/lib/deviceKind";

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

/** relay session.list 解析出的会话计数（含副行要的 running 数）。 */
interface SessionCounts {
  total: number;
  waiting: number;
  running: number;
}

const ACTIVE = 1;
const KIND_AGENTRED = "agentred";
const KIND_DESKTOP = "desktop";

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

/** 行首状态点（装饰）：online=运行绿，其余=中性灰。颜色不是状态的唯一表达—— */
function statusDotClass(d: DeviceItem): string {
  if (d.status !== ACTIVE) return "bg-muted-foreground/70";
  return d.online ? "bg-status-running" : "bg-muted-foreground/70";
}

function statusTone(d: DeviceItem): StatusTone {
  if (d.status !== ACTIVE) return "idle";
  return d.online ? "running" : "idle";
}

function statusLabel(d: DeviceItem, t: (key: string) => string): string {
  if (d.status !== ACTIVE) return t("device.manage.statusRevoked");
  return d.online
    ? t("device.manage.statusOnline")
    : d.kind === KIND_DESKTOP
      ? t("device.manage.desktopAppNotRunningShort")
      : t("device.manage.statusOffline");
}

/** 设备是否可撤销：撤销端点只认属于本账号的 ACTIVE 设备；已撤销的没有凭据可撤。 */
function isRevocable(d: DeviceItem): boolean {
  return d.status === ACTIVE;
}

/**
 * 一台目标设备（桌面端或 agentred）的会话计数（总条数 / 等待处理 / 在跑）。
 * server 一条会话都不存（硬不变量），唯一真相源是那台设备的 relay session.list ——
 * 现连现问，展开时才挂载，收起即断开；问不到就返回 null，调用方不得编数字。
 *
 * 「在跑」数是设备卡副行 cardSummary 的 {{m}}；「对话」一节用 total/waiting。
 */
function useSessionCounts(
  fingerprint: string | null,
  active: boolean,
): SessionCounts | null {
  const { client, relayState } = useRelayMachine(fingerprint);
  const [counts, setCounts] = useState<SessionCounts | null>(null);

  useEffect(() => {
    if (!active || !client || relayState !== "connected") return;
    let alive = true;
    client
      .request(MethodSessionList)
      .then((raw) => {
        if (!alive) return;
        const res = decodeSessionListResult(raw);
        setCounts({
          total: res.sessions.length,
          waiting: res.sessions.filter((s) => s.waitingForInput).length,
          running: res.sessions.filter((s) => s.lifecycleState === "running")
            .length,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active, client, relayState]);

  return counts;
}

/**
 * 设备行展开的详情：agentred 列「能跑的 Agent」（带档位）、「已配置的项目」与
 * 「对话」一节（R4 下钻入口，mockup 帧 47）；桌面端列项目。
 * 对话一节：两类目标复用同形入口 —— 在线给「查看这台机器 / 这个桌面端的对话」；
 * 不可达时 agentred 保留既有离线措辞，桌面端明确说明 Agentre App 没有运行并提示打开它。
 * 会话计数由外层 useSessionCounts 提供，这里不再各自连一次中继。
 *
 * 只渲染真实数据；N1/N2 旁白（「只显示是否配置」「Agent 属于账号」）不进入产品。
 */
function DeviceExpandDetail({
  state,
  device,
  counts,
  t,
}: {
  state: { loading: boolean; error: unknown; data: DeviceDetail | null };
  device: DeviceItem;
  counts: SessionCounts | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (state.loading) {
    return (
      <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
    );
  }
  if (state.error) {
    return (
      <Alert variant="destructive">{detailErrorText(state.error, t)}</Alert>
    );
  }
  const detail = state.data;
  if (!detail) return null;
  const isAgentred = detail.kind === KIND_AGENTRED;
  const isDesktop = detail.kind === KIND_DESKTOP;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      {isAgentred && (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] font-medium text-subtle-foreground">
            {t("device.manage.runnableAgents")}
          </span>
          {(detail.runnable_agents ?? []).length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("device.manage.noRunnableAgents")}
            </span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {(detail.runnable_agents ?? []).map((a) => (
                <span
                  key={a.sync_id}
                  className="inline-flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {a.name}
                  <span className="font-mono text-[9px] text-subtle-foreground">
                    {t("device.manage.rankLabel", { rank: a.rank })}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] font-medium text-subtle-foreground">
          {t("device.manage.projects")}
        </span>
        {detail.projects.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("device.manage.noProjectsReported")}
          </span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {detail.projects.map((p) => (
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
            ))}
          </div>
        )}
      </div>
      {(isAgentred || isDesktop) && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <span className="font-mono text-[10px] font-medium text-subtle-foreground">
            {t("device.manage.sessions")}
          </span>
          {device.online ? (
            <>
              {counts && (
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>
                    {t("device.manage.sessionCount", { count: counts.total })}
                  </span>
                  {counts.waiting > 0 && (
                    <span className="text-status-waiting">
                      {t("device.manage.sessionWaiting", {
                        count: counts.waiting,
                      })}
                    </span>
                  )}
                </p>
              )}
              <Link
                to={`/devices/${device.id}/sessions`}
                data-testid={`device-sessions-link-${device.id}`}
                className="inline-flex w-fit items-center text-xs font-medium text-primary-text hover:underline"
              >
                {t(
                  isDesktop
                    ? "device.manage.viewDesktopSessions"
                    : "device.manage.viewSessions",
                )}
              </Link>
            </>
          ) : (
            <p className="text-xs text-destructive">
              {t(
                isDesktop
                  ? "device.manage.desktopAppNotRunningDetail"
                  : "device.manage.offlineNotEnterable",
              )}
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

/** 设备行图标：从模块级常量取 kind → lucide 图标，装饰且 aria-hidden。 */
function DeviceIcon({
  Icon,
  testId,
  className,
}: {
  Icon: LucideIcon;
  testId?: string;
  className?: string;
}) {
  return <Icon aria-hidden="true" data-testid={testId} className={className} />;
}

/**
 * 一台设备的行。桌面（Q6qgs4/Ukz7i）：状态点 + 设备图标 + 名 + 类型 chip +
 * 状态标记 + 副行（Meta · 项目/对话总结）+ 可展开详情 + 行级菜单；移动（HUELX）：
 * 图标方框 + 名/类型 + Meta 的行式信息顺序。接单开关、并发负载条等无真实能力的
 * 控件不渲染（也不以禁用开关冒充）。撤销进入行级更多菜单，常驻危险说明卡已删除。
 */
function DeviceRow({
  d,
  isMobile,
  isExpanded,
  onToggle,
  onRevoke,
  detailState,
  t,
}: {
  d: DeviceItem;
  isMobile: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onRevoke: () => void;
  detailState: { loading: boolean; error: unknown; data: DeviceDetail | null };
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  // 只有展开的在线 agentred / 桌面端才去问中继；其余设备 fingerprint 传 null，不连。
  const sessionActive =
    isExpanded &&
    (d.kind === KIND_AGENTRED || d.kind === KIND_DESKTOP) &&
    d.online;
  const counts = useSessionCounts(
    sessionActive ? d.fingerprint : null,
    sessionActive,
  );
  const detail = detailState.data;
  const projectCount = detail ? detail.projects.length : null;
  // 项目数与对话在跑数缺一就不渲染副行 —— 不编数字。
  const subRow =
    projectCount !== null && counts !== null
      ? t("device.manage.cardSummary", {
          projects: projectCount,
          m: counts.running,
        })
      : null;

  const meta = [d.platform, d.version, formatLastActive(d.last_seen_at)]
    .filter(Boolean)
    .join(" · ");

  const revocable = isRevocable(d);
  // 帧 47：浏览器行不接单、也不可展开——展开区列的是项目与能跑的 Agent，
  // 浏览器两样都没有。
  const expandable = d.kind !== "web";

  if (isMobile) {
    return (
      <Card
        className="gap-0 rounded-lg border-border bg-card py-3 shadow-none"
        data-testid={`device-row-${d.id}`}
      >
        <div className="flex items-center gap-3 px-4">
          {/* 图标方框：移动端的信息顺序以图标开头（HUELX） */}
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <DeviceIcon
              Icon={DEVICE_KIND_ICONS[d.kind] ?? Cpu}
              testId={`device-icon-${d.id}`}
              className="size-[18px] text-muted-foreground"
            />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  statusDotClass(d),
                )}
              />
              <span className="truncate text-sm font-medium text-foreground">
                {d.name}
              </span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                {deviceKindLabel(d.kind, t)}
              </span>
            </div>
            <span className="truncate font-mono text-xs text-subtle-foreground">
              {meta}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <StatusMark
              tone={statusTone(d)}
              label={statusLabel(d, t)}
              testId={`device-status-${d.id}`}
            />
            {expandable && (
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid={`device-expand-${d.id}`}
                aria-expanded={isExpanded}
                aria-label={
                  isExpanded
                    ? t("device.manage.collapse")
                    : t("device.manage.expand")
                }
                onClick={onToggle}
              >
                {isExpanded ? <ChevronUp /> : <ChevronDown />}
              </Button>
            )}
            {revocable && (
              <RowMenu
                label={t("console.aria.rowActions")}
                testId={`device-menu-${d.id}`}
                items={[
                  {
                    key: "revoke",
                    label: t("device.manage.revokeConfirm"),
                    danger: true,
                    onSelect: onRevoke,
                  },
                ]}
              />
            )}
          </div>
        </div>
        {isExpanded && (
          <div className="px-4 pt-3">
            <DeviceExpandDetail
              state={detailState}
              device={d}
              counts={counts}
              t={t}
            />
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card
      className="gap-0 rounded-lg border-border bg-card py-4 shadow-none"
      data-testid={`device-row-${d.id}`}
    >
      {/* 标题行（Q6qgs4 R1）：状态点 + 设备图标 + 名 + 类型 chip + 状态标记 */}
      <div className="flex items-center gap-3 px-5">
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", statusDotClass(d))}
        />
        <DeviceIcon
          Icon={DEVICE_KIND_ICONS[d.kind] ?? Cpu}
          testId={`device-icon-${d.id}`}
          className="size-[18px] shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          {d.name}
        </span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
          {deviceKindLabel(d.kind, t)}
        </span>
        <StatusMark
          tone={statusTone(d)}
          label={statusLabel(d, t)}
          testId={`device-status-${d.id}`}
        />
        {expandable && (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid={`device-expand-${d.id}`}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t("device.manage.collapse")
                : t("device.manage.expand")
            }
            onClick={onToggle}
          >
            {isExpanded ? <ChevronUp /> : <ChevronDown />}
          </Button>
        )}
        {revocable && (
          <RowMenu
            label={t("console.aria.rowActions")}
            testId={`device-menu-${d.id}`}
            items={[
              {
                key: "revoke",
                label: t("device.manage.revokeConfirm"),
                danger: true,
                onSelect: onRevoke,
              },
            ]}
          />
        )}
      </div>
      {/* 副行（Q6qgs4 R2）：Meta · 项目/对话在跑（有数据才显示） */}
      <div className="flex flex-wrap items-center gap-x-2 px-5 pt-1.5">
        <span className="font-mono text-xs text-subtle-foreground">{meta}</span>
        {subRow && (
          <span className="text-xs text-muted-foreground">{subRow}</span>
        )}
      </div>
      {isExpanded && (
        <div className="px-5 pt-3">
          <DeviceExpandDetail
            state={detailState}
            device={d}
            counts={counts}
            t={t}
          />
        </div>
      )}
    </Card>
  );
}

export default function Devices() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
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
      // 失败时保留对话上下文并显示真实错误，设备行不动
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

  const deviceCount = !loading && loadError === null ? devices.length : null;
  const hasOnlineAgentred = devices.some(
    (d) => d.kind === KIND_AGENTRED && d.online,
  );

  return (
    <AppShell
      title={t("nav.devices")}
      right={
        <>
          {deviceCount !== null && (
            <span
              data-testid="devices-count"
              aria-label={t("device.manage.countLabel", {
                count: deviceCount,
              })}
              className="font-mono text-xs text-subtle-foreground"
            >
              {deviceCount}
            </span>
          )}
          {hasOnlineAgentred && (
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-[6px] rounded-full bg-status-running"
              />
              <span className="text-xs text-muted-foreground">
                {t("appShell.topBar.fresh")}
              </span>
            </span>
          )}
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5">
        {/* 设备行列表（桌面与移动共用；不再有右列常驻撤销说明卡） */}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {loadError !== null && (
            <Alert variant="destructive">{loadErrorText(loadError, t)}</Alert>
          )}

          {/* 加载失败时只留上面那条错误：不得改口说「还没有任何设备」——
              那是一句我们此刻答不上来的断言。 */}
          {loading ? (
            <p className="text-muted-foreground">{t("common.loading")}</p>
          ) : loadError !== null &&
            devices.length === 0 ? null : devices.length === 0 ? (
            <Card className="gap-0 rounded-lg border-border bg-card py-4 shadow-none">
              <EmptyState icon={MonitorX} title={t("device.manage.empty")} />
            </Card>
          ) : (
            devices.map((d) => (
              <DeviceRow
                key={d.id}
                d={d}
                isMobile={isMobile}
                isExpanded={expanded.has(d.id)}
                onToggle={() => toggleExpand(d)}
                onRevoke={() => {
                  setRevokeError(null);
                  setRevoking(d);
                }}
                detailState={
                  details[d.id] ?? {
                    loading: true,
                    error: null,
                    data: null,
                  }
                }
                t={t}
              />
            ))
          )}
        </div>
      </div>

      {/* 撤销确认：由行级菜单进入；失败保留上下文显示真实错误，成功刷新真实状态 */}
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
    </AppShell>
  );
}
