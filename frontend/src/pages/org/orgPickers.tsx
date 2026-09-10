/**
 * 组织面两个详情共用的「挑一个」控件：图标选择器 + 色板选择器。
 *
 * 抽在这里而不是两个详情各写一份：部门的 `accent_color` 与 Agent 的 `avatar_color`
 * 在桌面端读的本来就是同一套调色板（`org-detail-department.tsx` 用 `safeAgentColor`
 * + `agentColorClassNames`，与 Agent 头像同源），所以色板也只该有一份。
 *
 * 图标那一份现在也不在这里了：`avatar_icon` / 部门 `icon` 是**同步字段**，两端存的
 * 是同一串 key，各抄一份清单迟早会漂开成「一边认得、另一边渲染成空头像」。清单
 * （key、顺序、文案、画哪枚 lucide 图标）由共享包的 `ICON_VOCABULARY` / `iconList`
 * 出，本站只留渲染 —— 这里是**选择器**而不是「上传图片」：server 的浏览器通道没有
 * 承载头像图片的字段（读端点 `OrgAgentItem` 只有 avatar_color / avatar_icon，写端点
 * `AgentFields` 亦然；`/v1/sync/avatars` 挂在 device JWT 组上，且组织读端点不带内容
 * 哈希），画一个上传按钮就是伪造后端。
 */
import * as React from "react";
import { Ban, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  agentColorOrder,
  hasIcon,
  iconList,
  tokenToCssColor,
  cn,
} from "@agentre-hub/agentre-ui";

/** 图标按 prop 传进来再渲染：在渲染期把一个变量「变成」组件会被
 * react-hooks/static-components 拦下（与 Devices.tsx 的 DeviceIcon 同一种做法）。 */
export function RenderIcon({
  Icon,
  className,
}: {
  Icon: LucideIcon;
  className?: string;
}) {
  return <Icon className={className} aria-hidden="true" />;
}

/** 图标选择器：不设图标、桌面端设过而本表不认得的 key、以及本表这 30 枚。 */
export function OrgIconPicker(props: {
  value: string;
  onPick: (key: string) => void;
  /** 分组的可读名，同时用作 radiogroup 的 aria-label。 */
  label: string;
  noneLabel: string;
  customLabel: (key: string) => string;
}) {
  const { t } = useTranslation();
  const { value } = props;
  // 每次渲染按当前语言取：词表存的是 key，取文案的时机推迟到这里，
  // 语言一切换文案就跟着走（存成模块级常量等于把语言钉死在首次 import）。
  const icons = iconList(t);
  return (
    <div className="space-y-2">
      <label className="block text-2xs text-muted-foreground">
        {props.label}
      </label>
      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label={props.label}
      >
        <button
          type="button"
          role="radio"
          aria-checked={value === ""}
          aria-label={props.noneLabel}
          onClick={() => props.onPick("")}
          className={cn(
            "flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent",
            value === "" && "border-primary bg-primary-soft text-primary-text",
          )}
        >
          <Ban className="size-3.5" aria-hidden="true" />
        </button>
        {/* 桌面端设了一个本表没有的 key 时如实标出来并且标成选中的那一个：
            画成「什么都没选」会让用户以为自己没设过，随手一点就把它覆盖掉。 */}
        {value !== "" && !hasIcon(value) && (
          <span
            role="radio"
            aria-checked="true"
            aria-label={props.customLabel(value)}
            className="flex h-7 items-center rounded-md border border-primary bg-primary-soft px-2 font-mono text-2xs text-primary-text"
          >
            {value}
          </span>
        )}
        {icons.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="radio"
            aria-checked={value === entry.key}
            aria-label={entry.label}
            onClick={() => props.onPick(entry.key)}
            className={cn(
              "flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent",
              value === entry.key &&
                "border-primary bg-primary-soft text-primary-text",
            )}
          >
            <RenderIcon Icon={entry.icon} className="size-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** 色板选择器：格数与取值都来自共享包的 `agentColorOrder`，两端同源。 */
export function OrgColorPicker(props: {
  value: string;
  onPick: (color: string) => void;
  label: string;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-2xs text-muted-foreground">
        {props.label}
      </label>
      <div
        className="grid grid-cols-8 gap-1.5"
        role="radiogroup"
        aria-label={props.label}
      >
        {agentColorOrder.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={props.value === color}
            aria-label={color}
            onClick={() => props.onPick(color)}
            style={{ backgroundColor: tokenToCssColor(color) ?? undefined }}
            className={cn(
              "size-6 rounded-full ring-offset-2 transition-all",
              props.value === color && "ring-2 ring-primary",
            )}
          />
        ))}
      </div>
    </div>
  );
}
