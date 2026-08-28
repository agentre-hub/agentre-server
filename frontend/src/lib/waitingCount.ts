/**
 * 侧栏「对话」那颗角标的取数。
 *
 * 单开一条端点而不是让外壳去拉一页会话索引：这条路在**每一次进入任何页面**时都会跑
 * 一遍，而一页摘要里的标题、游标、项目归属一个都用不上。
 *
 * 判据（「等你处理」是哪一档）住在服务端，与索引上那个筛选 chip 共用同一个
 * —— 侧栏说有 3 条等你、点进去筛选却是 2 条，是一种没有任何地方会报错、而用户一眼
 * 就看得见的错。
 */
import { api } from "@/lib/api";

export interface WaitingCount {
  /** 账号里此刻等你处理的对话条数。0 是答案，不是「没问出来」。 */
  waiting: number;
}

export async function fetchWaitingCount(): Promise<WaitingCount> {
  return api<WaitingCount>("/v1/agent-sessions/waiting-count");
}
