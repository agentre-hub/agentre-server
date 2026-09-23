package ctl_svc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/agentre-hub/agentre/pkg/syncwire"
	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/engine_svc"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// 写网关：把合并好的文档翻译成 workspace_svc / engine_svc 现有写路径的入参。update
// 只送值真的变了的键（这两条写路径都是「缺席即不改」）；服务层的错误原样上抛。

func (st *state) agentPayload(r *sync_entity.SyncObject) syncwire.AgentPayload {
	var p syncwire.AgentPayload
	_ = json.Unmarshal([]byte(r.Payload), &p)
	return p
}

func (st *state) departmentPayload(r *sync_entity.SyncObject) syncwire.DepartmentPayload {
	var p syncwire.DepartmentPayload
	_ = json.Unmarshal([]byte(r.Payload), &p)
	return p
}

// changed 判一个字段在这次写入里是否要落：create 时列出即落，update 时还要值真的变了。
func (w *kindWrite) changed(field string, differs bool) bool {
	return w.fields[field] && (w.cur == nil || differs)
}

func (w *kindWrite) org(ctx context.Context, op, kind, syncID string, fields map[string]any) (*workspace_svc.OrgWriteResult, error) {
	in := workspace_svc.OrgWriteInput{UserID: w.st.userID, Kind: kind, SyncID: syncID, Fields: fields}
	switch op {
	case "create":
		return w.s.orgWriter().CreateOrgObject(ctx, in)
	case "update":
		return w.s.orgWriter().UpdateOrgObject(ctx, in)
	default:
		return w.s.orgWriter().DeleteOrgObject(ctx, in)
	}
}

// rowIDOf 取服务端新建那一行的 ctl id。
func (w *kindWrite) rowIDOf(ctx context.Context, syncID string) (int64, error) {
	row, err := sync_repo.SyncObject().Find(ctx, w.st.userID, syncID)
	if err != nil {
		return 0, err
	}
	if row == nil {
		return 0, fmt.Errorf("ctl_svc: created row %s not found", syncID)
	}
	return row.ID, nil
}

// ---- agents ----

func (w *kindWrite) agent(ctx context.Context) (int64, error) {
	if w.op() == agentrewire.CtlOp_CTL_OP_DELETE {
		_, err := w.org(ctx, "delete", sync_entity.KindAgent, w.st.byID[w.cur.GetAgent().GetId()].SyncID, nil)
		return w.cur.GetAgent().GetId(), err
	}
	cur, next := w.cur.GetAgent(), w.next.GetAgent()
	m := map[string]any{}
	if w.changed("name", cur.GetName() != next.GetName()) || w.cur == nil {
		m["name"] = next.GetName()
	}
	if w.changed("description", cur.GetDescription() != next.GetDescription()) {
		m["description"] = next.GetDescription()
	}
	if w.changed("avatarColor", cur.GetAvatarColor() != next.GetAvatarColor()) {
		m["avatar_color"] = next.GetAvatarColor()
	}
	if w.changed("avatarIcon", cur.GetAvatarIcon() != next.GetAvatarIcon()) {
		m["avatar_icon"] = next.GetAvatarIcon()
	}
	if w.changed("pinned", cur.GetPinned() != next.GetPinned()) {
		m["pinned"] = next.GetPinned()
	}
	if w.changed("departmentId", cur.GetDepartmentId() != next.GetDepartmentId()) {
		dept, err := w.syncOf(agentrewire.CtlKind_CTL_KIND_DEPARTMENT, next.GetDepartmentId())
		if err != nil {
			return 0, err
		}
		m["department_sync_id"] = dept
		if dept != "" {
			// 部门与上级 Agent 是归属的二选一：挂到部门上就不再是谁的下级。
			m["parent_agent_sync_id"] = ""
		}
	}
	var backends []string
	if w.fields["backendIds"] {
		for _, id := range next.GetBackendIds() {
			sid, err := w.syncOf(agentrewire.CtlKind_CTL_KIND_BACKEND, id)
			if err != nil {
				return 0, err
			}
			backends = appendUnique(backends, sid)
		}
	}

	var agentSync string
	var id int64
	if w.cur == nil {
		res, err := w.org(ctx, "create", sync_entity.KindAgent, "", m)
		if err != nil {
			return 0, err
		}
		if id, err = w.rowIDOf(ctx, res.SyncID); err != nil {
			return 0, err
		}
		agentSync = res.SyncID
	} else {
		id, agentSync = cur.GetId(), w.st.byID[cur.GetId()].SyncID
		if len(m) > 0 {
			if _, err := w.org(ctx, "update", sync_entity.KindAgent, agentSync, m); err != nil {
				return 0, err
			}
		}
	}
	if w.fields["backendIds"] && (w.cur == nil || !equalIDs(cur.GetBackendIds(), next.GetBackendIds())) {
		if err := w.setExecTargets(ctx, agentSync, backends); err != nil {
			return id, err
		}
	}
	return id, nil
}

// setExecTargets 把 Agent 的执行目标链改成 backends 这个次序：删掉不再要的档、补上
// 新的档，再按顺序排一次。已有的档（连同它的技能授权）原样留着。
func (w *kindWrite) setExecTargets(ctx context.Context, agentSync string, backends []string) error {
	have := map[string]bool{}
	for _, row := range w.st.execTargetsOf(agentSync) {
		b := sync_entity.ExecTargetBackendSyncID(row.Payload)
		if !containsStr(backends, b) {
			if _, err := w.org(ctx, "delete", sync_entity.KindAgentExecTarget, row.SyncID, nil); err != nil {
				return err
			}
			continue
		}
		have[b] = true
	}
	for i, b := range backends {
		if have[b] {
			continue
		}
		if _, err := w.org(ctx, "create", sync_entity.KindAgentExecTarget, "", map[string]any{
			"agent_sync_id": agentSync, "backend_sync_id": b, "sort_order": i,
		}); err != nil {
			return err
		}
	}
	if len(backends) == 0 {
		return nil
	}
	return w.s.orgWriter().SetExecTargetOrder(ctx, workspace_svc.SetExecTargetOrderInput{
		UserID: w.st.userID, AgentSyncID: agentSync, BackendSyncIDs: backends,
	})
}

// ---- departments ----

func (w *kindWrite) department(ctx context.Context) (int64, error) {
	if w.op() == agentrewire.CtlOp_CTL_OP_DELETE {
		return w.cur.GetDepartment().GetId(), w.deleteDepartment(ctx)
	}
	cur, next := w.cur.GetDepartment(), w.next.GetDepartment()
	m := map[string]any{}
	if w.changed("name", cur.GetName() != next.GetName()) || w.cur == nil {
		m["name"] = next.GetName()
	}
	if w.changed("description", cur.GetDescription() != next.GetDescription()) {
		m["description"] = next.GetDescription()
	}
	if w.changed("icon", cur.GetIcon() != next.GetIcon()) {
		m["icon"] = next.GetIcon()
	}
	if w.changed("accentColor", cur.GetAccentColor() != next.GetAccentColor()) {
		m["accent_color"] = next.GetAccentColor()
	}
	if w.changed("parentId", cur.GetParentId() != next.GetParentId()) {
		sid, err := w.syncOf(agentrewire.CtlKind_CTL_KIND_DEPARTMENT, next.GetParentId())
		if err != nil {
			return 0, err
		}
		if w.cur != nil && sid == w.st.byID[cur.GetId()].SyncID {
			return 0, badRequest("a department cannot be its own parent")
		}
		m["parent_sync_id"] = sid
	}
	if w.changed("leadAgentId", cur.GetLeadAgentId() != next.GetLeadAgentId()) {
		sid, err := w.syncOf(agentrewire.CtlKind_CTL_KIND_AGENT, next.GetLeadAgentId())
		if err != nil {
			return 0, err
		}
		m["lead_agent_sync_id"] = sid
	}
	if w.cur == nil {
		res, err := w.org(ctx, "create", sync_entity.KindDepartment, "", m)
		if err != nil {
			return 0, err
		}
		return w.rowIDOf(ctx, res.SyncID)
	}
	if len(m) > 0 {
		if _, err := w.org(ctx, "update", sync_entity.KindDepartment, w.st.byID[cur.GetId()].SyncID, m); err != nil {
			return 0, err
		}
	}
	return cur.GetId(), nil
}

// deleteDepartment：不级联时把直接子部门与挂在它上面的 Agent 上移到它的父部门；级联时
// 连同子树部门与其中的 Agent 一起删除（与桌面端的两种删除策略一致）。
func (w *kindWrite) deleteDepartment(ctx context.Context) error {
	row := w.st.byID[w.cur.GetDepartment().GetId()]
	if w.req.GetCascade() {
		depts, agents := w.st.cascadeImpact(row.SyncID)
		for _, a := range agents {
			if _, err := w.org(ctx, "delete", sync_entity.KindAgent, a.SyncID, nil); err != nil {
				return err
			}
		}
		for _, d := range depts {
			if _, err := w.org(ctx, "delete", sync_entity.KindDepartment, d.SyncID, nil); err != nil {
				return err
			}
		}
	} else {
		parent := w.st.departmentPayload(row).ParentSyncID
		for _, d := range w.st.byKind[sync_entity.KindDepartment] {
			if w.st.departmentPayload(d).ParentSyncID == row.SyncID {
				if _, err := w.org(ctx, "update", sync_entity.KindDepartment, d.SyncID, map[string]any{"parent_sync_id": parent}); err != nil {
					return err
				}
			}
		}
		for _, a := range w.st.byKind[sync_entity.KindAgent] {
			if w.st.agentPayload(a).DepartmentSyncID == row.SyncID {
				if _, err := w.org(ctx, "update", sync_entity.KindAgent, a.SyncID, map[string]any{"department_sync_id": parent}); err != nil {
					return err
				}
			}
		}
	}
	_, err := w.org(ctx, "delete", sync_entity.KindDepartment, row.SyncID, nil)
	return err
}

// ---- projects ----

func (w *kindWrite) project(ctx context.Context) (int64, error) {
	if w.op() == agentrewire.CtlOp_CTL_OP_DELETE {
		_, err := w.org(ctx, "delete", sync_entity.KindProject, w.st.byID[w.cur.GetProject().GetId()].SyncID, nil)
		return w.cur.GetProject().GetId(), err
	}
	cur, next := w.cur.GetProject(), w.next.GetProject()
	m := map[string]any{}
	if w.changed("name", cur.GetName() != next.GetName()) || w.cur == nil {
		m["name"] = next.GetName()
	}
	if w.changed("description", cur.GetDescription() != next.GetDescription()) {
		m["description"] = next.GetDescription()
	}
	if w.changed("icon", cur.GetIcon() != next.GetIcon()) {
		m["icon"] = next.GetIcon()
	}
	if w.changed("color", cur.GetColor() != next.GetColor()) {
		m["color"] = next.GetColor()
	}
	if w.changed("parentId", cur.GetParentId() != next.GetParentId()) {
		sid, err := w.syncOf(agentrewire.CtlKind_CTL_KIND_PROJECT, next.GetParentId())
		if err != nil {
			return 0, err
		}
		m["parent_sync_id"] = sid
	}
	var members []string
	for _, id := range next.GetMemberAgentIds() {
		sid, err := w.syncOf(agentrewire.CtlKind_CTL_KIND_AGENT, id)
		if err != nil {
			return 0, err
		}
		members = appendUnique(members, sid)
	}

	var id int64
	var projectSync string
	if w.cur == nil {
		res, err := w.org(ctx, "create", sync_entity.KindProject, "", m)
		if err != nil {
			return 0, err
		}
		if id, err = w.rowIDOf(ctx, res.SyncID); err != nil {
			return 0, err
		}
		projectSync = res.SyncID
	} else {
		id, projectSync = cur.GetId(), w.st.byID[cur.GetId()].SyncID
		if len(m) > 0 {
			if _, err := w.org(ctx, "update", sync_entity.KindProject, projectSync, m); err != nil {
				return 0, err
			}
		}
	}
	if w.fields["memberAgentIds"] {
		if err := w.setMembers(ctx, projectSync, members); err != nil {
			return id, err
		}
	}
	if w.changed("path", cur.GetPath() != next.GetPath()) {
		if err := w.setPath(ctx, projectSync, next.GetPath()); err != nil {
			return id, err
		}
	}
	return id, nil
}

// setMembers 把项目的直接成员改成 members：多的删、少的补。
func (w *kindWrite) setMembers(ctx context.Context, projectSync string, members []string) error {
	have := map[string]bool{}
	for _, row := range w.st.memberRows(projectSync) {
		agent := memberAgentSyncID(row)
		if !containsStr(members, agent) {
			if _, err := w.org(ctx, "delete", sync_entity.KindProjectAgent, row.SyncID, nil); err != nil {
				return err
			}
			continue
		}
		have[agent] = true
	}
	for _, agent := range members {
		if have[agent] {
			continue
		}
		if _, err := w.org(ctx, "create", sync_entity.KindProjectAgent, "", map[string]any{
			"project_sync_id": projectSync, "agent_sync_id": agent,
		}); err != nil {
			return err
		}
	}
	return nil
}

// setPath 设或清发起请求那台 agentred 上的项目路径（checkSupported 已挡住桌面设备）。
func (w *kindWrite) setPath(ctx context.Context, projectSync, path string) error {
	fp := w.st.callerFingerprint()
	if path == "" {
		row := w.st.locationRow(projectSync, fp)
		if row == nil {
			return nil
		}
		_, err := w.org(ctx, "delete", sync_entity.KindProjectLocation, row.SyncID, nil)
		return err
	}
	_, err := w.s.orgWriter().SetProjectLocation(ctx, workspace_svc.SetProjectLocationInput{
		UserID: w.st.userID, ProjectSyncID: projectSync, Fingerprint: fp, Path: path,
	})
	return err
}

// ---- providers ----

// stillReferenced 是删除仍被后端引用的提供方 / 模型而没带 --force。
func stillReferenced(kind agentrewire.CtlKind, name string, refs int32) error {
	return &Error{Status: http.StatusConflict, Msg: fmt.Sprintf(
		"%s %s is used by %s; pass --force to delete it anyway", kindNames[kind], name, plural(int(refs), "backend"))}
}

func (w *kindWrite) provider(ctx context.Context) (int64, error) {
	eng := w.s.engineWriter()
	if w.op() == agentrewire.CtlOp_CTL_OP_DELETE {
		p := w.cur.GetProvider()
		if p.GetBackendRefs() > 0 && !w.req.GetForce() {
			return 0, stillReferenced(agentrewire.CtlKind_CTL_KIND_PROVIDER, p.GetName(), p.GetBackendRefs())
		}
		return p.GetId(), eng.DeleteProvider(ctx, w.st.userID, w.st.byID[p.GetId()].SyncID)
	}
	cur, next := w.cur.GetProvider(), w.next.GetProvider()
	in := engine_svc.ProviderWriteInput{UserID: w.st.userID}
	if w.changed("name", cur.GetName() != next.GetName()) {
		in.Name = ptr(next.GetName())
	}
	if w.changed("type", cur.GetType() != next.GetType()) {
		in.Type = ptr(next.GetType())
	}
	if w.changed("baseUrl", cur.GetBaseUrl() != next.GetBaseUrl()) {
		in.BaseURL = ptr(next.GetBaseUrl())
	}
	if w.changed("enabled", cur.GetEnabled() != next.GetEnabled()) {
		in.Enabled = ptr(next.GetEnabled())
	}
	if w.changed("defaultModelKey", cur.GetDefaultModelKey() != next.GetDefaultModelKey()) {
		in.DefaultModelKey = ptr(next.GetDefaultModelKey())
	}
	if w.fields["apiKey"] && next.GetApiKey() != "" {
		in.APIKey = ptr(next.GetApiKey())
	}
	if w.cur == nil {
		view, err := eng.CreateProvider(ctx, in)
		if err != nil {
			return 0, err
		}
		return w.rowIDOf(ctx, view.ProviderKey)
	}
	in.ProviderKey = w.st.byID[cur.GetId()].SyncID
	_, err := eng.UpdateProvider(ctx, in)
	return cur.GetId(), err
}

// ---- models ----

func (w *kindWrite) model(ctx context.Context) (int64, error) {
	eng := w.s.engineWriter()
	if w.op() == agentrewire.CtlOp_CTL_OP_DELETE {
		m := w.cur.GetModel()
		if m.GetBackendRefs() > 0 && !w.req.GetForce() {
			return 0, stillReferenced(agentrewire.CtlKind_CTL_KIND_MODEL, w.st.label(w.cur), m.GetBackendRefs())
		}
		ref := w.st.modelByID(m.GetId())
		_, err := eng.DeleteProviderModel(ctx, w.st.userID, ref.provider.SyncID, ref.key)
		return m.GetId(), err
	}
	cur, next := w.cur.GetModel(), w.next.GetModel()
	in := engine_svc.ModelWriteInput{UserID: w.st.userID}
	if w.changed("modelId", cur.GetModelId() != next.GetModelId()) {
		in.ModelID = ptr(next.GetModelId())
	}
	if w.changed("name", cur.GetName() != next.GetName()) {
		in.Name = ptr(next.GetName())
	}
	if w.changed("enabled", cur.GetEnabled() != next.GetEnabled()) {
		in.Enabled = ptr(next.GetEnabled())
	}
	if w.changed("contextWindow", cur.GetContextWindow() != next.GetContextWindow()) {
		in.ContextWindow = ptr(next.GetContextWindow())
	}
	if w.changed("maxOutput", cur.GetMaxOutput() != next.GetMaxOutput()) {
		in.MaxOutput = ptr(next.GetMaxOutput())
	}
	var id int64
	if w.cur == nil {
		providerSync, err := w.syncOf(agentrewire.CtlKind_CTL_KIND_PROVIDER, next.GetProviderId())
		if err != nil {
			return 0, err
		}
		if providerSync == "" {
			return 0, badRequest("model needs a provider")
		}
		in.ProviderKey, in.ModelKey = providerSync, w.s.newKey()
		if _, err := eng.CreateProviderModel(ctx, in); err != nil {
			return 0, err
		}
		id = modelID(providerSync, in.ModelKey)
	} else {
		ref := w.st.modelByID(cur.GetId())
		in.ProviderKey, in.ModelKey, id = ref.provider.SyncID, ref.key, cur.GetId()
		if in.ModelID != nil || in.Name != nil || in.Enabled != nil || in.ContextWindow != nil || in.MaxOutput != nil {
			if _, err := eng.UpdateProviderModel(ctx, in); err != nil {
				return id, err
			}
		}
	}
	if w.changed("isDefault", cur.GetIsDefault() != next.GetIsDefault()) && (next.GetIsDefault() || w.cur != nil) {
		key := ""
		if next.GetIsDefault() {
			key = in.ModelKey
		}
		if _, err := eng.UpdateProvider(ctx, engine_svc.ProviderWriteInput{
			UserID: w.st.userID, ProviderKey: in.ProviderKey, DefaultModelKey: &key,
		}); err != nil {
			return id, err
		}
	}
	return id, nil
}

// ---- backends ----

func (w *kindWrite) backend(ctx context.Context) (int64, error) {
	eng := w.s.engineWriter()
	if w.op() == agentrewire.CtlOp_CTL_OP_DELETE {
		b := w.cur.GetBackend()
		return b.GetId(), eng.DeleteBackend(ctx, w.st.userID, w.st.byID[b.GetId()].SyncID)
	}
	cur, next := w.cur.GetBackend(), w.next.GetBackend()
	in := engine_svc.BackendWriteInput{UserID: w.st.userID}
	if w.changed("name", cur.GetName() != next.GetName()) {
		in.Name = ptr(next.GetName())
	}
	if w.changed("type", cur.GetType() != next.GetType()) {
		in.Type = ptr(next.GetType())
	}
	if w.changed("reasoningEffort", cur.GetReasoningEffort() != next.GetReasoningEffort()) {
		in.ReasoningEffort = ptr(next.GetReasoningEffort())
	}
	if w.changed("cliPath", cur.GetCliPath() != next.GetCliPath()) {
		in.CLIPath = ptr(next.GetCliPath())
	}
	if w.changed("configJson", cur.GetConfigJson() != next.GetConfigJson()) {
		in.Config = json.RawMessage(next.GetConfigJson())
	}
	if w.changed("env", !equalEnv(cur.GetEnv(), next.GetEnv())) {
		env := next.GetEnv()
		if env == nil {
			env = map[string]string{}
		}
		raw, err := json.Marshal(env)
		if err != nil {
			return 0, err
		}
		in.EnvJSON = ptr(string(raw))
	}
	if w.changed("providerId", cur.GetProviderId() != next.GetProviderId()) ||
		w.changed("modelId", cur.GetModelId() != next.GetModelId()) {
		providerSync, err := w.syncOf(agentrewire.CtlKind_CTL_KIND_PROVIDER, next.GetProviderId())
		if err != nil {
			return 0, err
		}
		modelKey := ""
		if next.GetModelId() != 0 {
			ref := w.st.modelByID(next.GetModelId())
			if ref == nil {
				return 0, notFound(agentrewire.CtlKind_CTL_KIND_MODEL, next.GetModelId())
			}
			if ref.provider.SyncID != providerSync {
				return 0, badRequest("model %s does not belong to the backend's provider", ref.model.ModelID)
			}
			modelKey = ref.key
		}
		in.ProviderKey, in.ModelKey = &providerSync, &modelKey
	}
	// 运行设备在 engine_svc 的每次写入里都是必填：没改就沿用它现在绑定的那台。
	var fp string
	if w.cur == nil || w.fields["device"] {
		var err error
		if fp, err = w.st.resolveDevice(next.GetDevice()); err != nil {
			return 0, err
		}
	} else {
		fp = w.st.byID[cur.GetId()].AgentredFingerprint
	}
	in.DeviceFingerprint = &fp
	if w.cur == nil {
		view, err := eng.CreateBackend(ctx, in)
		if err != nil {
			return 0, err
		}
		return w.rowIDOf(ctx, view.SyncID)
	}
	in.SyncID = w.st.byID[cur.GetId()].SyncID
	_, err := eng.UpdateBackend(ctx, in)
	return cur.GetId(), err
}

// ---- helpers ----

func ptr[T any](v T) *T { return &v }

func appendUnique(list []string, v string) []string {
	if containsStr(list, v) {
		return list
	}
	return append(list, v)
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func equalIDs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalEnv(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}
