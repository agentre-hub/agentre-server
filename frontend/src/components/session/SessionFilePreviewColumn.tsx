import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";

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
 *
 * 移动端（传了 `layer`）改为整屏一层盖住整个会话（规格 2026-09-21-server-mobile-gaps
 * 决策 2）：顶部返回 + 文件名 + 目录与机器副行，下面是同一块共享面板。层开不开由
 * 宿主答（见 useFilePreviewLayer），关着时组件仍挂着，Monaco 不必重装。
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
  layer,
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
  /** 移动端整屏层：给了就不画 420 列，只在 `shown` 时画整屏一层。 */
  layer?: { shown: boolean; onBack: () => void };
}) {
  const { t } = useTranslation();
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
  if (layer && !layer.shown) return null;

  const panel = (
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
  );

  if (layer) {
    // 两种分隔符都认，与共享包 file-meta 的 basename / dirname 同一套：Windows
    // 会话的 relPath 用反斜杠分隔，只认 "/" 的话标题成了整条路径、副行退成工作根。
    const sep = Math.max(
      activePath.lastIndexOf("/"),
      activePath.lastIndexOf("\\"),
    );
    const name = activePath.slice(sep + 1);
    // 工作根下的文件没有目录段：它就在工作根里，副行说工作根。
    const dir = sep > 0 ? activePath.slice(0, sep) : cwd;
    return (
      <section
        role="dialog"
        aria-modal="true"
        aria-label={name}
        data-testid="session-file-preview-layer"
        // 盖住会话的头部与输入框；会话本身不卸载，转录滚动位置与未发送的文字都留着。
        className="fixed inset-0 z-50 flex flex-col bg-background pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)]"
      >
        <header className="flex shrink-0 items-center gap-1 border-b border-border bg-card py-1.5 pl-1 pr-4">
          <button
            type="button"
            aria-label={t("session.filePreviewLayer.back")}
            onClick={layer.onBack}
            className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <h2
              className="truncate font-mono text-sm font-semibold text-foreground"
              title={activePath}
            >
              {name}
            </h2>
            <p
              data-testid="session-file-preview-layer-subline"
              className="truncate text-xs text-muted-foreground"
            >
              {deviceName
                ? t("session.filePreviewLayer.location", {
                    dir,
                    machine: deviceName,
                  })
                : dir}
            </p>
          </div>
        </header>
        {panel}
      </section>
    );
  }

  return (
    <aside
      data-testid="session-file-preview"
      // 420 定宽、不可拖（上游规格决策 8：详情列 896 = 转录 476 + 预览 420）。
      className="flex w-[420px] shrink-0 flex-col overflow-hidden border-l border-border bg-background"
    >
      {panel}
    </aside>
  );
}
