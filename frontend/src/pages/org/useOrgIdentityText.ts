import { useState } from "react";
import type { OrgSaveController } from "./OrgDetailHeader";

type TextKey = "name" | "description";
type UpdateText = (patch: Partial<Record<TextKey, string>>) => Promise<void>;

function useTextField(
  key: TextKey,
  saved: string,
  save: OrgSaveController,
  update: UpdateText,
) {
  const [draft, setDraft] = useState<string>();
  const [submitted, setSubmitted] = useState<{ value: string }>();
  const baseline = submitted?.value ?? saved;
  const commit = () => {
    if (draft === undefined) return;
    setDraft(undefined);
    const value = key === "name" ? draft.trim() || baseline : draft;
    if (value === baseline) return;
    // 草稿、在途值和服务端快照分开：未编辑时跟随刷新，改回旧值也不能漏写。
    const request = { value };
    setSubmitted(request);
    save.run(async () => {
      await update({ [key]: value });
      setSubmitted((current) => (current === request ? undefined : current));
    }, key);
  };
  return { value: draft ?? baseline, change: setDraft, commit };
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
