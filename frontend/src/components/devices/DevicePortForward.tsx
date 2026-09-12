/**
 * 设备卡展开区的「端口转发」小节（规格 2026-09-09 决策 4 / 11 / 12）。
 *
 * 这一层只做宿主专属的三件事：经中继调声明族、把访问地址拼出来、拉一个新标签页 /
 * 摸剪贴板。**行的渲染规则全在共享包 `PortForwardSection` 里**（哪个控件在什么条件
 * 下出现、空态、离线句、更多操作菜单），两个宿主共用同一份 —— 这里一行都不重画。
 *
 * 与桌面端那一半（`agentre` 仓的 `device-port-forward.tsx`）的两处结构性差别：
 *
 *  1. **地址无需先「打开」就存在**。桌面端那条 `127.0.0.1:<端口>` 要等
 *     `PortForwardOpen` 绑上本机监听、端口由内核给；控制台这条 `/fw/<设备>/<端口>/`
 *     是路由算出来的，所以这里没有桌面端那份 `addresses` state。
 *  2. **「打开」是新标签页**，不是拉系统浏览器：用户已经在浏览器里，被转发的应用与
 *     控制台同源（同源风险由规格的「安全」一节记录，界面上不出现）。
 */
import {
  Button,
  Input,
  Label,
  PortForwardSection,
  Skeleton,
  copyTextWithToast,
  type PortForwardMappingView,
} from "@agentre-hub/agentre-ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  byPort,
  classifyPortForwardError,
  createPortForward,
  deletePortForward,
  listPortForwards,
  portForwardAddress,
  setPortForwardEnabled,
  type PortForwardDeclaration,
} from "@/lib/portForward";

export function DevicePortForward({
  deviceId,
  fingerprint,
  offline,
  offlineDetail,
}: {
  /** 设备的数字 id：访问地址里用的就是它（决策 4）。 */
  deviceId: number;
  /** 中继寻址用的指纹。 */
  fingerprint: string;
  /** 设备卡已经做过的在线判定。 */
  offline: boolean;
  /** 离线句后面那句补充（相对时间由设备卡格式化）。 */
  offlineDetail?: string;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const alive = useRef(true);

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [mappings, setMappings] = useState<PortForwardDeclaration[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [actionError, setActionError] = useState("");

  const [adding, setAdding] = useState(false);
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [addError, setAddError] = useState("");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * 列举。
   *
   * **设备离线时一个字节都不发**：声明存在被访问的那台设备上（上游决策 1），够不着
   * 就读不到那份声明，拨过去只是让一条注定失败的握手在池子里空转一遍。本站既有的
   * 同一条口径见 `enginePorts` 的探测（离线设备直接给理由，不拨号）。已经列出来的
   * 行照旧留着 —— 它们只是打不开，不是不存在。
   */
  const load = useCallback((): Promise<void> => {
    if (offline) return Promise.resolve();
    // 写状态一律落在 promise 回调里（与 `useBoard` / `useOrgData` 同一种形状）：
    // effect 体里同步 setState 会引起级联渲染，`react-hooks/set-state-in-effect`
    // 守的就是这条。
    return listPortForwards(fingerprint)
      .then((list) => {
        if (!alive.current) return;
        setMappings(list);
        setUnreachable(false);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        const failure = classifyPortForwardError(err);
        // 够不着那台机器不是「读失败」，而是离线态：不出新增入口，也不摆一句机器原话。
        if (failure.kind === "disconnected") {
          setUnreachable(true);
          setPhase("ready");
          return;
        }
        setLoadError(failure.message);
        setPhase("error");
      });
  }, [fingerprint, offline]);

  /**
   * 重取**不**退回加载态：`phase` 的初值就是 loading，此后只会走到 ready / error。
   *
   * 会重跑这只 effect 的只有「设备回来了」那一次跳变（`load` 的依赖里有 `offline`）
   * ——那一刻手上已经有列出来的行，把它们换成一行「正在读取」等于让一次自愈的刷新
   * 看起来像一次重新加载。首屏那一次由初值负责，什么都不用做。
   */
  useEffect(() => {
    void load();
  }, [load]);

  /** 一次动作真的到了那台设备：此前记下的「够不着」就此作废。 */
  const markReached = useCallback(() => setUnreachable(false), []);

  /** 三种「不是这一次动作本身的错」在这里统一收口。 */
  const handleFailure = useCallback(
    (err: unknown) => {
      const failure = classifyPortForwardError(err);
      if (failure.kind === "disconnected") {
        setUnreachable(true);
        return;
      }
      // 那条声明在设备上已经变了（别的客户端刚改过）：手上这份列表是旧的，重取。
      if (failure.kind === "gone" || failure.kind === "disabled") {
        void load();
        return;
      }
      setActionError(
        t("device.portForward.actionFailed", {
          message: failure.message,
        }),
      );
    },
    [load, t],
  );

  const replaceRow = useCallback((row: PortForwardDeclaration) => {
    setMappings((prev) => byPort(prev.map((m) => (m.id === row.id ? row : m))));
  }, []);

  async function handleToggle(
    mapping: PortForwardMappingView,
    enabled: boolean,
  ) {
    setActionError("");
    try {
      const row = await setPortForwardEnabled(fingerprint, mapping.id, enabled);
      if (!alive.current) return;
      markReached();
      replaceRow(row);
    } catch (err) {
      if (!alive.current) return;
      handleFailure(err);
    }
  }

  async function handleRemove(mapping: PortForwardMappingView) {
    setActionError("");
    try {
      await deletePortForward(fingerprint, mapping.id);
      if (!alive.current) return;
      markReached();
      setMappings((prev) => prev.filter((m) => m.id !== mapping.id));
    } catch (err) {
      if (!alive.current) return;
      handleFailure(err);
    }
  }

  /**
   * 新标签页打开。
   *
   * `noopener,noreferrer` 是 `<a target="_blank">` 上那两个 rel 的等价物：被转发的
   * 那个应用与控制台同源，不给它 `window.opener` 这条反向把手。
   */
  function handleOpen(mapping: PortForwardMappingView) {
    if (!mapping.address) return;
    window.open(mapping.address, "_blank", "noopener,noreferrer");
  }

  /**
   * 复制地址。
   *
   * 走共享包的 `copyTextWithToast` 而不是自己摸 `navigator.clipboard`：本站常在
   * `http://<局域网 IP>:port` 这类**非安全上下文**下部署，那里 Clipboard API 整个
   * 对象都不存在，只剩它的 `execCommand` 兜底。回执只能是 toast —— 这一行上没有
   * 留内联「已复制」的地方。
   */
  function handleCopy(mapping: PortForwardMappingView) {
    if (!mapping.address) return;
    void copyTextWithToast(mapping.address, {
      successTitle: t("device.portForward.copyDone"),
      errorTitle: t("device.portForward.copyFailed"),
    });
  }

  function openAddForm() {
    setAdding(true);
    setAddError("");
  }

  function closeAddForm() {
    setAdding(false);
    setPort("");
    setName("");
    setAddError("");
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number(port.trim());
    if (port.trim() === "" || !Number.isInteger(parsed)) {
      setAddError(t("device.portForward.add.invalidPort"));
      return;
    }
    setAddError("");
    try {
      const row = await createPortForward(fingerprint, parsed, name.trim());
      if (!alive.current) return;
      markReached();
      setMappings((prev) => byPort([...prev, row]));
      closeAddForm();
    } catch (err) {
      if (!alive.current) return;
      const failure = classifyPortForwardError(err);
      // 两个码都指向端口那一格，但出路不同：一个换端口，一个把号填对。
      if (failure.kind === "portTaken") {
        setAddError(t("device.portForward.add.portTaken"));
        return;
      }
      if (failure.kind === "invalidPort") {
        setAddError(t("device.portForward.add.invalidPort"));
        return;
      }
      if (failure.kind === "disconnected") {
        setUnreachable(true);
        closeAddForm();
        return;
      }
      setAddError(
        t("device.portForward.add.failed", {
          message: failure.message,
        }),
      );
    }
  }

  const isOffline = offline || unreachable;
  /**
   * 离线时那次列举压根没发出去，「读取中」这一档对它没有意义 —— 直接按已就绪渲染，
   * 让共享包出那句离线说明。`phase` 因此只描述**发出去过的那次列举**，不描述这一屏。
   */
  const displayPhase = offline ? "ready" : phase;
  const views: PortForwardMappingView[] = mappings.map((m) => ({
    ...m,
    address: portForwardAddress(deviceId, m.port),
  }));

  return (
    <div
      data-testid={`device-port-forward-${deviceId}`}
      className="flex flex-col gap-1.5 border-t border-border pt-3"
    >
      {/*
        取列表期间是**骨架**，不是一句「正在读取端口映射」：这一屏其余各处
        （设备列表、展开区正文）早就是骨架，状态由占位形状自己说；再叠一句解释性
        的话既多一条要翻译的文案，又在数据落地时把内容顶下去。骨架自己 aria-hidden，
        「正在取」这件事由容器上的 aria-busy 说 —— 与 DeviceDetailSkeleton 同一套。
      */}
      {displayPhase === "loading" ? (
        <div
          data-testid={`device-port-forward-loading-${deviceId}`}
          aria-busy="true"
        >
          <div aria-hidden="true" className="flex flex-col gap-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ) : null}

      {displayPhase === "error" ? (
        <p className="text-xs text-destructive">
          {t("device.portForward.loadFailed", { message: loadError })}
        </p>
      ) : null}

      {displayPhase === "ready" ? (
        <PortForwardSection
          mappings={views}
          offline={isOffline}
          offlineDetail={offlineDetail}
          openLabel={t("device.portForward.open")}
          onOpen={handleOpen}
          onCopyAddress={handleCopy}
          // 离线时收起来的只有**新增入口**：它领向一张填完必然提交失败的表单。
          // 已经列出来的那些行整行保留、只是打不开（上游规格「三种非常态」）。
          onCreate={isOffline ? undefined : openAddForm}
          onToggleEnabled={handleToggle}
          onRemove={handleRemove}
        />
      ) : null}

      {actionError ? (
        <p className="text-xs text-destructive">{actionError}</p>
      ) : null}

      {adding && displayPhase === "ready" && !isOffline ? (
        <form
          data-testid={`device-port-forward-add-${deviceId}`}
          className="flex flex-col gap-1.5"
          onSubmit={handleCreate}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex w-24 flex-col gap-1">
              <Label
                htmlFor={`${fieldId}-port`}
                className="text-2xs text-muted-foreground"
              >
                {t("device.portForward.add.port")}
              </Label>
              <Input
                id={`${fieldId}-port`}
                type="number"
                inputMode="numeric"
                className="h-7 text-xs"
                aria-invalid={addError !== ""}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label
                htmlFor={`${fieldId}-name`}
                className="text-2xs text-muted-foreground"
              >
                {t("device.portForward.add.name")}
              </Label>
              <Input
                id={`${fieldId}-name`}
                className="h-7 text-xs"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" size="xs">
              {t("device.portForward.add.submit")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={closeAddForm}
            >
              {t("device.portForward.add.cancel")}
            </Button>
          </div>
          {addError ? (
            <p className="text-2xs text-destructive">{addError}</p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
