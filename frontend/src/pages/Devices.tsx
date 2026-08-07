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
import AuthLayout from "@/components/AuthLayout";
import { api, ApiError } from "@/lib/api";
import { deviceKindLabel } from "@/lib/deviceKind";

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
  online: boolean;
  is_this_device: boolean;
}

const ACTIVE = 1;

// 只有 ApiError 才带可展示的服务端文案；其余(代理返回非 JSON 的 502 → SyntaxError、
// 离线 → TypeError)同样是失败，必须说出来 —— 静默吞掉会让页面渲染成「还没有任何
// 设备」，而用户名下的设备一台没少。
function loadErrorText(e: unknown, t: (key: string) => string): string {
  return e instanceof ApiError ? e.message : t("device.manage.loadError");
}

function formatLastActive(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
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
    <AuthLayout>
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
            {devices.map((d) => (
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
                    {d.status !== ACTIVE
                      ? t("device.manage.statusRevoked")
                      : d.online
                        ? t("device.manage.statusOnline")
                        : t("device.manage.statusOffline")}
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
    </AuthLayout>
  );
}
