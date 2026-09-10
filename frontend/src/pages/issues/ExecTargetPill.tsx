/**
 * 任务表单执行段的**机器**那一颗（规格 2026-08-27「执行归属」）。
 *
 * web 与桌面端**唯一**的功能差别就在这里：浏览器不能新建 agent backend，只能从账号
 * 里已有的档中挑一个（`GET /v1/workspace/org/backends`，与组织面配执行目标同一份
 * 清单）。理由与组织面排除 `agent_backend` 写通道的理由是同一条——后端的载荷带本机
 * 可执行文件路径与透传环境变量，浏览器建出来的档必然不可用。
 *
 * 不可用的档**保留在列表里并说明原因**：把它藏掉的话，用户只会得出「那台机器不存在」
 * 这个错误结论。
 */
import * as React from "react";
import { MapPin, Server, ServerOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@agentre-hub/agentre-ui";

import { availabilityReasonKey } from "@/components/session/newconv/types";
import type { OrgBackendItem } from "@/pages/org/types";

export interface BoardExecTargetPillProps {
  /** 共享包递过来的 pill 形状；三颗触发器摆在一排必须是同一串。 */
  className: string;
  backends: OrgBackendItem[];
  /** 上面那份清单是否真的拉回来过；没拉到时不判死任何一档。 */
  backendsLoaded: boolean;
  /** 空串 = 跟随 Agent 绑定。 */
  value: string;
  onChange: (backendSyncId: string) => void;
  disabled?: boolean;
}

function MachineIcon({ backend }: { backend: OrgBackendItem }) {
  if (backend.is_local_reference || !backend.device_id) {
    return <MapPin className="size-3 shrink-0" aria-hidden="true" />;
  }
  return backend.availability === "available" ? (
    <Server className="size-3 shrink-0" aria-hidden="true" />
  ) : (
    <ServerOff className="size-3 shrink-0" aria-hidden="true" />
  );
}

function backendName(backend: OrgBackendItem): string {
  return backend.name || backend.sync_id;
}

/** 「这一档是什么」：后端类型 · 哪台机器。 */
function backendMeta(backend: OrgBackendItem): string {
  return [backend.backend_type, backend.device_name]
    .filter(Boolean)
    .join(" · ");
}

export function BoardExecTargetPill({
  className,
  backends,
  backendsLoaded,
  value,
  onChange,
  disabled,
}: BoardExecTargetPillProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const selected = backends.find((backend) => backend.sync_id === value);

  // 钉住的那一档已经不在账号里（在别处删掉了）：退回「跟随 Agent 绑定」，不留一个
  // 死指向。pill 本来就画成「跟随 Agent 绑定」（找不到 selected），值却还是那个已经
  // 消失的标识——保存时服务端按引用核对直接拒（OrgObjectNotFound），而界面上没有
  // 任何一个字段能让用户改正。桌面端那一颗是同样的处置。
  //
  // 只在清单**真的拉过**之后才判：还没拉到 / 这次拉失败时 backends 同样是空的，
  // 此刻清掉等于把用户选的机器悄悄换掉。**不可用**的档不在此列——它们照常留在
  // 列表里并说明原因（见文件头）。
  React.useEffect(() => {
    if (!backendsLoaded || !value) return;
    if (!backends.some((backend) => backend.sync_id === value)) onChange("");
  }, [backends, backendsLoaded, onChange, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="board-exec-target-pill"
          disabled={disabled}
          className={className}
          aria-label={t("issues.exec.machineAria")}
        >
          {selected ? <MachineIcon backend={selected} /> : null}
          <span
            className={cn("truncate", !selected && "text-muted-foreground")}
          >
            {selected ? backendName(selected) : t("issues.exec.followAgent")}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border-strong px-3 py-2 text-2xs font-semibold">
          {t("issues.exec.pickerTitle")}
        </div>
        <div className="max-h-64 overflow-y-auto">
          <button
            type="button"
            data-testid="board-exec-target-row-follow"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className="flex w-full cursor-pointer items-center gap-2 border-b border-border-strong px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
          >
            {t("issues.exec.followAgent")}
          </button>
          {backends.map((backend) => {
            const available = backend.availability === "available";
            const reasonKey = availabilityReasonKey(backend.availability);
            return (
              <button
                key={backend.sync_id}
                type="button"
                data-testid={`board-exec-target-row-${backend.sync_id}`}
                disabled={!available}
                onClick={() => {
                  onChange(backend.sync_id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-2 border-b border-border-strong px-3 py-2 text-left last:border-b-0",
                  available
                    ? "cursor-pointer hover:bg-accent"
                    : "cursor-not-allowed opacity-60",
                )}
              >
                <span className="mt-0.5 text-muted-foreground">
                  <MachineIcon backend={backend} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-xs font-semibold">
                    {backendName(backend)}
                  </span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {backendMeta(backend)}
                  </span>
                  {reasonKey ? (
                    <span className="truncate text-2xs text-status-waiting">
                      {t(reasonKey)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
