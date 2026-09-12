import { useEffect, useMemo, useState } from "react";

import {
  FilePreviewPanel,
  previewNeedsMonaco,
  type FilePreviewSegment,
  type FilePreviewTab,
  type MonacoNS,
  type PreviewRevealTarget,
} from "@agentre-hub/agentre-ui";

import { createFilePreviewPorts } from "@/lib/filePreviewPorts";
import { loadMonaco } from "@/lib/monacoLoader";
import type { RelayClient } from "@/lib/relayClient";

/**
 * 预览栏在控制台这一侧的装配根（规格 2026-09-08「预览开在哪」）。
 *
 * 面板、标签条与四类视图都在共享包里；这一层只做三件宿主的事：把中继裹成取数
 * 端口、把「这是哪条会话的哪个工作根」交给面板当身份、把「正文来自哪台机器」
 * 交上去。设计源是 `agentre.pen` 的 `B1`：定宽 420，不可拖。
 */
export default function SessionFilePreviewColumn({
  sid,
  cwd,
  client,
  deviceName,
  deviceOnline,
  tabs,
  activePath,
  segment = null,
  refreshToken = 0,
  revealTarget,
  onActivate,
  onPromote,
  onTogglePin,
  onSegmentChange,
  onClose,
  onCloseOthers,
  onCloseAll,
}: {
  /** 这条会话的身份。与 cwd 一起构成取数目标的 sourceKey。 */
  sid: string;
  cwd: string;
  client: Pick<RelayClient, "request"> | null;
  deviceName?: string;
  deviceOnline?: boolean;
  tabs: FilePreviewTab[];
  activePath: string | null;
  /** 当前标签的 markdown 档位（渲染/文本/双栏）；存在宿主，见 useFilePreviewTabs。 */
  segment?: FilePreviewSegment | null;
  /**
   * 变一次面板重读一次。接的是**本会话轮次结束**（桌面端接 doneTick，同一条口径）：
   * 预览的文件正是 agent 此刻在改的那些，不接的话它停在打开那一刻的那一版，而面板
   * 没有刷新入口（重试只在失败态出现）。
   */
  refreshToken?: number;
  /**
   * 当前标签要滚到哪一段：转录里点了一条带行号的链接才有（`script.ts:311-330`）。
   * 缺席 = 不定位；怎么滚、越界怎么办都在共享包里，本站只负责把它交上去。
   */
  revealTarget?: PreviewRevealTarget;
  onActivate: (path: string) => void;
  /** 双击标签：转常驻。 */
  onPromote: (path: string) => void;
  /** 右键菜单的固定 / 取消固定 —— 它是个**开关**，不是单向的「钉住」。 */
  onTogglePin: (path: string) => void;
  onSegmentChange: (segment: FilePreviewSegment) => void;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
}) {
  const ports = useMemo(
    () => createFilePreviewPorts({ client, cwd }),
    [client, cwd],
  );

  /**
   * Monaco 只在**这个标签真的要它渲染**时才装（图片与工具 diff 不经 Monaco）。
   * 装载失败保持 null：内容容器留空，面板照常在，不把整栏炸掉。
   */
  const [monaco, setMonaco] = useState<MonacoNS | null>(null);
  const needsMonaco = previewNeedsMonaco(
    activePath ? { path: activePath, sourceMode: "directory" } : null,
  );
  useEffect(() => {
    if (!needsMonaco) return;
    let cancelled = false;
    loadMonaco()
      .then((ns) => {
        if (!cancelled) setMonaco(ns);
      })
      .catch(() => {
        /* 拉不下来就保持 null，内容区留空。 */
      });
    return () => {
      cancelled = true;
    };
  }, [needsMonaco]);

  // 换会话或换工作根就是换了一个取数目标，此前在途的结果一律作废 —— 面板拿这个
  // 键判定，两条会话恰好开着同一条 relPath 时才不会把上一条的正文提交出去一帧。
  const sourceKey = `${sid}\n${cwd}`;

  if (!activePath) return null;

  return (
    <aside
      data-testid="session-file-preview"
      // 420 定宽、不可拖（上游规格决策 8：详情列 896 = 转录 476 + 预览 420）。
      className="flex w-[420px] shrink-0 flex-col overflow-hidden border-l border-border bg-background"
    >
      <FilePreviewPanel
        tabs={tabs}
        activePath={activePath}
        segment={segment}
        sourceMode="directory"
        revealTarget={revealTarget}
        ports={ports}
        sourceKey={sourceKey}
        refreshToken={refreshToken}
        monaco={monaco}
        deviceName={deviceName}
        deviceOnline={deviceOnline}
        onSegmentChange={onSegmentChange}
        onActivate={onActivate}
        onPromote={onPromote}
        onPin={onTogglePin}
        onClose={onClose}
        onCloseOthers={onCloseOthers}
        onCloseAll={onCloseAll}
      />
    </aside>
  );
}
