package workspace_svc

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/cago-frame/cago/pkg/i18n"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
)

// indexProjectRows 从一批 sync_objects 行里建出项目名与「(指纹, 项目) → 路径」两查
// 表，供 picker 与确认派发阶段用。
func indexProjectRows(
	rows []*sync_entity.SyncObject,
) (projectName map[string]string, locationsByFP map[string]map[string]string) {
	projectName = map[string]string{}
	locationsByFP = map[string]map[string]string{}
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
	return projectName, locationsByFP
}

// dispatchResolver 按「设备 + 项目」判一档能不能派活，并把一次派发计划里会被重复
// 问到的两件事缓存住：设备在线态，以及桌面端配了哪些项目的路径。同一次计划里同一
// 台机器会在多档上出现，不缓存就是同一个问题问好几遍。
type dispatchResolver struct {
	ctx        context.Context
	userID     int64
	deviceByFP map[string]*device_entity.Device
	// locationsByFP 是 agentred 那一侧的「指纹 → 项目 sync_id → 路径」查表，
	// 建索引时已经一次算完，这里只读。
	locationsByFP map[string]map[string]string

	online           map[string]bool
	desktopLocations map[int64]map[string]string
}

func newDispatchResolver(
	ctx context.Context, userID int64,
	devices []*device_entity.Device, locationsByFP map[string]map[string]string,
) *dispatchResolver {
	return &dispatchResolver{
		ctx: ctx, userID: userID,
		deviceByFP:       deviceFingerprintMap(devices),
		locationsByFP:    locationsByFP,
		online:           map[string]bool{},
		desktopLocations: map[int64]map[string]string{},
	}
}

func (r *dispatchResolver) isOnline(fingerprint string) bool {
	if v, ok := r.online[fingerprint]; ok {
		return v
	}
	v, err := onlineChecker.IsDaemonOnline(r.ctx, r.userID, fingerprint)
	if err != nil {
		v = false
	}
	r.online[fingerprint] = v
	return v
}

// locationsFor 取每个设备「配了哪些项目的路径」：agentred 的路径在同步组
// project_location（跟着账号在桌面端之间流动，决策 7）；桌面端的本机路径不流动
// （决策 6），只存在于上报组 device_local_paths（按上报设备分命名空间）。两者不能
// 混用，按设备种类各取各的。
func (r *dispatchResolver) locationsFor(dev *device_entity.Device) (map[string]string, error) {
	if dev.Kind != device_entity.KindDesktop {
		return r.locationsByFP[dev.Fingerprint], nil
	}
	if m, ok := r.desktopLocations[dev.ID]; ok {
		return m, nil
	}
	rows, err := sync_repo.SyncLocalPath().ListByDevice(r.ctx, r.userID, dev.ID)
	if err != nil {
		return nil, err
	}
	m := make(map[string]string, len(rows))
	for _, row := range rows {
		if row.ProjectSyncID != "" {
			m[row.ProjectSyncID] = row.Path
		}
	}
	r.desktopLocations[dev.ID] = m
	return m, nil
}

// evaluateTier 判一档：算出它的可用性、机器身份，以及这一档选中时该用的 cwd。
//
// 第二个返回值是**这一档**所选项目在那台机器上的绝对路径，按档算出、不跨档留存：
// 两台机器上同一个项目的路径不同，留着上一轮的值会把 A 机的路径派到 B 机上去。
// 原先靠循环体里每轮把 chosenCwd 重置成空来保证，抽成返回值之后由函数边界保证。
func (r *dispatchResolver) evaluateTier(
	t resolvedTarget, projectSyncID string,
) (WebDispatchTier, string, error) {
	tier := WebDispatchTier{Rank: t.Rank, BackendSyncID: t.BackendSyncID, BackendType: t.BackendType}
	switch {
	case t.IsLocalReference:
		// 后端行没写运行设备：跳过，理由如实写在这一档上。
		tier.Availability = AvailabilityNoDevice
	case t.Fingerprint == "":
		tier.Availability = AvailabilityUnpaired
	default:
		dev, ok := r.deviceByFP[t.Fingerprint]
		if !ok {
			tier.Availability = AvailabilityUnpaired
			break
		}
		tier.DeviceID = dev.ID
		tier.DeviceName = dev.Name
		tier.Kind = dev.Kind
		if !dev.IsActive() || !r.isOnline(t.Fingerprint) {
			tier.Availability = AvailabilityOffline
			break
		}
		locations, lerr := r.locationsFor(dev)
		if lerr != nil {
			return WebDispatchTier{}, "", lerr
		}
		if projectSyncID != "" {
			if _, configured := locations[projectSyncID]; !configured {
				tier.Availability = AvailabilityProjectPathMissing
				break
			}
		}
		tier.Availability = AvailabilityAvailable
		return tier, locations[projectSyncID], nil
	}
	return tier, "", nil
}

// projectPicker 列出选中的那一档机器上已配置的项目清单（按 sync_id 排序稳定）。
func (r *dispatchResolver) projectPicker(
	fingerprint string, projectName map[string]string,
) ([]ProjectView, error) {
	configured, err := r.locationsFor(r.deviceByFP[fingerprint])
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(configured))
	for id := range configured {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var out []ProjectView
	for _, id := range ids {
		if name := projectName[id]; name != "" {
			out = append(out, ProjectView{SyncID: id, Name: name, Configured: true})
		}
	}
	return out, nil
}

// findAgentChain 在解析好的链里找这个 Agent。
func findAgentChain(chains []agentChain, agentSyncID string) *agentChain {
	for i := range chains {
		if chains[i].SyncID == agentSyncID {
			return &chains[i]
		}
	}
	return nil
}

// targetOnChain 判这个后端标识是不是真在这条链上。
//
// 指定了档就先确认它真在这条链上。链被改过、浏览器手里那个标识过期时按找不到
// 拒——不回落到自动挑：回落等于拿一个用户没挑过的目标去跑。
func targetOnChain(targets []resolvedTarget, backendSyncID string) bool {
	for _, t := range targets {
		if t.BackendSyncID == backendSyncID {
			return true
		}
	}
	return false
}

// loadDispatchInputs 取一次派发计划要的两批原始数据：账号的同步行与设备清单。
func loadDispatchInputs(
	ctx context.Context, userID int64,
) ([]*sync_entity.SyncObject, []*device_entity.Device, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{
		sync_entity.KindAgent, sync_entity.KindAgentBackend, sync_entity.KindAgentExecTarget,
		sync_entity.KindProject, sync_entity.KindProjectLocation,
	})
	if err != nil {
		return nil, nil, err
	}
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	return rows, devices, nil
}

// planTiers 逐档评估，摆出全部档并挑出生效的那一档。
func (r *dispatchResolver) planTiers(
	targets []resolvedTarget, in WebDispatchPlanInput,
) ([]WebDispatchTier, *WebDispatchChoice, error) {
	var tiers []WebDispatchTier
	var chosen *WebDispatchChoice
	currentAssigned := false
	for _, t := range targets {
		tier, chosenCwd, err := r.evaluateTier(t, in.ProjectSyncID)
		if err != nil {
			return nil, nil, err
		}
		// 生效档：指定了就只认那一档，没指定才是「按序第一个可用」。
		selected := tier.Availability == AvailabilityAvailable &&
			(in.TargetBackendSyncID == "" && !currentAssigned ||
				in.TargetBackendSyncID != "" && t.BackendSyncID == in.TargetBackendSyncID)
		if selected {
			tier.Current = true
			currentAssigned = true
			chosen = &WebDispatchChoice{
				DeviceFingerprint: t.Fingerprint,
				DeviceID:          tier.DeviceID,
				DeviceName:        tier.DeviceName,
				BackendType:       tier.BackendType,
				Kind:              tier.Kind,
				// 选中档的 cwd：所选项目在这台机器上的绝对路径（见 WebDispatchChoice.Cwd
				// 注释，这是 R19 在主动派活场景下的唯一例外）。未选项目时留空。
				Cwd: chosenCwd,
			}
		}
		tiers = append(tiers, tier)
	}
	return tiers, chosen, nil
}

func (s *workspaceSvc) WebDispatchPlan(
	ctx context.Context, in WebDispatchPlanInput,
) (*WebDispatchPlan, error) {
	rows, devices, err := loadDispatchInputs(ctx, in.UserID)
	if err != nil {
		return nil, err
	}
	projectName, locationsByFP := indexProjectRows(rows)
	resolver := newDispatchResolver(ctx, in.UserID, devices, locationsByFP)

	chain := findAgentChain(buildAgentChains(rows), in.AgentSyncID)
	if chain == nil {
		return nil, i18n.NewNotFoundError(ctx, code.NotFound)
	}
	// 顺序已经是最终顺序（sort_order 就是账号默认，浏览器排的也是它），直接走下面
	// 那个「取第一个可用」的循环。
	targets := chain.Targets
	if in.TargetBackendSyncID != "" && !targetOnChain(targets, in.TargetBackendSyncID) {
		return nil, i18n.NewNotFoundError(ctx, code.NotFound)
	}

	tiers, chosen, err := resolver.planTiers(targets, in)
	if err != nil {
		return nil, err
	}
	plan := &WebDispatchPlan{AgentSyncID: in.AgentSyncID, Tiers: tiers, Chosen: chosen}
	if plan.Chosen != nil {
		projects, perr := resolver.projectPicker(plan.Chosen.DeviceFingerprint, projectName)
		if perr != nil {
			return nil, perr
		}
		plan.Projects = projects
	}
	return plan, nil
}
