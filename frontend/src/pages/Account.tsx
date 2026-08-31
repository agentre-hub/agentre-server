import { KeyRound, Monitor, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import AppShell from "@/components/AppShell";
import { EmptyState, StatusMark } from "@/components/console";
import {
  Alert,
  AlertDescription,
  Button,
  DialogShell,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  DialogShellSubmit,
  Input,
  cn,
} from "@agentre-hub/agentre-ui";
import { useAliveEffect } from "@/hooks/use-api-query";
import { useMe } from "@/hooks/use-me";
import { api, ApiError } from "@/lib/api";
import { PASSKEY_CODES } from "@/lib/errorCodes";
import {
  decodeCreationOptions,
  encodeCreationResponse,
  type RawCreationOptions,
} from "@/lib/webauthn";
import { passkeySupport, type PasskeySupport } from "@/lib/passkeySupport";

/** 通行密钥清单里的一条（`GET /v1/passkeys`）。 */
interface PasskeyRow {
  id: number;
  name: string;
  created_at: number;
  last_used_at: number;
}

/**
 * 登录会话清单里的一条（`GET /v1/auth/sessions`）。刻意不带 sid（后端就没发，
 * 见 internal/api/auth/auth.go 的 SessionItem 注释），行的身份因此只能是它在
 * 清单里的位置——展开态、删除目标都按下标而不是按 id 归集。
 */
interface SessionRow {
  user_agent: string;
  ip: string;
  created_at: number;
  last_active_at: number;
  current: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function formatDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

// 下面三个拼行函数都定义在组件与 JSX 之外：eslint-plugin-i18next 的
// `jsx-only` 模式按「祖先链里有没有 JSXElement」判定，不是按「是不是 JSX
// 直接子节点」——挪进 `.map()` 回调里算不出来，因为回调本身就挂在
// `{list.map(...)}` 这个 JSXExpressionContainer 下面。挪成模块级函数才是
// 真正在 JSX 之外，与 Devices.tsx 的 `.join(" · ")` 同一手法：连接符「·」
// 是代码里拼的，不是译文的一部分，两段译文各自独立可译。

function passkeyMetaLine(t: Translate, k: PasskeyRow): string {
  return [
    t("account.passkeys.created", { date: formatDate(k.created_at) }),
    k.last_used_at
      ? t("account.passkeys.lastUsed", { date: formatDate(k.last_used_at) })
      : t("account.passkeys.neverUsed"),
  ].join(" · ");
}

function sessionTimesLine(t: Translate, s: SessionRow): string {
  return (
    " · " +
    [
      t("account.sessions.signedInAt", { date: formatDate(s.created_at) }),
      t("account.sessions.lastActiveAt", {
        date: formatDate(s.last_active_at),
      }),
    ].join(" · ")
  );
}

/**
 * 用不了通行密钥时那句话。**说的必须是真正的原因**：源不是安全上下文（本站有时
 * 用 http 提供）与浏览器太老，补救办法相反 —— 前者换几个浏览器都一样。
 * 此前这里一律说「这个浏览器不支持」，对着一个完全支持的浏览器。
 */
function unavailableBannerText(t: Translate, why: PasskeySupport): string {
  return why === "insecure-origin"
    ? [
        t("account.passkeys.insecureOrigin"),
        t("account.passkeys.insecureOriginHint"),
      ].join(" · ")
    : [
        t("account.passkeys.unsupported"),
        t("account.passkeys.unsupportedHint"),
      ].join(" · ");
}

/** 禁用的「添加」按钮上那句 title：同一个原因的短版。 */
function unavailableReason(t: Translate, why: PasskeySupport): string {
  return why === "insecure-origin"
    ? t("account.passkeys.insecureOrigin")
    : t("account.passkeys.unsupported");
}

/** 通行密钥段位里前端表自己声明的码 → 该码对应的账号页文案键。 */
const PASSKEY_ERROR_KEY: Record<keyof typeof PASSKEY_CODES, string> = {
  PasskeyLimitReached: "limitReached",
  PasskeyChallengeInvalid: "challengeInvalid",
  PasskeyVerificationFailed: "verificationFailed",
  PasskeyAlreadyRegistered: "alreadyRegistered",
  PasskeyNotFound: "notFound",
};

/**
 * 只有 ApiError 才带得出服务端说法；已知的通行密钥业务码换成账号页自己的
 * 文案（两份 locale 都翻译过，不像 e.message 那样恒回中文——本服务没有设置
 * 语言的中间件，所有请求都落在 zh-CN，见 internal/pkg/code/zh_cn.go 的注释）。
 * 未知失败（离线、非 JSON 502）落一句通用文案，不吞掉。
 */
function passkeyErrorText(e: unknown, t: Translate): string {
  if (e instanceof ApiError) {
    const entry = (
      Object.entries(PASSKEY_CODES) as [keyof typeof PASSKEY_CODES, number][]
    ).find(([, code]) => code === e.code);
    if (entry)
      return t(`account.passkeys.errors.${PASSKEY_ERROR_KEY[entry[0]]}`);
  }
  return t("account.passkeys.errors.generic");
}

/** 用户在系统/认证器弹窗里主动取消：不是报错（与既有「拒绝授权不是报错」同一判断）。 */
function isUserCancelled(e: unknown): boolean {
  return e instanceof DOMException && e.name === "NotAllowedError";
}

/** 卡片外壳：rounded-lg + border-border + bg-card。 */
function SectionCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-aux font-bold text-foreground">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * `/account`：受 `RequireAuth` 保护、不进主导航（规格「用户菜单与 /account」）。
 * 三张卡纵向堆叠，桌面与移动同一条流，390 宽下不产生横向溢出。
 */
export default function Account() {
  const { t } = useTranslation();
  const { me } = useMe();

  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [passkeysError, setPasskeysError] = useState<unknown>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState<unknown>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<PasskeyRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [confirmingSignOutOthers, setConfirmingSignOutOthers] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const passkeySupportState = passkeySupport();
  const supported = passkeySupportState === "available";

  useAliveEffect((alive) => {
    api<{ passkeys: PasskeyRow[] }>("/v1/passkeys")
      .then((r) => {
        if (alive()) setPasskeys(r.passkeys);
      })
      .catch((e: unknown) => {
        if (alive()) setPasskeysError(e ?? new Error("passkeys load failed"));
      });
  }, []);

  function loadSessions() {
    return api<{ sessions: SessionRow[] }>("/v1/auth/sessions").then((r) => {
      setSessions(r.sessions);
      return r.sessions;
    });
  }

  useAliveEffect((alive) => {
    loadSessions().catch((e: unknown) => {
      if (alive()) setSessionsError(e ?? new Error("sessions load failed"));
    });
  }, []);

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/v1/passkeys/${deleteTarget.id}`, { method: "DELETE" });
      setPasskeys((prev) =>
        (prev ?? []).filter((p) => p.id !== deleteTarget.id),
      );
      setDeleteTarget(null);
    } catch (e) {
      setDeleteError(passkeyErrorText(e, t));
    } finally {
      setDeleting(false);
    }
  }

  async function onConfirmSignOutOthers() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await api("/v1/auth/sessions/revoke-others", { method: "POST" });
      setConfirmingSignOutOthers(false);
      setExpandedIndex(null);
      // 尽力删除、单条失败不影响其余（决策 8）：用真实清单刷新，而不是本地
      // 推算「应该只剩当前一条」，如实反映还剩几个。
      await loadSessions();
    } catch (e) {
      setSignOutError(
        e instanceof ApiError ? e.message : t("account.sessions.signOutError"),
      );
    } finally {
      setSigningOut(false);
    }
  }

  function openAdd() {
    setAddName("");
    setAddError(null);
    setAddOpen(true);
  }

  async function onConfirmAdd(e: FormEvent) {
    e.preventDefault();
    const name = addName.trim();
    if (!name || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const begin = await api<{ publicKey: RawCreationOptions }>(
        "/v1/passkeys/register/begin",
        { method: "POST" },
      );
      const options = decodeCreationOptions(begin.publicKey);
      const cred = (await navigator.credentials.create({
        publicKey: options,
      })) as PublicKeyCredential | null;
      if (!cred) throw new Error("no credential returned");
      const finish = await api<{ passkey: PasskeyRow }>(
        "/v1/passkeys/register/finish",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            credential: encodeCreationResponse(cred),
          }),
        },
      );
      // 放在最前面而不是追加：服务端的清单是 id DESC（最近添加的在前）。追加的话
      // 用户加完看到它在最后一行，刷新一次又跳到第一行——同一份清单两种次序。
      setPasskeys((prev) => [finish.passkey, ...(prev ?? [])]);
      setAddOpen(false);
    } catch (err) {
      if (isUserCancelled(err)) {
        setAddOpen(false);
      } else {
        setAddError(passkeyErrorText(err, t));
      }
    } finally {
      setAdding(false);
    }
  }

  const otherCount = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <AppShell title={t("account.title")}>
      {me ? (
        <div
          data-testid="account-page"
          className="mx-auto flex w-full max-w-[840px] flex-col gap-4"
        >
          {/* 账号卡：github_login 第一次有地方显示。 */}
          <SectionCard title={t("account.profile.title")}>
            <div className="flex items-center gap-4 px-4 py-4">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-soft text-lg font-semibold text-primary-text">
                {me.display_name.charAt(0)}
              </div>
              <dl className="grid min-w-0 flex-1 gap-1">
                <div className="truncate text-prose font-semibold text-foreground">
                  {me.display_name}
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <dt className="text-2xs text-muted-foreground">
                      {t("account.profile.email")}
                    </dt>
                    <dd className="truncate text-xs text-muted-foreground">
                      {me.email}
                    </dd>
                  </div>
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <dt className="text-2xs text-muted-foreground">
                      {t("account.profile.github")}
                    </dt>
                    <dd className="truncate font-mono text-xs text-muted-foreground">
                      {me.github_login}
                    </dd>
                  </div>
                </div>
              </dl>
            </div>
          </SectionCard>

          {/* 通行密钥卡 */}
          <SectionCard
            title={t("account.passkeys.title")}
            subtitle={t("account.passkeys.subtitle")}
            action={
              <Button
                size="sm"
                onClick={openAdd}
                disabled={!supported || adding}
                title={
                  supported
                    ? undefined
                    : unavailableReason(t, passkeySupportState)
                }
              >
                <KeyRound />
                {adding
                  ? t("account.passkeys.adding")
                  : t("account.passkeys.add")}
              </Button>
            }
          >
            {!supported && (
              // 不支持就说清楚为什么，不让用户去撞一次可预知的失败（决策 17）。
              <p className="border-b border-border bg-status-waiting-bg px-4 py-2.5 text-xs text-status-waiting">
                {unavailableBannerText(t, passkeySupportState)}
              </p>
            )}
            {passkeys === null ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t("common.loading")}
              </p>
            ) : passkeysError ? (
              <Alert variant="destructive" className="m-4">
                <AlertDescription>
                  {passkeysError instanceof ApiError
                    ? passkeysError.message
                    : t("account.passkeys.loadError")}
                </AlertDescription>
              </Alert>
            ) : passkeys.length === 0 ? (
              <EmptyState
                icon={KeyRound}
                title={t("account.passkeys.emptyTitle")}
                body={
                  // 决策 18：不支持时不号召一个此刻做不到的动作。
                  supported
                    ? t("account.passkeys.emptyBody")
                    : t("account.passkeys.emptyBodyUnsupported")
                }
              />
            ) : (
              <ul>
                {passkeys.map((k, i) => {
                  return (
                    <li
                      key={k.id}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3",
                        i > 0 && "border-t border-border",
                      )}
                    >
                      <KeyRound className="size-4 shrink-0 text-decorative-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-aux font-semibold text-foreground">
                          {k.name}
                        </div>
                        <div className="truncate text-2xs text-muted-foreground">
                          {passkeyMetaLine(t, k)}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(k);
                        }}
                        aria-label={t("account.passkeys.remove")}
                      >
                        <Trash2 />
                        <span className="hidden sm:inline">
                          {t("account.passkeys.remove")}
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          {/* 登录会话卡 */}
          <SectionCard
            title={t("account.sessions.title")}
            subtitle={t("account.sessions.subtitle")}
            action={
              otherCount > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSignOutError(null);
                    setConfirmingSignOutOthers(true);
                  }}
                >
                  {t("account.sessions.signOutOthers")}
                </Button>
              ) : undefined
            }
          >
            {sessions === null ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t("common.loading")}
              </p>
            ) : sessionsError ? (
              <Alert variant="destructive" className="m-4">
                <AlertDescription>
                  {sessionsError instanceof ApiError
                    ? sessionsError.message
                    : t("account.sessions.loadError")}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <ul>
                  {sessions.map((s, i) => {
                    const isExpanded = expandedIndex === i;
                    return (
                      <li
                        key={i}
                        className={cn(i > 0 && "border-t border-border")}
                      >
                        {/* 整行可点展开：UA 原样、等宽，默认截断（决策 7）。不解析
                            成「Chrome on macOS」——猜错会让人撤销掉正在用的那一个；
                            展开态只属于这一行自己，不影响其它行。 */}
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpandedIndex(isExpanded ? null : i)
                          }
                          className={cn(
                            "flex w-full cursor-pointer gap-3 px-4 py-3 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
                            // 折叠态与通行密钥行同一套 items-center：16px 图标相对
                            // 两行块垂直居中。展开后 UA 折成多行，改钉在顶部。
                            isExpanded ? "items-start" : "items-center",
                          )}
                        >
                          <Monitor
                            className={cn(
                              "size-4 shrink-0 text-decorative-foreground",
                              isExpanded && "mt-0.5",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={cn(
                                  "min-w-0 flex-1 font-mono text-aux text-foreground",
                                  isExpanded ? "break-all" : "truncate",
                                )}
                              >
                                {s.user_agent}
                              </span>
                              {s.current && (
                                <StatusMark
                                  tone="running"
                                  label={t("account.sessions.current")}
                                />
                              )}
                            </div>
                            <div className="mt-0.5 truncate text-2xs text-muted-foreground">
                              <span className="font-mono">{s.ip}</span>
                              {sessionTimesLine(t, s)}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {otherCount === 0 && (
                  <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                    {t("account.sessions.onlyCurrent")}
                  </p>
                )}
              </>
            )}
          </SectionCard>
        </div>
      ) : (
        <p className="text-muted-foreground">{t("common.loading")}</p>
      )}

      {/* 添加通行密钥：先起名字，再触发认证器（decision 10：注册要求 residentKey）。 */}
      <DialogShell
        open={addOpen}
        onOpenChange={(o) => {
          if (!o && !adding) setAddOpen(false);
        }}
        size="md"
        busy={adding}
      >
        <form onSubmit={onConfirmAdd} className="contents">
          <DialogShellHeader
            title={t("account.passkeys.nameLabel")}
            subtitle={t("account.passkeys.nameHint")}
            busy={adding}
            onClose={() => setAddOpen(false)}
          />
          <DialogShellBody>
            <Input
              autoFocus
              maxLength={64}
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder={t("account.passkeys.namePlaceholder")}
              disabled={adding}
            />
          </DialogShellBody>
          <DialogShellFooter error={addError}>
            <Button
              type="button"
              variant="outline"
              disabled={adding}
              onClick={() => setAddOpen(false)}
            >
              {t("account.passkeys.cancel")}
            </Button>
            <DialogShellSubmit
              type="submit"
              busy={adding}
              disabled={!addName.trim()}
            >
              {t("account.passkeys.confirm")}
            </DialogShellSubmit>
          </DialogShellFooter>
        </form>
      </DialogShell>

      {/* 删除通行密钥：二次确认。 */}
      <DialogShell
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o && !deleting) {
            setDeleteError(null);
            setDeleteTarget(null);
          }
        }}
        size="sm"
        danger
        busy={deleting}
      >
        <DialogShellHeader
          title={t("account.passkeys.removeTitle", {
            name: deleteTarget?.name ?? "",
          })}
          danger
          busy={deleting}
          onClose={() => setDeleteTarget(null)}
        />
        <DialogShellBody>
          <p className="text-aux leading-relaxed text-muted-foreground">
            {t("account.passkeys.removeBody")}
          </p>
        </DialogShellBody>
        <DialogShellFooter error={deleteError}>
          <Button
            variant="outline"
            disabled={deleting}
            onClick={() => setDeleteTarget(null)}
          >
            {t("account.passkeys.cancel")}
          </Button>
          <DialogShellSubmit
            variant="destructive"
            busy={deleting}
            onClick={onConfirmDelete}
          >
            {t("account.passkeys.removeConfirm")}
          </DialogShellSubmit>
        </DialogShellFooter>
      </DialogShell>

      {/* 登出其它全部：二次确认。 */}
      <DialogShell
        open={confirmingSignOutOthers}
        onOpenChange={(o) => {
          if (!o && !signingOut) {
            setSignOutError(null);
            setConfirmingSignOutOthers(false);
          }
        }}
        size="sm"
        danger
        busy={signingOut}
      >
        <DialogShellHeader
          title={t("account.sessions.signOutOthersTitle", {
            count: otherCount,
          })}
          danger
          busy={signingOut}
          onClose={() => setConfirmingSignOutOthers(false)}
        />
        <DialogShellBody>
          <p className="text-aux leading-relaxed text-muted-foreground">
            {t("account.sessions.signOutOthersBody")}
          </p>
        </DialogShellBody>
        <DialogShellFooter error={signOutError}>
          <Button
            variant="outline"
            disabled={signingOut}
            onClick={() => setConfirmingSignOutOthers(false)}
          >
            {t("account.passkeys.cancel")}
          </Button>
          <DialogShellSubmit
            variant="destructive"
            busy={signingOut}
            onClick={onConfirmSignOutOthers}
          >
            {t("account.sessions.signOutOthersConfirm")}
          </DialogShellSubmit>
        </DialogShellFooter>
      </DialogShell>
    </AppShell>
  );
}
