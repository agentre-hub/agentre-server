import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OrgSaveController } from "./OrgDetailHeader";

type TextKey = "name" | "description";
type UpdateText = (patch: Partial<Record<TextKey, string>>) => Promise<void>;

/**
 * 离开页面前先存一次（规格 2026-11-25 F4）：组件卸载（‹、系统返回、换去别的页）与页面
 * 进后台（`pagehide`、切走标签页 / 被杀前的 `visibilitychange`）都调 `flush`。
 * `flush` 自己负责「没改就不存、存过不重复存」；iOS 点 ‹ 不一定先失焦，所以不能只靠 blur。
 */
export function useFlushOnLeave(flush: () => void) {
  const latest = useRef(flush);
  useLayoutEffect(() => {
    latest.current = flush;
  });
  useEffect(() => {
    const run = () => latest.current();
    const onHide = () => {
      if (document.visibilityState === "hidden") run();
    };
    window.addEventListener("pagehide", run);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", run);
      document.removeEventListener("visibilitychange", onHide);
      run();
    };
  }, []);
}

function useTextField(
  key: TextKey,
  saved: string,
  save: OrgSaveController,
  update: UpdateText,
) {
  const [draft, setDraft] = useState<string>();
  const [submitted, setSubmitted] = useState<{ value: string }>();
  const baseline = submitted?.value ?? saved;
  // 同步镜像：离开时的 flush 与 blur 可能在同一个事件循环里先后触发，此时 state 还没
  // 重渲染，只看 state 会把同一份文字存两遍。草稿与基线的真源在这两个 ref 上。
  const draftRef = useRef<string | undefined>(undefined);
  const baselineRef = useRef(baseline);
  useLayoutEffect(() => {
    baselineRef.current = baseline;
  });
  const change = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };
  const commit = () => {
    const text = draftRef.current;
    if (text === undefined) return;
    draftRef.current = undefined;
    setDraft(undefined);
    const value = key === "name" ? text.trim() || baselineRef.current : text;
    if (value === baselineRef.current) return;
    // 草稿、在途值和服务端快照分开：未编辑时跟随刷新，改回旧值也不能漏写。
    const request = { value };
    baselineRef.current = value;
    setSubmitted(request);
    save.run(async () => {
      await update({ [key]: value });
      setSubmitted((current) => (current === request ? undefined : current));
    }, key);
  };
  useFlushOnLeave(commit);
  return { value: draft ?? baseline, change, commit };
}

export function useOrgIdentityText(
  item: { name: string; description?: string },
  save: OrgSaveController,
  update: UpdateText,
) {
  const name = useTextField("name", item.name, save, update);
  const description = useTextField(
    "description",
    item.description ?? "",
    save,
    update,
  );
  return {
    name: name.value,
    onNameChange: name.change,
    onNameBlur: name.commit,
    description: description.value,
    onDescriptionChange: description.change,
    onDescriptionBlur: description.commit,
  };
}
