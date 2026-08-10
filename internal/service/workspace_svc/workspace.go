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

	"github.com/cago-frame/cago/pkg/i18n"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/sync_entity"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/repository/device_repo"
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
)

// ExecTargetView 是总览页 Agent 卡片里一条执行目标链上的一档。
type ExecTargetView struct {
	Rank             int
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

type WorkspaceSvc interface {
	// ListAccountAgents 是总览页「我有哪些 Agent」的唯一数据源：账号下每个 Agent
	// 一行，逐档给出有序执行目标链与当前生效的那一档。
	ListAccountAgents(ctx context.Context, userID int64) ([]AgentView, error)
	// DeviceDetail 是设备行展开时取的详情，deviceID 必须属于 userID 且未被撤销，
	// 否则返回 NotFound——不区分「不存在」与「不属于你」，避免枚举探测。
	DeviceDetail(ctx context.Context, userID, deviceID int64) (*DeviceDetailView, error)
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

// resolvedTarget 是「Agent → 执行目标 → backend」这条链解析到指纹这一层的中间
// 结果，ListAccountAgents 与 DeviceDetail 共用同一份解析，避免各写一遍
// JSON 解析与分组逻辑（DRY）。
type resolvedTarget struct {
	Rank        int
	BackendType string
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
			rt := resolvedTarget{Rank: i + 1, BackendType: backendType[te.backendID]}
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

func (s *workspaceSvc) ListAccountAgents(ctx context.Context, userID int64) ([]AgentView, error) {
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

	chains := buildAgentChains(rows)
	out := make([]AgentView, 0, len(chains))
	for _, chain := range chains {
		view := AgentView{
			SyncID: chain.SyncID, Name: chain.Name,
			AvatarColor: chain.AvatarColor, DepartmentName: deptName[chain.DepartmentSyncID],
		}
		currentAssigned := false
		for _, t := range chain.Targets {
			et := ExecTargetView{Rank: t.Rank, BackendType: t.BackendType, IsLocalReference: t.IsLocalReference}
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
