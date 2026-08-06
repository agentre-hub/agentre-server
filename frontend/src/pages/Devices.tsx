import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { api, ApiError } from "@/lib/api";

interface DeviceItem {
  id: number;
  name: string;
  kind: string;
  platform: string;
  version: string;
  fingerprint: string;
  capabilities: Record<string, boolean>;
  last_seen_at: number;
  status: number;
  is_this_device: boolean;
}

const ACTIVE = 1;

function formatLastActive(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export default function Devices() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<DeviceItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 只负责取数据，不碰状态；由调用方决定怎么落状态。
  async function fetchDevices(): Promise<DeviceItem[]> {
    const got = await api<{ devices: DeviceItem[] }>("/v1/devices");
    return got.devices;
  }

  function applyList(list: DeviceItem[]) {
    setDevices(list);
    setError(null);
  }

  useEffect(() => {
    let alive = true;
    fetchDevices()
      .then((list) => {
        if (alive) applyList(list);
      })
      .catch((e) => {
        if (alive && e instanceof ApiError) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  function kindLabel(kind: string): string {
    const key = `device.kind.${kind}`;
    const translated = t(key);
    // i18next 返回 key 本身表示没有这个翻译，回退到后端给的原文。
    return translated === key ? kind : translated;
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
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen justify-center bg-background px-4 py-12">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{t("device.manage.title")}</h1>
        </div>

        {error && <Alert variant="destructive">{error}</Alert>}

        {loading ? (
          <p className="text-muted-foreground">{t("common.loading")}</p>
        ) : devices.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground">
              {t("device.manage.empty")}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {devices.map((d) => (
              <Card key={d.id} className="py-4">
                <CardHeader className="px-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate">{d.name}</CardTitle>
                      <CardDescription className="mt-1">
                        {kindLabel(d.kind)}
                        {d.platform ? ` · ${d.platform}` : ""}
                        {d.version ? ` ${d.version}` : ""}
                        {d.is_this_device
                          ? ` · ${t("device.manage.thisDevice")}`
                          : ""}
                      </CardDescription>
                    </div>
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
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 text-sm text-muted-foreground">
                  <span>
                    {t("device.manage.colLastActive")}:{" "}
                    {formatLastActive(d.last_seen_at)}
                  </span>
                  <span>
                    {t("device.manage.colStatus")}:{" "}
                    {d.status === ACTIVE
                      ? t("device.manage.statusOnline")
                      : t("device.manage.statusRevoked")}
                  </span>
                </CardContent>
              </Card>
            ))}
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
    </div>
  );
}
