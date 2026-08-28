/**
 * 详情主区，选中一行 Agent 时出现，三栏：身份 / 行为 / 执行（规格「详情」）。
 * 归属下拉、工具清单、执行目标行都来自共享包；三栏骨架、名称/简介/头像、
 * 系统提示词编辑器是宿主自己搭的（与桌面端各自维护一份同形的壳，规格
 * 「外壳保持分叉」只到索引 + 行 + 转录，详情三栏骨架本就是宿主各自的装配）。
 *
 * 每一次字段编辑只提交这一个字段（AgentFields 全是指针语义：不传 = 不改，
 * 服务端只覆盖明确涉及的键）——不把整份表单状态囫囵提交回去，避免把用户没碰过的
 * 键写成当前表单快照（本来就该是这样，但快照式提交是最容易踩的默认写法）。
 * 提交是静默的，反馈落在头部那条保存态上（见 OrgDetailHeader）。
 */
import * as React from "react";
import { useTranslation } from "react-i18next";

import OrgDeleteConfirm from "./OrgDeleteConfirm";
import type { RowMenuItem } from "./OrgDetailHeader";
import {
  Button,
  DialogShell,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  DialogShellSubmit,
  Input,
  isOrgSystemAgent,
  OrgPlacementField,
  Textarea,
  OrgToolList,
  resolveOrgReportTo,
  type OrgAgentModel,
  type OrgDepartmentModel,
  hasIcon,
  iconForKey,
  type OrgPlacement,
} from "@agentre-hub/agentre-ui";

import { OrgColorPicker, OrgIconPicker, RenderIcon } from "./orgPickers";
import {
  parsePromptJSON,
  parseToolsJSON,
  stringifyPromptJSON,
  stringifyToolsJSON,
  type OrgIdMaps,
} from "./adapter";
import {
  OrgDetailBadge,
  OrgDetailChip,
  OrgDetailGlyph,
  OrgDetailHeader,
  useOrgSaveState,
} from "./OrgDetailHeader";
import { OrgExecTargetSection } from "./OrgExecTargetSection";
import type { AgentFields, OrgAgentItem, OrgBackendItem } from "./types";

/** 静态内置工具注册表（`agentre` 的 internal/pkg/agenttool.Keys()）：这一份是
 * 跨仓的固定 3 个 key，server 没有单独的读端点暴露它——它本来就不是账号可配置的
 * 数据，是编译期常量，两端各自照抄一份是合理的（与包内 ORG_APPROVAL_TOOLS 的
 * 硬编码同一种做法）。 */
const ORG_TOOL_KEYS = ["org", "subagent", "hook"];

export interface OrgAgentDetailProps {
  agent: OrgAgentItem;
  agentModel: OrgAgentModel;
  agents: OrgAgentModel[];
  departments: OrgDepartmentModel[];
  backends: OrgBackendItem[];
  maps: OrgIdMaps;
  onUpdate: (fields: AgentFields) => Promise<void>;
  onDelete: () => Promise<void>;
  onCreateExecTarget: (backendSyncId: string) => void;
  onRemoveExecTarget: (syncId: string) => void;
  onChangeExecTargetSkills: (syncId: string, skillsJson: string) => void;
  onReload: () => void;
  /** 移动端下钻回索引；桌面端不传（索引一直并排摆着，返回没有可去之处）。 */
  onBack?: () => void;
  onClose: () => void;
}

export function OrgAgentDetail(props: OrgAgentDetailProps) {
  const { t } = useTranslation();
  const { agent, agentModel } = props;
  const isSystem = isOrgSystemAgent(agentModel);

  const [name, setName] = React.useState(agent.name);
  const [description, setDescription] = React.useState(agent.description ?? "");
  const [prompt, setPrompt] = React.useState(() =>
    parsePromptJSON(agent.prompt_json),
  );
  const [promptOpen, setPromptOpen] = React.useState(false);
  const [promptDraft, setPromptDraft] = React.useState("");
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const tools = parseToolsJSON(agent.tools_json);
  const avatarIcon = agent.avatar_icon ?? "";

  const save = useOrgSaveState();
  const saveIfChanged = (fields: AgentFields) =>
    save.run(() => props.onUpdate(fields));

  const placement: OrgPlacement =
    agentModel.parentAgentId && agentModel.parentAgentId > 0
      ? { kind: "agent", id: agentModel.parentAgentId }
      : { kind: "department", id: agentModel.departmentId ?? 0 };

  // 归属是部门时，下面附一条只读的推导行说明汇报对象（部门负责人）；归属是
  // 上级 Agent 时不需要——那种情况下汇报对象就等于归属本身，OrgPlacementField
  // 自己会跳过那一行。
  const reportToId = resolveOrgReportTo(
    agentModel,
    props.agents,
    props.departments,
  );
  const reportTarget =
    placement.kind === "department" && reportToId !== 0
      ? (props.agents.find((a) => a.id === reportToId) ?? null)
      : null;

  const handlePlacementPick = (next: OrgPlacement) => {
    // 归属是二选一：两个键都要显式带上（一个真值,另一个显式清空），
    // 否则「指针=不改」的语义会把旧的那一边原样留着，读起来像同时挂在两处。
    saveIfChanged({
      department_sync_id:
        next.kind === "department" ? props.maps.deptSyncOf(next.id) : "",
      parent_agent_sync_id:
        next.kind === "agent" ? props.maps.agentSyncOf(next.id) : "",
    });
  };

  const toggleTool = (key: string) => {
    // 与桌面端同形（org-detail-agent.tsx）：稠密表示——已知的每个 key 都在数组里
    // 带一个 enabled 位，不是「只列已授权的」那种稀疏数组。
    const current = new Map(tools.map((tl) => [tl.key, tl.enabled]));
    const next = ORG_TOOL_KEYS.map((k) => ({
      key: k,
      enabled:
        k === key ? !(current.get(k) ?? false) : (current.get(k) ?? false),
    }));
    saveIfChanged({ tools_json: stringifyToolsJSON(next) });
  };

  const savePrompt = (text: string) => {
    if (parsePromptJSON(agent.prompt_json) === text) return;
    saveIfChanged({ prompt_json: stringifyPromptJSON(text) });
  };

  // ---- 头部：头像 + 名字 + **算得出来的**角色徽标 ----
  // 词表外的 key（桌面端设过而这版不认得）按「没有图标」处理，回落成首字母 ——
  // 包的 iconForKey 会给一枚拼图兜底，那在这里会把「不认得」画成一个像模像样的图标。
  const avatarIconComponent = hasIcon(avatarIcon)
    ? iconForKey(avatarIcon)
    : undefined;
  const leadsDepartments = props.departments.some(
    (d) => d.leadAgentId === agentModel.id,
  );
  const ownDepartment =
    agentModel.departmentId && agentModel.departmentId > 0
      ? props.departments.find((d) => d.id === agentModel.departmentId)
      : undefined;
  const parentAgent =
    agentModel.parentAgentId && agentModel.parentAgentId > 0
      ? props.agents.find((a) => a.id === agentModel.parentAgentId)
      : undefined;

  // 系统 Agent 删不得（agent_svc 那侧硬拒），所以它一条菜单项都没有——
  // 于是整个 `⋮` 不画，而不是画一个禁用的删除项去暗示它以后能删。
  const menuItems: RowMenuItem[] = isSystem
    ? []
    : [
        {
          key: "delete",
          label: t("org.detail.actions.delete"),
          danger: true,
          onSelect: () => setDeleteOpen(true),
        },
      ];

  return (
    <div
      data-slot="org-detail-agent"
      className="flex h-full min-w-0 flex-col bg-card"
    >
      <OrgDetailHeader
        avatar={
          <OrgDetailGlyph label={agent.name} color={agent.avatar_color}>
            {avatarIconComponent ? (
              <RenderIcon Icon={avatarIconComponent} className="size-[18px]" />
            ) : (
              agent.name.trim().charAt(0).toUpperCase()
            )}
          </OrgDetailGlyph>
        }
        title={agent.name}
        badges={
          <>
            {isSystem && (
              <OrgDetailBadge>
                {t("org.detail.header.systemBadge")}
              </OrgDetailBadge>
            )}
            {leadsDepartments && (
              <OrgDetailBadge>
                {t("org.detail.header.leadBadge")}
              </OrgDetailBadge>
            )}
            {ownDepartment && (
              <OrgDetailChip>{ownDepartment.name}</OrgDetailChip>
            )}
            {parentAgent && (
              <OrgDetailChip>
                {t("org.detail.header.reportsToParent", {
                  name: parentAgent.name,
                })}
              </OrgDetailChip>
            )}
          </>
        }
        save={save}
        menuItems={menuItems}
        onBack={props.onBack}
        onClose={props.onClose}
      />

      <div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-5">
        <div
          className="grid min-w-0 grid-cols-1 items-start gap-6 @xl:grid-cols-2 @3xl:grid-cols-3"
          data-slot="org-detail-columns"
        >
          <section
            aria-label={t("org.detail.columns.identity")}
            data-slot="org-detail-col-identity"
            className="flex min-w-0 flex-col gap-4"
          >
            <h3 className="font-mono text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("org.detail.columns.identity")}
            </h3>
            <div className="space-y-1.5">
              <label
                className="block text-2xs text-muted-foreground"
                htmlFor="org-agent-name"
              >
                {t("org.detail.fields.name")}
              </label>
              <Input
                id="org-agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  if (name !== agent.name) saveIfChanged({ name });
                }}
                aria-label={t("org.detail.fields.name")}
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="block text-2xs text-muted-foreground"
                htmlFor="org-agent-description"
              >
                {t("org.detail.fields.description")}
              </label>
              <Input
                id="org-agent-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (description !== (agent.description ?? "")) {
                    saveIfChanged({ description });
                  }
                }}
                aria-label={t("org.detail.fields.description")}
              />
            </div>
            <OrgColorPicker
              value={agent.avatar_color ?? ""}
              onPick={(color) => saveIfChanged({ avatar_color: color })}
              label={t("org.detail.fields.avatarColor")}
            />
            <OrgIconPicker
              value={avatarIcon}
              onPick={(key) => saveIfChanged({ avatar_icon: key })}
              label={t("org.detail.fields.avatarIconPick")}
              noneLabel={t("org.detail.fields.avatarIconNone")}
              customLabel={(key) =>
                t("org.detail.fields.avatarIconCustom", { key })
              }
            />
            <OrgPlacementField
              agent={agentModel}
              agents={props.agents}
              departments={props.departments}
              placement={placement}
              reportTarget={reportTarget}
              onPick={handlePlacementPick}
            />
          </section>

          <section
            aria-label={t("org.detail.columns.behavior")}
            data-slot="org-detail-col-behavior"
            className="flex min-w-0 flex-col gap-4"
          >
            <h3 className="font-mono text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("org.detail.columns.behavior")}
            </h3>
            <div className="min-w-0 space-y-2">
              {/* 这是这一屏最常改的字段：区头写出字数，右侧给一个展开入口，
                  框本身加高到 232px（mockup README 点名的第 3 处）。 */}
              <div className="flex min-w-0 items-center gap-2">
                <label
                  className="font-mono text-2xs text-muted-foreground"
                  htmlFor="org-agent-prompt"
                >
                  {t("org.detail.systemPrompt")}
                </label>
                <span
                  data-testid="org-prompt-count"
                  className="min-w-0 truncate text-2xs text-muted-foreground"
                >
                  {t("org.detail.prompt.charCount", { n: prompt.length })}
                </span>
                <Button
                  variant="link"
                  size="xs"
                  className="ml-auto shrink-0 px-0"
                  onClick={() => {
                    setPromptDraft(prompt);
                    setPromptOpen(true);
                  }}
                >
                  {t("org.detail.prompt.expand")}
                </Button>
              </div>
              <Textarea
                id="org-agent-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onBlur={() => savePrompt(prompt)}
                placeholder={t("org.detail.systemPromptPlaceholder")}
                aria-label={t("org.detail.systemPrompt")}
                className="min-h-[232px] bg-transparent font-mono text-xs [overflow-wrap:anywhere]"
              />
            </div>
            <OrgToolList
              toolKeys={ORG_TOOL_KEYS}
              agentTools={tools}
              onToggleGrant={toggleTool}
            />
          </section>

          <OrgExecTargetSection
            agentSyncId={agent.sync_id}
            targets={agent.exec_targets}
            backends={props.backends}
            onCreate={props.onCreateExecTarget}
            onRemove={props.onRemoveExecTarget}
            onChangeSkills={props.onChangeExecTargetSkills}
            onReordered={props.onReload}
          />
        </div>
      </div>

      <DialogShell
        open={promptOpen}
        onOpenChange={(o) => !o && setPromptOpen(false)}
        size="lg"
      >
        <DialogShellHeader
          title={t("org.detail.prompt.dialogTitle", { name: agent.name })}
          subtitle={t("org.detail.systemPromptPlaceholder")}
          onClose={() => setPromptOpen(false)}
        />
        <DialogShellBody>
          <Textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            aria-label={t("org.detail.systemPrompt")}
            className="h-[50vh] min-h-[320px] bg-transparent font-mono text-xs shadow-none [overflow-wrap:anywhere]"
          />
        </DialogShellBody>
        <DialogShellFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPromptOpen(false)}
          >
            {t("org.detail.prompt.cancel")}
          </Button>
          <DialogShellSubmit
            size="sm"
            onClick={() => {
              setPrompt(promptDraft);
              savePrompt(promptDraft);
              setPromptOpen(false);
            }}
          >
            {t("org.detail.prompt.save")}
          </DialogShellSubmit>
        </DialogShellFooter>
      </DialogShell>

      <OrgDeleteConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        titleKey="org.detail.delete.agentTitle"
        name={agent.name}
        onConfirm={() => void props.onDelete()}
      />
    </div>
  );
}
