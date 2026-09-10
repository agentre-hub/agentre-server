/**
 * 活跃统计的读写契约（`/v1/stats/*`）。
 *
 * 前端只在这里声明这组端点的形状——Overview 与 Settings·隐私 各写一份的话，
 * 少写的字段不会报错，只会在其中一页上安静地缺一段（device-item-contract 那条
 * 守卫写过同一种病）。
 *
 * 两个「有含义的空」贯穿全文件，别顺手合并掉：
 *   - `backend_type` 为空 = 那条对话没上报后端，不是某个叫「空」的后端；
 *   - `provider_key` 与 `model_key` 皆空 = 跟随 Agent 绑定，是一档真实配置，
 *     不能并进「未上报」。
 */
import { api } from "@/lib/api";

/** 顶栏分段控件的三档。只管统计区，热力图始终是一年。 */
export type StatsRange = "7d" | "30d" | "all";

export const STATS_RANGES: StatsRange[] = ["7d", "30d", "all"];

/**
 * 这份数字覆盖了什么。
 *
 * `full` = 活跃上报开着，覆盖全部活动；`saved` = 开关关着，只覆盖已保存到账号的
 * 对话。两者都是**真数据**，差别是范围——所以 `saved` 下热力图照常画，只是更稀，
 * 绝不退成空态。
 */
export type StatsScope = "full" | "saved";

export interface StatsSummary {
  conversations: number;
  conversations_total: number;
  streak_days: number;
  longest_streak_days: number;
  active_days: number;
  window_days: number;
  devices_online: number;
  devices_total: number;
}

export interface StatsHeatmapDay {
  day: string;
  count: number;
}

export interface StatsHeatmap {
  from: string;
  to: string;
  days: StatsHeatmapDay[];
  busiest_day?: StatsHeatmapDay | null;
  avg_per_active_day?: number;
}

export interface StatsAgentRow {
  sync_id: string;
  count: number;
}

export interface StatsBackendRow {
  backend_type: string;
  count: number;
}

export interface StatsModelRow {
  provider_key: string;
  model_key: string;
  count: number;
}

export interface StatsProjectRow {
  sync_id: string;
  count: number;
}

export interface StatsOverview {
  activity_stats_enabled: boolean;
  scope: StatsScope;
  time_zone: string;
  summary: StatsSummary;
  heatmap: StatsHeatmap;
  agents: StatsAgentRow[];
  backends: StatsBackendRow[];
  models: StatsModelRow[];
  projects: StatsProjectRow[];
}

/**
 * 一台机器的上报进度。
 *
 * `reported_through` 是可选的：从没上报过的机器服务端**不发这个字段**，面板就少说
 * 一句，而不是摆一个「未知」——那是编出来的状态。
 */
export interface StatsDeviceReport {
  device_id: number;
  name: string;
  online: boolean;
  /** 已上报到哪一天（`YYYY-MM-DD`）。 */
  reported_through?: string;
}

export interface StatsSettings {
  activity_stats_enabled: boolean;
  /** 最近一次上报的毫秒级时间戳。 */
  last_report_at?: number;
  /**
   * 账号里已保存的对话条数。
   *
   * 不是可选的：0 是一个要说出来的答案（「还没有保存过对话」），把它和「服务端给不出
   * 这个数」压成同一种表现，最常见的新账号反而什么都不显示。
   */
  saved_conversations: number;
  /**
   * **服务端**此刻的日界（`YYYY-MM-DD`），与 `reported_through` 同一套时区。
   *
   * 判「这台机器已经上报到今天了」只能拿它比。拿浏览器的今天去比会差一天：服务端在
   * UTC+8 的早上 07:00，浏览器算出来的今天还是昨天，一台刚上报完的机器会被显示成
   * 「已上报到某个看起来像未来的日期」。
   */
  today: string;
  devices?: StatsDeviceReport[];
}

export async function fetchStatsOverview(
  range: StatsRange,
): Promise<StatsOverview> {
  return api<StatsOverview>(
    `/v1/stats/overview?range=${encodeURIComponent(range)}`,
  );
}

export async function fetchStatsSettings(): Promise<StatsSettings> {
  return api<StatsSettings>("/v1/stats/settings");
}

/**
 * 开 / 关活跃统计。
 *
 * `backfill` 只在开启那一次有意义（一并回填本机已有的历史），关闭时不传——
 * 关闭是「停止上报并删除服务端已有的日计数」，没有回填这回事。
 */
export async function saveStatsSettings(input: {
  enabled: boolean;
  backfill?: boolean;
}): Promise<StatsSettings> {
  const body: Record<string, unknown> = {
    activity_stats_enabled: input.enabled,
  };
  if (input.enabled) body.backfill = input.backfill === true;
  return api<StatsSettings>("/v1/stats/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
