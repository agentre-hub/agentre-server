/**
 * 详情「执行」栏：一档一行（共享包 `OrgExecTargetRow`），排序走既有的账号级排序
 * 端点（`@/lib/execOrder.ts`，POST /v1/workspace/exec-target-order）。
 *
 * 排序有两条入口，落到同一个判据上：拖拽柄（dnd-kit 的 `DndContext` +
 * `SortableContext`，指针与键盘两种传感器）与柄聚焦后的 ↑/↓（共享件自带的键盘
 * 兜底，见 `org-exec-target-row.tsx` 的 `onHandleKeyDown`）。行右侧不再另画一对
 * 上下箭头按钮，但 `onMoveUp` / `onMoveDown` 仍然要传 —— 那对回调正是键盘兜底
 * 的落点，撤掉按钮不等于撤掉键盘路径。
 *
 * 落点算法只有一份：`reorderTargets`（一次挪一位，不可移动的档钉在原位）。拖拽
 * 跨越多位时是对它的**连续调用**，而不是另写一个 arrayMove —— 「哪些档可以排、
 * 能不能再往前/往后」的判据不能有第二个实现。
 *
 * 增删档走任务 8 的三个执行目标端点；后端只能从 `backends`（GET
 * /v1/workspace/org/backends）里挑,新建/编辑后端不在这个面板的能力范围内。
 */
import * as React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
  OrgExecTargetRow,
  type OrgBackendModel,
  type OrgExecTargetRowProps,
  type OrgExecTargetStatus,
} from "@agentre-hub/agentre-ui";

import {
  isMovableTier,
  reorderTargets,
  saveExecTargetOrder,
  type OrderableTier,
} from "@/lib/execOrder";
import {
  fetchSkillCatalog,
  parseSkillAuthorizations,
  serializeSkillAuthorizations,
  setSkillTriState,
  skillTriState,
  type SkillAuthorization,
  type SkillPack as SkillPackSummary,
  type SkillTriState,
} from "@/lib/skillCatalog";
import type { OrgBackendItem, OrgExecTargetItem } from "./types";

function toBackendModel(
  target: OrgExecTargetItem,
): OrgBackendModel | undefined {
  if (!target.backend_sync_id) return undefined;
  return {
    id: 0,
    type: target.backend_type ?? "",
    name: target.backend_name ?? "",
    deviceId: target.is_local_reference
      ? undefined
      : target.device_id
        ? String(target.device_id)
        : undefined,
    deviceName: target.device_name,
  };
}

// 不支持技能的后端不给展开入口（规格「详情」）。判据与桌面端同源 —— 桌面端问的是
// Go 侧的能力矩阵（GetBackendCapabilities → runtime 声明的 CapSkills），浏览器这一侧
// 本轮没有那个端点，只能钉一张表。
//
// **它与 `skills.catalog` 的 `discovery: "unsupported"` 分工明确，不是二选一。**
// 白名单是**拨号之前**就能下的判断：builtin / piagent / openclaw 上问技能必然得到
// unsupported，为此建一条 WebSocket、握一次手、等一个必然的否定答复，只是把一句
// 本地就知道的话绕了一圈网络。`discovery` 要拨通了才知道，它守的是白名单**猜错**
// 的那一侧：白名单说「这类后端有技能」，而那台机器上的这个 backend 其实没有发现器
// （版本旧、装法不同），机器有最终发言权，技能块就地说明并且不再给出可挑的列表。
// 于是：白名单决定给不给入口，`discovery` 决定入口里说什么。
//
// 这张表是**白名单**而不是「排除 builtin」的黑名单。能出现在这里的 backend_type
// 只有 agent_backend_entity 那五个常量（builtin / claudecode / codex / piagent /
// openclaw —— 载荷里的 type 就是那一列，见 agentre 的 sync_svc/adapter_org.go），
// 其中声明 CapSkills 的只有 claudecode 与 codex；builtin / piagent / openclaw 都没有。
// （remote 是跨机跑的传输，不是一种 backend_type：远端那台上的档 type 仍是 claudecode。）
// 白名单同时定死了默认值 —— 日后多一种 runtime，这一侧默认「不支持」，最多少一个
// 入口；黑名单的默认是「支持」，会展开后给一句规格点名不要的空话。桌面端拉不到
// 能力矩阵时同样按「不支持」渲染（exec-target-list.tsx 的 caps?.has("skills") ?? false）。
const BACKENDS_WITH_SKILLS = new Set(["claudecode", "codex"]);

function supportsSkills(backendType: string | undefined): boolean {
  return BACKENDS_WITH_SKILLS.has((backendType ?? "").trim());
}

/** availability(server 词汇) → {available,reason}(共享包词汇) 的最小映射。 */
function statusOf(target: OrgExecTargetItem): OrgExecTargetStatus {
  switch (target.availability) {
    case "available":
      return { available: true, reason: "" };
    case "offline":
      return { available: false, reason: "exec-target-offline" };
    case "unpaired":
      return { available: false, reason: "exec-target-unpaired" };
    default:
      // 本机相对引用在浏览器语境下永远没有指代对象：没有专门的 reason 词条，
      // 「未配对」是语义上最接近的既有取值（都是「这一档此刻没有可用设备」）。
      return { available: false, reason: "exec-target-unpaired" };
  }
}

export interface OrgExecTargetSectionProps {
  agentSyncId: string;
  targets: OrgExecTargetItem[];
  backends: OrgBackendItem[];
  onCreate: (backendSyncId: string) => void;
  onRemove: (syncId: string) => void;
  onChangeSkills: (syncId: string, skillsJson: string) => void;
  onReordered: () => void;
}

/** 一次移动的结果：要提交的排列，以及被挪的那一档落在第几位（从 0 起）。 */
interface TierMove {
  ids: string[];
  next: OrderableTier[];
  landed: number;
}

function toOrderable(target: OrgExecTargetItem): OrderableTier {
  return {
    backend_sync_id: target.backend_sync_id,
    availability: target.availability,
  };
}

/**
 * 把 `reorderTargets` 交回来的 sync_id 排列还原成档的排列。
 *
 * `reorderTargets` 只会重排**可移动**的档，并把没有 sync_id 的档滤出结果，因此
 * 「有 sync_id 的档按新序、其余留在原位」就足以复原整份列表 —— 有了它，跨越多位
 * 的一次拖拽才能表达成对 `reorderTargets` 的连续调用。
 */
function rebuildTiers(tiers: OrderableTier[], ids: string[]): OrderableTier[] {
  const byId = new Map<string, OrderableTier>();
  for (const tier of tiers) {
    if (tier.backend_sync_id) byId.set(tier.backend_sync_id, tier);
  }
  let cursor = 0;
  return tiers.map((tier) =>
    tier.backend_sync_id ? (byId.get(ids[cursor++]) ?? tier) : tier,
  );
}

/** 挪一位。不可移动、或已经在这个方向的尽头时返回 null（调用方据此什么都不发）。 */
function stepTier(
  tiers: OrderableTier[],
  index: number,
  direction: -1 | 1,
): TierMove | null {
  const ids = reorderTargets(tiers, index, direction);
  if (!ids) return null;
  const next = rebuildTiers(tiers, ids);
  return { ids, next, landed: next.indexOf(tiers[index]) };
}

/**
 * 拖拽落点：把第 `from` 档一步一步挪到第 `to` 档。每一步都是 `reorderTargets`，
 * 于是「不可移动的档钉在原位」这条判据自动成立，也不会多出第二套落点算法。
 * 中途撞上走不动（例如目标位其实不可落）就停在最后一次成功的排列上。
 */
function dragTier(
  tiers: OrderableTier[],
  from: number,
  to: number,
): TierMove | null {
  if (from === to) return null;
  const direction: -1 | 1 = to > from ? 1 : -1;
  let working = tiers;
  let cursor = from;
  let last: TierMove | null = null;
  while (direction === 1 ? cursor < to : cursor > to) {
    const step = stepTier(working, cursor, direction);
    if (!step) break;
    last = step;
    working = step.next;
    cursor = step.landed;
  }
  return last;
}

export function OrgExecTargetSection(props: OrgExecTargetSectionProps) {
  const { t } = useTranslation();
  const [announcement, setAnnouncement] = React.useState("");
  const usedBackendIds = new Set(
    props.targets.map((tg) => tg.backend_sync_id).filter(Boolean),
  );
  const pickable = props.backends.filter((b) => !usedBackendIds.has(b.sync_id));
  const total = props.targets.length;
  const orderable = props.targets.map(toOrderable);

  // 拖拽、拖拽柄上的 ↑/↓ 全部收敛到这里：一次移动只有一个提交口，播报也只有一处。
  const commit = async (move: TierMove) => {
    setAnnouncement(
      t("org.detail.execTargets.moved", {
        position: move.landed + 1,
        total,
      }),
    );
    await saveExecTargetOrder({
      agentSyncId: props.agentSyncId,
      backendSyncIds: move.ids,
    });
    props.onReordered();
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const move = stepTier(orderable, index, direction);
    if (!move) return;
    await commit(move);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const indexOf = (raw: UniqueIdentifier) =>
      props.targets.findIndex((tg) => tg.sync_id === String(raw));
    const from = indexOf(event.active.id);
    const to = indexOf(event.over.id);
    if (from < 0 || to < 0) return;
    const move = dragTier(orderable, from, to);
    if (!move) return;
    void commit(move);
  };

  const movableAt = (index: number) =>
    total > 1 && isMovableTier(orderable[index]);

  const rowPropsFor = (
    target: OrgExecTargetItem,
    index: number,
  ): OrgExecTargetRowProps => ({
    index,
    total,
    backend: toBackendModel(target),
    status: statusOf(target),
    isFirstAvailable: target.current,
    // 行右侧不再画上下箭头，但这两个回调仍要给：共享件的键盘兜底（柄聚焦后按
    // ↑/↓）就落在它们身上，撤掉按钮不能顺手把唯一的键盘重排入口也撤掉。
    onMoveUp: movableAt(index) ? () => void handleMove(index, -1) : undefined,
    onMoveDown: movableAt(index) ? () => void handleMove(index, 1) : undefined,
    onRemove: () => props.onRemove(target.sync_id),
    skillsSupported: supportsSkills(target.backend_type),
    skillsBlock: (
      <SkillsEditor
        target={target}
        onChange={(next) =>
          props.onChangeSkills(
            target.sync_id,
            serializeSkillAuthorizations(next),
          )
        }
      />
    ),
  });

  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-slot="org-detail-col-execution"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("org.detail.execTargets.title")}
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-2xs"
              disabled={pickable.length === 0}
            >
              <Plus className="size-3" aria-hidden="true" />
              {t("org.detail.execTargets.addTarget")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-64 overflow-auto">
            {pickable.length === 0 ? (
              <div className="px-2.5 py-2 text-2xs text-muted-foreground">
                {t("org.detail.execTargets.noBackendsLeft")}
              </div>
            ) : (
              pickable.map((backend) => (
                <DropdownMenuItem
                  key={backend.sync_id}
                  onSelect={() => props.onCreate(backend.sync_id)}
                >
                  {backend.name || backend.sync_id}
                  {backend.device_name ? ` · ${backend.device_name}` : ""}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {total === 0 ? (
        <p className="text-2xs text-muted-foreground">
          {t("org.detail.execTargets.empty")}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border">
          {total === 1 ? (
            // 单档没有次序可言：不进 DndContext，也就不画拖拽柄。
            <OrgExecTargetRow
              key={props.targets[0].sync_id}
              {...rowPropsFor(props.targets[0], 0)}
            />
          ) : (
            <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
              <SortableContext
                items={props.targets.map((tg) => tg.sync_id)}
                strategy={verticalListSortingStrategy}
              >
                {props.targets.map((target, index) => (
                  <SortableExecTargetRow
                    key={target.sync_id}
                    id={target.sync_id}
                    movable={movableAt(index)}
                    row={rowPropsFor(target, index)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      )}

      {/* 本栏自己的播报：拖拽柄的 ↑/↓ 与拖拽落下都经它说出「挪到第几位」。
          DndContext 另有一个它自己的活动区用于拖拽过程，靠 testid 区分。 */}
      <p role="status" data-testid="exec-target-announcer" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

/**
 * 一行的可排序绑定。拖拽柄是**唯一**的激活器（`setActivatorNodeRef`）：整行都变成
 * 热区会把行里的移除按钮、技能折叠一起吞掉。
 *
 * 不可移动的档 `disabled`，于是它既拖不动、也不作为落点 —— 这与
 * `isMovableTier` 是同一条判据，只是换到手势这一侧表达。
 */
function SortableExecTargetRow(props: {
  id: string;
  movable: boolean;
  row: OrgExecTargetRowProps;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id, disabled: !props.movable });
  return (
    <OrgExecTargetRow
      {...props.row}
      drag={{
        setNodeRef,
        handle: {
          ref: setActivatorNodeRef,
          attributes,
          listeners: listeners ?? {},
        },
        style: {
          transform: transform
            ? `translate3d(0, ${transform.y}px, 0)`
            : undefined,
          transition,
          opacity: isDragging ? 0.5 : undefined,
        },
        isDragging,
      }}
    />
  );
}

/**
 * 折在一档行内的技能块：从**那台机器上实际装了什么**里挑，三态「继承全局 /
 * 强制开 / 强制关」（形状与桌面端 `exec-target-skills-block.tsx` +
 * `capability-picker.tsx` 一致，只是取数从 Wails 换成中继）。
 *
 * 展开即拨号：`skillsBlock` 只在共享件把这一折展开时才挂载，所以「挂载就取数」
 * 就是「展开一档才去问那台机器」。
 *
 * 什么时候**不**拨号，两处都是「不做一次必然失败的往返」：
 *   · 后端不支持技能 —— 白名单在外层就把展开入口收掉了，这个组件根本不会挂载；
 *   · 这一档此刻不可用（离线 / 未配对 / 本机相对引用，或者干脆没有指纹）——
 *     直接给说明，已授权的照常列得出、移得掉（规格「详情」的降级）。
 */
function SkillsEditor({
  target,
  onChange,
}: {
  target: OrgExecTargetItem;
  onChange: (next: SkillAuthorization[]) => void;
}) {
  const { t } = useTranslation();
  const authorized = parseSkillAuthorizations(target.skills_json);
  const fingerprint = target.device_fingerprint ?? "";
  const dialable = target.availability === "available" && fingerprint !== "";
  const catalog = useSkillCatalog(
    dialable,
    fingerprint,
    target.backend_type,
    authorized,
  );

  const setState = (id: string, next: SkillTriState) =>
    onChange(setSkillTriState(authorized, id, next));

  // 目录里没有的授权（包被卸了、改了名）仍要摆出来：只在目录里画三态的话，它们
  // 就从界面上消失了 —— 看不见也就撤不掉，而它们照样在这一档上生效。
  const listed = new Set(
    catalog.status === "ok" ? catalog.packs.map((p) => p.id) : [],
  );
  const orphans = authorized.filter((s) => !listed.has(s.id));

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {orphans.length === 0 ? (
        catalog.status === "ok" ? null : (
          <p className="text-2xs text-muted-foreground">
            {t("org.detail.execTargets.skills.empty")}
          </p>
        )
      ) : (
        <ul className="flex flex-wrap gap-1">
          {orphans.map((skill) => (
            <li
              key={skill.id}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-2xs",
                skill.enabled
                  ? "bg-secondary"
                  : "bg-destructive-soft text-destructive line-through",
              )}
            >
              <span>{skill.id}</span>
              <button
                type="button"
                aria-label={t("org.detail.execTargets.skills.remove", {
                  id: skill.id,
                })}
                onClick={() => setState(skill.id, "inherit")}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <SkillCatalogBody
        catalog={catalog}
        authorized={authorized}
        onSetState={setState}
      />
    </div>
  );
}

/** 目录问出来的那一态。三态各自成一态，一条都不合并（见 `lib/skillCatalog`）。 */
type SkillCatalogOutcome = "ok" | "unavailable" | "unsupported" | "unreachable";

interface SkillCatalogHandle {
  /**
   * `not-dialable` = 这一档不可用，压根没拨号（离线 / 未配对 / 本机相对引用）；
   * `loading` = 这一轮的答复还没回来。其余四态就是 `SkillCatalogOutcome`。
   */
  status: "not-dialable" | "loading" | SkillCatalogOutcome;
  packs: SkillPackSummary[];
  retry: () => void;
}

/**
 * 拨一次号问目录。
 *
 * 授权集是**请求参数**（agentred 上没有组织架构库，谁掌握那一档的授权谁报进去），
 * 但它一变就重问一次是没有意义的往返 —— 目录行上的 `enabled` 这一侧本地就算得出
 * 来（`skillTriState`），这一块从头到尾没读过它。所以报进去的是**拨号那一刻**的
 * 授权集：用一个在 effect 里同步的 ref 表达，而不是把它塞进依赖表。
 *
 * 「这一轮答复到了没有」不另立一个 loading 标志，而是拿答复自带的 `key` 与当前
 * 这一轮比：换了机器、或者按了「再问一次」，key 当场对不上，界面自动回到 loading，
 * 上一台机器的答复也不会冒充这一台的。
 */
function useSkillCatalog(
  dialable: boolean,
  fingerprint: string,
  backendType: string | undefined,
  authorized: SkillAuthorization[],
): SkillCatalogHandle {
  const [attempt, setAttempt] = React.useState(0);
  const [answer, setAnswer] = React.useState<{
    key: string;
    outcome: SkillCatalogOutcome;
    packs: SkillPackSummary[];
  } | null>(null);
  const type = backendType ?? "";
  const key = `${attempt} ${fingerprint} ${type}`;

  // 先声明：effect 按声明序跑，因此拨号那个 effect 读到的一定是这一轮渲染的授权集。
  const authorizedRef = React.useRef(authorized);
  React.useEffect(() => {
    authorizedRef.current = authorized;
  });

  React.useEffect(() => {
    if (!dialable) return;
    let cancelled = false;
    void fetchSkillCatalog({
      fingerprint,
      backendType: type,
      authorized: authorizedRef.current,
    })
      .then((res) => {
        if (cancelled) return;
        // unavailable / unsupported 都带回空 packs —— 各自照原样表达，绝不
        // 折叠成「这台机器上没有技能包」。
        setAnswer({ key, outcome: res.discovery, packs: res.packs });
      })
      .catch(() => {
        if (cancelled) return;
        setAnswer({ key, outcome: "unreachable", packs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [dialable, fingerprint, type, key]);

  const settled = answer?.key === key ? answer : null;
  return {
    status: !dialable ? "not-dialable" : (settled?.outcome ?? "loading"),
    packs: settled?.outcome === "ok" ? settled.packs : [],
    retry: () => setAttempt((n) => n + 1),
  };
}

/** 三个分组的次序：先能立刻用上的，再是要先装的。 */
const SKILL_GROUPS = ["inherited", "enableable", "installable"] as const;

type SkillGroup = (typeof SKILL_GROUPS)[number];

function groupOf(pack: SkillPackSummary): SkillGroup {
  if (!pack.installed) return "installable";
  return pack.globallyEnabled ? "inherited" : "enableable";
}

/** 目录本体：一态一说法，`ok` 才画得出可挑的列表。 */
function SkillCatalogBody({
  catalog,
  authorized,
  onSetState,
}: {
  catalog: SkillCatalogHandle;
  authorized: SkillAuthorization[];
  onSetState: (id: string, next: SkillTriState) => void;
}) {
  const { t } = useTranslation();

  if (catalog.status === "not-dialable") {
    return (
      <p className="text-2xs text-muted-foreground">
        {t("org.detail.execTargets.skills.offlineNote")}
      </p>
    );
  }
  if (catalog.status === "loading") {
    return (
      <p className="text-2xs text-muted-foreground">
        {t("org.detail.execTargets.skills.loading")}
      </p>
    );
  }
  if (catalog.status !== "ok") {
    // unsupported 是稳定答案（再问一次结果一样），因此不给「再问一次」；
    // unavailable / unreachable 都可能下一秒就好了，给。
    return (
      <div className="flex flex-col items-start gap-1">
        <p className="text-2xs text-muted-foreground">
          {t(`org.detail.execTargets.skills.${catalog.status}`)}
        </p>
        {catalog.status !== "unsupported" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-2xs"
            onClick={catalog.retry}
          >
            {t("org.detail.execTargets.skills.retry")}
          </Button>
        )}
      </div>
    );
  }
  if (catalog.packs.length === 0) {
    // 这一条才是「一个都没装」——它只能从 discovery=ok 得出来。
    return (
      <p className="text-2xs text-muted-foreground">
        {t("org.detail.execTargets.skills.catalogEmpty")}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {SKILL_GROUPS.map((group) => {
        const packs = catalog.packs.filter((p) => groupOf(p) === group);
        if (packs.length === 0) return null;
        return (
          <div key={group} className="flex min-w-0 flex-col gap-1">
            <p className="font-mono text-2xs uppercase tracking-wide text-muted-foreground">
              {t(`org.detail.execTargets.skills.group.${group}`)}
            </p>
            {packs.map((pack) => (
              <SkillPackRow
                key={pack.id}
                pack={pack}
                state={skillTriState(authorized, pack.id)}
                onSetState={(next) => onSetState(pack.id, next)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

const TRI_STATES: SkillTriState[] = ["inherit", "on", "off"];

const TRI_STATE_LABEL_KEY: Record<SkillTriState, string> = {
  inherit: "org.detail.execTargets.skills.setInherit",
  on: "org.detail.execTargets.skills.setOn",
  off: "org.detail.execTargets.skills.setOff",
};

/** 目录里的一行：名字、条数、一句说明，右侧三态。没装的行只能看不能挑。 */
function SkillPackRow({
  pack,
  state,
  onSetState,
}: {
  pack: SkillPackSummary;
  state: SkillTriState;
  onSetState: (next: SkillTriState) => void;
}) {
  const { t } = useTranslation();
  const locked = pack.installed === false;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-2xs font-semibold">{pack.name}</span>
          {pack.skills && pack.skills.length > 0 && (
            <span className="shrink-0 rounded bg-secondary px-1 font-mono text-2xs text-muted-foreground">
              {pack.skills.length}
            </span>
          )}
        </span>
        <span
          className="truncate font-mono text-2xs text-muted-foreground"
          title={pack.id}
        >
          {locked
            ? t("org.detail.execTargets.skills.needInstall")
            : (pack.description ?? pack.id)}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label={t("org.detail.execTargets.skills.stateFor", {
          name: pack.name,
        })}
        className="flex shrink-0 overflow-hidden rounded-md border border-border"
      >
        {TRI_STATES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={state === option}
            aria-label={t(TRI_STATE_LABEL_KEY[option], { name: pack.name })}
            disabled={locked}
            onClick={() => onSetState(option)}
            className={cn(
              "px-1.5 py-0.5 font-mono text-2xs",
              state === option
                ? "bg-primary-soft text-primary-text"
                : "text-muted-foreground",
              locked ? "cursor-not-allowed opacity-50" : "hover:bg-accent",
            )}
          >
            {t(`org.detail.execTargets.skills.state.${option}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
