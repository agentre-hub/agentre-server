/**
 * 设备卡展开区的「端口转发」小节（规格 2026-09-21-port-forward-subdomain「控制台
 * 界面」）。
 *
 * 这一层只做宿主专属的几件事：经中继调声明族、按需向本站分配转发子域地址、拉一个
 * 新标签页 / 摸剪贴板。**行与新增表单的渲染规则全在共享包 `PortForwardSection`
 * 里**（哪个控件在什么条件下出现、空态、离线句、更多操作菜单、目标写法校验、
 * https 才出的「忽略证书错误」勾选框），两个宿主共用同一份 —— 这里一行都不重画
 * （规格「控制台界面」最后一条）。
 *
 * 与桌面端那一半（`agentre` 仓的 `device-port-forward.tsx`）的结构性差别：
 *
 *  1. **地址要向服务端要，不是拼出来的**。此前 `/fw/<设备>/<端口>/` 是路由算出来的
 *     常量，随时可用；按 Host 分发的转发域取代了那条路由之后，地址由
 *     `POST /v1/port-forwards/links` 分配（S2），对同一条映射幂等——第一次用到
 *     「打开」或「复制地址」时才去要，要到之后缓存在 `addresses` 里，往后两个动作
 *     显示 / 复制的都是同一个串（规格「控制台界面」第一条）。这一点与桌面端等
 *     `PortForwardOpen` 绑本机监听的 `addresses` 缓存同构，但网络对端不同：那边打
 *     的是那台设备，这里打的是服务端自己。
 *  2. **「打开」是新标签页**，不是拉系统浏览器：用户已经在浏览器里。
 *  3. **部署没配 `base_domain` 时分配会 503**（`code.PortForwardLinksUnavailable`）
 *     ——这与「设备够不着」是两类不同的失败：前者是本站配置问题，与哪台设备无关，
 *     不该被并进 `unreachable`（那会让离线句显示成「设备离线」，文不对题）。
 */
import {
  PortForwardSection,
  Skeleton,
  copyTextWithToast,
  useUiTranslation,
  type PortForwardCreateInput,
  type PortForwardMappingView,
} from "@agentre-hub/agentre-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  allocatePortForwardLink,
  byPort,
  classifyPortForwardError,
  classifyPortForwardLinkError,
  createPortForward,
  deletePortForward,
  listPortForwards,
  setPortForwardEnabled,
  type PortForwardDeclaration,
} from "@/lib/portForward";

export function DevicePortForward({
  deviceId,
  fingerprint,
  offline,
  offlineDetail,
}: {
  /** 设备的数字 id：分配转发地址时带的就是它。 */
  deviceId: number;
  /** 中继寻址用的指纹。 */
  fingerprint: string;
  /** 设备卡已经做过的在线判定。 */
  offline: boolean;
  /** 离线句后面那句补充（相对时间由设备卡格式化）。 */
  offlineDetail?: string;
}) {
  const { t } = useTranslation();
  // 「无效目标」这一句由共享包 `@agentre-hub/agentre-ui` 持有（规格「映射与目标」
  // 声明 + 决策 15）：表单即时校验与设备 -32076 回绝说的是同一句话，本站不再自己
  // 存一份译文（此前 `device.portForward.add.invalidTarget` 的重复已删）。
  const { t: tUi } = useUiTranslation();
  const alive = useRef(true);

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [mappings, setMappings] = useState<PortForwardDeclaration[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [actionError, setActionError] = useState("");
  /**
   * 分配到的转发地址，按映射 id 缓存。**不**随列举一起重取——列举刷新时，用户刚
   * 复制的那条地址不该跟着消失；而 `/v1/port-forwards/links` 对同一条映射本来就
   * 幂等，缓存只是省一趟往返，不是权威来源。
   */
  const [addresses, setAddresses] = useState<Record<string, string>>({});

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

  /** 三种「不是这一次动作本身的错」在这里统一收口——都是打那台设备的动作用这条。 */
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

  /**
   * 分配转发地址这条路失败落在哪一类——打的是服务端自己，不是那台设备，所以与
   * `handleFailure` 分开收口，不碰 `unreachable`（那个只描述「设备够不着」）。
   */
  const handleLinkFailure = useCallback(
    (err: unknown) => {
      const failure = classifyPortForwardLinkError(err);
      // 前缀不是这个账号的 / 已撤销 / 不存在：手上这一行大概率被并发操作抢先删了，
      // 重取列表，而不是把一句机器原话摆到用户面前。
      if (failure.kind === "notFound") {
        void load();
        return;
      }
      // `unavailable`（503）与其余未知失败都直接显示服务端给的文案——那句文案本来
      // 就是给人看的（与账号页 `loadErrorText` 同一条口径），不必在这里另编一份。
      setActionError(failure.message);
    },
    [load],
  );

  const replaceRow = useCallback((row: PortForwardDeclaration) => {
    setMappings((prev) => byPort(prev.map((m) => (m.id === row.id ? row : m))));
  }, []);

  const dropAddress = useCallback((id: string) => {
    setAddresses((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  /**
   * 分配（或复用缓存的）这条映射的转发地址。「打开」「复制地址」共用这一条——第一次
   * 用到任意一个都会走到这里分配一次，之后两个动作显示 / 复制的都是同一个串
   * （规格「控制台界面」第一条）。
   */
  const ensureAddress = useCallback(
    async (mapping: PortForwardMappingView): Promise<string> => {
      const cached = addresses[mapping.id];
      if (cached) return cached;
      const link = await allocatePortForwardLink(deviceId, mapping.id);
      if (alive.current) {
        setAddresses((prev) => ({ ...prev, [mapping.id]: link.url }));
      }
      return link.url;
    },
    [addresses, deviceId],
  );

  /**
   * 「打开」先同步开一个空白标签页，分配到地址之后才把它导航过去。
   *
   * 分配地址是一次网络往返，`await` 之后再调 `window.open` 已经跳出了这次点击的
   * 用户手势——Chrome / Safari 的弹窗拦截器会把这次 `window.open` 当成非用户发起
   * 而拦下来（第一次点某条映射时最容易撞上，那时地址还没缓存）。开在点击的同一个
   * 事件循环里就没有这个问题；空白页拿到手之后，`opener` 手动置空——等价于
   * `noopener`（被转发的那个应用与控制台不同源，不给它反向把手），但保留句柄好在
   * 地址到手后设置它的 `location`。
   */
  function handleOpen(mapping: PortForwardMappingView) {
    setActionError("");
    const pending = window.open("", "_blank");
    if (pending) pending.opener = null;
    void (async () => {
      try {
        const url = await ensureAddress(mapping);
        if (!alive.current) {
          pending?.close();
          return;
        }
        if (pending) {
          pending.location.href = url;
        } else {
          // 拿到手的那次调用被拦了（没能提前开出空白页）：退回直接开一次——多数
          // 浏览器仍然认它跑在同一次用户手势派生的宏任务里，拦不住也没有更好的兜底。
          window.open(url, "_blank", "noopener,noreferrer");
        }
      } catch (err) {
        pending?.close();
        if (!alive.current) return;
        handleLinkFailure(err);
      }
    })();
  }

  /**
   * 复制地址。
   *
   * 走共享包的 `copyTextWithToast` 而不是自己摸 `navigator.clipboard`：本站常在
   * `http://<局域网 IP>:port` 这类**非安全上下文**下部署，那里 Clipboard API 整个
   * 对象都不存在，只剩它的 `execCommand` 兜底。回执只能是 toast —— 这一行上没有
   * 留内联「已复制」的地方。
   */
  async function handleCopy(mapping: PortForwardMappingView) {
    setActionError("");
    try {
      const url = await ensureAddress(mapping);
      if (!alive.current) return;
      void copyTextWithToast(url, {
        successTitle: t("device.portForward.copyDone"),
        errorTitle: t("device.portForward.copyFailed"),
      });
    } catch (err) {
      if (!alive.current) return;
      handleLinkFailure(err);
    }
  }

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
      dropAddress(mapping.id);
    } catch (err) {
      if (!alive.current) return;
      handleFailure(err);
    }
  }

  /**
   * 新增表单本身(哪个字段、https 才出的勾选框、目标写法的即时校验)全在共享包里,
   * 这里只管把提交的载荷送到设备、把设备回来的业务码翻成一句人话。resolve 让
   * 表单关掉、reject 把 `error.message` 显示在表单里——够不着设备是一种例外:
   * 静默转离线态,不当错误显示(表单已经在共享包里因为 `offline` 变真而自己关掉)。
   */
  async function handleCreate(input: PortForwardCreateInput) {
    try {
      const row = await createPortForward(
        fingerprint,
        input.target,
        input.name,
        input.insecure,
      );
      if (!alive.current) return;
      markReached();
      setMappings((prev) => byPort([...prev, row]));
    } catch (err) {
      if (!alive.current) return;
      const failure = classifyPortForwardError(err);
      if (failure.kind === "disconnected") {
        setUnreachable(true);
        return;
      }
      // 判定权威恒在设备侧(规格「映射与目标」决策 8):两个码都指着目标那一格,
      // 但出路不同——一个换个目标,一个把写法改对。
      if (failure.kind === "targetTaken") {
        throw new Error(t("device.portForward.add.targetTaken"), {
          cause: err,
        });
      }
      if (failure.kind === "invalidTarget") {
        throw new Error(tUi("portForward.add.invalidTarget"), {
          cause: err,
        });
      }
      throw new Error(
        t("device.portForward.add.failed", { message: failure.message }),
        { cause: err },
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
    id: m.id,
    name: m.name,
    enabled: m.enabled,
    target: m.target,
    address: addresses[m.id],
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
          onCreate={isOffline ? undefined : handleCreate}
          onToggleEnabled={handleToggle}
          onRemove={handleRemove}
        />
      ) : null}

      {actionError ? (
        <p className="text-xs text-destructive">{actionError}</p>
      ) : null}
    </div>
  );
}
