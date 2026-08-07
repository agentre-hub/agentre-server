import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CircleAlert, Info, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import AuthLayout from "@/components/AuthLayout";
import CodeInput from "@/components/CodeInput";
import { api, ApiError } from "@/lib/api";
import { DEVICE_FLOW_CODES } from "@/lib/errorCodes";
import { normalize, toChars } from "@/lib/userCode";

interface PendingInfo {
  device_kind: string;
  platform: string;
  version: string;
  capabilities: Record<string, boolean>;
  expires_in: number;
}

/**
 * 码格的就地校验错误。两种来源共用同一套「整排标红、停在原地」的呈现：
 * - incomplete：本地归一化就没过（不足六位、或含字母表外字符），不发请求
 * - invalid：后端回 30205，代码不存在或已被消费
 * 文案分开是因为「这个代码不存在」对一个只填了两位的人是句假话。
 */
type CodeError = "incomplete" | "invalid";

export default function Device() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const initial = params.get("user_code") ?? "";
  const [code, setCode] = useState(initial);
  const [chars, setChars] = useState<string[]>(() => toChars(initial));
  const [info, setInfo] = useState<PendingInfo | null>(null);
  const [codeError, setCodeError] = useState<CodeError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    const norm = normalize(initial);
    if (norm) loadPending(norm);
  }, [initial]);

  async function loadPending(uc: string) {
    setError(null);
    setCodeError(null);
    setSubmitting(true);
    try {
      const got = await api<PendingInfo>(
        `/v1/oauth/device/pending?user_code=${encodeURIComponent(uc)}`,
      );
      setInfo(got);
      setCode(uc);
    } catch (e) {
      if (e instanceof ApiError) {
        // 30205 就地标红、不跳页：输错一个字符不该让用户丢掉已输入的内容
        // （design decision 10）。判据是业务码而不是文案——文案是可翻译的。
        if (e.code === DEVICE_FLOW_CODES.DeviceFlowUserCodeInvalid)
          setCodeError("invalid");
        else setError(e.message);
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
      nav("/device/success");
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
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
      setError(t("device.denied"));
      setInfo(null);
    } finally {
      setSubmitting(false);
    }
  }

  const enabledCapabilities = Object.entries(info?.capabilities ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

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
            <h1 className="text-2xl font-semibold text-foreground">
              {t("device.entry.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("device.entry.description")}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <CodeInput
              value={chars}
              onChange={onCodeChange}
              invalid={!!codeError}
              describedBy={codeError ? `${errorId} ${hintId}` : hintId}
            />
            {codeError && (
              <p
                id={errorId}
                className="flex items-start gap-2 text-[13px] text-destructive"
              >
                <CircleAlert
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {t(`device.entry.errors.${codeError}`)}
              </p>
            )}
            <p
              id={hintId}
              className="flex items-start gap-2 text-xs text-subtle-foreground"
            >
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("device.entry.hint")}
            </p>
          </div>

          {error && (
            <Alert
              variant="destructive"
              className="border-destructive bg-destructive-soft"
            >
              {error}
            </Alert>
          )}

          <Button
            type="submit"
            disabled={submitting}
            className="h-auto w-full py-[13px]"
          >
            {t("device.entry.submit")}
          </Button>

          <p className="text-center text-xs text-subtle-foreground">
            {t("device.entry.footnote")}
          </p>
        </form>

        <Dialog
          open={!!info}
          onOpenChange={(o) => {
            if (!o) setInfo(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("device.approveTitle")}</DialogTitle>
              <DialogDescription>
                {info?.device_kind} ({info?.platform} {info?.version})
                <br />
                {t("device.capabilities")}: {enabledCapabilities}
                {info?.device_kind === "agentred" && (
                  <>
                    <br />
                    {t("device.computeRisk")}
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onDeny} disabled={submitting}>
                {t("device.deny")}
              </Button>
              <Button onClick={onApprove} disabled={submitting}>
                {t("device.approve")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AuthLayout>
  );
}
