/**
 * 详情主区，选中一个部门组头时出现：名称、简介、图标 key、强调色、上级部门、
 * 负责人。上级部门候选按 `isValidOrgDepartmentDrop` 过滤掉自己与自己的后代——
 * 判据与拖拽的非法落点同一条（规格「详情」：置灰判据与拖拽非法落点同一条；这里
 * 没有拖拽，但成环这条硬约束不因为换了交互方式就不管）。
 */
import * as React from "react";

import { useTranslation } from "react-i18next";

import OrgDeleteConfirm from "./OrgDeleteConfirm";
import type { RowMenuItem } from "./OrgDetailHeader";
import {
  Input,
  isValidOrgDepartmentDrop,
  Select,
  SelectContent,
  SelectItem,
  SELECT_NONE,
  SelectTrigger,
  type OrgAgentModel,
  type OrgDepartmentModel,
} from "@agentre-hub/agentre-ui";

import { OrgColorPicker, OrgIconPicker } from "./orgPickers";

import type { OrgIdMaps } from "./adapter";
import {
  OrgDetailChip,
  OrgDetailGlyph,
  OrgDetailHeader,
  useOrgSaveState,
} from "./OrgDetailHeader";
import type { DepartmentFields, OrgDepartmentItem } from "./types";

export interface OrgDepartmentDetailProps {
  department: OrgDepartmentItem;
  departmentModel: OrgDepartmentModel;
  agents: OrgAgentModel[];
  departments: OrgDepartmentModel[];
  maps: OrgIdMaps;
  onUpdate: (fields: DepartmentFields) => Promise<void>;
  onDelete: () => Promise<void>;
  /** 移动端下钻回索引；桌面端不传（索引一直并排摆着，返回没有可去之处）。 */
  onBack?: () => void;
  onClose: () => void;
}

export function OrgDepartmentDetail(props: OrgDepartmentDetailProps) {
  const { t } = useTranslation();
  const { department, departmentModel } = props;

  const [name, setName] = React.useState(department.name);
  const [description, setDescription] = React.useState(
    department.description ?? "",
  );
  const [icon, setIcon] = React.useState(department.icon ?? "");
  const [accentColor, setAccentColor] = React.useState(
    department.accent_color ?? "",
  );
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const saveState = useOrgSaveState();
  const save = (fields: DepartmentFields) =>
    saveState.run(() => props.onUpdate(fields));

  // 与 Agent 详情同一条：危险动作收进 `⋮`，不常驻版面（部门可删，所以这里
  // 总有一项）。
  const menuItems: RowMenuItem[] = [
    {
      key: "delete",
      label: t("org.detail.actions.delete"),
      danger: true,
      onSelect: () => setDeleteOpen(true),
    },
  ];

  const parentOptions = props.departments.filter(
    (d) =>
      d.id !== departmentModel.id &&
      isValidOrgDepartmentDrop(
        departmentModel.id,
        { kind: "department", departmentId: d.id },
        { agents: props.agents, departments: props.departments },
      ),
  );

  /*
    触发器上显示的是**名字**，而下拉的值是 sync id —— 两者的对应只有这里查得到
    （id ↔ sync id 的映射住在 props.maps 里）。查不到就落回「无」：一个刚被删掉的
    上级留在字段里时，显示一个空白比显示它的 sync id 好。
  */
  const parentName = props.departments.find(
    (d) => props.maps.deptSyncOf(d.id) === department.parent_sync_id,
  )?.name;
  const leadName = props.agents.find(
    (a) => props.maps.agentSyncOf(a.id) === department.lead_agent_sync_id,
  )?.name;

  return (
    <div
      data-slot="org-detail-department"
      className="flex h-full min-w-0 flex-col bg-card"
    >
      <OrgDetailHeader
        avatar={
          <OrgDetailGlyph
            label={department.name}
            color={department.accent_color}
          >
            {department.name.trim().charAt(0).toUpperCase()}
          </OrgDetailGlyph>
        }
        title={department.name}
        badges={
          <OrgDetailChip>
            {t("org.detail.header.memberCount", {
              n: departmentModel.memberCount ?? 0,
            })}
          </OrgDetailChip>
        }
        save={saveState}
        menuItems={menuItems}
        onBack={props.onBack}
        onClose={props.onClose}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="flex max-w-md min-w-0 flex-col gap-4">
          <div className="space-y-1.5">
            <label
              className="block text-2xs text-muted-foreground"
              htmlFor="org-dept-name"
            >
              {t("org.detail.fields.name")}
            </label>
            <Input
              id="org-dept-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (name !== department.name) save({ name });
              }}
              aria-label={t("org.detail.fields.name")}
            />
          </div>
          <div className="space-y-1.5">
            <label
              className="block text-2xs text-muted-foreground"
              htmlFor="org-dept-description"
            >
              {t("org.detail.fields.description")}
            </label>
            <Input
              id="org-dept-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                if (description !== (department.description ?? "")) {
                  save({ description });
                }
              }}
              aria-label={t("org.detail.fields.description")}
            />
          </div>
          <OrgIconPicker
            value={icon}
            onPick={(key) => {
              setIcon(key);
              save({ icon: key });
            }}
            label={t("org.detail.fields.avatarIconPick")}
            noneLabel={t("org.detail.fields.avatarIconNone")}
            customLabel={(key) =>
              t("org.detail.fields.avatarIconCustom", { key })
            }
          />
          <OrgColorPicker
            value={accentColor}
            onPick={(color) => {
              setAccentColor(color);
              save({ accent_color: color });
            }}
            label={t("org.detail.fields.accentColor")}
          />
          <div className="space-y-1.5">
            {/* 字段名不用 <label htmlFor>：Radix 的触发器是一颗 <button>，
                点在字段名上会转发一次点击，弹层开了又立刻关。 */}
            <p className="block text-2xs text-muted-foreground">
              {t("org.detail.fields.parentDepartment")}
            </p>
            <Select
              value={department.parent_sync_id || SELECT_NONE}
              onValueChange={(next) =>
                save({ parent_sync_id: next === SELECT_NONE ? "" : next })
              }
            >
              <SelectTrigger
                id="org-dept-parent"
                aria-label={t("org.detail.fields.parentDepartment")}
                className="font-normal"
              >
                <span className="truncate">
                  {parentName ?? t("org.detail.fields.none")}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE}>
                  {t("org.detail.fields.none")}
                </SelectItem>
                {parentOptions.map((d) => (
                  <SelectItem key={d.id} value={props.maps.deptSyncOf(d.id)}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <p className="block text-2xs text-muted-foreground">
              {t("org.detail.fields.leadAgent")}
            </p>
            <Select
              value={department.lead_agent_sync_id || SELECT_NONE}
              onValueChange={(next) =>
                save({ lead_agent_sync_id: next === SELECT_NONE ? "" : next })
              }
            >
              <SelectTrigger
                id="org-dept-lead"
                aria-label={t("org.detail.fields.leadAgent")}
                className="font-normal"
              >
                <span className="truncate">
                  {leadName ?? t("org.detail.fields.none")}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE}>
                  {t("org.detail.fields.none")}
                </SelectItem>
                {props.agents.map((a) => (
                  <SelectItem key={a.id} value={props.maps.agentSyncOf(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <OrgDeleteConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        titleKey="org.detail.delete.departmentTitle"
        name={department.name}
        onConfirm={() => void props.onDelete()}
      />
    </div>
  );
}
