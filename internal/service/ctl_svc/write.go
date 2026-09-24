package ctl_svc

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// write 先对照当前数据算出变更清单，再（非预览时）经现有服务落库。审批不在这里：
// agentred 在拥有会话的那一端出卡，批准后才调过来（决策 4），所以这里直接执行。
func (s *ctlSvc) write(
	ctx context.Context, caller Caller, req *agentrewire.CtlWriteRequest, preview bool,
) (*agentrewire.CtlWriteResponse, error) {
	kind, op := req.GetKind(), req.GetOp()
	if _, ok := kindNames[kind]; !ok {
		return nil, badRequest("unknown resource kind %s", kind)
	}
	if op != agentrewire.CtlOp_CTL_OP_CREATE && op != agentrewire.CtlOp_CTL_OP_UPDATE && op != agentrewire.CtlOp_CTL_OP_DELETE {
		return nil, badRequest("write needs an op: create, update or delete")
	}
	st, err := loadState(ctx, caller)
	if err != nil {
		return nil, err
	}
	if st.caller == nil {
		return nil, &Error{Status: http.StatusForbidden, Msg: "the calling device is not active in this account"}
	}
	fields := append([]string(nil), req.GetFields()...)
	if err := checkSupported(st, kind, fields); err != nil {
		return nil, err
	}

	w := &kindWrite{s: s, st: st, req: req, fields: map[string]bool{}}
	change := &agentrewire.CtlChange{Op: op, Kind: kind, Id: req.GetId()}
	if op != agentrewire.CtlOp_CTL_OP_CREATE {
		if w.cur, err = st.get(kind, req.GetId()); err != nil {
			return nil, err
		}
		change.Name = st.label(w.cur)
	}
	if op == agentrewire.CtlOp_CTL_OP_DELETE {
		// 桌面端拒删带子项目的项目（project_svc.Delete）；workspace_svc 的删除会把子树
		// 一起落墓碑，所以这条拒绝在这里判，预览时就挡住，审批卡不会出现。
		if kind == agentrewire.CtlKind_CTL_KIND_PROJECT && st.hasSubProjects(st.byID[req.GetId()].SyncID) {
			return nil, &Error{Status: http.StatusConflict, Msg: fmt.Sprintf(
				"project %q has sub-projects; delete or move them first", change.GetName())}
		}
		if kind == agentrewire.CtlKind_CTL_KIND_DEPARTMENT && req.GetCascade() {
			depts, agents := st.cascadeImpact(st.byID[req.GetId()].SyncID)
			// 句式是约定：agentred 用它还原审批卡上的级联数量（agentre 的
			// transcript/blocks.ParseCtlCascadeNote），与桌面端执行者写的是同一句。
			change.Note = fmt.Sprintf("also deletes %s and %s", plural(len(depts), "sub-department"), plural(len(agents), "agent"))
		}
	} else {
		if w.next, err = mergeDoc(kind, op, w.cur, req.GetResource(), fields); err != nil {
			return nil, err
		}
		if p := w.next.GetProject(); p != nil && op == agentrewire.CtlOp_CTL_OP_UPDATE &&
			(len(req.GetAddMemberAgentIds()) > 0 || len(req.GetRemoveMemberAgentIds()) > 0) {
			p.MemberAgentIds = mergeMembers(p.GetMemberAgentIds(), req.GetAddMemberAgentIds(), req.GetRemoveMemberAgentIds())
			fields = append(fields, "memberAgentIds")
		}
		if err := w.resolveBackendDevice(slices.Contains(fields, "device")); err != nil {
			return nil, err
		}
		if change.Fields, err = st.fieldChanges(kind, w.cur, w.next, fields); err != nil {
			return nil, err
		}
		if w.cur == nil {
			change.Name = st.label(w.next)
		}
	}
	for _, f := range fields {
		w.fields[f] = true
	}
	resp := &agentrewire.CtlWriteResponse{Id: req.GetId(), Name: change.GetName(), Changes: []*agentrewire.CtlChange{change}}
	if preview {
		return resp, nil
	}

	log := logger.Ctx(ctx).With(zap.Int64("userId", caller.UserID), zap.Int64("deviceId", caller.DeviceID),
		zap.String("op", opName(op)), zap.String("kind", kindNames[kind]), zap.Int64("id", req.GetId()),
		zap.Strings("fields", fields))
	id, err := w.execute(ctx)
	if err != nil {
		log.Warn("ctl_svc.write: write failed", zap.Error(err))
		return nil, err
	}
	change.Id, resp.Id = id, id
	log.Info("ctl_svc.write: written", zap.Int64("resultId", id))
	return resp, nil
}

// checkSupported 挡住本 spec 在 server 路径上不做的写入（「server 执行者」）。
func checkSupported(st *state, kind agentrewire.CtlKind, fields []string) error {
	if kind == agentrewire.CtlKind_CTL_KIND_BACKEND && slices.Contains(fields, "token") {
		return unsupported("the OpenClaw token cannot be written through the server; " +
			"set it on the machine the backend is bound to")
	}
	if kind == agentrewire.CtlKind_CTL_KIND_PROJECT && slices.Contains(fields, "path") &&
		st.caller.Kind != device_entity.KindAgentred {
		return unsupported("a desktop device's local project path cannot be set through the server; " +
			"set it in the Agentre desktop on that machine")
	}
	return nil
}

// kindWrite 是一次写入执行时的全部材料。
type kindWrite struct {
	s      *ctlSvc
	st     *state
	req    *agentrewire.CtlWriteRequest
	cur    *agentrewire.CtlResource
	next   *agentrewire.CtlResource
	fields map[string]bool
	// deviceFP 是后端 device 字段解析出的指纹（只解析一次，见 resolveBackendDevice）。
	deviceFP string
}

// resolveBackendDevice 把后端文档里的 device 解析成账号里的一台设备，并写成它的名字，
// 变更清单因此前后都是名字。create 没给 device 时是发起请求的这台机器。
func (w *kindWrite) resolveBackendDevice(written bool) error {
	b := w.next.GetBackend()
	if b == nil || (!written && w.cur != nil) {
		return nil
	}
	fp, err := w.st.resolveDevice(b.GetDevice())
	if err != nil {
		return err
	}
	// 文档里写成名字给变更清单看；落库用这次解析出的指纹——名字可能不唯一，不能再解析一遍。
	w.deviceFP, b.Device = fp, w.st.deviceName(fp)
	return nil
}

func (w *kindWrite) execute(ctx context.Context) (int64, error) {
	switch w.req.GetKind() {
	case agentrewire.CtlKind_CTL_KIND_AGENT:
		return w.agent(ctx)
	case agentrewire.CtlKind_CTL_KIND_DEPARTMENT:
		return w.department(ctx)
	case agentrewire.CtlKind_CTL_KIND_PROJECT:
		return w.project(ctx)
	case agentrewire.CtlKind_CTL_KIND_PROVIDER:
		return w.provider(ctx)
	case agentrewire.CtlKind_CTL_KIND_MODEL:
		return w.model(ctx)
	default:
		return w.backend(ctx)
	}
}

func (w *kindWrite) op() agentrewire.CtlOp { return w.req.GetOp() }

// syncOf 把 ctl id 换成某类行的同步标识；0 是「没有」，指向不存在的行是 404。
func (w *kindWrite) syncOf(kind agentrewire.CtlKind, id int64) (string, error) {
	if id == 0 {
		return "", nil
	}
	row := w.st.row(syncKinds[kind], id)
	if row == nil {
		return "", notFound(kind, id)
	}
	return row.SyncID, nil
}

var syncKinds = map[agentrewire.CtlKind]string{
	agentrewire.CtlKind_CTL_KIND_AGENT:      sync_entity.KindAgent,
	agentrewire.CtlKind_CTL_KIND_DEPARTMENT: sync_entity.KindDepartment,
	agentrewire.CtlKind_CTL_KIND_PROJECT:    sync_entity.KindProject,
	agentrewire.CtlKind_CTL_KIND_PROVIDER:   sync_entity.KindLLMProvider,
	agentrewire.CtlKind_CTL_KIND_BACKEND:    sync_entity.KindAgentBackend,
}

// cascadeImpact 是级联删除一个部门会连带删除的子部门（不含它自己）与 Agent（子树部门
// 上的顶层 Agent 连同它们的下级 Agent），与桌面端 department_svc 的级联同一口径。
func (st *state) cascadeImpact(deptSyncID string) (depts, agents []*sync_entity.SyncObject) {
	childDepts := map[string][]*sync_entity.SyncObject{}
	for _, d := range st.byKind[sync_entity.KindDepartment] {
		parent := st.departmentPayload(d).ParentSyncID
		childDepts[parent] = append(childDepts[parent], d)
	}
	inTree := map[string]bool{deptSyncID: true}
	var walkDept func(id string)
	walkDept = func(id string) {
		for _, c := range childDepts[id] {
			if !inTree[c.SyncID] {
				inTree[c.SyncID] = true
				depts = append(depts, c)
				walkDept(c.SyncID)
			}
		}
	}
	walkDept(deptSyncID)

	childAgents := map[string][]*sync_entity.SyncObject{}
	for _, a := range st.byKind[sync_entity.KindAgent] {
		parent := st.agentPayload(a).ParentAgentSyncID
		childAgents[parent] = append(childAgents[parent], a)
	}
	seen := map[string]bool{}
	var walkAgent func(a *sync_entity.SyncObject)
	walkAgent = func(a *sync_entity.SyncObject) {
		if seen[a.SyncID] {
			return
		}
		seen[a.SyncID] = true
		agents = append(agents, a)
		for _, c := range childAgents[a.SyncID] {
			walkAgent(c)
		}
	}
	for _, a := range st.byKind[sync_entity.KindAgent] {
		p := st.agentPayload(a)
		if p.ParentAgentSyncID == "" && inTree[p.DepartmentSyncID] {
			walkAgent(a)
		}
	}
	return depts, agents
}

// departmentWithin 判 start 是不是 root 自己或它的某个后代：沿 start 的父链往上爬，
// 碰到 root 即是（桌面端 department_svc.hasCycle 同口径）。数据里已有环时不会转不出来。
func (st *state) departmentWithin(start, root string) bool {
	seen := map[string]bool{}
	for cur := start; cur != "" && !seen[cur]; {
		if cur == root {
			return true
		}
		seen[cur] = true
		row, ok := st.bySync[cur]
		if !ok || row.Kind != sync_entity.KindDepartment {
			return false
		}
		cur = st.departmentPayload(row).ParentSyncID
	}
	return false
}

// systemAgent 是账号里那一个系统 Agent（载荷 system_badge 非空，同 workspace_svc 的判据）。
func (st *state) systemAgent() *sync_entity.SyncObject {
	for _, a := range st.byKind[sync_entity.KindAgent] {
		if strings.TrimSpace(st.agentPayload(a).SystemBadge) != "" {
			return a
		}
	}
	return nil
}

// hasSubProjects 判一个项目下还有没有存活的子项目（state 里只有存活行）。
func (st *state) hasSubProjects(projectSyncID string) bool {
	return len(workspace_svc.ProjectChildren(st.byKind[sync_entity.KindProject])[projectSyncID]) > 0
}
