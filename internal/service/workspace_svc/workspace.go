// Package workspace_svc 编排 web 控制台两屏（总览页的账号级 Agent 清单、设备页
// 展开）需要的只读视图。
//
// R19 是这里唯一的红线：项目在各设备上的绝对路径、agent_backends 的 CLIPath 与
// EnvJSON 不出现在发往浏览器的任何响应里。落实方式不是「渲染时挑着不显示」，
// 而是这个包里解析 sync_objects.payload 用的几个结构体本来就没有能装下它们的
// 字段——json.Unmarshal 对无 tag 对应的键直接丢弃，这几类敏感字段因此在
// service 边界之前就已经出局，不依赖调用方守规矩。
package workspace_svc

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/exec_order_entity"
	"agentre-server/internal/model/entity/sync_entity"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/exec_order_repo"
	"agentre-server/internal/repository/sync_repo"
)

// 执行目标的可用性分类，供两屏共用同一套文案键。
const (
	// AvailabilityAvailable 这一档所在的机器已配对且在线，是可以被派活的一档。
	AvailabilityAvailable = "available"
	// AvailabilityOffline 机器已配对但当前不在线。
	AvailabilityOffline = "offline"
	// AvailabilityUnpaired 这一档指向的指纹在账号下找不到对应的设备
	// （引用了一个尚未配对/已被撤销的 agentred，或它引用的 backend 行已消失）。
	AvailabilityUnpaired = "unpaired"
	// AvailabilitySkippedForWeb 是 device_id 为空的「本机」相对引用：R15d 规定
	// 从 web 派发时跳过「当前桌面端」这一档，因为浏览器语境下它没有指代对象。
	AvailabilitySkippedForWeb = "skipped_for_web"
	// AvailabilityProjectPathMissing 这一档的机器已配对且在线，但没配所选项目
	// 的路径——那台机器跑不起这个项目（块 1 R15 的 BlockReasonExecTargetProjectPathMissing
	// 在浏览器语境下的对应物）。
	AvailabilityProjectPathMissing = "project_path_missing"
)

// ExecTargetView 是总览页 Agent 卡片里一条执行目标链上的一档。
type ExecTargetView struct {
	Rank int
	// BackendSyncID 是这一档跨机稳定且逐档唯一的标识，浏览器靠它表达排列：
	// Rank 是位置性的（重排后就变了），DeviceID 也不唯一（一台机器可挂多个 backend）。
	BackendSyncID    string
	IsLocalReference bool
	DeviceID         int64
	DeviceName       string
	BackendType      string
	Availability     string
	// Current 标记「按顺序取第一个可用的」会落到哪一档（R15d：本机相对引用不参与
	// 这个挑选）。至多一档为 true。
	Current bool
}

// AgentView 是总览页「Agent」卡片的一行。
type AgentView struct {
	SyncID             string
	Name               string
	AvatarColor        string
	DepartmentName     string
	ExecTargets        []ExecTargetView
	HasAvailableTarget bool
}

// RunnableAgentView 是 agentred 展开的「能跑的 Agent」一项：这台机器在该 Agent
// 的执行目标链里排第几档。
type RunnableAgentView struct {
	SyncID string
	Name   string
	Rank   int
}

// ProjectView 是设备展开的「项目」一项：只回答「已配置」这个事实，不带路径。
type ProjectView struct {
	SyncID     string
	Name       string
	Configured bool
}

// DeviceDetailView 是设备页展开一行时取到的详情。RunnableAgents 只在
// Kind==agentred 时有值——Agent 不按桌面端归属（决策 13）。
type DeviceDetailView struct {
	DeviceID       int64
	Kind           string
	RunnableAgents []RunnableAgentView
	Projects       []ProjectView
}

// WebDispatchTier 是 R15 派发计划里执行目标链上的一档：从 web 给「某 Agent +
// 某项目」派活时，这一档为什么能用 / 不能用。Availability 取值见常量。
// Kind 是这一档指向的设备种类（device_entity.KindDesktop / KindAgentred）——R17
// 发起前要按它如实说明 org/subagent/hook 在目标上是否可用。
type WebDispatchTier struct {
	Rank int
	// BackendSyncID 是这一档跨机稳定且逐档唯一的标识，浏览器靠它表达排列
	// （见 ExecTargetView.BackendSyncID）。
	BackendSyncID string
	DeviceID      int64
	DeviceName    string
	BackendType   string
	Kind          string
	Availability  string
	// Current 标记按顺序取第一个可用的会落到这一档。至多一档为 true。
	Current bool
}

// WebDispatchChoice 是 R15 派发最终落到的那一档（第一档可用的 agentred）。
// Cwd 是所选项目在那台机器上的绝对路径：屏幕 25 要呈现「将运行在 <机器> · <路径>」，
// 派发 runtime.run 也要拿它当 RunParams.cwd。
//
// R19（块 1 红线）说路径不出现在发往浏览器的任何响应里，那是针对总览 / 设备两屏
// 的**被动读视图**；这里是一次**用户主动发起的派活**，路径是该动作本身的执行参数，
// 没有它浏览器无法在远端把这条项目会话跑起来——按设计稿屏 25 的呈现，这条是 R19
// 的唯一例外，且只在 project_sync_id 非空（确认派发阶段）时才带出。
type WebDispatchChoice struct {
	DeviceFingerprint string
	DeviceID          int64
	DeviceName        string
	BackendType       string
	// Kind 是选中目标设备种类（device_entity.KindDesktop / KindAgentred），R17
	// 发起前据此说明三个内置工具是否可用。
	Kind string
	Cwd  string
}

// WebDispatchPlan 是「从 web 给某 Agent + 某项目派活」的完整计划：有序逐档说明 +
// 落到哪一档。Chosen 为 nil 表示全部档都不可用——调用方据此逐档渲染原因，不静默失败。
type WebDispatchPlan struct {
	AgentSyncID string
	Tiers       []WebDispatchTier
	Chosen      *WebDispatchChoice
	// Projects 是选中的那一档机器上已配置的项目（picker 阶段挑项目用）。
	Projects []ProjectView
}

type WorkspaceSvc interface {
	// ListAccountAgents 是总览页「我有哪些 Agent」的唯一数据源：账号下每个 Agent
	// 一行，逐档给出有序执行目标链与当前生效的那一档。deviceFingerprint 是调用方
	// 自己的设备指纹（可空），带上时链按**这台设备自己的排列**渲染。
	ListAccountAgents(ctx context.Context, userID int64, deviceFingerprint string) ([]AgentView, error)
	// WebDispatchPlan 是 R15 的派发计划：给定 Agent 与项目（可空），按序解析执行
	// 目标链，跳过 device_id 为空的档（R15d），返回每档原因与选中的第一档可用
	// agentred。全部不可用时 Chosen 为空，逐档原因由调用方渲染。
	// deviceFingerprint 是调用方自己的设备指纹（可空），带上时先按它的排列重排
	// 执行目标链，再走既有的「取第一个可用」挑选。
	WebDispatchPlan(ctx context.Context, userID int64, agentSyncID, projectSyncID, deviceFingerprint string) (*WebDispatchPlan, error)
	// SetExecTargetOrder 保存调用方设备对某个 Agent 的执行目标排列。指纹解析不到
	// 账号下的活跃设备时**拒绝**，不猜一个 device_id 去写（决策 9）。
	SetExecTargetOrder(ctx context.Context, in SetExecTargetOrderInput) error
	// PurgeDeviceExecTargetOrders 删掉某台设备名下全部排列：设备被解除授权 / 删除时，
	// 它排的顺序一并消失，不残留在账号里。
	PurgeDeviceExecTargetOrders(ctx context.Context, deviceID int64) error
	// DeviceDetail 是设备行展开时取的详情，deviceID 必须属于 userID 且未被撤销，
	// 否则返回 NotFound——不区分「不存在」与「不属于你」，避免枚举探测。
	DeviceDetail(ctx context.Context, userID, deviceID int64) (*DeviceDetailView, error)
}

// SetExecTargetOrderInput 是一次「这台设备把某个 Agent 的执行目标排成这个次序」。
// UserID 来自调用方鉴权上下文，不由调用方填；DeviceFingerprint 只能由参数传入
// （这组端点鉴权的是用户不是设备），因此它必须先被解析成 devices 行才作数。
type SetExecTargetOrderInput struct {
	UserID            int64
	DeviceFingerprint string
	AgentSyncID       string
	// BackendSyncIDs 是排列本身。不校验它与当前执行目标集合是否一致：排列是收敛的
	// 偏好，解析时以集合为准（指向已删 backend 的项忽略、未覆盖的档补到尾部）。
	BackendSyncIDs []string
}

// DaemonOnlineChecker 是这个包需要的窄接口（ISP）：只问「这个指纹的 daemon 现在
// 在线吗」，不需要 relay_svc.RelaySvc 那一整套连接/转发方法。bootstrap 用
// relay_svc.Default() 结构性满足它。
type DaemonOnlineChecker interface {
	IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error)
}

// noopOnlineChecker 是 SetOnlineChecker 之前的安全占位：未装配时（例如未跑完整
// bootstrap 的调用方）一律按离线处理，而不是对 nil 接口 panic——与
// device_svc.noopLocalPathPurger 同一模式。
type noopOnlineChecker struct{}

func (noopOnlineChecker) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	return false, nil
}

var onlineChecker DaemonOnlineChecker = noopOnlineChecker{}

// SetOnlineChecker 由 bootstrap 注入真实的 relay_svc；传 nil 时恢复成安全占位。
func SetOnlineChecker(c DaemonOnlineChecker) {
	if c == nil {
		onlineChecker = noopOnlineChecker{}
		return
	}
	onlineChecker = c
}

type workspaceSvc struct{}

// New 构造一个无状态的 WorkspaceSvc；每次调用都直接读 sync_repo / device_repo
// 的当前状态，不持有任何缓存。
func New() WorkspaceSvc { return &workspaceSvc{} }

var defaultSvc WorkspaceSvc = New()

func Default() WorkspaceSvc     { return defaultSvc }
func SetDefault(s WorkspaceSvc) { defaultSvc = s }

// ---------- 载荷解析：只列 web 端要展示的安全字段 ----------

type agentPayload struct {
	Name             string `json:"name"`
	AvatarColor      string `json:"avatar_color"`
	DepartmentSyncID string `json:"department_sync_id"`
}

type departmentPayload struct {
	Name string `json:"name"`
}

type agentBackendPayload struct {
	Type string `json:"type"`
}

type agentExecTargetPayload struct {
	AgentSyncID   string `json:"agent_sync_id"`
	BackendSyncID string `json:"backend_sync_id"`
	SortOrder     int    `json:"sort_order"`
}

type projectPayload struct {
	Name string `json:"name"`
}

// projectLocationPayload 只带路径正文（agentre 侧 adapter_project.go 的镜像）：
// 路径在同步组里以 kind=project_location、agentred_fingerprint 等于目标机器指纹
// 的行存放。
type projectLocationPayload struct {
	Path string `json:"path"`
}

// resolvedTarget 是「Agent → 执行目标 → backend」这条链解析到指纹这一层的中间
// 结果，ListAccountAgents 与 DeviceDetail 共用同一份解析，避免各写一遍
// JSON 解析与分组逻辑（DRY）。
type resolvedTarget struct {
	Rank int
	// BackendSyncID 是这一档指向的 backend 同步标识：跨机稳定、逐档唯一，是排列
	// 唯一能用的锚点，一路带到对外的档结构上。
	BackendSyncID string
	BackendType   string
	// Fingerprint 为空表示这一档是 device_id 为空的「本机」相对引用。
	Fingerprint      string
	IsLocalReference bool
}

type agentChain struct {
	SyncID           string
	Name             string
	AvatarColor      string
	DepartmentSyncID string
	Targets          []resolvedTarget
}

// buildAgentChains 从一批 sync_objects 行里挑出 kind=agent/agent_backend/
// agent_exec_target 的行，解析并按 sort_order 分组、排序。调用方按需再解析
// department，或再解析设备信息——这个函数只负责「Agent 有序执行目标链」这一层，
// 不关心 department 是谁、指纹对应哪台设备（SRP）。
func buildAgentChains(rows []*sync_entity.SyncObject) []agentChain {
	var agents []*sync_entity.SyncObject
	backendType := map[string]string{}
	backendFingerprint := map[string]string{}
	type targetEntry struct {
		agentSyncID string
		sortOrder   int
		backendID   string
	}
	var targetEntries []targetEntry

	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindAgent:
			agents = append(agents, row)
		case sync_entity.KindAgentBackend:
			var bp agentBackendPayload
			if err := json.Unmarshal([]byte(row.Payload), &bp); err != nil {
				continue
			}
			backendType[row.SyncID] = bp.Type
			backendFingerprint[row.SyncID] = row.AgentredFingerprint
		case sync_entity.KindAgentExecTarget:
			var tp agentExecTargetPayload
			if err := json.Unmarshal([]byte(row.Payload), &tp); err != nil {
				continue
			}
			targetEntries = append(targetEntries, targetEntry{
				agentSyncID: tp.AgentSyncID, sortOrder: tp.SortOrder, backendID: tp.BackendSyncID,
			})
		}
	}

	targetsByAgent := map[string][]targetEntry{}
	for _, te := range targetEntries {
		targetsByAgent[te.agentSyncID] = append(targetsByAgent[te.agentSyncID], te)
	}
	for agentSyncID := range targetsByAgent {
		list := targetsByAgent[agentSyncID]
		sort.SliceStable(list, func(i, j int) bool { return list[i].sortOrder < list[j].sortOrder })
		targetsByAgent[agentSyncID] = list
	}

	out := make([]agentChain, 0, len(agents))
	for _, a := range agents {
		var ap agentPayload
		if err := json.Unmarshal([]byte(a.Payload), &ap); err != nil {
			continue
		}
		chain := agentChain{
			SyncID: a.SyncID, Name: ap.Name,
			AvatarColor: ap.AvatarColor, DepartmentSyncID: ap.DepartmentSyncID,
		}
		for i, te := range targetsByAgent[a.SyncID] {
			fp, known := backendFingerprint[te.backendID]
			rt := resolvedTarget{
				Rank: i + 1, BackendSyncID: te.backendID, BackendType: backendType[te.backendID],
			}
			if !known {
				// backend 行不存在（已删除/尚未同步到）：既非本机引用也非任何已知
				// 指纹，调用方把它当「未配对」处理。
				rt.Fingerprint = ""
				rt.IsLocalReference = false
				rt.BackendType = ""
			} else if fp == "" {
				rt.IsLocalReference = true
			} else {
				rt.Fingerprint = fp
			}
			chain.Targets = append(chain.Targets, rt)
		}
		out = append(out, chain)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func deviceFingerprintMap(devices []*device_entity.Device) map[string]*device_entity.Device {
	out := make(map[string]*device_entity.Device, len(devices))
	for _, d := range devices {
		out[d.Fingerprint] = d
	}
	return out
}

// ---------- 每端自己的派发顺序 ----------

// callerDevice 解析「发来这次请求的那台设备」。指纹只能由参数传入（这组端点鉴权的
// 是用户不是设备），所以归属校验必须在这里发生：devices 取自 deviceByFP，而那张表
// 由 device_repo.ListByUser(userID) 建出——只含调用方账号名下的活跃设备，别人账号的
// 指纹在这里天然查不到，也就拿不到 device_id 去读它的排列。
//
// 返回 nil 表示「没有可用的排列持有者」：指纹缺失、这个账号下没有这台设备、或它已
// 被解除授权。读路径据此回落账号 sort_order，不报错（决策 9 的读侧）。
func callerDevice(deviceByFP map[string]*device_entity.Device, fingerprint string) *device_entity.Device {
	if fingerprint == "" {
		return nil
	}
	dev := deviceByFP[fingerprint]
	if !dev.IsActive() {
		return nil
	}
	return dev
}

// applyDeviceOrder 按一份排列重排执行目标链。
//
// 排列是**收敛的**，不是权威的：以当前账号执行目标集合为准——排列里指向已不存在
// backend 的项忽略，集合里没被排列覆盖到的档按账号 sort_order 补到尾部。因此增删
// 执行目标之后旧排列不会失效，也不会让某一档凭空消失（与桌面端 ResolveExecTargetOrder
// 同一规则）。
//
// 重排之后 Rank 必须重编号：它是位置性的，沿用账号次序的旧号会让调用方看到的序号
// 与真实派发顺序对不上。这里只换顺序，不换任何一档的语义——本机相对引用被排到第一位
// 也仍然是本机相对引用（R15d 照旧跳过）。
func applyDeviceOrder(targets []resolvedTarget, permutation []string) []resolvedTarget {
	if len(permutation) == 0 || len(targets) == 0 {
		return targets
	}
	indexByBackend := make(map[string]int, len(targets))
	for i, t := range targets {
		if t.BackendSyncID == "" {
			continue
		}
		if _, dup := indexByBackend[t.BackendSyncID]; !dup {
			indexByBackend[t.BackendSyncID] = i
		}
	}

	// 没有 sync_id 的档钉在原位：排列以 sync_id 表达，它无从指代自己，也就不该被
	// 排序动到。浏览器侧同样把它钉住（execOrder.ts 的 reorderTargets 只在可移动的
	// 档之间换位、并把空 sync_id 滤出提交载荷），两端因此对同一次操作给出同一结果。
	// 注意这和「未覆盖补到队尾」不冲突：那条针对的是**能被指代却没被排到**的档。
	pinned := make([]bool, len(targets))
	slots := make([]int, 0, len(targets))
	for i, t := range targets {
		if t.BackendSyncID == "" {
			pinned[i] = true
			continue
		}
		slots = append(slots, i)
	}

	taken := make([]bool, len(targets))
	ordered := make([]resolvedTarget, 0, len(slots))
	for _, backendSyncID := range permutation {
		i, ok := indexByBackend[backendSyncID]
		if !ok || taken[i] || pinned[i] {
			continue
		}
		taken[i] = true
		ordered = append(ordered, targets[i])
	}
	for i, t := range targets {
		if !taken[i] && !pinned[i] {
			ordered = append(ordered, t)
		}
	}

	// 把重排后的档按原有的非钉住位置回填，钉住的档留在自己的下标上。
	out := make([]resolvedTarget, len(targets))
	for i, t := range targets {
		if pinned[i] {
			out[i] = t
		}
	}
	for n, i := range slots {
		out[i] = ordered[n]
	}
	for i := range out {
		out[i].Rank = i + 1
	}
	return out
}

func (s *workspaceSvc) ListAccountAgents(
	ctx context.Context, userID int64, deviceFingerprint string,
) ([]AgentView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{
		sync_entity.KindAgent, sync_entity.KindAgentBackend,
		sync_entity.KindAgentExecTarget, sync_entity.KindDepartment,
	})
	if err != nil {
		return nil, err
	}
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	deviceByFP := deviceFingerprintMap(devices)

	deptName := map[string]string{}
	for _, row := range rows {
		if row.Kind != sync_entity.KindDepartment {
			continue
		}
		var dp departmentPayload
		if err := json.Unmarshal([]byte(row.Payload), &dp); err == nil {
			deptName[row.SyncID] = dp.Name
		}
	}

	onlineCache := map[string]bool{}
	isOnline := func(fingerprint string) bool {
		if v, ok := onlineCache[fingerprint]; ok {
			return v
		}
		v, err := onlineChecker.IsDaemonOnline(ctx, userID, fingerprint)
		if err != nil {
			v = false
		}
		onlineCache[fingerprint] = v
		return v
	}

	// 卡片渲染的是同一条链，也按调用方设备自己的排列：否则卡片上排第一、标着
	// 「当前」的那一档，会和真派发时选中的不是同一档。一次取这台设备对全部 Agent
	// 的排列，一屏多张卡片不按 Agent 逐条查库。
	orderByAgent := map[string][]string{}
	if dev := callerDevice(deviceByFP, deviceFingerprint); dev != nil {
		orders, oerr := exec_order_repo.ExecOrder().ListByDevice(ctx, userID, dev.ID)
		if oerr != nil {
			logger.Ctx(ctx).Warn("workspace_svc.ListAccountAgents: read device exec target orders failed, falling back to account order",
				zap.Int64("userID", userID), zap.Int64("deviceID", dev.ID), zap.Error(oerr))
		}
		for _, o := range orders {
			orderByAgent[o.AgentSyncID] = o.BackendSyncIDs()
		}
	}

	chains := buildAgentChains(rows)
	out := make([]AgentView, 0, len(chains))
	for _, chain := range chains {
		view := AgentView{
			SyncID: chain.SyncID, Name: chain.Name,
			AvatarColor: chain.AvatarColor, DepartmentName: deptName[chain.DepartmentSyncID],
		}
		currentAssigned := false
		for _, t := range applyDeviceOrder(chain.Targets, orderByAgent[chain.SyncID]) {
			et := ExecTargetView{
				Rank: t.Rank, BackendSyncID: t.BackendSyncID,
				BackendType: t.BackendType, IsLocalReference: t.IsLocalReference,
			}
			switch {
			case t.IsLocalReference:
				et.Availability = AvailabilitySkippedForWeb
			case t.Fingerprint == "":
				et.Availability = AvailabilityUnpaired
			default:
				dev, ok := deviceByFP[t.Fingerprint]
				if !ok {
					et.Availability = AvailabilityUnpaired
				} else {
					et.DeviceID = dev.ID
					et.DeviceName = dev.Name
					if dev.IsActive() && isOnline(t.Fingerprint) {
						et.Availability = AvailabilityAvailable
					} else {
						et.Availability = AvailabilityOffline
					}
				}
			}
			if !currentAssigned && et.Availability == AvailabilityAvailable {
				et.Current = true
				currentAssigned = true
			}
			view.ExecTargets = append(view.ExecTargets, et)
		}
		view.HasAvailableTarget = currentAssigned
		out = append(out, view)
	}
	return out, nil
}

func (s *workspaceSvc) WebDispatchPlan(
	ctx context.Context, userID int64, agentSyncID, projectSyncID, deviceFingerprint string,
) (*WebDispatchPlan, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{
		sync_entity.KindAgent, sync_entity.KindAgentBackend, sync_entity.KindAgentExecTarget,
		sync_entity.KindProject, sync_entity.KindProjectLocation,
	})
	if err != nil {
		return nil, err
	}
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	deviceByFP := deviceFingerprintMap(devices)

	// 项目名与「(指纹, 项目) → 路径」两查表，供 picker 与确认派发阶段用。
	projectName := map[string]string{}
	locationsByFP := map[string]map[string]string{}
	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindProject:
			var pp projectPayload
			if json.Unmarshal([]byte(row.Payload), &pp) == nil {
				projectName[row.SyncID] = pp.Name
			}
		case sync_entity.KindProjectLocation:
			if row.IsDeleted() || row.AgentredFingerprint == "" {
				continue
			}
			var lp projectLocationPayload
			if json.Unmarshal([]byte(row.Payload), &lp) != nil {
				continue
			}
			if locationsByFP[row.AgentredFingerprint] == nil {
				locationsByFP[row.AgentredFingerprint] = map[string]string{}
			}
			locationsByFP[row.AgentredFingerprint][row.ProjectSyncID] = lp.Path
		}
	}

	onlineCache := map[string]bool{}
	isOnline := func(fingerprint string) bool {
		if v, ok := onlineCache[fingerprint]; ok {
			return v
		}
		v, err := onlineChecker.IsDaemonOnline(ctx, userID, fingerprint)
		if err != nil {
			v = false
		}
		onlineCache[fingerprint] = v
		return v
	}

	// 每个设备「配了哪些项目的路径」：agentred 的路径在同步组 project_location（跟着
	// 账号在桌面端之间流动，决策 7）；桌面端的本机路径不流动（决策 6），只存在于上报组
	// device_local_paths（按上报设备分命名空间）。两者不能混用，按设备种类各取各的。
	desktopLocations := map[int64]map[string]string{}
	locationsFor := func(dev *device_entity.Device) (map[string]string, error) {
		if dev.Kind != device_entity.KindDesktop {
			return locationsByFP[dev.Fingerprint], nil
		}
		if m, ok := desktopLocations[dev.ID]; ok {
			return m, nil
		}
		rows, err := sync_repo.SyncLocalPath().ListByDevice(ctx, userID, dev.ID)
		if err != nil {
			return nil, err
		}
		m := make(map[string]string, len(rows))
		for _, row := range rows {
			if row != nil && row.ProjectSyncID != "" {
				m[row.ProjectSyncID] = row.Path
			}
		}
		desktopLocations[dev.ID] = m
		return m, nil
	}

	chains := buildAgentChains(rows)
	var chain *agentChain
	for i := range chains {
		if chains[i].SyncID == agentSyncID {
			chain = &chains[i]
			break
		}
	}
	if chain == nil {
		return nil, i18n.NewNotFoundError(ctx, code.NotFound)
	}

	// 先按调用方设备自己的排列重排，再走下面那个「取第一个可用」的循环——挑选逻辑
	// 一行不改，Chosen / Current 与逐档原因自动跟着新顺序走。
	targets := applyDeviceOrder(chain.Targets,
		deviceOrder(ctx, userID, deviceByFP, deviceFingerprint, agentSyncID))

	plan := &WebDispatchPlan{AgentSyncID: agentSyncID}
	currentAssigned := false
	// chosenCwd 是选中档（第一个可用）所选项目在那台机器上的绝对路径；case 块内
	// 变量出不了 switch，先摆在这里由选中档写入。
	var chosenCwd string
	for _, t := range targets {
		tier := WebDispatchTier{Rank: t.Rank, BackendSyncID: t.BackendSyncID, BackendType: t.BackendType}
		switch {
		case t.IsLocalReference:
			// R15d：device_id 为空的「本机」档在浏览器语境下没有指代对象，跳过。
			tier.Availability = AvailabilitySkippedForWeb
		case t.Fingerprint == "":
			tier.Availability = AvailabilityUnpaired
		default:
			dev, ok := deviceByFP[t.Fingerprint]
			if !ok {
				tier.Availability = AvailabilityUnpaired
				break
			}
			tier.DeviceID = dev.ID
			tier.DeviceName = dev.Name
			tier.Kind = dev.Kind
			if !dev.IsActive() || !isOnline(t.Fingerprint) {
				tier.Availability = AvailabilityOffline
				break
			}
			locations, lerr := locationsFor(dev)
			if lerr != nil {
				return nil, lerr
			}
			if projectSyncID != "" {
				if _, configured := locations[projectSyncID]; !configured {
					tier.Availability = AvailabilityProjectPathMissing
					break
				}
			}
			tier.Availability = AvailabilityAvailable
			chosenCwd = locations[projectSyncID]
		}
		if !currentAssigned && tier.Availability == AvailabilityAvailable {
			tier.Current = true
			currentAssigned = true
			plan.Chosen = &WebDispatchChoice{
				DeviceFingerprint: t.Fingerprint,
				DeviceID:          tier.DeviceID,
				DeviceName:        tier.DeviceName,
				BackendType:       tier.BackendType,
				Kind:              tier.Kind,
			}
			// 选中档的 cwd：所选项目在这台机器上的绝对路径（见 WebDispatchChoice.Cwd
			// 注释，这是 R19 在主动派活场景下的唯一例外）。未选项目时留空。
			plan.Chosen.Cwd = chosenCwd
		}
		plan.Tiers = append(plan.Tiers, tier)
	}

	// picker 用：选中的那一档机器上已配置的项目清单（按 sync_id 排序稳定）。
	if plan.Chosen != nil {
		configured, cerr := locationsFor(deviceByFP[plan.Chosen.DeviceFingerprint])
		if cerr != nil {
			return nil, cerr
		}
		ids := make([]string, 0, len(configured))
		for id := range configured {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			if name := projectName[id]; name != "" {
				plan.Projects = append(plan.Projects,
					ProjectView{SyncID: id, Name: name, Configured: true})
			}
		}
	}
	return plan, nil
}

// deviceOrder 取调用方设备对某个 Agent 的排列，取不到就返回空（回落账号 sort_order）。
//
// 读路径**刻意**不因它失败：指纹缺失、设备解析不到、这台设备还没排过序、甚至读库
// 出错，都按「没有排列」处理——派发不该因为一个偏好读不到就失败，也不该静默改派到
// 别处（决策 9 的读侧）。读库出错是「降级但已处理」，落一条 Warn 让它可查。
func deviceOrder(
	ctx context.Context, userID int64,
	deviceByFP map[string]*device_entity.Device, deviceFingerprint, agentSyncID string,
) []string {
	dev := callerDevice(deviceByFP, deviceFingerprint)
	if dev == nil {
		return nil
	}
	order, err := exec_order_repo.ExecOrder().Find(ctx, userID, dev.ID, agentSyncID)
	if err != nil {
		logger.Ctx(ctx).Warn("workspace_svc.deviceOrder: read device exec target order failed, falling back to account order",
			zap.Int64("userID", userID), zap.Int64("deviceID", dev.ID),
			zap.String("agentSyncID", agentSyncID), zap.Error(err))
		return nil
	}
	return order.BackendSyncIDs()
}

// SetExecTargetOrder 保存「这台设备把某个 Agent 的执行目标排成这个次序」。
//
// 与读路径相反：这里解析不到设备就**拒绝**，绝不猜一个 device_id 去写（决策 9）。
// 指纹是参数传进来的（这组端点鉴权的是用户不是设备），账号归属只能靠这次
// (user_id, fingerprint) 解析来保证；device_id 又是主键的一部分，拿不到它就写不进去，
// 校验因此不可绕过。已被解除授权的设备同样写不进去——它的排列马上就要被清掉。
func (s *workspaceSvc) SetExecTargetOrder(ctx context.Context, in SetExecTargetOrderInput) error {
	dev, err := device_repo.Device().FindByFingerprint(ctx, in.UserID, in.DeviceFingerprint)
	if err != nil {
		return err
	}
	if !dev.IsActive() {
		// 常见成因是浏览器攥着一枚已失效的指纹（换了账号、设备被解除授权）：顺序
		// 因此存不下，界面会当场说明——落一条 Warn，让「用户说排序不生效」有据可查。
		logger.Ctx(ctx).Warn("workspace_svc.SetExecTargetOrder: device fingerprint resolves to no active device, refusing to store order",
			zap.Int64("userID", in.UserID), zap.String("agentSyncID", in.AgentSyncID))
		return i18n.NewNotFoundError(ctx, code.DeviceNotFound)
	}

	order := &exec_order_entity.DeviceExecTargetOrder{
		UserID:      in.UserID,
		DeviceID:    dev.ID,
		AgentSyncID: in.AgentSyncID,
		Updatetime:  time.Now().UnixMilli(),
	}
	if err := order.SetBackendSyncIDs(in.BackendSyncIDs); err != nil {
		return err
	}
	return exec_order_repo.ExecOrder().Save(ctx, order)
}

// PurgeDeviceExecTargetOrders 删掉某台设备名下全部排列：用户解除一个浏览器的授权
// （或删掉一台设备的记录）时，它排的顺序一并消失，不残留在账号里。
//
// 只按 device_id 删，不带 user_id：device_id 是全局自增主键、天然只属于一个账号，
// 一个账号的清理碰不到另一个账号的行（与 sync_svc.PurgeDeviceLocalPaths 同一约定）。
// 账号级的执行目标**集合**不受影响——它在同步组里，不属于任何一台设备。
func (s *workspaceSvc) PurgeDeviceExecTargetOrders(ctx context.Context, deviceID int64) error {
	return exec_order_repo.ExecOrder().DeleteByDevice(ctx, deviceID)
}

// configuredProjects 回答「这台机器上哪些项目配了路径」。两类设备的路径存在不同的
// 地方，因为它们的流动性不同：
//
//   - agentred 的路径在**同步组**里（决策 7：它跟着账号在桌面端之间流动），是
//     kind=project_location、agentred_fingerprint 等于这台机器指纹的那些行。
//   - 桌面端的本机路径**不流动**（决策 6），只存在于上报组 device_local_paths，
//     按上报设备分命名空间。
//
// 两者不能混用：上报组只有桌面端会写（sync_svc.ReportLocalPaths 以上报设备为键），
// agentred 从不上报，照它取到的清单不是「少几行」而是恒为空——决策 13 要求的
// agentred 展开会永远空着。
//
// 返回值只有「这个项目同步标识配过路径」这个布尔，路径正文一步都不往外带（R19）。
func configuredProjects(
	ctx context.Context, userID int64, dev *device_entity.Device, rows []*sync_entity.SyncObject,
) (map[string]bool, error) {
	configured := map[string]bool{}
	if dev.Kind == device_entity.KindAgentred {
		for _, row := range rows {
			if row.Kind == sync_entity.KindProjectLocation && row.AgentredFingerprint == dev.Fingerprint {
				configured[row.ProjectSyncID] = true
			}
		}
		return configured, nil
	}
	localPaths, err := sync_repo.SyncLocalPath().ListByDevice(ctx, userID, dev.ID)
	if err != nil {
		return nil, err
	}
	for _, lp := range localPaths {
		configured[lp.ProjectSyncID] = true
	}
	return configured, nil
}

func (s *workspaceSvc) DeviceDetail(ctx context.Context, userID, deviceID int64) (*DeviceDetailView, error) {
	dev, err := device_repo.Device().Find(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if dev == nil || dev.UserID != userID || !dev.IsActive() {
		return nil, i18n.NewNotFoundError(ctx, code.DeviceNotFound)
	}

	isAgentred := dev.Kind == device_entity.KindAgentred
	kinds := []string{sync_entity.KindProject}
	if isAgentred {
		kinds = append(kinds, sync_entity.KindProjectLocation,
			sync_entity.KindAgent, sync_entity.KindAgentBackend, sync_entity.KindAgentExecTarget)
	}
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, kinds)
	if err != nil {
		return nil, err
	}

	configured, err := configuredProjects(ctx, userID, dev, rows)
	if err != nil {
		return nil, err
	}

	view := &DeviceDetailView{DeviceID: dev.ID, Kind: dev.Kind}
	for _, row := range rows {
		if row.Kind != sync_entity.KindProject {
			continue
		}
		var pp projectPayload
		if err := json.Unmarshal([]byte(row.Payload), &pp); err != nil {
			continue
		}
		isConfigured := configured[row.SyncID]
		// agentred 展开只列「配了路径的项目」（决策 13 的呈现约定）；桌面端展开
		// 两种状态都要出现，用户才看得出「未配置」是一个需要处理的显式状态（R10）。
		if isAgentred && !isConfigured {
			continue
		}
		view.Projects = append(view.Projects, ProjectView{SyncID: row.SyncID, Name: pp.Name, Configured: isConfigured})
	}

	if isAgentred {
		for _, chain := range buildAgentChains(rows) {
			for _, t := range chain.Targets {
				if t.IsLocalReference || t.Fingerprint != dev.Fingerprint {
					continue
				}
				view.RunnableAgents = append(view.RunnableAgents,
					RunnableAgentView{SyncID: chain.SyncID, Name: chain.Name, Rank: t.Rank})
				break
			}
		}
	}
	return view, nil
}
