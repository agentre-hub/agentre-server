/**
 * 草稿静默保留（规格 2026-11-25 决策 C1）：对话输入框里写到一半的字与贴的图，离开、
 * 重载、杀 App 之后回来仍在，发出或清空即清除。
 *
 * 存在本机（`accountStore`，kind = `draft`）：按账号隔离，登出 / 401 / 换账号时随业务
 * 数据一起清掉；存储不可用时静默退回「不保留」，从不抛错。
 *
 * **原样**是这里的硬约束（不改动用户发送的任何内容）：文字不 trim、不归一，图片就是
 * 输入框交出来的那份 `{ dataUrl, mediaType, name }`，不压缩不转码；IndexedDB 的结构化
 * 克隆保证读回来逐字节一致。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import type {
  ChatComposerDraft,
  ChatComposerHandle,
} from "@agentre-hub/agentre-ui";

import { useAliveEffect } from "@/hooks/use-alive-effect";
import { accountStore } from "@/lib/localStore";

export type Draft = ChatComposerDraft;

const KIND = "draft";

/** 停手这么久才落库：打字时不是每个键都写一次 IndexedDB。 */
export const DRAFT_SAVE_DEBOUNCE_MS = 400;

/** 一条已有对话的草稿键。 */
export function conversationDraftKey(conversationId: string): string {
  return `session:${conversationId}`;
}

/** 新对话草稿（还没有对话号）。全账号只有一份：换 Agent 不换草稿。 */
export const NEW_CONVERSATION_DRAFT_KEY = "new";

/** 只有空白、也没有图 = 没有草稿（与「发送」按钮的启用判据一致：发送会 trim）。 */
export function isEmptyDraft(draft: Draft): boolean {
  return draft.text.trim() === "" && draft.images.length === 0;
}

/** 本地草稿库。所有方法都不会拒绝。 */
export const draftStore = {
  get(key: string): Promise<Draft | undefined> {
    return accountStore.get<Draft>(KIND, key);
  },
  put(key: string, draft: Draft): Promise<void> {
    return accountStore.put(KIND, key, draft);
  },
  delete(key: string): Promise<void> {
    return accountStore.delete(KIND, key);
  },
  async list(): Promise<Map<string, Draft>> {
    const all = await accountStore.list<Draft>(KIND);
    return new Map(all.map((r) => [r.key, r.value]));
  },
};

/**
 * 输入框属于哪份草稿。由宿主在会话详情外面给（Chat 页按地址上的对话号包一层）；
 * 不给 = 这个输入框不保留草稿。
 */
export const DraftKeyContext = createContext<string | undefined>(undefined);

export function useDraftKey(): string | undefined {
  return useContext(DraftKeyContext);
}

/** 草稿库里全部草稿（挂载时读一次）。手机首页的行副行用。 */
export function useDraftMap(): Map<string, Draft> {
  const [drafts, setDrafts] = useState<Map<string, Draft>>(() => new Map());
  useAliveEffect((alive) => {
    void draftStore.list().then((all) => {
      if (alive()) setDrafts(all);
    });
  }, []);
  return drafts;
}

/**
 * 把一个输入框接到草稿库：挂载后恢复（`seed` 优先，其次库里的），随后输入框每次报告
 * 草稿就防抖保存；空了立即删；卸载、页面被藏起来（pagehide / 切后台）时冲刷未落库的。
 *
 * 返回要接到输入框 `onDraftChange` 的回调。
 *
 * 发送：共享输入框提交时先 `onSubmit`、随后恰好报一次空草稿——清除只认这一次空报告，
 * 发送失败时输入框被 `restoreDraft` 放回的内容会再报一次，因此仍然保存着。
 */
export function useComposerDraft({
  draftKey,
  handleRef,
  seed,
  onDraftChange,
}: {
  draftKey: string | undefined;
  handleRef: RefObject<ChatComposerHandle | null>;
  /** 开场就该放进输入框的草稿（换 Agent 时带过来的那份），优先于库里的。 */
  seed?: Draft;
  /** 每次草稿变化也告诉宿主（换 Agent 要带走它）。 */
  onDraftChange?: (draft: Draft) => void;
}): (draft: Draft) => void {
  /** 用户（或输入框）已经报过草稿：恢复晚到时不能盖掉它。 */
  const touched = useRef(false);
  const pending = useRef<{ key: string; draft: Draft } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(draftKey);
  const onChangeRef = useRef(onDraftChange);
  useEffect(() => {
    keyRef.current = draftKey;
    onChangeRef.current = onDraftChange;
  });

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) void draftStore.put(p.key, p.draft);
  }, []);

  const report = useCallback(
    (draft: Draft) => {
      touched.current = true;
      onChangeRef.current?.(draft);
      const key = keyRef.current;
      if (!key) return;
      if (isEmptyDraft(draft)) {
        // 发出或清空：撤掉还没触发的保存，立刻删——否则防抖会把它写回来。
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        pending.current = null;
        void draftStore.delete(key);
        return;
      }
      pending.current = { key, draft };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, DRAFT_SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // 恢复：只做一次（输入框随 key 重挂，换一条对话就是新的一次）。
  useEffect(() => {
    if (!draftKey) return;
    let alive = true;
    void (async () => {
      const draft = seed ?? (await draftStore.get(draftKey));
      if (!alive || !draft || touched.current || isEmptyDraft(draft)) return;
      handleRef.current?.restoreDraft(draft.text, draft.images);
    })();
    return () => {
      alive = false;
    };
    // seed 只在开场用一次；之后的变化不该再次覆盖输入框。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, handleRef]);

  // 冲刷：页面被藏起来（iOS 主屏幕 App 被划掉前多半只会触发这两个之一）与卸载。
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  return report;
}
