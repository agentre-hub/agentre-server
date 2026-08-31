import { rpcMethods } from "@agentre-hub/agentre-wire";
import {
  sessionListFromProtobuf,
  type SessionSummary,
} from "@agentre-hub/agentre-wire";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useRelayMachine } from "@/hooks/use-relay";
import type { DeviceItem } from "@/lib/devices";
import type { IndexAxis, MachineInfo } from "@/lib/sessionAxes";

/** 一台机器的解析状态。连不上与「还没连上」是两回事，不能共用一个转圈。 */
export type MachineState = "connecting" | "connected" | "unreachable";

export interface ResolvedMachine {
  sessions: SessionSummary[];
  /**
   * **这条连接**在 daemon 眼里的对端指纹（中继 ticket 的 clientId）。
   *
   * 清单里省略 `peerFingerprint` 的那些会话，说的就是「发起端是这一端」——不记下它，
   * 调用方只能拿机器指纹去顶，而那是另一个身份（见 chatRows.machineRowOrigin）。
   */
  localFingerprint: string;
}

/**
 * 一台在线目标机器的会话解析器：用 useRelayMachine 连到桌面端或 agentred，连上后
 * session.list，把那台机器上的会话回传。只有机器轴选中一台机器时才挂——
 * 「那台机器上有什么」只有机器自己知道（决策 11）。
 *
 * `keyword` 随请求下推给机器，由机器自己筛：机器上有几千条对话时，整份拉回来再在
 * 浏览器里按标题过滤，等于把几千份摘要送过线，其中绝大多数与搜索无关。命中口径的
 * 保底是标题子串；桌面端另外匹配 agent 名与项目名（它手上有这些名字，agentred 存的
 * 是 sync id）——所以这一档不再在客户端重筛一遍，重筛会把机器按名字命中的那些丢掉。
 */
function MachineSessionResolver({
  fingerprint,
  keyword,
  onResolved,
  onState,
}: {
  fingerprint: string;
  keyword: string;
  onResolved: (fp: string, resolved: ResolvedMachine) => void;
  onState: (fp: string, state: MachineState) => void;
}) {
  const { client, relayState, relayTicket } = useRelayMachine(fingerprint);
  // 记的是「已经按哪个关键词解析过」而不是一个布尔：关键词一变就得重问一次，
  // 而连接本身没有断，不该整个重挂。null = 本次连接还没解析过。
  const resolvedForRef = useRef<string | null>(null);

  useEffect(() => {
    const state: MachineState =
      relayState === "connected" && resolvedForRef.current !== null
        ? "connected"
        : relayState === "reconnecting"
          ? "unreachable"
          : "connecting";
    onState(fingerprint, state);
  }, [relayState, fingerprint, onState]);

  useEffect(() => {
    if (relayState !== "connected" || !client) {
      // 掉线/重连中：清掉「本次连接已解析」的标记。断连期间那条对话可能跑完了、
      // 也可能停下来等审批，连回来必须重新解析一次，否则页面一直挂着断线前那一刻
      // 的状态。标记记的是「解析过没有」而不是状态字符串本身 —— 拿状态跟它自己比
      // 恒成立（这个 effect 只在 connected 时走到这里），重连后一次也不会再解析。
      resolvedForRef.current = null;
      return;
    }
    if (resolvedForRef.current === keyword) return;
    resolvedForRef.current = keyword;
    client
      .request(rpcMethods.sessionList, { keyword })
      .then((raw) => {
        // 打字期间两次请求可能乱序回来。只认「此刻要的那个关键词」那一份，
        // 否则慢一步的旧结果会把新结果盖回去。
        if (resolvedForRef.current !== keyword) return;
        const res = sessionListFromProtobuf(raw);
        onResolved(fingerprint, {
          sessions: res.sessions,
          localFingerprint: relayTicket?.clientId ?? "",
        });
        onState(fingerprint, "connected");
      })
      .catch(() => {
        if (resolvedForRef.current !== keyword) return;
        // 这一次没答上来：清掉标记，关键词再变或重连时还会再问。
        resolvedForRef.current = null;
        onState(fingerprint, "unreachable");
      });
  }, [
    relayState,
    client,
    fingerprint,
    keyword,
    relayTicket,
    onResolved,
    onState,
  ]);

  return null;
}

/** 机器可达性这一族要向页面借的东西。设备名单只有页面那一处取数与重取。 */
export interface MachineReachabilityInput {
  /** 账号下的设备名单（含离线的）。 */
  devices: DeviceItem[];
  /** 当前轴：只有机器轴才真的去连那些机器。 */
  axis: IndexAxis;
  /** 已去抖的搜索词。随 session.list 下推给机器，由机器自己筛。 */
  keyword: string;
}

/** 「对话」页与机器可达性那一族之间的全部契约。 */
export interface MachineReachability {
  /** 指纹 → 设备。行的机器维、删除确认、保存都按指纹回查这一份。 */
  devicesByFp: Map<string, DeviceItem>;
  /** 可下钻的目标：能跑会话的机器（agentred / desktop）。 */
  machines: MachineInfo[];
  /** 机器轴上此刻要同时去问的那些机器；不在这一轴上时是空的。 */
  onlineMachines: DeviceItem[];
  /** 每台在线机器此刻的连接档位，按**设备标识**说话。 */
  machineStates: Record<number, MachineState>;
  /** 每台机器交出来的那份清单，按指纹。 */
  resolved: Record<string, ResolvedMachine>;
  /** 离线机器组头上的「最后在线」。 */
  machineNotes: Record<number, { lastSeenAt?: number }>;
  /** 有没有在线的 agentred：顶栏那句「桌面端已连接」认它。 */
  hasOnlineDesktop: boolean;
  /** 「重新问一次这台机器」：把那一台的解析器整个重挂。 */
  retryMachine: (deviceId: number) => void;
  /** 忘掉已经答上来的那些清单：离开机器轴时用。 */
  forgetResolved: () => void;
  /** 每台在线机器一条中继连接。由页面决定什么时候把它挂上去。 */
  resolvers: ReactNode;
}

/**
 * 「哪些机器在、够不够得着、它们上面有什么」这一族：中继连接、每台的解析状态、
 * 重试，以及由设备名单派生的那几份表。
 *
 * 与索引数据层分开住：索引回答「账号里有哪些对话」，这里回答「机器此刻是什么样」，
 * 两件事只在设备名单这一份数据上碰头。
 */
export function useMachineReachability({
  devices,
  axis,
  keyword,
}: MachineReachabilityInput): MachineReachability {
  /**
   * 「重新问一次这台机器」的计数器，按指纹。加一下让那一台的 resolver 整个重挂
   * ——它的连接与 `session.list` 都在 hook 里，重挂是重来一次的唯一入口
   * （规格 2026-08-21-connection-failure-ux 决策 9）。
   *
   * 一台一台地重挂，不牵动别的机器：它们本来就是并行去问的，一台连不上没有理由
   * 让已经答上来的那几台也重来。
   */
  const [machineNonce, setMachineNonce] = useState<Record<string, number>>({});
  const [resolved, setResolved] = useState<Record<string, ResolvedMachine>>({});
  const [machineState, setMachineState] = useState<
    Record<string, MachineState>
  >({});

  const devicesByFp = useMemo(
    () => new Map(devices.map((d) => [d.fingerprint, d])),
    [devices],
  );

  /** 可下钻的目标：能跑会话的机器（agentred / desktop）。 */
  const machines = useMemo<MachineInfo[]>(
    () =>
      devices
        .filter((d) => d.kind === "agentred" || d.kind === "desktop")
        .map((d) => ({ deviceId: d.id, name: d.name, online: d.online })),
    [devices],
  );

  /**
   * 机器轴上要**同时**去问的那些机器（规格 2026-08-21 决策 1）：能跑会话且此刻
   * 在线的都在其中。离线的不问——它答不出「上面有什么」，组头上说清楚就够了。
   */
  const onlineMachines = useMemo(
    () =>
      axis === "machine"
        ? devices.filter(
            (d) => (d.kind === "agentred" || d.kind === "desktop") && d.online,
          )
        : [],
    [axis, devices],
  );

  /**
   * 每台在线机器此刻的连接档位，按**设备标识**说话（索引的组按设备标识分）。
   * `connected` 判的是「已经交出清单」而不只是中继连上了：连上了、清单还在路上的
   * 那一段里，这一组同样答不出「上面有什么」。
   */
  const machineStates = useMemo(() => {
    const states: Record<number, MachineState> = {};
    for (const device of onlineMachines) {
      states[device.id] = resolved[device.fingerprint]
        ? "connected"
        : machineState[device.fingerprint] === "unreachable"
          ? "unreachable"
          : "connecting";
    }
    return states;
  }, [onlineMachines, resolved, machineState]);

  const onResolved = useCallback((fp: string, machine: ResolvedMachine) => {
    setResolved((prev) => ({ ...prev, [fp]: machine }));
  }, []);

  const onState = useCallback((fp: string, state: MachineState) => {
    setMachineState((prev) =>
      prev[fp] === state ? prev : { ...prev, [fp]: state },
    );
  }, []);

  // 机器交出的清单只对当前 relay 连接成立。离开机器轴会卸载解析器；下次
  // 回来必须重新问，不能拿上一条连接的答案顶在新的连接上。
  const forgetResolved = useCallback(() => {
    setResolved({});
    setMachineState({});
  }, []);

  const retryMachine = useCallback(
    (deviceId: number) => {
      const device = devices.find((d) => d.id === deviceId);
      if (!device) return;
      setMachineState((prev) => ({
        ...prev,
        [device.fingerprint]: "connecting",
      }));
      setMachineNonce((prev) => ({
        ...prev,
        [device.fingerprint]: (prev[device.fingerprint] ?? 0) + 1,
      }));
    },
    [devices],
  );

  /**
  /** 离线机器在自己的组头显示最后在线时间。 */
  const machineNotes = useMemo(() => {
    const notes: Record<number, { lastSeenAt?: number }> = {};
    for (const device of devices) {
      if (device.kind !== "agentred" && device.kind !== "desktop") continue;
      if (!device.last_seen_at) continue;
      notes[device.id] = {
        // 在线的机器不摆「最后在线」：它此刻就在线，那个数说的是另一件事。
        ...(device.online ? {} : { lastSeenAt: device.last_seen_at }),
      };
    }
    return notes;
  }, [devices]);

  // Fresh「桌面端已连接」只在有在线 agentred 时渲染；未知/离线都不显示。
  const hasOnlineDesktop = devices.some(
    (d) => d.kind === "agentred" && d.online,
  );

  /* 机器轴上对**每台在线机器**各连一条中继：只有机器自己答得出「它上面
     有什么」。离开这个轴（或离开页面）时它们一并卸载、连接随之关闭。 */
  const resolvers = onlineMachines.map((device) => (
    <MachineSessionResolver
      key={`${device.fingerprint}:${machineNonce[device.fingerprint] ?? 0}`}
      fingerprint={device.fingerprint}
      keyword={keyword}
      onResolved={onResolved}
      onState={onState}
    />
  ));

  return {
    devicesByFp,
    machines,
    onlineMachines,
    machineStates,
    resolved,
    machineNotes,
    hasOnlineDesktop,
    retryMachine,
    forgetResolved,
    resolvers,
  };
}
