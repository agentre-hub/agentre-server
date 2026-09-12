/**
 * 组的两套词汇之间的翻译：**索引里的组** ⇄ **端点上的 scope**
 * （规格 2026-08-19-session-index-pagination「索引读到什么」）。
 *
 * 组本身由共享包的 `buildAxisGroups` 分（组怎么分、怎么排、兜底组摆在哪，两端只有
 * 一份答案）；但「这一组在 `/v1/agent-sessions` 上叫什么」是**本站端点自己的词汇**
 * ——`project:<同步标识>` / `machine:<发起端指纹>` 这套说法只有这个 server 认，
 * 没有理由进共享 UI 包。所以它留在宿主，并且**只留这一处**：两个方向写在一起，
 * 谁也漂不开谁。漂开的后果是「点了查看全部却翻出别的组」，而那看起来只是数字不对。
 */
import {
  UNASSIGNED_PROJECT_KEY,
  UNKNOWN_MACHINE_KEY,
  UNNAMED_AGENT_KEY,
  type IndexGroup,
} from "@agentre-hub/agentre-ui";

const SCOPE_TIME = "time";
const SCOPE_UNASSIGNED_PROJECT = "unassigned-project";
const SCOPE_UNNAMED_AGENT = "unnamed-agent";
const SCOPE_PREFIX_PROJECT = "project:";
const SCOPE_PREFIX_AGENT = "agent:";
const SCOPE_PREFIX_MACHINE = "machine:";

/** 一台机器在索引里的组键。端点按指纹说话，索引按设备标识分组。 */
export function machineGroupKey(deviceId: number): string {
  return `device-${deviceId}`;
}

/**
 * 反过来：组键 → 设备标识。认不出机器的那一组不是一台机器，回 `undefined`。
 *
 * 排序要的是**数**而不是这个键：`"device-10" < "device-9"` 在字符串上成立，
 * 于是同名的两台机器在页面上与共享包（`a.deviceId - b.deviceId`）次序相反。
 * 拆键这件事因此和拼键放在一起——两个方向分开写就会漂。
 */
export function deviceIdOfGroupKey(key: string): number | undefined {
  const id = Number(key.slice("device-".length));
  return key.startsWith("device-") && Number.isFinite(id) ? id : undefined;
}

/**
 * 一个组在端点上的身份。「查看全部 N」按它继续翻这一组。
 *
 * 认不出机器的那一组**没有** scope：它是好几台机器的行凑在一起的，翻不成一组。
 * 返回 undefined 而不是编一个，界面据此不摆溢出入口。
 * 只依赖行上的承载机器指纹，避免引入 chatRows 形成循环依赖。
 */
export function scopeOfGroup(
  group: Omit<IndexGroup, "rows"> & {
    rows: ReadonlyArray<{ machineFingerprint: string }>;
  },
): string | undefined {
  switch (group.kind) {
    case "all":
      return SCOPE_TIME;
    case "unassignedProject":
      return SCOPE_UNASSIGNED_PROJECT;
    case "unnamedAgent":
      return SCOPE_UNNAMED_AGENT;
    case "project":
      return SCOPE_PREFIX_PROJECT + group.key;
    case "agent":
      return SCOPE_PREFIX_AGENT + group.key;
    case "machine": {
      if (group.key === UNKNOWN_MACHINE_KEY) return undefined;
      // 机器组按承载机器指纹，与发起端指纹无关。
      const fingerprints = new Set(group.rows.map((r) => r.machineFingerprint));
      const only = [...fingerprints];
      // 空串表示无法识别承载机器。
      return only.length === 1 && only[0]
        ? SCOPE_PREFIX_MACHINE + only[0]
        : undefined;
    }
  }
}

/**
 * 反过来：服务端给的 scope → 索引里的组键（`AxisInput.totals` 认的就是这个键）。
 *
 * 认不出的机器指纹回 UNKNOWN_MACHINE_KEY——那些行在索引里并成一组，因此它们的数
 * 要**相加**而不是各占一格。翻不出来的回 null，调用方跳过它。
 */
export function groupKeyOfScope(
  scope: string | undefined,
  deviceIdByFingerprint: (fingerprint: string) => number | undefined,
): string | null {
  if (!scope) return null;
  if (scope === SCOPE_TIME) return "__all__";
  if (scope === SCOPE_UNASSIGNED_PROJECT) return UNASSIGNED_PROJECT_KEY;
  if (scope === SCOPE_UNNAMED_AGENT) return UNNAMED_AGENT_KEY;
  if (scope.startsWith(SCOPE_PREFIX_PROJECT)) {
    return scope.slice(SCOPE_PREFIX_PROJECT.length);
  }
  if (scope.startsWith(SCOPE_PREFIX_AGENT)) {
    return scope.slice(SCOPE_PREFIX_AGENT.length);
  }
  if (scope.startsWith(SCOPE_PREFIX_MACHINE)) {
    const deviceId = deviceIdByFingerprint(
      scope.slice(SCOPE_PREFIX_MACHINE.length),
    );
    return deviceId === undefined
      ? UNKNOWN_MACHINE_KEY
      : machineGroupKey(deviceId);
  }
  return null;
}
