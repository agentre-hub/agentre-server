package workspace_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	mirrorapi "github.com/agentre-hub/agentre-server/internal/api/agentsession"
	api "github.com/agentre-hub/agentre-server/internal/api/workspace"
)

// 硬不变量守卫（R19）：workspace 与 mirror 两个包的响应载荷都不带项目路径 /
// CLIPath / EnvJSON。包注释把它写成了「这些字段在视图对象里根本不存在」——这里让
// 那句话有牙齿：一旦有人往任何一个响应结构体（含嵌套的档 / 项目 / Agent / 摘要 /
// 转录帧条目）里加一个这类字段，下面的白名单比较会立刻红，而不是靠调用方自觉不填。
//
// mirror 包的两个响应根（决策 12：项目归属判定整个移到服务端的镜像上，cwd 存在
// server 上但不出现在任何发往浏览器的响应里）与 workspace 走的是同一份守卫——两个
// 包各自都会产生「账号里保存的对话」这一类载荷，分开守就会有两份容易漂开的白名单。
//
// 唯一的例外是 DispatchChoiceItem.Cwd：主动派活时选中的那台机器上的工作目录必须
// 带出去，否则 runtime.run 无处落脚（见 workspace.go 上它自己的注释）。它写在白
// 名单里，因此是一处**显式**的例外，而不是一道悄悄敞开的口子。
//
// 结构与隔壁 internal/api/savedsession/guard_test.go 同形，只是这里的可达面更大：
// 白名单按类型登记，再从响应根做一次反射深走，任何新出现的嵌套结构体没有
// 登记就会红——白名单因此不会随着载荷长大而悄悄过期。
func TestWorkspaceResponses_NeverCarryPathsOrSecrets_Guard(t *testing.T) {
	// 字段名里出现这些词 = 载荷在往「机器上的东西」而不是「指向」的方向长。
	forbidden := []string{"path", "cli", "env", "token", "secret", "credential", "prompt"}

	allowed := map[string][]string{
		"ListAgentsResponse": {"Agents"},
		// AvatarIcon 是 Agent 自己选的图标名（lucide 图标标识，桌面端定义），
		// ProjectSyncIDs 是它直接加入的项目的**同步标识**——两样都是「指向」，
		// 不是机器上的东西：图标名不指向任何文件，项目标识也不是路径（路径只在
		// project_location 里，而那一份从不出现在这个响应上）。
		"AgentItem": {
			"SyncID", "Name", "AvatarColor", "AvatarIcon", "ProjectSyncIDs",
			"DepartmentName", "ExecTargets", "HasAvailableTarget",
		},
		"ExecTargetItem": {
			"Rank", "BackendSyncID", "IsLocalReference",
			"DeviceID", "DeviceName", "BackendType", "Availability", "Current",
		},
		"DispatchTargetResponse": {"AgentSyncID", "Tiers", "Chosen", "Projects"},
		"DispatchTierItem": {
			"Rank", "BackendSyncID", "DeviceID", "DeviceName",
			"BackendType", "Kind", "Availability", "Current",
		},
		// Cwd 是 R19 红线在主动派活场景下**唯一**的显式例外。
		"DispatchChoiceItem": {
			"DeviceFingerprint", "DeviceID", "DeviceName", "BackendType", "Kind", "Cwd",
		},
		"DeviceDetailResponse":       {"DeviceID", "Kind", "RunnableAgents", "Projects"},
		"RunnableAgentItem":          {"SyncID", "Name", "Rank"},
		"ProjectItem":                {"SyncID", "Name", "Configured"},
		"SetExecTargetOrderResponse": {},
		// 组织面九个写端点共用的回执：只有标识与版本号。写通道同样不许把
		// 「机器上的东西」当回执带回去——它一样是一个发往浏览器的载荷。
		"OrgWriteResponse": {"SyncID", "Version"},
		// 会话索引的项目轴：项目树只回「指向」。
		"AccountProjectsResponse": {"Projects"},
		// Description 与 Members 是 2026-08-20 那一轮新长出来的两块：项目设置要改简介，
		// 组头的 ＋ 要列成员。两者都只是「指向」——简介是项目数据本身，成员是一对同步
		// 标识，路径一个字段都没多。
		"ProjectNodeItem": {"SyncID", "Name", "Icon", "Color", "Description",
			"ParentSyncID", "SortOrder", "Configured", "Members"},
		// 成员一项带的是**这条成员关系自己**的同步标识（删成员按它定位）与 Agent 的
		// 同步标识，两个都是指向。
		"ProjectMemberItem": {"SyncID", "AgentSyncID"},
		// R19 收窄的**唯一**一处（规格 2026-08-20「路径与 R19」，2026-08-21 扩了一次
		// 口径）：项目设置的「机器与路径」那一节按项目逐条下发路径正文，理由是用户要
		// 改的就是它，而改不了一个看不见的值。**两类机器都带**——桌面端那一行现在也
		// 改得动，只是写不经服务端（浏览器经中继喊那台机器自己写）。Fingerprint 是
		// **机器的身份**，与 OrgExecTargetItem 那一处同理，不是新开的口子。
		"ProjectMachinesResponse": {"Machines"},
		"ProjectMachineItem": {"DeviceID", "DeviceName", "Kind", "Fingerprint",
			"Online", "Configured", "Path", "LocationSyncID"},
		// 账号镜像的摘要：项目归属只回同步标识，cwd 到 service 边界就为止了；发起端
		// 指纹与会话标识是身份键（决策 17），必须带出去，否则详情页发不出消息。
		// MachineFingerprint 是承载它的账号设备指纹：与 GET /v1/devices 已下行的
		// fingerprint 同类，不是路径或凭据；浏览器发起时详情靠它选择实际连接目标。
		// 索引分页（2026-08-19-session-index-pagination.md）：组骨架、游标与两个
		// 计数都不带路径。Scope 是组的身份，项目那一档里是**项目同步标识**而不是
		// 它的位置——路径不因为换了个字段名就可以出网。
		"SavedSessionsResponse": {"Groups", "Items", "Cursor", "HasMore", "Total"},
		"SavedSessionGroup":     {"Scope", "Total", "Items", "Cursor", "HasMore"},
		// LastReadAt 是这个账号最后一次打开这条对话的时刻，与 LastMessageAt 同类：
		// 一个毫秒数，不是路径也不是凭据。索引的「未读」那一档要拿两个时刻相比
		// （unread = LastMessageAt > LastReadAt），所以下行的是时刻而不是算好的布尔 ——
		// 客户端手里有乐观覆盖层，刚打开的那条当场就该不再是未读。
		//
		// ProviderKey / ModelKey 是这条对话自己钉的 LLM ModelTarget：两个**不透明
		// 稳定 key**，与 AgentSyncID / ProjectSyncID 同类——不是路径、不是凭据、也
		// 不是 API Key（供应商凭据从不离开服务端，这里带的只是它的标识）。带出去是
		// 因为机器离线时详情页仍要显示得出这条对话用的是哪个模型，而那正是「已保存」
		// 承诺的一部分。
		// ConversationID 取代了 SessionID：它是这条对话的全局标识（UUIDv7 / 存量的
		// UUIDv5），同 AgentSyncID / ProjectSyncID 一样是不透明标识，不是路径也不是凭据。
		"SavedSessionItem": {
			"ConversationID", "PeerFingerprint", "MachineFingerprint", "Title",
			"AgentSyncID", "ProjectSyncID",
			"BackendType", "LifecycleState", "WaitingForInput", "LastMessageAt",
			"LastReadAt", "ProviderKey", "ModelKey",
		},
		// 标记已读的响应只有落定的那个时刻。
		"MarkSessionReadResponse": {"LastReadAt"},
		// 组织面的读通道：索引与详情的全部材料，加上「配一档时能挑哪个后端」。
		// 后端那一项是本轮这条红线最吃紧的一处——它专门用来呈现后端，而后端的同步
		// 载荷里就摆着 cli_path 与 env_json；这份白名单因此逐字段登记它能带什么。
		"OrgChartResponse": {"Departments", "Agents"},
		"OrgDepartmentItem": {"SyncID", "Name", "Description", "Icon", "AccentColor",
			"ParentSyncID", "LeadAgentSyncID", "SortOrder"},
		"OrgAgentItem": {"SyncID", "Name", "Description", "AvatarColor", "AvatarIcon",
			"SystemBadge", "DepartmentSyncID", "ParentAgentSyncID", "SortOrder",
			"PromptJSON", "ToolsJSON", "ExecTargets"},
		// DeviceFingerprint 是**机器的身份**，不是「机器上的东西」：浏览器的中继
		// 点对点，`/v1/relay/client?daemon_fingerprint=…` 认的就是它，没有它这一
		// 档的技能目录问不出来。同一个值已经随 GET /v1/devices
		// （device.ListDevicesItem.Fingerprint）与 DispatchChoiceItem 下行给同一个
		// 浏览器会话——登记它不是新开口子，是把既有的暴露面写进白名单。
		"OrgExecTargetItem": {"SyncID", "Rank", "BackendSyncID", "BackendName", "BackendType",
			"DeviceID", "DeviceName", "DeviceFingerprint", "IsLocalReference",
			"Availability", "Current", "SkillsJSON"},
		"OrgBackendsResponse": {"Backends"},
		"OrgBackendItem": {"SyncID", "Name", "BackendType", "DeviceID", "DeviceName",
			"IsLocalReference", "Availability"},
		// 转录：原始帧本身（seq/method/params）不是「机器上的东西」，是对话内容
		// 本身（决策 4）——渲染的保真度不留例外（决策 14），因此不受这份白名单约束
		// 到 Params 内部；这里只守 TranscriptResponse/TranscriptFrameItem 自己的
		// 字段集不长出 cwd 这一类新字段。
		// OldestSeq / HasBefore 是反向读那一页的两个数（规格 2026-08-21-transcript-
		// tail-loading 决策 2）：都是 seq 与布尔，不带任何机器上的东西。
		// Createtime 是这一帧发生的时刻（Unix 毫秒），同样只是一个数：它说的是「什么
		// 时候」，不是「在哪台机器上的哪个路径」。浏览器的转录从帧现折，每条消息头上
		// 那个 HH:mm 只有这一个来源。
		"TranscriptResponse":  {"Frames", "Cursor", "HasMore", "OldestSeq", "HasBefore"},
		"TranscriptFrameItem": {"Seq", "Method", "Params", "Createtime"},
		// 看板（规格 2026-08-27）：卡片、标签目录与两套计数。整族只有「指向」——
		// 标题、描述、阶段、位置，以及项目 / Agent / 机器的**同步标识**。
		// AgentBackendSyncID 是那个标识本身，不是后端的正文：cli_path 与 env_json
		// 在这一族里同样一个字段都没有。
		"IssueBoardResponse": {"Issues", "Labels", "StageCounts", "StageTotals",
			"ProjectCounts"},
		"IssueItem": {"SyncID", "Title", "Description", "Stage", "Position",
			"ProjectSyncID", "AgentSyncID", "AgentBackendSyncID",
			"LLMProviderKey", "LLMModelKey", "ClosedAt", "CreatedAt", "UpdatedAt", "Labels"},
		"LabelItem":             {"SyncID", "Name", "Tone", "UsageCount"},
		"ProjectIssueCountItem": {"ProjectSyncID", "Count"},
	}

	// 禁词的两处显式例外，逐个字段登记（不是把词从禁词表里删掉——那等于给所有类型
	// 都开了口子）：
	//
	//   - DispatchChoiceItem.Cwd 见上面。
	//   - OrgAgentItem.PromptJSON 是**系统提示词**，web 组织面本来就管它（写方向同样
	//     收得下，见下面那条守卫的注释）。R19 守的是「机器上的东西」——本机可执行
	//     文件路径与透传环境变量；提示词是组织数据本身，不在其列。cli / env / path
	//     这三个词一个都没放开。
	//   - ProjectMachineItem.Path 是 R19 按对象收窄的那一条（规格 2026-08-20
	//     「路径与 R19」，2026-08-21 决策 5 把它从「只有 agentred」扩成「任何机器上
	//     这个项目的路径」）：**仍然只有项目设置这一处**带得动它。cwd 与 cli_path /
	//     env_json 一条都没松——它们各自的类型上仍然没有那个字段。
	exempt := map[string]bool{
		"OrgAgentItem.PromptJSON": true,
		"ProjectMachineItem.Path": true,
	}

	seen := map[string]bool{}
	pkgPaths := map[string]bool{
		reflect.TypeOf(api.ListAgentsResponse{}).PkgPath():          true,
		reflect.TypeOf(mirrorapi.SavedSessionsResponse{}).PkgPath(): true,
	}
	for _, root := range []any{
		api.ListAgentsResponse{},
		api.DispatchTargetResponse{},
		api.DeviceDetailResponse{},
		api.SetExecTargetOrderResponse{},
		api.OrgWriteResponse{},
		api.OrgChartResponse{},
		api.OrgBackendsResponse{},
		api.AccountProjectsResponse{},
		api.ProjectMachinesResponse{},
		api.IssueBoardResponse{},
		mirrorapi.SavedSessionsResponse{},
		mirrorapi.TranscriptResponse{},
		mirrorapi.MarkSessionReadResponse{},
	} {
		walkResponseStruct(t, reflect.TypeOf(root), allowed, forbidden, exempt, pkgPaths, seen)
	}

	// 反向核对：白名单里登记了却从任何响应根都走不到的类型 = 白名单已经过期，
	// 它守着的其实是一个没人再返回的结构体。
	for name := range allowed {
		if !seen[name] {
			t.Errorf("%s 在白名单里但从任何响应根都不可达：白名单已过期", name)
		}
	}
}

// walkResponseStruct 深走一个响应结构体：逐字段核对白名单与禁词，再对嵌套的
// 结构体 / 指针 / 切片元素递归，直到所有可达类型都被核对过一遍。递归只进入
// pkgPaths 登记过的包——响应结构体引用的标准库/第三方类型（比如
// json.RawMessage）到此为止，不需要为它们逐个登记白名单。
func walkResponseStruct(
	t *testing.T, typ reflect.Type,
	allowed map[string][]string, forbidden []string, exempt map[string]bool,
	pkgPaths map[string]bool, seen map[string]bool,
) {
	t.Helper()
	for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct || !pkgPaths[typ.PkgPath()] {
		return
	}
	name := typ.Name()
	if seen[name] {
		return
	}
	seen[name] = true

	names, ok := allowed[name]
	if !ok {
		t.Errorf("%s 是响应载荷里的一个结构体，但没有登记在白名单里："+
			"新载荷必须先说清楚自己允许带哪些字段", name)
		return
	}
	allowedSet := make(map[string]bool, len(names))
	for _, n := range names {
		allowedSet[n] = true
	}
	if typ.NumField() != len(allowedSet) {
		t.Errorf("%s 字段数 %d != 白名单 %d（多出的字段 = 载荷里多了不该有的东西）",
			name, typ.NumField(), len(allowedSet))
	}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !allowedSet[field.Name] {
			t.Errorf("%s.%s 不在白名单里：响应出现了 workspace 不该带的字段", name, field.Name)
		}
		lower := strings.ToLower(field.Name)
		for _, f := range forbidden {
			if strings.Contains(lower, f) && !exempt[name+"."+field.Name] {
				t.Errorf("%s.%s 命中禁词 %q：R19 硬不变量被破坏", name, field.Name, f)
			}
		}
		walkResponseStruct(t, field.Type, allowed, forbidden, exempt, pkgPaths, seen)
	}
}

// 写方向的同一条红线（规格 2026-08-18「后端是机器的，浏览器只能引用，不能创建或编辑」）。
//
// 读方向由上面那条守卫钉住；这一条钉写方向：**浏览器连表达一次「建 / 改后端」的
// 请求都做不到**。做法同样是结构性的——不是端点收到之后拒绝，而是契约里根本没有
// 那个形状：没有以 backend 为对象的请求结构体，已有的九个里也没有任何一个字段能装下
// cli_path 或 env_json。
//
// 禁词只有 cli / env 两个，不沿用响应侧那一份：系统提示词（PromptJSON）在写方向是
// 合法的——web 组织面本来就管它。path 也不禁：backend_sync_id 是一个**引用**，
// 执行目标就是靠它从已有后端里挑一个（BackendSyncID 里不含 path，这里禁的是字段名
// 里的 cli / env）。
func TestOrgWriteRequests_CannotExpressABackendOrAMachineLocalKey_Guard(t *testing.T) {
	forbidden := []string{"cli", "env", "secret", "credential", "apikey", "token"}

	cases := []struct {
		req    any
		path   string
		fields []string
	}{
		// 排序不在里面：规格只把「排序」给了执行目标，部门与 Agent 的次序浏览器不动。
		{api.CreateDepartmentRequest{}, "/v1/workspace/org/departments",
			[]string{"Name", "Description", "Icon", "AccentColor", "ParentSyncID", "LeadAgentSyncID"}},
		{api.UpdateDepartmentRequest{}, "/v1/workspace/org/departments/update",
			[]string{"SyncID", "Name", "Description", "Icon", "AccentColor", "ParentSyncID", "LeadAgentSyncID"}},
		{api.DeleteDepartmentRequest{}, "/v1/workspace/org/departments/delete", []string{"SyncID"}},
		{api.CreateAgentRequest{}, "/v1/workspace/org/agents",
			[]string{"Name", "Description", "AvatarColor", "AvatarIcon", "DepartmentSyncID",
				"ParentAgentSyncID", "PromptJSON", "ToolsJSON"}},
		{api.UpdateAgentRequest{}, "/v1/workspace/org/agents/update",
			[]string{"SyncID", "Name", "Description", "AvatarColor", "AvatarIcon", "DepartmentSyncID",
				"ParentAgentSyncID", "PromptJSON", "ToolsJSON"}},
		{api.DeleteAgentRequest{}, "/v1/workspace/org/agents/delete", []string{"SyncID"}},
		{api.CreateExecTargetRequest{}, "/v1/workspace/org/exec-targets",
			[]string{"AgentSyncID", "BackendSyncID", "SortOrder", "SkillsJSON"}},
		{api.UpdateExecTargetRequest{}, "/v1/workspace/org/exec-targets/update",
			[]string{"SyncID", "AgentSyncID", "BackendSyncID", "SortOrder", "SkillsJSON"}},
		{api.DeleteExecTargetRequest{}, "/v1/workspace/org/exec-targets/delete", []string{"SyncID"}},
		// 项目一族（规格 2026-08-20）。**这里没有 path**：项目的绝对路径不是项目
		// 自己的字段，它按「项目 × agentred」逐条存在 project_location 上，另有入口。
		{api.CreateProjectRequest{}, "/v1/workspace/org/projects",
			[]string{"Name", "Description", "Icon", "Color", "ParentSyncID", "SortOrder"}},
		{api.UpdateProjectRequest{}, "/v1/workspace/org/projects/update",
			[]string{"SyncID", "Name", "Description", "Icon", "Color", "ParentSyncID", "SortOrder"}},
		{api.DeleteProjectRequest{}, "/v1/workspace/org/projects/delete", []string{"SyncID"}},
		// 成员关系没有改：它要么在、要么不在（桌面端 projectAgentAdapter.apply 同理
		// ——「成员关系没有可改的内容」）。因此只有建与删两个端点。
		{api.CreateProjectMemberRequest{}, "/v1/workspace/org/project-members",
			[]string{"ProjectSyncID", "AgentSyncID"}},
		{api.DeleteProjectMemberRequest{}, "/v1/workspace/org/project-members/delete",
			[]string{"SyncID"}},
		// 路径：**只有 agentred 的路径写得进去**（决策 4），因此请求里带的是目标机器
		// 的指纹而不是 device_id——桌面端的本机路径住在上报组、整份快照替换，写一行
		// 进去下次上报就冲掉了。禁词表里没有 path：这条通道就是用来写它的，禁的是
		// cli / env 那两个「机器上的东西」。
		{api.SetProjectLocationRequest{}, "/v1/workspace/org/project-locations",
			[]string{"ProjectSyncID", "DeviceFingerprint", "Path"}},
		{api.DeleteProjectLocationRequest{}, "/v1/workspace/org/project-locations/delete",
			[]string{"SyncID"}},
		// 看板一族（规格 2026-08-27）。**这里没有 position、没有 closed_at、没有
		// status**：位置由服务端在相邻两卡之间算（交给浏览器算，两个标签页同时拖就会
		// 算出两个互相覆盖的值），关闭时刻完全由 stage 推导，标签的存活由建 / 删两条
		// 路径决定。AgentBackendSyncID 是**引用**——浏览器挑的是账号里已有的后端，
		// 建不出新的，与执行目标那一处同理。
		{api.CreateIssueRequest{}, "/v1/workspace/issues",
			[]string{"Title", "Description", "Stage", "ProjectSyncID", "AgentSyncID",
				"AgentBackendSyncID", "LLMProviderKey", "LLMModelKey", "LabelSyncIDs"}},
		{api.UpdateIssueRequest{}, "/v1/workspace/issues/update",
			[]string{"SyncID", "Title", "Description", "Stage", "ProjectSyncID", "AgentSyncID",
				"AgentBackendSyncID", "LLMProviderKey", "LLMModelKey", "LabelSyncIDs"}},
		{api.MoveIssueRequest{}, "/v1/workspace/issues/move",
			[]string{"SyncID", "Stage", "AfterSyncID"}},
		{api.DeleteIssueRequest{}, "/v1/workspace/issues/delete", []string{"SyncID"}},
		{api.CreateIssueLabelRequest{}, "/v1/workspace/issues/labels", []string{"Name", "Tone"}},
		{api.UpdateIssueLabelRequest{}, "/v1/workspace/issues/labels/update",
			[]string{"SyncID", "Name", "Tone"}},
		{api.DeleteIssueLabelRequest{}, "/v1/workspace/issues/labels/delete", []string{"SyncID"}},
	}

	for _, tc := range cases {
		typ := reflect.TypeOf(tc.req)
		t.Run(typ.Name(), func(t *testing.T) {
			meta, ok := typ.FieldByName("Meta")
			if !ok {
				t.Fatalf("%s 没有 mux.Meta：它不是一个端点", typ.Name())
			}
			assert.Equal(t, tc.path, meta.Tag.Get("path"))
			// 路径里出现 backend = 有人给后端开了一条 web 写端点。
			assert.NotContains(t, strings.ToLower(tc.path), "backend",
				"后端在 web 上只读：不该有以它为对象的写端点")

			got := leafFieldNames(typ)
			assert.ElementsMatch(t, tc.fields, got,
				"%s 的字段集变了：写通道允许浏览器碰哪些键必须显式登记", typ.Name())
			for _, name := range got {
				lower := strings.ToLower(name)
				for _, f := range forbidden {
					assert.NotContains(t, lower, f,
						"%s.%s 命中禁词 %q：浏览器不该有键去写机器上的东西", typ.Name(), name, f)
				}
			}
		})
	}

	// 请求体里没有任何身份字段：写入范围只由鉴权上下文里的账号圈定。这是「跨账号
	// 写不进去」在契约上的那一半——service 那一半按（账号, 同步标识）取行。
	for _, tc := range cases {
		typ := reflect.TypeOf(tc.req)
		for _, name := range leafFieldNames(typ) {
			lower := strings.ToLower(name)
			if lower == "userid" || lower == "accountid" || lower == "deviceid" {
				t.Errorf("%s.%s 是身份字段：账号只能来自鉴权上下文", typ.Name(), name)
			}
		}
	}
}

// leafFieldNames 收集一个请求结构体上所有**可由调用方填**的字段名：嵌入的字段组
// （DepartmentFields 之类）摊平，mux.Meta 不算——它是路由声明，不是载荷。
func leafFieldNames(typ reflect.Type) []string {
	var out []string
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if field.Name == "Meta" {
			continue
		}
		if field.Anonymous && field.Type.Kind() == reflect.Struct {
			out = append(out, leafFieldNames(field.Type)...)
			continue
		}
		out = append(out, field.Name)
	}
	return out
}
