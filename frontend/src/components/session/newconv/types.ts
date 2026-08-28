/**
 * 「新对话」这一族组件共用的数据形状。
 *
 * 这些结构是 `/v1/workspace/agents` 与 `/v1/workspace/projects` 的响应形状，
 * 不是界面自己的模型——刻意保持与线上载荷同名同形，省掉一层只会漂开的映射。
 */

/** `/v1/workspace/agents` 的一项。 */
export interface NewConvAgent {
  sync_id: string;
  name: string;
  avatar_color?: string;
  /** Agent 自己选的图标名。本站没有图标集，留着是为了别让后端字段悄悄消失。 */
  avatar_icon?: string;
  /** 直接加入的项目。缺席 = 它不属于任何项目（不是「后端没实现」，见后端注释）。 */
  project_sync_ids?: string[];
  has_available_target: boolean;
  exec_targets: {
    rank: number;
    device_name?: string;
    /** 这一档跑的是哪个后端（claudecode / codex / …）。 */
    backend_type?: string;
    availability: string;
    current?: boolean;
    is_local_reference?: boolean;
  }[];
}

/** `/v1/workspace/projects` 的一项：账号项目树的一个节点。 */
export interface NewConvProject {
  sync_id: string;
  name: string;
  color?: string;
  icon?: string;
  parent_sync_id?: string;
  sort_order?: number;
}

/** 逐档不可用的原因文案键；available 没有原因标签。 */
export function availabilityReasonKey(availability: string): string | null {
  switch (availability) {
    case "no_device":
      return "overview.noDevice";
    case "offline":
      return "overview.offline";
    case "unpaired":
      return "overview.unpaired";
    case "project_path_missing":
      return "chat.projectPathMissing";
    default:
      return null;
  }
}

/**
 * 行尾那句「当前落到 X」/ 不可用的原因。
 *
 * 可用时说的是**会派到哪**（而不是光一个机器名）：Agent 有一条执行目标链，
 * 「当前落到」这个说法在总览页已经用了同一句文案，两处说的是同一件事。
 */
export function targetSummary(
  agent: NewConvAgent,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (agent.has_available_target) {
    const current = agent.exec_targets.find((x) => x.current);
    const device = current?.is_local_reference
      ? t("overview.thisDevice")
      : (current?.device_name ?? "");
    return t("overview.currentTarget", { device });
  }
  // 跑不了时给**第一档说得出原因的**那一条：本机相对引用在网页语境下永远跳过，
  // 把它当理由等于每个 Agent 都写着「网页派活跳过」，什么都没说。
  const blocking =
    agent.exec_targets.find(
      (x) => x.availability !== "available" && !x.is_local_reference,
    ) ?? agent.exec_targets[0];
  if (!blocking) return t("overview.noAvailableTarget");
  const reason = availabilityReasonKey(blocking.availability);
  if (!reason) return t("overview.noAvailableTarget");
  return blocking.device_name
    ? `${blocking.device_name} · ${t(reason)}`
    : t(reason);
}
