import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";
import { CircleAlert, ShieldCheck } from "lucide-react";
import { Button, Alert } from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import CodeInput from "@/components/CodeInput";
import DeviceApproval, { type PendingInfo } from "@/components/DeviceApproval";
import PageTitle from "@/components/PageTitle";
import { api, ApiError } from "@/lib/api";
import { DEVICE_FLOW_CODES } from "@/lib/errorCodes";
import { normalize, toChars } from "@/lib/userCode";

/**
 * 码格的就地校验错误。两种来源共用同一套「整排标红、停在原地」的呈现：
 * - incomplete：本地归一化就没过（不足六位、或含字母表外字符），不发请求
 * - invalid：后端回 30205，代码不存在或已被消费
 * 文案分开是因为「这个代码不存在」对一个只填了两位的人是句假话。
 */
type CodeError = "incomplete" | "invalid";

/** 授权请求已过期：无论出现在哪一步，都落到 /device/expired（决策 9）。 */
function isExpired(e: unknown): boolean {
  return (
    e instanceof ApiError && e.code === DEVICE_FLOW_CODES.DeviceFlowExpiredToken
  );
}

export default function Device() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const initial = params.get("user_code") ?? "";
  const [code, setCode] = useState(initial);
  const [chars, setChars] = useState<string[]>(() => toChars(initial));
  const [info, setInfo] = useState<PendingInfo | null>(null);
  const [codeError, setCodeError] = useState<CodeError | null>(null);
  // 存住失败本身，渲染时才翻译成文案：effect 里不碰 t，就不必把它拉进依赖
  // 数组（切语言不该重新查一次 pending）。与 Devices.tsx 同一手法。
  const [failure, setFailure] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorId = useId();

  useEffect(() => {
    const norm = normalize(initial);
    if (norm) void loadPending(norm);
  }, [initial]);

  /**
   * 只有 ApiError 才带得出服务端说法；其余（离线、代理返回非 JSON）同样是
   * 失败，必须说出来——静默吞掉会让用户对着一个没反应的按钮点第二次。
   */
  function failureText(e: unknown): string {
    return e instanceof ApiError ? e.message : t("device.approve.actionError");
  }

  async function loadPending(uc: string) {
    setFailure(null);
    setCodeError(null);
    setSubmitting(true);
    try {
      const got = await api<PendingInfo>(
        `/v1/oauth/device/pending?user_code=${encodeURIComponent(uc)}`,
      );
      setInfo(got);
      setCode(uc);
    } catch (e) {
      // 30205 就地标红、不跳页：输错一个字符不该让用户丢掉已输入的内容
      // （design decision 10）。判据是业务码而不是文案——文案是可翻译的。
      if (
        e instanceof ApiError &&
        e.code === DEVICE_FLOW_CODES.DeviceFlowUserCodeInvalid
      ) {
        setCodeError("invalid");
      } else {
        setFailure(e);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    const norm = normalize(chars.join(""));
    // 归一化不过就地报错，一个请求都不发。
    if (!norm) {
      setCodeError("incomplete");
      return;
    }
    void loadPending(norm);
  }

  function onCodeChange(next: string[]) {
    setChars(next);
    // 用户一动手就撤掉红态：继续瞪着上一次的错误没有意义。
    setCodeError(null);
  }

  async function onApprove() {
    if (!info) return;
    setSubmitting(true);
    try {
      await api(`/v1/oauth/device/approve`, {
        method: "POST",
        body: JSON.stringify({ user_code: code }),
      });
      // 设备信息随 router state 带到成功屏——那一屏自己拿不到 pending 记录。
      nav("/device/success", {
        state: {
          kind: info.device_kind,
          platform: info.platform,
          version: info.version,
        },
      });
    } catch (e) {
      setFailure(e);
    } finally {
      setSubmitting(false);
    }
  }

  async function onDeny() {
    if (!info) return;
    setSubmitting(true);
    try {
      await api(`/v1/oauth/device/deny`, {
        method: "POST",
        body: JSON.stringify({ user_code: code }),
      });
      nav("/device/denied");
    } catch (e) {
      setFailure(e);
    } finally {
      setSubmitting(false);
    }
  }

  // 过期在哪一步冒出来都一样：查 pending、点允许、点拒绝，全部落到终态页
  // （决策 9）。放在渲染里判一次，三条 catch 就都不必各自跳一遍。
  if (isExpired(failure)) return <Navigate to="/device/expired" replace />;

  if (info) {
    return (
      <AuthLayout>
        <DeviceApproval
          code={code}
          info={info}
          submitting={submitting}
          error={failure === null ? null : failureText(failure)}
          onApprove={() => void onApprove()}
          onDeny={() => void onDeny()}
          // 请求已经发出去时本地这块表说了不算：服务端可能已经把这次授权
          // 收下了，抢先跳过期页会让用户以为失败而再授权一次，名下于是多出
          // 一台没打算批两遍的设备。真过期了 approve/deny 自己会回 30202，
          // 上面那句 isExpired 照样把人送到终态页。
          onExpire={() => {
            if (!submitting) nav("/device/expired");
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="w-full max-w-[496px] rounded-lg border border-border bg-card p-6 sm:p-10">
        <form onSubmit={onSubmitCode} className="flex flex-col gap-[26px]">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-[7px] text-primary-text">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              <span className="text-xs font-semibold">
                {t("device.eyebrow")}
              </span>
            </div>
            <PageTitle>{t("device.entry.title")}</PageTitle>
            <p className="text-sm text-muted-foreground">
              {t("device.entry.description")}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <CodeInput
              value={chars}
              onChange={onCodeChange}
              invalid={!!codeError}
              describedBy={codeError ? errorId : undefined}
            />
            {codeError && (
              <p
                id={errorId}
                className="flex items-start gap-2 text-aux text-destructive"
              >
                <CircleAlert
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {t(`device.entry.errors.${codeError}`)}
              </p>
            )}
          </div>

          {failure !== null && (
            <Alert
              variant="destructive"
              className="border-destructive bg-destructive-soft"
            >
              {failureText(failure)}
            </Alert>
          )}

          <Button
            type="submit"
            disabled={submitting}
            className="h-auto w-full py-[13px]"
          >
            {t("device.entry.submit")}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            {t("device.entry.footnote")}
          </p>
        </form>
      </div>
    </AuthLayout>
  );
}
