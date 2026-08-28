/**
 * 「新建部门」「新建 Agent」两个对话框：只要求名称（server 侧的判据同设备上行那条
 * 路径——name 必填，其余字段留给创建之后详情面板里逐个改）。
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
  Input,
  Select,
  SelectContent,
  SelectItem,
  SELECT_NONE,
  SelectTrigger,
} from "@agentre-hub/agentre-ui";

import type { OrgDepartmentItem } from "./types";

function NameDialogForm(props: {
  title: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
  children?: (name: string) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    props.onSubmit(trimmed);
  };

  // 只要一个名称字段，标题已经把用途说完整了——没有额外说明可给，因此不给 subtitle。
  return (
    <>
      <DialogShellHeader title={props.title} onClose={props.onCancel} />
      <DialogShellBody className="flex flex-col gap-3">
        <div className="space-y-1.5">
          <label
            className="block text-2xs text-muted-foreground"
            htmlFor="org-create-name"
          >
            {t("org.detail.fields.name")}
          </label>
          <Input
            id="org-create-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            aria-label={t("org.detail.fields.name")}
          />
        </div>
        {props.children?.(name)}
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
  onCreate: (name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogShell open={props.open} onOpenChange={props.onOpenChange} size="sm">
      {props.open && (
        <NameDialogForm
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
  onCreate: (name: string, departmentSyncId: string) => void;
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
  onCreate: (name: string, departmentSyncId: string) => void;
}) {
  const { t } = useTranslation();
  const [departmentSyncId, setDepartmentSyncId] = React.useState(
    props.defaultDepartmentSyncId,
  );

  return (
    <NameDialogForm
      title={t("org.create.agentTitle")}
      onCancel={props.onCancel}
      onSubmit={(name) => props.onCreate(name, departmentSyncId)}
    >
      {() => (
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
      )}
    </NameDialogForm>
  );
}
