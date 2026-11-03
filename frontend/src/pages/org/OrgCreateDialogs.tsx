/**
 * 「新建部门」「新建 Agent」共用身份区：名称必填，描述、记号和颜色只改草稿，
 * 点创建才提交；没设置的可选字段不进请求。
 *
 * 表单状态只活在「打开」这一次挂载里（`{open && <Form/>}`）：关闭再打开是一次全新
 * 挂载，`useState` 的初值天然就是空——不需要额外一个 effect 在「打开」这个时机把
 * 状态拨回空串。
 */
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  DialogShellSubmit,
  DialogShell,
  IdentityFields,
  Select,
  SelectContent,
  SelectItem,
  SELECT_NONE,
  SelectTrigger,
} from "@agentre-hub/agentre-ui";

import type { OrgDepartmentItem } from "./types";

export interface CreateIdentityDraft {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
}

function IdentityDialogForm(props: {
  kind: "agent" | "department";
  title: string;
  onCancel: () => void;
  onSubmit: (draft: CreateIdentityDraft) => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [icon, setIcon] = React.useState("");
  const [color, setColor] = React.useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    props.onSubmit({
      name: trimmed,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(icon ? { icon } : {}),
      ...(color ? { color } : {}),
    });
  };

  // 标题已经说明用途，不额外添加说明文案。
  return (
    <>
      <DialogShellHeader title={props.title} onClose={props.onCancel} />
      <DialogShellBody className="flex flex-col gap-3">
        <div
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              e.target instanceof HTMLInputElement &&
              e.target.dataset.testid === `org-create-${props.kind}-name`
            )
              submit();
          }}
        >
          <IdentityFields
            kind={props.kind}
            testIdPrefix={`org-create-${props.kind}`}
            name={name}
            description={description}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            autoFocusName
            mark={{
              iconKey: icon,
              color,
              onPickIcon: setIcon,
              onPickColor: setColor,
            }}
          />
        </div>
        {props.children}
      </DialogShellBody>
      <DialogShellFooter>
        <Button variant="outline" size="sm" onClick={props.onCancel}>
          {t("org.create.cancel")}
        </Button>
        <DialogShellSubmit size="sm" disabled={!name.trim()} onClick={submit}>
          {t("org.create.submit")}
        </DialogShellSubmit>
      </DialogShellFooter>
    </>
  );
}

export function CreateDepartmentDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: CreateIdentityDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogShell open={props.open} onOpenChange={props.onOpenChange} size="sm">
      {props.open && (
        <IdentityDialogForm
          kind="department"
          title={t("org.create.departmentTitle")}
          onCancel={() => props.onOpenChange(false)}
          onSubmit={props.onCreate}
        />
      )}
    </DialogShell>
  );
}

export function CreateAgentDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departments: OrgDepartmentItem[];
  /**
   * 打开时下拉里预选哪个部门。索引组头上的「＋」是「往**这个**部门加 Agent」，
   * 而表单状态只在「打开」这一次挂载里取初值（见文件头），所以预选值只能从外面
   * 传进来。空串 = 不预选（顶层 / 由用户自己挑）。
   */
  defaultDepartmentSyncId?: string;
  onCreate: (draft: CreateIdentityDraft, departmentSyncId: string) => void;
}) {
  return (
    <DialogShell open={props.open} onOpenChange={props.onOpenChange} size="sm">
      {props.open && (
        <CreateAgentForm
          departments={props.departments}
          defaultDepartmentSyncId={props.defaultDepartmentSyncId ?? ""}
          onCancel={() => props.onOpenChange(false)}
          onCreate={props.onCreate}
        />
      )}
    </DialogShell>
  );
}

function CreateAgentForm(props: {
  departments: OrgDepartmentItem[];
  defaultDepartmentSyncId: string;
  onCancel: () => void;
  onCreate: (draft: CreateIdentityDraft, departmentSyncId: string) => void;
}) {
  const { t } = useTranslation();
  const [departmentSyncId, setDepartmentSyncId] = React.useState(
    props.defaultDepartmentSyncId,
  );

  return (
    <IdentityDialogForm
      kind="agent"
      title={t("org.create.agentTitle")}
      onCancel={props.onCancel}
      onSubmit={(draft) => props.onCreate(draft, departmentSyncId)}
    >
      <div className="space-y-1.5">
        {/* 字段名不用 <label htmlFor>：Radix 的触发器是一颗 <button>，点在字段名
              上会转发一次点击，弹层开了又立刻关。 */}
        <p className="block text-2xs text-muted-foreground">
          {t("org.create.department")}
        </p>
        <Select
          value={departmentSyncId || SELECT_NONE}
          onValueChange={(next) =>
            setDepartmentSyncId(next === SELECT_NONE ? "" : next)
          }
        >
          <SelectTrigger
            id="org-create-agent-department"
            aria-label={t("org.create.department")}
            className="font-normal"
          >
            <span className="truncate">
              {props.departments.find((d) => d.sync_id === departmentSyncId)
                ?.name ?? t("org.detail.fields.none")}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_NONE}>
              {t("org.detail.fields.none")}
            </SelectItem>
            {props.departments.map((d) => (
              <SelectItem key={d.sync_id} value={d.sync_id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </IdentityDialogForm>
  );
}
