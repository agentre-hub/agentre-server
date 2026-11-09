import type { IndexAxis } from "@/lib/sessionAxes";

/**
 * 手机首页的**整页范围**（规格 2026-11-05「首页（对话列表）」：范围收进标题弹层）。
 *
 * 手机上没有轴选择器：列表永远按「需要你 / 进行中 / 今天 / 更早」分段，换的只是
 * 「看谁的对话」。范围仍住在地址上（与桌面同一组参数，链接因此可分享、设备页的
 * 「查看这台机器的对话」重定向过来照样落得准）：
 *
 *   - 全部：不收（取数走时间轴，平铺、能往下翻）；
 *   - 一个项目：`?axis=project&project=<同步标识>`；
 *   - 一个 Agent：`?axis=agent&agent=<同步标识>`；
 *   - 机器：`?axis=machine`，`&machine=<设备标识>` 时只看那一台（不带就是每台在线
 *     机器，空态「按机器看设备上的对话」落在这一档）。
 *
 * 地址上别的轴（桌面留下的 `?axis=project` 等）在手机上读作「全部」。
 */
export type PhoneScope =
  | { kind: "all" }
  | { kind: "project"; projectSyncId: string }
  | { kind: "agent"; agentSyncId: string }
  | { kind: "machine"; deviceId: number | null };

/**
 * `?machine=<设备标识>`：把机器轴收到这一台上。桌面与手机读同一个参数，同一份解析。
 *
 * `/devices/:deviceId/sessions`（「查看这台机器的对话」）重定向过来时带着它——
 * 那句话说的是**一台**机器，不带范围的话落地看到的是账号下每一台。没带、或者
 * 带了个不是设备标识的东西，就是不收范围：机器轴本身仍是每台在线机器各一组。
 */
export function readMachineScope(raw: string | null): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function readPhoneScope(params: URLSearchParams): PhoneScope {
  const axis = params.get("axis");
  if (axis === "machine") {
    return {
      kind: "machine",
      deviceId: readMachineScope(params.get("machine")),
    };
  }
  const project = params.get("project")?.trim();
  if (axis === "project" && project) {
    return { kind: "project", projectSyncId: project };
  }
  const agent = params.get("agent")?.trim();
  if (axis === "agent" && agent) return { kind: "agent", agentSyncId: agent };
  return { kind: "all" };
}

/** 把范围写回地址：只动范围那几格，别的参数原样留着。 */
export function withPhoneScope(
  params: URLSearchParams,
  scope: PhoneScope,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("axis");
  next.delete("agent");
  next.delete("project");
  next.delete("machine");
  if (scope.kind === "project") {
    next.set("axis", "project");
    next.set("project", scope.projectSyncId);
  } else if (scope.kind === "agent") {
    next.set("axis", "agent");
    next.set("agent", scope.agentSyncId);
  } else if (scope.kind === "machine") {
    next.set("axis", "machine");
    if (scope.deviceId !== null) next.set("machine", String(scope.deviceId));
  }
  return next;
}

/** 这一范围向索引数据层要哪一轴。 */
export function phoneDataAxis(scope: PhoneScope): IndexAxis {
  switch (scope.kind) {
    case "project":
      return "project";
    case "agent":
      return "agent";
    case "machine":
      return "machine";
    case "all":
      return "time";
  }
}

/** 端点上的那一组（项目与 Agent 范围要收）。 */
export function phoneServerScope(scope: PhoneScope): string | undefined {
  if (scope.kind === "project") return `project:${scope.projectSyncId}`;
  return scope.kind === "agent" ? `agent:${scope.agentSyncId}` : undefined;
}

/** 范围的身份：返回恢复按它记滚动位置。 */
export function phoneScopeKey(scope: PhoneScope): string {
  switch (scope.kind) {
    case "project":
      return `project:${scope.projectSyncId}`;
    case "agent":
      return `agent:${scope.agentSyncId}`;
    case "machine":
      return `machine:${scope.deviceId ?? "*"}`;
    case "all":
      return "all";
  }
}
