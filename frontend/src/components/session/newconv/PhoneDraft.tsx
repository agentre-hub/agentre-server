import { AgentAvatar, cn } from "@agentre-hub/agentre-ui";
import { ChevronRight } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { NewConvAgent } from "./types";

/**
 * 输入框里此刻有没有东西（字或贴的图）。
 *
 * 共享包的 ChatComposer 不对外给「空了没有」的回调，而宿主的 SessionComposer 也没有
 * 往下传，所以从输入框外面那一格容器观察它的 DOM：TipTap 的内容变化与贴图都会落成
 * 子树变动。只用于手机新对话页「有字时空态收起」这一个判断，不参与任何发送逻辑。
 */
export function useComposerHasDraft(rootRef: RefObject<HTMLElement | null>) {
  const [hasDraft, setHasDraft] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const read = () => {
      const text = root.querySelector(".ProseMirror")?.textContent ?? "";
      const hasImage = root.querySelector("img") !== null;
      setHasDraft(text.trim() !== "" || hasImage);
    };
    const observer = new MutationObserver(read);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [rootRef]);
  return hasDraft;
}

/** 一行可点的事实：左图标 + 名，右值 + ›。作为 Popover 触发器时 props 会被透传进来。 */
export function FactRow({
  icon,
  label,
  value,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "value"> & {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent",
        className,
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="shrink-0 text-foreground">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
        {value}
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-decorative-foreground"
      />
    </button>
  );
}

/**
 * 手机新对话页的正文：与对话页同一副骨架里，转录那一格摆的东西。
 *
 * 空草稿：头像 + 一句话 + 三行事实 + 「接着最近的对话」；有字时只剩三行事实——
 * 键盘顶起来之后屏上放不下更多，但发出之前仍要看得见会在哪台机器、哪个项目里跑。
 */
export function PhoneDraftBody({
  agent,
  sentence,
  hasDraft,
  facts,
  onContinueRecent,
  busy,
}: {
  agent: NewConvAgent;
  sentence: string;
  hasDraft: boolean;
  /** 三行事实（项目 / 运行在 / 模型），由宿主按计划状态摆好。 */
  facts: ReactNode;
  onContinueRecent: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-busy={busy || undefined}
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4",
        !hasDraft && "justify-center",
      )}
    >
      {!hasDraft && (
        <div
          data-testid="draft-phone-empty"
          className="flex flex-col items-center gap-2 text-center"
        >
          <span data-testid="draft-empty-avatar">
            <AgentAvatar
              name={agent.name}
              color={agent.avatar_color}
              iconKey={agent.avatar_icon}
              size="lg"
            />
          </span>
          <p className="text-prose font-semibold text-foreground">{sentence}</p>
          <p className="text-xs text-muted-foreground">
            {t("chat.draftEmptyHint")}
          </p>
        </div>
      )}
      <div
        data-testid="draft-facts"
        className="flex flex-col overflow-hidden rounded-xl bg-field-fill"
      >
        {facts}
      </div>
      {!hasDraft && (
        <button
          type="button"
          data-testid="draft-continue-recent"
          onClick={onContinueRecent}
          className="flex min-h-11 items-center justify-between gap-2 rounded-xl px-4 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent"
        >
          {t("chat.continueRecent")}
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-decorative-foreground"
          />
        </button>
      )}
    </div>
  );
}
