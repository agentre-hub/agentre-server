/**
 * 组织面的取数：一次拿全 GET /v1/workspace/org（部门 + Agent，Agent 下带执行目标）
 * 与 GET /v1/workspace/org/backends（配一档时能挑的后端），外加账号级实时通道
 * （规格「账号级实时通道」）——收到 `sync_version` 推进、每一次建连/重连都重拉一次。
 *
 * **通道整个连不上时组织面必须照样正确**：初次加载走的是这里的 `reload()`，
 * 不等通道的 onopen；通道只是在它能连上的时候把 30 秒轮询提前触发。
 * `useAccountChannel` 自己已经把「连不上就退回轮询」「起不来也不抛给页面」这两条
 * 焊死了，这里只需要说清楚自己关心哪一类信号。
 */
import * as React from "react";

import { useAccountChannel } from "@/hooks/use-account-channel";
import { useAliveEffect } from "@/hooks/use-api-query";
import { AccountChannelSyncVersion } from "@/lib/accountChannel";
import { api } from "@/lib/api";

import type { OrgBackendItem, OrgChartResponse } from "./types";

export interface UseOrgDataResult {
  chart: OrgChartResponse | null;
  backends: OrgBackendItem[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

export function useOrgData(): UseOrgDataResult {
  const [chart, setChart] = React.useState<OrgChartResponse | null>(null);
  const [backends, setBackends] = React.useState<OrgBackendItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const [chartRes, backendsRes] = await Promise.all([
        api<OrgChartResponse>("/v1/workspace/org"),
        api<{ backends: OrgBackendItem[] }>("/v1/workspace/org/backends"),
      ]);
      setChart(chartRes);
      setBackends(backendsRes.backends ?? []);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次加载：直接落 api() 的 promise 链，不经 reload 这个本地闭包——与 AppShell.tsx
  // 同一种形状（订阅 fetch 这个外部系统，在它的 .then()/.catch() 回调里 setState），
  // 而不是在 effect 体的同步部分直接调用一个「已知会 setState」的本地函数。
  useAliveEffect((alive) => {
    Promise.all([
      api<OrgChartResponse>("/v1/workspace/org"),
      api<{ backends: OrgBackendItem[] }>("/v1/workspace/org/backends"),
    ])
      .then(([chartRes, backendsRes]) => {
        if (!alive()) return;
        setChart(chartRes);
        setBackends(backendsRes.backends ?? []);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive()) setError(messageOf(err));
      })
      .finally(() => {
        if (alive()) setLoading(false);
      });
  }, []);

  // 只订同步版本：组织架构、Agent、执行目标都是 sync_objects 上的东西。别人发了
  // 条消息、一台机器上线，都与这一页无关，不该让它把两条请求重打一遍。
  //
  // 通道起不来时这一页照常正确（起不来的处理在 useAccountChannel 里）：首次加载走
  // 的是上面那个 effect，不等通道。
  useAccountChannel([AccountChannelSyncVersion], () => void reload());

  return { chart, backends, loading, error, reload };
}
