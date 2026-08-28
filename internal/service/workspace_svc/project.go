package workspace_svc

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
)

// ── 浏览器直写项目一族（规格 2026-08-20「项目在 web 上成为一件可管理的事」）──────
//
// 项目与成员关系走的是与部门 / Agent / 执行目标**完全同一条**写通道（决策 2）：
// 同一套「校验 → 载荷 → NextVersion → Save → 广播」，只是多了三条项目自己的判据，
// 都在这个文件里：
//
//   - 父项目不能指向自己或自己的后代（环会让两端的项目树递归缩进永不终止）；
//   - 成员关系的两端必须都是账号里存活的对象，且同一个 Agent 不重复入同一个项目；
//   - 删项目时子树连同各自的成员关系与路径记录一并落墓碑（决策 13）。
//
// 路径记录（project_location）不在这里：它是任务 2 的对象，写通道那张闸门表里
// 也还没有它。级联删除是个例外——它落的是**墓碑**而不是新内容，而一个指向已删项目
// 的路径记录留着只会让那台机器上的目录一直挂在一个不存在的项目名下。

// projectAgentPayload 是项目 ↔ Agent 成员关系的同步载荷，与桌面端
// （agentre 侧 sync_svc/adapter_project.go 的同名结构体）同名同键。两端都用同步标识
// 表达，**不占 sync_objects.project_sync_id 列**——那一列是路径记录的账号内自然键，
// 桌面端推上来的成员关系同样不带它。
//
// 与本仓 agent_session_entity / sync_entity.GuardPayload 同一种「跨仓重新声明」的做法
// （决策 6 的同一条理由）：键名改了两边都要改，因此这里写明出处。
type projectAgentPayload struct {
	ProjectSyncID string `json:"project_sync_id"`
	AgentSyncID   string `json:"agent_sync_id"`
	JoinedAt      int64  `json:"joined_at"`
}

// ProjectMemberView 是项目的一个直接成员。
//
// SyncID 是**这条成员关系自己的**同步标识，不是 Agent 的：删一个成员删的是这条关系
// 那一行，浏览器没有它就定位不到要删哪一行。
type ProjectMemberView struct {
	SyncID      string
	AgentSyncID string
}

// checkProjectWrite 是项目一族在写入之前的那几条判据。selfSyncID 为空即新建
// （还没有自己的标识，因此不可能指向自己）。
func checkProjectWrite(ctx context.Context, in OrgWriteInput, selfSyncID string) error {
	switch in.Kind {
	case sync_entity.KindProject:
		return checkProjectParent(ctx, in, selfSyncID)
	case sync_entity.KindProjectAgent:
		return checkProjectMemberEnds(ctx, in, selfSyncID)
	}
	return nil
}

// checkProjectParent 落实「父项目不能是自己或自己的后代」。
//
// 判的是**写进去的值**而不是键在不在：请求没提到父项目时不动原来的归属，显式写空串
// 是「挂回根上」这个正当动作（同 checkSystemAgentPlacement 的口径）。
//
// 环必须判在服务端：这一行会经下行游标到达每一台机器，那边按 parent 递归缩进，
// 一个环就是一次渲染不终止；禁用下拉里的那几项拦不住直接打端点的请求。
func checkProjectParent(ctx context.Context, in OrgWriteInput, selfSyncID string) error {
	raw, ok := in.Fields["parent_sync_id"]
	if !ok {
		return nil
	}
	parent, _ := raw.(string)
	if parent == "" {
		return nil
	}
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, in.UserID, []string{sync_entity.KindProject})
	if err != nil {
		return err
	}
	parentOf := make(map[string]string, len(rows))
	for _, row := range rows {
		var pp projectPayload
		if json.Unmarshal([]byte(row.Payload), &pp) != nil {
			// 载荷解不开的行只是不知道它挂在谁下面，不该让整次写入失败；它在环检测里
			// 相当于一个根节点，向上走到它就停。
			parentOf[row.SyncID] = ""
			continue
		}
		parentOf[row.SyncID] = pp.ParentSyncID
	}
	if _, exists := parentOf[parent]; !exists {
		// 指向账号里不存在（或已落墓碑）的项目：落下去就是一棵接不上的孤树。
		return i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
	}
	if selfSyncID == "" {
		return nil
	}
	// 从新父项目往上走：走到自己就说明这个「父项目」其实在自己的子树里。
	// 步数按行数封顶——数据里已经有环时（别的写入路径漏判过）这里不该跟着转不出来。
	for cur, steps := parent, 0; cur != "" && steps <= len(parentOf); steps++ {
		if cur == selfSyncID {
			return i18n.NewError(ctx, code.OrgProjectParentCycle)
		}
		cur = parentOf[cur]
	}
	return nil
}

// checkProjectMemberEnds 落实成员关系的两条判据：两端都得是账号里**存活**的对象，
// 且同一个 Agent 不重复入同一个项目。
//
// 前者：指不到的一端在每一端都解析不出引用，只会按 R2a 一直暂缓，30 天后以「引用
// 丢失」记进用户的追回列表。后者：第二行成员关系会让清单里出现两个同一个人，删掉
// 其中一个之后它还在——用户看到的是「删不掉」。
func checkProjectMemberEnds(ctx context.Context, in OrgWriteInput, selfSyncID string) error {
	projectSyncID, _ := in.Fields["project_sync_id"].(string)
	agentSyncID, _ := in.Fields["agent_sync_id"].(string)
	if projectSyncID == "" || agentSyncID == "" {
		return nil
	}
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, in.UserID, []string{
		sync_entity.KindProject, sync_entity.KindAgent, sync_entity.KindProjectAgent})
	if err != nil {
		return err
	}
	projectFound, agentFound := false, false
	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindProject:
			projectFound = projectFound || row.SyncID == projectSyncID
		case sync_entity.KindAgent:
			agentFound = agentFound || row.SyncID == agentSyncID
		case sync_entity.KindProjectAgent:
			if row.SyncID == selfSyncID {
				continue
			}
			var pa projectAgentPayload
			if json.Unmarshal([]byte(row.Payload), &pa) != nil {
				continue
			}
			if pa.ProjectSyncID == projectSyncID && pa.AgentSyncID == agentSyncID {
				return i18n.NewError(ctx, code.OrgProjectMemberExists)
			}
		}
	}
	if !projectFound || !agentFound {
		return i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
	}
	return nil
}

// withProjectMemberJoinedAt 给新成员关系补上入组时刻。
//
// 不补的话载荷里根本没有这个键，桌面端解出来是 0，而它那一侧拿它当这一行的
// 「最后修改时间」（adapter_project.go 的 outbound.UpdatedAt = row.JoinedAt）：
// 0 会让这条关系在每一台机器上都显示成 1970 年加入的。**显式给了就照给的写**。
func withProjectMemberJoinedAt(kind string, fields map[string]any, nowMs int64) map[string]any {
	if kind != sync_entity.KindProjectAgent {
		return fields
	}
	if _, ok := fields["joined_at"]; ok {
		return fields
	}
	// 原 map 不就地改：调用方拼出来的那一份不该因为走了一趟 service 就多出一个键。
	next := make(map[string]any, len(fields)+1)
	for k, v := range fields {
		next[k] = v
	}
	next["joined_at"] = nowMs
	return next
}

// cascadeProjectDelete 落实决策 13 的那一半：删一个项目时，它的**全部子项目**、
// 以及这整棵子树名下的成员关系与路径记录都跟着落墓碑。
//
// **对话一条都不删。** 项目归属是判出来的而不是存出来的（projectSyncIDByLocation），
// 项目行没了，那些对话自然落回「未归项目」组——删项目是整理，不是清账。
//
// 与桌面端 projectAdapter.children 是同一份清单，只是那一份由桌面端在本端发起删除时
// 入队，而这一条删除由浏览器发起，走不到那条路径：少了它，子项目会成为一批指向已删
// 父项目的孤儿行，在每一台机器上照常显示。
//
// 版本号逐行取（同 sync_svc.tombstoneExecTargetsOf），主行最后落，因此主行拿到的是
// 这次操作推进到的最高版本，一次广播就够。
func cascadeProjectDelete(
	ctx context.Context, in OrgWriteInput, root *sync_entity.SyncObject,
) error {
	if in.Kind != sync_entity.KindProject {
		return nil
	}
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, in.UserID, []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation})
	if err != nil {
		return err
	}
	subtree := projectSubtree(rows, root.SyncID)

	now := time.Now().UnixMilli()
	cascaded := 0
	for _, row := range rows {
		if row.ID == root.ID || !belongsToSubtree(row, subtree) {
			continue
		}
		version, err := sync_repo.SyncState().NextVersion(ctx, in.UserID, 1)
		if err != nil {
			return err
		}
		n, err := sync_repo.SyncObject().Tombstone(ctx, row.ID, version, now)
		if err != nil {
			return err
		}
		cascaded += int(n)
	}
	if cascaded > 0 {
		// 载荷正文一律不进日志（里面有项目路径与简介），只报数。
		logger.Ctx(ctx).Info("workspace_svc.cascadeProjectDelete: subtree tombstoned from web",
			zap.Int64("userId", in.UserID), zap.String("syncId", root.SyncID),
			zap.Int("cascadedCount", cascaded))
	}
	return nil
}

// projectSubtree 回「这个项目自己 + 它的全部后代」的标识集合。父子关系按载荷里的
// parent_sync_id 建，访问过的节点不再展开——数据里已经有环时这里不该转不出来。
func projectSubtree(rows []*sync_entity.SyncObject, rootSyncID string) map[string]bool {
	childrenOf := map[string][]string{}
	for _, row := range rows {
		if row.Kind != sync_entity.KindProject {
			continue
		}
		var pp projectPayload
		if json.Unmarshal([]byte(row.Payload), &pp) != nil || pp.ParentSyncID == "" {
			continue
		}
		childrenOf[pp.ParentSyncID] = append(childrenOf[pp.ParentSyncID], row.SyncID)
	}
	subtree := map[string]bool{rootSyncID: true}
	queue := []string{rootSyncID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, child := range childrenOf[cur] {
			if subtree[child] {
				continue
			}
			subtree[child] = true
			queue = append(queue, child)
		}
	}
	return subtree
}

// belongsToSubtree 判断这一行是不是要跟着删的：子树里的项目行本身，或者挂在子树里
// 某个项目下的成员关系 / 路径记录。
//
// 两类子行认「项目」的方式不同，因为它们本来就存在不同的地方：成员关系把项目写在
// **载荷**里（与桌面端同形），路径记录把项目写在 **project_sync_id 列**上（那是它的
// 账号内自然键的一半）。
func belongsToSubtree(row *sync_entity.SyncObject, subtree map[string]bool) bool {
	switch row.Kind {
	case sync_entity.KindProject:
		return subtree[row.SyncID]
	case sync_entity.KindProjectAgent:
		var pa projectAgentPayload
		if json.Unmarshal([]byte(row.Payload), &pa) != nil {
			return false
		}
		return subtree[pa.ProjectSyncID]
	case sync_entity.KindProjectLocation:
		return row.ProjectSyncID != "" && subtree[row.ProjectSyncID]
	}
	return false
}

// projectMembersBySyncID 把成员关系那批行整理成 项目同步标识 → 成员清单。
//
// 同一个 (项目, Agent) 有两行时收敛成一行，取同步标识字典序最小的那一个：两台桌面端
// 各自离线把同一个 Agent 加进同一个项目就会落成这样（桌面端 projectAgentAdapter.apply
// 只在本机去重，挡不住跨机的这一种）。判据只看数据本身、不看行序——ListByKinds 没有
// ORDER BY，「以先到的一行为准」等于把「该删哪一行」交给这一次的返回顺序。
func projectMembersBySyncID(rows []*sync_entity.SyncObject) map[string][]ProjectMemberView {
	// (项目, Agent) → 这一对当前选中的成员关系标识。
	chosen := map[string]map[string]string{}
	for _, row := range rows {
		if row.Kind != sync_entity.KindProjectAgent {
			continue
		}
		var pa projectAgentPayload
		if json.Unmarshal([]byte(row.Payload), &pa) != nil ||
			pa.ProjectSyncID == "" || pa.AgentSyncID == "" {
			continue
		}
		byAgent := chosen[pa.ProjectSyncID]
		if byAgent == nil {
			byAgent = map[string]string{}
			chosen[pa.ProjectSyncID] = byAgent
		}
		if taken, ok := byAgent[pa.AgentSyncID]; !ok || row.SyncID < taken {
			byAgent[pa.AgentSyncID] = row.SyncID
		}
	}
	out := make(map[string][]ProjectMemberView, len(chosen))
	for projectSyncID, byAgent := range chosen {
		members := make([]ProjectMemberView, 0, len(byAgent))
		for agentSyncID, memberSyncID := range byAgent {
			members = append(members, ProjectMemberView{SyncID: memberSyncID, AgentSyncID: agentSyncID})
		}
		// 顺序要稳定：不排的话同一份数据两次请求能给出两个样子（map 遍历无序）。
		sort.Slice(members, func(i, j int) bool { return members[i].AgentSyncID < members[j].AgentSyncID })
		out[projectSyncID] = members
	}
	return out
}
