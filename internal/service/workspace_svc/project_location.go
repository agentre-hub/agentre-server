package workspace_svc

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/cago-frame/cago/pkg/i18n"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
)

// ── 项目 × 机器的路径（规格 2026-08-20「路径与 R19」）────────────────────────────
//
// **这是 R19 本轮唯一收窄的地方，收窄的边界就是这个文件。**
//
// 收窄成按对象的三条：镜像会话的 cwd 永不下发（服务端为判项目归属自己存的，用户
// 从没要过）；agent_backends 的 cli_path 与 env_json 永不下发（「那台机器上的可执行
// 文件在哪」与「用户塞了什么环境变量」）；只有 project_location.path 在项目设置这
// 一处、按项目逐条下发——理由只有一条：**用户要改的就是它，而改不了一个看不见的值**。
// 「已配置 / 未配置」这个布尔支撑得起设备展开那一屏（它问的是「这台机器准备好了
// 吗」），支撑不起「把这个项目的路径从 A 改成 B」。
//
// 收窄不外溢：设备展开的 ProjectView 仍然只回布尔，会话索引、派发计划、组织面一个
// 路径字段都没多。守卫在 internal/api/workspace/guard_test.go——那里只多了**一处**
// 显式例外，形状与已经在里面的 DispatchChoiceItem.Cwd 完全一样。

// ProjectMachineView 是「机器与路径」那一节的一行：账号里的一台机器，以及这个项目
// 在它上面的落脚点。
type ProjectMachineView struct {
	DeviceID   int64
	DeviceName string
	// Kind 是 desktop / agentred。两者在这一屏上的口径完全不同，见下面各字段。
	Kind string
	// Fingerprint 是机器的身份，不是「机器上的东西」：目录选择器靠它拨中继
	// （`/v1/relay/client?daemon_fingerprint=…` 认的就是它）。同一个值已经随
	// GET /v1/devices 与派发计划下行给同一个浏览器会话。
	Fingerprint string
	Online      bool
	Configured  bool
	// Path 是这个项目在这台机器上的路径正文。两类机器都有（规格 2026-08-21 决策 5），
	// 但来源不同：agentred 取自同步组 project_location，桌面端取自上报组
	// device_local_paths。这是 R19 收窄后唯一带得动路径的字段。
	Path string
	// LocationSyncID 是这一行路径记录自己的同步标识，移除一条 agentred 路径按它定位。
	// **桌面端恒为空**：它在同步组里没有这样一行，移除经中继喊那台机器自己去做
	// （决策 6）——删不掉的东西不该长成能删的样子。
	LocationSyncID string
}

// SetProjectLocationInput 是一次「把这个项目在这台 agentred 上的路径设成这个」。
// UserID 来自鉴权上下文而不是请求体。
type SetProjectLocationInput struct {
	UserID        int64
	ProjectSyncID string
	// Fingerprint 是目标 agentred 的指纹。桌面端的指纹一律拒——不是因为它的路径
	// 不能从 web 配（2026-08-21 起可以），而是因为那份数据不在这条通道能写的地方。
	Fingerprint string
	Path        string
}

// ProjectMachines 见接口注释。
func (s *workspaceSvc) ProjectMachines(
	ctx context.Context, userID int64, projectSyncID string,
) ([]ProjectMachineView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID,
		[]string{sync_entity.KindProject, sync_entity.KindProjectLocation})
	if err != nil {
		return nil, err
	}
	if !hasLiveProject(rows, projectSyncID) {
		// 不存在、别人的、已落墓碑共用一个码：区分开就等于给出一个跨账号的存在性探测器。
		return nil, i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
	}
	// 这个项目在各台 agentred 上的落脚点，按指纹索引。
	locationByFingerprint := map[string]*sync_entity.SyncObject{}
	for _, row := range rows {
		if row.Kind == sync_entity.KindProjectLocation && row.ProjectSyncID == projectSyncID &&
			row.AgentredFingerprint != "" {
			locationByFingerprint[row.AgentredFingerprint] = row
		}
	}

	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	placer := newTargetPlacer(ctx, userID, devices)
	out := make([]ProjectMachineView, 0, len(devices))
	for _, dev := range devices {
		view := ProjectMachineView{
			DeviceID: dev.ID, DeviceName: device_entity.DisplayName(dev.Name, dev.Fingerprint), Kind: dev.Kind,
			Fingerprint: dev.Fingerprint, Online: placer.isOnline(dev.Fingerprint),
		}
		if dev.Kind == device_entity.KindAgentred {
			// agentred：路径在同步组里，逐条给正文。
			if row, ok := locationByFingerprint[dev.Fingerprint]; ok {
				var lp projectLocationPayload
				if json.Unmarshal([]byte(row.Payload), &lp) == nil && lp.Path != "" {
					view.Configured, view.Path, view.LocationSyncID = true, lp.Path, row.SyncID
				}
			}
			out = append(out, view)
			continue
		}
		// 桌面端：**只问上报组**。同步组里就算有一行指纹撞上它也不认——那两组数据的
		// 流动性不同，混用取到的不是「少几行」而是错的。
		//
		// 路径正文照给（规格 2026-08-21 决策 5）：这一行现在改得动，而改不了一个看不见
		// 的值。但 LocationSyncID 仍然不给——桌面端在同步组里没有那样一行，「移除」
		// 经中继喊那台机器自己去做（决策 6），不是删服务端的一行记录。
		localPaths, err := sync_repo.SyncLocalPath().ListByDevice(ctx, userID, dev.ID)
		if err != nil {
			return nil, err
		}
		for _, lp := range localPaths {
			// 路径正文非空才算配好了：与索引组头那枚角标的判据（projectsWithARunnablePath）
			// 同一条。同一件事两处给出不同结论，就会出现「设置里打绿勾、组头上挂未配置」。
			if lp.ProjectSyncID == projectSyncID && lp.Path != "" {
				view.Configured, view.Path = true, lp.Path
				break
			}
		}
		out = append(out, view)
	}
	// 顺序要稳定：ListByUser 按 last_seen_at 排，那个值自己会变，同一份数据两次请求
	// 就会排出两个样子。按机器名再按指纹兜底。
	sort.Slice(out, func(i, j int) bool {
		if out[i].DeviceName != out[j].DeviceName {
			return out[i].DeviceName < out[j].DeviceName
		}
		return out[i].Fingerprint < out[j].Fingerprint
	})
	return out, nil
}

// SetProjectLocation 见接口注释。
//
// 它是路径记录唯一的正当入口：先挡住桌面端与缺件，再按自然键决定这次是改还是建，
// 然后交给与组织面完全同一条写通道（版本分配、来源指纹记空串、广播都在那里）。
func (s *workspaceSvc) SetProjectLocation(
	ctx context.Context, in SetProjectLocationInput,
) (*OrgWriteResult, error) {
	path := strings.TrimSpace(in.Path)
	if in.ProjectSyncID == "" || in.Fingerprint == "" || path == "" {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	dev, err := device_repo.Device().FindByFingerprint(ctx, in.UserID, in.Fingerprint)
	if err != nil {
		return nil, err
	}
	if dev == nil || !dev.IsActive() {
		return nil, i18n.NewNotFoundError(ctx, code.DeviceNotFound)
	}
	if dev.Kind != device_entity.KindAgentred {
		return nil, i18n.NewError(ctx, code.OrgProjectPathDesktopReadOnly)
	}
	project, err := sync_repo.SyncObject().Find(ctx, in.UserID, in.ProjectSyncID)
	if err != nil {
		return nil, err
	}
	if project == nil || project.IsDeleted() || project.Kind != sync_entity.KindProject {
		return nil, i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
	}

	existing, err := sync_repo.SyncObject().FindLocationByNaturalKey(
		ctx, in.UserID, in.ProjectSyncID, in.Fingerprint)
	if err != nil {
		return nil, err
	}
	write := OrgWriteInput{
		UserID: in.UserID, Kind: sync_entity.KindProjectLocation,
		Fields:              map[string]any{"path": path},
		ProjectSyncID:       in.ProjectSyncID,
		AgentredFingerprint: in.Fingerprint,
	}
	if existing != nil {
		// 已经有一行就改它，**不新建第二行**：(账号, 项目, 指纹) 上有一个部分唯一
		// 索引（uk_sync_objects_natural），第二行会直接撞库。
		write.SyncID = existing.SyncID
		return s.UpdateOrgObject(ctx, write)
	}
	return s.CreateOrgObject(ctx, write)
}

// checkLocationNaturalKey 挡住没有账号内自然键的路径记录。
//
// 同步协议自己也挡这一条（sync_svc.rejectReason：「没有项目同步标识就没有自然键，
// R4b 的合并也就无从谈起」），但**写入侧必须先挡住，不能靠下游**——服务端直写这条
// 路径根本不经过那道校验。指纹同理：一条不知道属于哪台机器的路径记录谁也用不上。
func checkLocationNaturalKey(ctx context.Context, in OrgWriteInput) error {
	if in.Kind != sync_entity.KindProjectLocation {
		return nil
	}
	if in.ProjectSyncID == "" || in.AgentredFingerprint == "" {
		return i18n.NewError(ctx, code.InvalidParameter)
	}
	return nil
}

// projectsWithARunnablePath 回「哪些项目在账号里至少有一台机器配了路径」——也就是
// 「从网页在这个项目里开得出对话吗」。
//
// 这是决策 9 那枚「未配置」角标的判据，它必须与 WebDispatchPlan 的判据同源：
// 组头说「未配置」而派发说「可用」，用户看到的就是控制台自己跟自己打架。
//
// 两类设备的路径存在不同的地方，因此按种类各取各的（决策 4、6、7）：
//
//   - **agentred**：路径是账号级同步对象 `project_location`。指纹必须对得上账号里
//     一台存活的 agentred——指向一台已经撤销 / 从未配对的机器的路径记录谁也用不上，
//     算它配好了等于把角标撤掉却仍然开不出对话。
//   - **桌面端**：本机路径不流动，只在上报组 `device_local_paths`，按上报设备分
//     命名空间。**它算数**：决策 9 原先写的依据「web 派活时桌面端那一档本来就跳过」
//     是错的——跳过的是 backend 行没写运行设备的那一档（AvailabilityNoDevice，
//     `case t.IsLocalReference`），不是桌面端这一类设备。一台已配对、在线、上报过
//     本机路径的桌面端在派发计划里拿到的是 AvailabilityAvailable，cwd 就取自上报组
//     （`locationsFor`）。
//   - **路径为空的行不算**：一行解不出路径的记录与没有这一行是同一件事。两类设备
//     同一条口径。
//
// 只回布尔，路径正文一步都不往外带（R19）。
func projectsWithARunnablePath(
	ctx context.Context, userID int64,
	rows []*sync_entity.SyncObject, devices []*device_entity.Device,
) (map[string]bool, error) {
	out := map[string]bool{}
	agentredFingerprints := make(map[string]bool, len(devices))
	for _, dev := range devices {
		if !dev.IsActive() {
			continue
		}
		if dev.Kind == device_entity.KindAgentred {
			if dev.Fingerprint != "" {
				agentredFingerprints[dev.Fingerprint] = true
			}
			continue
		}
		// 桌面端：问上报组，一台一问。台数是账号里的桌面端数量（个位数），
		// 与 ProjectMachines 那一屏同一个做法。
		localPaths, err := sync_repo.SyncLocalPath().ListByDevice(ctx, userID, dev.ID)
		if err != nil {
			return nil, err
		}
		for _, lp := range localPaths {
			if lp.ProjectSyncID != "" && lp.Path != "" {
				out[lp.ProjectSyncID] = true
			}
		}
	}
	for _, row := range rows {
		if row.Kind != sync_entity.KindProjectLocation || row.ProjectSyncID == "" ||
			!agentredFingerprints[row.AgentredFingerprint] {
			continue
		}
		var lp projectLocationPayload
		if json.Unmarshal([]byte(row.Payload), &lp) == nil && lp.Path != "" {
			out[row.ProjectSyncID] = true
		}
	}
	return out, nil
}

// hasLiveProject 判断这批行里有没有这个存活项目。ListByKinds 只回存活行，因此
// 「在里面」就等于「存活且属于这个账号」。
func hasLiveProject(rows []*sync_entity.SyncObject, projectSyncID string) bool {
	if projectSyncID == "" {
		return false
	}
	for _, row := range rows {
		if row.Kind == sync_entity.KindProject && row.SyncID == projectSyncID {
			return true
		}
	}
	return false
}
