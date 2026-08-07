import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
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
import { api, ApiError } from "@/lib/api";

interface PendingInfo {
  device_kind: string;
  platform: string;
  version: string;
  capabilities: Record<string, boolean>;
  expires_in: number;
}

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function normalize(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "").split("");
  if (cleaned.length !== 6) return null;
  for (const c of cleaned) if (!ALPHABET.includes(c)) return null;
  return cleaned.slice(0, 3).join("") + "-" + cleaned.slice(3).join("");
}

export default function Device() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const initial = params.get("user_code") ?? "";
  const [code, setCode] = useState(initial);
  const [info, setInfo] = useState<PendingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const norm = normalize(initial);
    if (norm) loadPending(norm);
  }, [initial]);

  async function loadPending(uc: string) {
    setError(null);
    try {
      const got = await api<PendingInfo>(
        `/v1/oauth/device/pending?user_code=${encodeURIComponent(uc)}`,
      );
      setInfo(got);
      setCode(uc);
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
    }
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
    } catch (e) {
      // 服务端的 deny 是带条件的 UPDATE：行已被换取或已拒绝时命中 0 行，返回 400。
      // 不接住的话这里会是一个未处理的 promise rejection——对话框原地不动、
      // 一个字都不显示，用户完全走不下去。
      if (e instanceof ApiError) setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  const enabledCapabilities = Object.entries(info?.capabilities ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md space-y-6 rounded-xl border p-6 sm:p-8">
        <h1 className="text-2xl font-semibold">{t("device.title")}</h1>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("device.codePlaceholder")}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          inputMode="text"
        />
        {error && <Alert variant="destructive">{error}</Alert>}
        <Button
          className="w-full sm:w-auto"
          onClick={() => {
            const n = normalize(code);
            if (n) loadPending(n);
            else setError(t("device.invalidCode"));
          }}
        >
          {t("device.lookup")}
        </Button>

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
    </div>
  );
}
