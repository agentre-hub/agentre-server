package ctl_svc

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"sort"
	"strings"

	"github.com/agentre-hub/agentre/pkg/syncwire"
	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/google/uuid"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
)

// readKinds 是一次读要取的全部同步组类型：五类资源本身，加上它们的关联行（执行目标、
// 项目成员、项目路径、后端的每设备 CLI 覆盖）。
var readKinds = []string{
	sync_entity.KindDepartment, sync_entity.KindAgent, sync_entity.KindAgentExecTarget,
	sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	sync_entity.KindLLMProvider, sync_entity.KindAgentBackend, sync_entity.KindAgentBackendCLI,
}

// modelRef 是提供方载荷里的一个模型，连同它派生出来的 ctl id。
type modelRef struct {
	id       int64
	provider *sync_entity.SyncObject
	key      string
	model    syncwire.LLMProviderModel
}

// state 是一次请求读到的账号快照：同步组的存活行、设备，以及由它们建出的索引。
type state struct {
	userID  int64
	caller  *device_entity.Device
	devices []*device_entity.Device
	byKind  map[string][]*sync_entity.SyncObject
	byID    map[int64]*sync_entity.SyncObject
	bySync  map[string]*sync_entity.SyncObject
	models  []modelRef
}

// loadState 读一次账号快照。调用方设备必须属于这个账号且仍在用（鉴权已经判过，这里
// 取的是它的指纹与类型）。
func loadState(ctx context.Context, caller Caller) (*state, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, caller.UserID, readKinds)
	if err != nil {
		return nil, err
	}
	devices, err := device_repo.Device().ListByUser(ctx, caller.UserID)
	if err != nil {
		return nil, err
	}
	st := &state{
		userID: caller.UserID, byKind: map[string][]*sync_entity.SyncObject{},
		byID: map[int64]*sync_entity.SyncObject{}, bySync: map[string]*sync_entity.SyncObject{},
	}
	for _, d := range devices {
		if !d.IsActive() {
			continue
		}
		st.devices = append(st.devices, d)
		if d.ID == caller.DeviceID {
			st.caller = d
		}
	}
	for _, row := range rows {
		if row.IsDeleted() {
			continue
		}
		st.byKind[row.Kind] = append(st.byKind[row.Kind], row)
		st.byID[row.ID] = row
		st.bySync[row.SyncID] = row
	}
	for _, kind := range readKinds {
		sort.Slice(st.byKind[kind], func(i, j int) bool { return st.byKind[kind][i].ID < st.byKind[kind][j].ID })
	}
	for _, p := range st.byKind[sync_entity.KindLLMProvider] {
		var payload syncwire.LLMProviderPayload
		if json.Unmarshal([]byte(p.Payload), &payload) != nil {
			continue
		}
		for _, m := range payload.Models {
			if m.ModelKey == "" {
				continue
			}
			st.models = append(st.models, modelRef{id: modelID(p.SyncID, m.ModelKey), provider: p, key: m.ModelKey, model: m})
		}
	}
	return st, nil
}

// modelID 给模型派生一个稳定的 ctl id：模型住在提供方载荷里，没有自己的行。取
// sha256(提供方同步标识, ModelKey) 的高 53 位，JSON 数字也不会丢精度。
func modelID(providerSyncID, modelKey string) int64 {
	sum := sha256.Sum256([]byte(providerSyncID + "\x00" + modelKey))
	return int64(binary.BigEndian.Uint64(sum[:8]) >> 11)
}

func newModelKey() string { return uuid.NewString() }

// callerFingerprint 是「本机」在 server 路径上的含义：发起请求的那台机器。
func (st *state) callerFingerprint() string {
	if st.caller == nil {
		return ""
	}
	return st.caller.Fingerprint
}

// idOf 把一个同步标识换成 ctl id；空串或指向不存在的行都是 0。
func (st *state) idOf(syncID string) int64 {
	if syncID == "" {
		return 0
	}
	if row, ok := st.bySync[syncID]; ok {
		return row.ID
	}
	return 0
}

// row 按 ctl id 取一类资源的行。
func (st *state) row(kind string, id int64) *sync_entity.SyncObject {
	row, ok := st.byID[id]
	if !ok || row.Kind != kind {
		return nil
	}
	return row
}

func (st *state) modelByID(id int64) *modelRef {
	for i := range st.models {
		if st.models[i].id == id {
			return &st.models[i]
		}
	}
	return nil
}

func (st *state) modelByKey(providerSyncID, key string) *modelRef {
	for i := range st.models {
		if st.models[i].provider.SyncID == providerSyncID && st.models[i].key == key {
			return &st.models[i]
		}
	}
	return nil
}

// deviceName 是一台设备在变更清单与后端文档里的名字：用户起的备注名优先，其次是
// 自报主机名；账号里查不到的指纹原样给出。
func (st *state) deviceName(fingerprint string) string {
	for _, d := range st.devices {
		if d.Fingerprint == fingerprint {
			if strings.TrimSpace(d.DisplayName) != "" {
				return d.DisplayName
			}
			return device_entity.DisplayName(d.Name, d.Fingerprint)
		}
	}
	return fingerprint
}

// resolveDevice 把后端的 device 字段解析成指纹：空串是发起请求的这台机器；否则先按
// 指纹精确匹配，再按名字匹配，名字撞了就是歧义。
func (st *state) resolveDevice(device string) (string, error) {
	device = strings.TrimSpace(device)
	if device == "" {
		if fp := st.callerFingerprint(); fp != "" {
			return fp, nil
		}
		return "", badRequest("backend device is required")
	}
	for _, d := range st.devices {
		if d.Fingerprint == device {
			return d.Fingerprint, nil
		}
	}
	var hits []string
	for _, d := range st.devices {
		if st.deviceName(d.Fingerprint) == device || d.Name == device {
			hits = append(hits, d.Fingerprint)
		}
	}
	switch len(hits) {
	case 1:
		return hits[0], nil
	case 0:
		return "", &Error{Status: 404, Msg: "device " + device + " not found in this account"}
	default:
		return "", badRequest("device name %q is ambiguous; use the device fingerprint", device)
	}
}

// ---- 读：五类资源的文档 ----

func (st *state) list(kind agentrewire.CtlKind) ([]*agentrewire.CtlResource, error) {
	var out []*agentrewire.CtlResource
	switch kind {
	case agentrewire.CtlKind_CTL_KIND_AGENT:
		for _, r := range st.byKind[sync_entity.KindAgent] {
			out = append(out, &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Agent{Agent: st.agentDoc(r)}})
		}
	case agentrewire.CtlKind_CTL_KIND_DEPARTMENT:
		for _, r := range st.byKind[sync_entity.KindDepartment] {
			out = append(out, &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Department{Department: st.departmentDoc(r)}})
		}
	case agentrewire.CtlKind_CTL_KIND_PROJECT:
		for _, r := range st.byKind[sync_entity.KindProject] {
			out = append(out, &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Project{Project: st.projectDoc(r)}})
		}
	case agentrewire.CtlKind_CTL_KIND_PROVIDER:
		for _, r := range st.byKind[sync_entity.KindLLMProvider] {
			out = append(out, &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Provider{Provider: st.providerDoc(r)}})
		}
	case agentrewire.CtlKind_CTL_KIND_MODEL:
		for i := range st.models {
			out = append(out, &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Model{Model: st.modelDoc(&st.models[i])}})
		}
	case agentrewire.CtlKind_CTL_KIND_BACKEND:
		for _, r := range st.byKind[sync_entity.KindAgentBackend] {
			out = append(out, &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: st.backendDoc(r)}})
		}
	default:
		return nil, badRequest("unknown resource kind %s", kind)
	}
	return out, nil
}

func (st *state) get(kind agentrewire.CtlKind, id int64) (*agentrewire.CtlResource, error) {
	items, err := st.list(kind)
	if err != nil {
		return nil, err
	}
	for _, it := range items {
		if resourceID(it) == id {
			return it, nil
		}
	}
	return nil, notFound(kind, id)
}

func (st *state) agentDoc(r *sync_entity.SyncObject) *agentrewire.CtlAgent {
	var p syncwire.AgentPayload
	_ = json.Unmarshal([]byte(r.Payload), &p)
	return &agentrewire.CtlAgent{
		Id: r.ID, Name: p.Name, Description: p.Description, DepartmentId: st.idOf(p.DepartmentSyncID),
		BackendIds: st.agentBackendIDs(r.SyncID), Pinned: p.Pinned,
		AvatarColor: p.AvatarColor, AvatarIcon: p.AvatarIcon, SystemBadge: p.SystemBadge,
	}
}

// execTargetsOf 是一个 Agent 的执行目标行，按链上次序（sort_order，平局按行 id）。
func (st *state) execTargetsOf(agentSyncID string) []*sync_entity.SyncObject {
	type target struct {
		row   *sync_entity.SyncObject
		order int
	}
	var ts []target
	for _, r := range st.byKind[sync_entity.KindAgentExecTarget] {
		var p syncwire.AgentExecTargetPayload
		if json.Unmarshal([]byte(r.Payload), &p) != nil || p.AgentSyncID != agentSyncID {
			continue
		}
		ts = append(ts, target{row: r, order: p.SortOrder})
	}
	sort.SliceStable(ts, func(i, j int) bool { return ts[i].order < ts[j].order })
	out := make([]*sync_entity.SyncObject, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.row)
	}
	return out
}

func (st *state) agentBackendIDs(agentSyncID string) []int64 {
	var out []int64
	for _, r := range st.execTargetsOf(agentSyncID) {
		if id := st.idOf(sync_entity.ExecTargetBackendSyncID(r.Payload)); id != 0 {
			out = append(out, id)
		}
	}
	return out
}

func (st *state) departmentDoc(r *sync_entity.SyncObject) *agentrewire.CtlDepartment {
	var p syncwire.DepartmentPayload
	_ = json.Unmarshal([]byte(r.Payload), &p)
	return &agentrewire.CtlDepartment{
		Id: r.ID, Name: p.Name, Description: p.Description, Icon: p.Icon, AccentColor: p.AccentColor,
		ParentId: st.idOf(p.ParentSyncID), LeadAgentId: st.idOf(p.LeadAgentSyncID),
	}
}

// memberRows 是一个项目的直接成员关系行。
func (st *state) memberRows(projectSyncID string) []*sync_entity.SyncObject {
	var out []*sync_entity.SyncObject
	for _, r := range st.byKind[sync_entity.KindProjectAgent] {
		var p syncwire.ProjectAgentPayload
		if json.Unmarshal([]byte(r.Payload), &p) == nil && p.ProjectSyncID == projectSyncID {
			out = append(out, r)
		}
	}
	return out
}

func memberAgentSyncID(r *sync_entity.SyncObject) string {
	var p syncwire.ProjectAgentPayload
	_ = json.Unmarshal([]byte(r.Payload), &p)
	return p.AgentSyncID
}

// locationRow 是这个项目在某台 agentred 上的路径行。
func (st *state) locationRow(projectSyncID, fingerprint string) *sync_entity.SyncObject {
	if fingerprint == "" {
		return nil
	}
	for _, r := range st.byKind[sync_entity.KindProjectLocation] {
		if r.ScopeSyncID == projectSyncID && r.AgentredFingerprint == fingerprint {
			return r
		}
	}
	return nil
}

func locationPath(r *sync_entity.SyncObject) string {
	if r == nil {
		return ""
	}
	var p syncwire.ProjectLocationPayload
	_ = json.Unmarshal([]byte(r.Payload), &p)
	return p.Path
}

// projectDoc：path 是发起请求那台 agentred 上的路径（server 路径上的「本机」）；
// locations 是同步组里各台 agentred 的路径——桌面端的本机路径住在上报组，不在这里。
func (st *state) projectDoc(r *sync_entity.SyncObject) *agentrewire.CtlProject {
	var p syncwire.ProjectPayload
	_ = json.Unmarshal([]byte(r.Payload), &p)
	doc := &agentrewire.CtlProject{
		Id: r.ID, ParentId: st.idOf(p.ParentSyncID), Name: p.Name, Icon: p.Icon, Color: p.Color,
		Description: p.Description, Path: locationPath(st.locationRow(r.SyncID, st.callerFingerprint())),
	}
	for _, m := range st.memberRows(r.SyncID) {
		if id := st.idOf(memberAgentSyncID(m)); id != 0 {
			doc.MemberAgentIds = append(doc.MemberAgentIds, id)
		}
	}
	for _, l := range st.byKind[sync_entity.KindProjectLocation] {
		if l.ScopeSyncID != r.SyncID || l.AgentredFingerprint == "" {
			continue
		}
		doc.Locations = append(doc.Locations, &agentrewire.CtlProjectLocation{
			DeviceId: l.AgentredFingerprint, DeviceName: st.deviceName(l.AgentredFingerprint), Path: locationPath(l),
		})
	}
	return doc
}

// backendRefs 数引用某个提供方（modelKey 为空）或某个模型的后端。
func (st *state) backendRefs(providerSyncID, modelKey string) int32 {
	var n int32
	for _, r := range st.byKind[sync_entity.KindAgentBackend] {
		var p syncwire.AgentBackendPayload
		if json.Unmarshal([]byte(r.Payload), &p) != nil || p.ProviderKey != providerSyncID {
			continue
		}
		if modelKey == "" || p.ModelKey == modelKey {
			n++
		}
	}
	return n
}

// providerDoc：API key 在这里就只剩掩码，明文不出这个函数。
func (st *state) providerDoc(r *sync_entity.SyncObject) *agentrewire.CtlProvider {
	var p syncwire.LLMProviderPayload
	_ = json.Unmarshal([]byte(r.Payload), &p)
	return &agentrewire.CtlProvider{
		Id: r.ID, Name: p.Name, Type: p.Type, BaseUrl: p.BaseURL, Enabled: p.Enabled,
		ApiKey: MaskSecret(p.APIKey), ApiKeySet: p.APIKey != "",
		DefaultModelKey: p.DefaultModelKey, BackendRefs: st.backendRefs(r.SyncID, ""),
	}
}

func (st *state) modelDoc(m *modelRef) *agentrewire.CtlModel {
	var p syncwire.LLMProviderPayload
	_ = json.Unmarshal([]byte(m.provider.Payload), &p)
	return &agentrewire.CtlModel{
		Id: m.id, ProviderId: m.provider.ID, Key: m.key, ModelId: m.model.ModelID, Name: m.model.Name,
		ContextWindow: int64(m.model.ContextWindow), MaxOutput: int64(m.model.MaxOutput),
		Enabled: m.model.Enabled, IsDefault: p.DefaultModelKey == m.key,
		BackendRefs: st.backendRefs(m.provider.SyncID, m.key),
	}
}

// overlayPath 是后端在它绑定那台机器上的 CLI 路径覆盖。
func (st *state) overlayPath(backendSyncID, fingerprint string) string {
	for _, r := range st.byKind[sync_entity.KindAgentBackendCLI] {
		if r.ScopeSyncID == backendSyncID && r.AgentredFingerprint == fingerprint {
			var o syncwire.AgentBackendCLIPayload
			_ = json.Unmarshal([]byte(r.Payload), &o)
			return o.CLIPath
		}
	}
	return ""
}

// backendTypeOpenClaw 是 OpenClaw 后端的 type 字面量（同步契约里的 AgentBackendPayload.Type），
// 与桌面端 agent_backend_entity.TypeOpenClaw 同值。
const backendTypeOpenClaw = "openclaw"

// backendDoc：OpenClaw token 住在绑定机器的钥匙串里，server 够不到，只能报 UNKNOWN；
// 没有 token 概念的后端类型报 UNSPECIFIED（同桌面端 openClawTokenState 的口径）。
func (st *state) backendDoc(r *sync_entity.SyncObject) *agentrewire.CtlBackend {
	var doc map[string]json.RawMessage
	_ = json.Unmarshal([]byte(r.Payload), &doc)
	str := func(key string) string {
		var v string
		_ = json.Unmarshal(doc[key], &v)
		return v
	}
	backendType := str("type")
	out := &agentrewire.CtlBackend{
		Id: r.ID, Name: str("name"), Type: backendType, ProviderId: st.idOf(str("provider_key")),
		Device: st.deviceName(r.AgentredFingerprint), CliPath: st.overlayPath(r.SyncID, r.AgentredFingerprint),
		ReasoningEffort: str("reasoning_effort"), ConfigJson: compactObject(doc["config"]),
		SyncId: r.SyncID, DeviceFingerprint: r.AgentredFingerprint,
		TokenState: backendTokenState(backendType),
	}
	if m := st.modelByKey(str("provider_key"), str("model_key")); m != nil {
		out.ModelId = m.id
	}
	env := map[string]string{}
	if raw := strings.TrimSpace(str("env_json")); raw != "" && json.Unmarshal([]byte(raw), &env) == nil && len(env) > 0 {
		out.Env = env
	}
	return out
}

// backendTokenState 报后端 token 的状态。OpenClaw token 存在绑定设备的钥匙串里，server
// 端只有同步过来的文档，够不到那台设备，因此恒报 UNKNOWN；其它类型没有 token 概念，报
// UNSPECIFIED。
func backendTokenState(backendType string) agentrewire.CtlTokenState {
	if backendType != backendTypeOpenClaw {
		return agentrewire.CtlTokenState_CTL_TOKEN_STATE_UNSPECIFIED
	}
	return agentrewire.CtlTokenState_CTL_TOKEN_STATE_UNKNOWN
}

// compactObject 把后端 config 原文收成紧凑 JSON；不是对象（含缺席）读作 {}。
func compactObject(raw json.RawMessage) string {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return "{}"
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return "{}"
	}
	return string(out)
}

func resourceID(r *agentrewire.CtlResource) int64 {
	switch d := r.GetDoc().(type) {
	case *agentrewire.CtlResource_Agent:
		return d.Agent.GetId()
	case *agentrewire.CtlResource_Department:
		return d.Department.GetId()
	case *agentrewire.CtlResource_Project:
		return d.Project.GetId()
	case *agentrewire.CtlResource_Provider:
		return d.Provider.GetId()
	case *agentrewire.CtlResource_Model:
		return d.Model.GetId()
	case *agentrewire.CtlResource_Backend:
		return d.Backend.GetId()
	}
	return 0
}

// maskBullets 是掩码中间的圆点数，与桌面端 ctl_svc.MaskSecret 同形。
const maskBullets = 6

// MaskSecret 把密钥收成「前 4 位、圆点、后 4 位」；8 位以内全部换成圆点。按 rune 计。
func MaskSecret(s string) string {
	if s == "" {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= 8 {
		return strings.Repeat("•", len(runes))
	}
	return string(runes[:4]) + strings.Repeat("•", maskBullets) + string(runes[len(runes)-4:])
}
