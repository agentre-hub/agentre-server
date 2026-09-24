// Package engine_svc 管理账号级 LLM 供应商、后端身份与每设备 CLI 覆盖。
package engine_svc

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/agentre-hub/agentre/pkg/syncwire"
	"github.com/cago-frame/cago/pkg/i18n"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

type Model struct {
	ModelKey      string `json:"model_key"`
	ModelID       string `json:"model_id"`
	Name          string `json:"name"`
	Enabled       bool   `json:"enabled"`
	ContextWindow *int64 `json:"context_window,omitempty"`
	MaxOutput     *int64 `json:"max_output,omitempty"`
}

type ProviderView struct {
	ProviderKey     string  `json:"provider_key"`
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	BaseURL         string  `json:"base_url"`
	MaskedTail      string  `json:"masked_tail"`
	DefaultModelKey string  `json:"default_model_key"`
	Enabled         bool    `json:"enabled"`
	Models          []Model `json:"models"`
}

type ProviderSnapshot struct {
	ProviderKey     string  `json:"provider_key"`
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	BaseURL         string  `json:"base_url"`
	APIKey          string  `json:"api_key"`
	DefaultModelKey string  `json:"default_model_key"`
	Models          []Model `json:"models"`
}

type ProviderWriteInput struct {
	UserID          int64
	ProviderKey     string
	Name            *string
	Type            *string
	BaseURL         *string
	APIKey          *string
	DefaultModelKey *string
	Models          *[]Model
	Enabled         *bool
}

type BackendWriteInput struct {
	UserID      int64
	SyncID      string
	Name        *string
	Type        *string
	ProviderKey *string
	ModelKey    *string
	// Config 是后端的单类型独占设置（syncwire.AgentBackendConfig 那张键表的 JSON 对象）。
	// 给了就整体替换存着的 config；为空（请求里没有这个字段）表示这次不改。
	Config json.RawMessage
	// EnvJSON 给了就是整表覆写（与桌面端同语义：编辑器读进 entries、保存序列化回来）；
	// nil 表示这次不改，存着的表原样保留。
	EnvJSON         *string
	ReasoningEffort *string
	CLIPath         *string
	// DeviceFingerprint 是这个后端的运行设备指纹（决策 5：必填）。它落在既有列
	// sync_objects.agentred_fingerprint 上，不是 agent_backend 载荷里的一个键。
	DeviceFingerprint *string
}

type CLIByDevice struct {
	Fingerprint string `json:"fingerprint"`
	Status      string `json:"status"`
}

type BackendView struct {
	SyncID          string `json:"sync_id"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	ProviderKey     string `json:"provider_key"`
	ModelKey        string `json:"model_key"`
	EnvJSON         string `json:"env_json"`
	ReasoningEffort string `json:"reasoning_effort"`
	// Config 是存着的 config 对象原文；旧平铺格式的行没有它，读作 {}。
	Config      json.RawMessage `json:"config"`
	RefCount    int             `json:"ref_count"`
	CLIByDevice []CLIByDevice   `json:"cli_by_device"`
	// DeviceFingerprint 读自 sync_objects.agentred_fingerprint。agent_backend 这一 kind 不在
	// 上行的指纹非空校验里（只有 project_location / agent_backend_cli 受约束），
	// 所以没登记设备的行是合法的，读回来如实为空。
	DeviceFingerprint string `json:"device_fingerprint"`
}

type CLIOverlayView struct {
	BackendSyncID string `json:"backend_sync_id"`
	Fingerprint   string `json:"fingerprint"`
	Status        string `json:"status"`
	// CLIPath 是那台机器上的可执行文件绝对路径。它**刻意**下发浏览器：控制台要能
	// 配这条路径，就得先读得回已经配过的值，否则打开编辑器看到的是空框，一保存
	// 就把用户填过的路径抹掉。api_key 没有跟着松，见 api 层的 guard_test.go。
	CLIPath string `json:"cli_path"`
}

type CLIOverlaySnapshot struct {
	BackendSyncID string `json:"backend_sync_id"`
	CLIPath       string `json:"cli_path"`
}

// BackendSnapshot 是设备 JWT 快照里的一条后端 config：按后端同步标识寻址，正文是
// 共享契约的整份 AgentBackendConfig。
//
// ACP 启动身份（acpCommand / acpArgs）只在这里下行，且只给「这条后端分配到的
// 机器」。它是整个服务端唯一携带这段任意 argv 的下行载荷，因此不经过浏览器形状的
// DTO（见 internal/api/engine 的 guard_test.go）。形状对应 agentre daemon 那份
// snapshotBackendConfig：字段名逐字一致，两端共用一个 config 键表。
type BackendSnapshot struct {
	BackendSyncID string                      `json:"backend_sync_id"`
	Config        syncwire.AgentBackendConfig `json:"config"`
}

type SnapshotView struct {
	Providers   []ProviderSnapshot   `json:"providers"`
	CLIOverlays []CLIOverlaySnapshot `json:"cli_overlays"`
	Backends    []BackendSnapshot    `json:"backends"`
}

type EngineSvc interface {
	ListProviders(context.Context, int64) ([]ProviderView, error)
	CreateProvider(context.Context, ProviderWriteInput) (*ProviderView, error)
	UpdateProvider(context.Context, ProviderWriteInput) (*ProviderView, error)
	DeleteProvider(context.Context, int64, string) error
	CreateProviderModel(context.Context, ModelWriteInput) (*ProviderView, error)
	UpdateProviderModel(context.Context, ModelWriteInput) (*ProviderView, error)
	DeleteProviderModel(ctx context.Context, userID int64, providerKey, modelKey string) (*ProviderView, error)
	ListBackends(context.Context, int64) ([]BackendView, error)
	CreateBackend(context.Context, BackendWriteInput) (*BackendView, error)
	UpdateBackend(context.Context, BackendWriteInput) (*BackendView, error)
	DeleteBackend(context.Context, int64, string) error
	ListCLIOverlays(context.Context, int64) ([]CLIOverlayView, error)
	Snapshot(context.Context, int64, string) (*SnapshotView, error)
}

type engineSvc struct{ now func() int64 }

func New() EngineSvc { return &engineSvc{now: func() int64 { return time.Now().UnixMilli() }} }

var defaultSvc EngineSvc = New()

func Default() EngineSvc     { return defaultSvc }
func SetDefault(s EngineSvc) { defaultSvc = s }

// 三种载荷的形状归共享契约 syncwire（ProjectPayload 那一族的同一批）：这一侧
// **只消费，不再自己声明一遍**。
//
// 写路径不解进结构体再整体 re-marshal：sync_objects 是整行 last-write-wins，结构体
// 没声明的键每一次控制台编辑都会被静默抹掉。供应商、单个模型、后端与覆盖行都按 JSON
// 键合并（providerDoc / modelDoc / backendDoc / saveCLIOverlay），存着的其它键原样保留。
//
// 模型行是唯一一处还要转换的：契约的 LLMProviderModel 用 int（0 = 未知，带
// omitempty），engine_svc 对外的 Model 用 *int64（REST 那一层 internal/api/engine.Model
// 就是这个形状）。见 contractModels / viewModels。

func (s *engineSvc) ListProviders(ctx context.Context, userID int64) ([]ProviderView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindLLMProvider})
	if err != nil {
		return nil, err
	}
	out := make([]ProviderView, 0, len(rows))
	for _, row := range rows {
		if p, ok := decodeProvider(row); ok {
			out = append(out, browserProvider(row.SyncID, p))
		}
	}
	return out, nil
}

func (s *engineSvc) CreateProvider(ctx context.Context, in ProviderWriteInput) (*ProviderView, error) {
	doc := newProviderDoc()
	doc.apply(in, true)
	if !validProviderDoc(doc) || strings.TrimSpace(doc.str("api_key")) == "" {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	payload, err := doc.encode()
	if err != nil {
		return nil, err
	}
	key := workspace_svc.NewOrgSyncID(s.now())
	row := &sync_entity.SyncObject{UserID: in.UserID, Kind: sync_entity.KindLLMProvider, SyncID: key, Createtime: s.now(), Payload: payload}
	if err := workspace_svc.SaveOrgRow(ctx, in.UserID, row); err != nil {
		return nil, err
	}
	out := doc.view(key)
	return &out, nil
}

// UpdateProvider 只改请求涉及的载荷键：与 UpdateBackend 同一套道理（问题 6）——存着的
// 其它键（含服务端不认识的键）原样保留，models 数组同理，不带 Models 就不重编那个
// 键，数组元素里服务端不认识的键跟着活下来。读、合并、写在同一个事务里并锁住该行
// （writeLockedProvider，问题 7）。
func (s *engineSvc) UpdateProvider(ctx context.Context, in ProviderWriteInput) (*ProviderView, error) {
	var view ProviderView
	if _, err := writeLockedProvider(ctx, in.UserID, in.ProviderKey, func(ctx context.Context, row *sync_entity.SyncObject) error {
		doc, ok := parseProviderDoc(row.Payload)
		if !ok {
			return i18n.NewError(ctx, code.InvalidParameter)
		}
		doc.apply(in, false)
		if !validProviderDoc(doc) {
			return i18n.NewError(ctx, code.InvalidParameter)
		}
		payload, err := doc.encode()
		if err != nil {
			return err
		}
		row.Payload = payload
		view = doc.view(row.SyncID)
		return nil
	}); err != nil {
		return nil, err
	}
	return &view, nil
}

func (s *engineSvc) DeleteProvider(ctx context.Context, userID int64, key string) error {
	_, err := writeLockedProvider(ctx, userID, key, func(_ context.Context, row *sync_entity.SyncObject) error {
		row.DeletedAt = s.now()
		return nil
	})
	return err
}

func (s *engineSvc) ListBackends(ctx context.Context, userID int64) ([]BackendView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindAgentBackend, sync_entity.KindAgentBackendCLI, sync_entity.KindAgentExecTarget})
	if err != nil {
		return nil, err
	}
	refs := map[string]int{}
	overlays := map[string][]CLIByDevice{}
	out := make([]BackendView, 0)
	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindAgentExecTarget:
			if id := sync_entity.ExecTargetBackendSyncID(row.Payload); id != "" {
				refs[id]++
			}
		case sync_entity.KindAgentBackendCLI:
			if o, ok := decodeOverlay(row); ok {
				overlays[row.ScopeSyncID] = append(overlays[row.ScopeSyncID], CLIByDevice{Fingerprint: row.AgentredFingerprint, Status: overlayStatus(o.CLIPath)})
			}
		case sync_entity.KindAgentBackend:
			if doc, ok := parseBackendDoc(row.Payload); ok {
				view := doc.view(row.SyncID)
				view.DeviceFingerprint = row.AgentredFingerprint
				out = append(out, view)
			}
		}
	}
	for i := range out {
		out[i].RefCount = refs[out[i].SyncID]
		out[i].CLIByDevice = overlays[out[i].SyncID]
		if out[i].CLIByDevice == nil {
			out[i].CLIByDevice = []CLIByDevice{}
		}
	}
	return out, nil
}
func (s *engineSvc) CreateBackend(ctx context.Context, in BackendWriteInput) (*BackendView, error) {
	if err := checkBackendConfig(ctx, in.Config); err != nil {
		return nil, err
	}
	doc := newBackendDoc()
	doc.apply(in)
	if err := validateBackendWrite(ctx, doc, in); err != nil {
		return nil, err
	}
	payload, err := doc.encode()
	if err != nil {
		return nil, err
	}
	fingerprint := strings.TrimSpace(*in.DeviceFingerprint)
	now := s.now()
	id := workspace_svc.NewOrgSyncID(now)
	// 运行设备写进既有列 sync_objects.agentred_fingerprint，而不是塞进载荷——载荷与
	// 身份指纹是两回事，读的一侧（ListBackends）也是分开取的。
	row := &sync_entity.SyncObject{
		UserID: in.UserID, Kind: sync_entity.KindAgentBackend, SyncID: id, Createtime: now,
		Payload: payload, AgentredFingerprint: fingerprint,
	}
	if err := workspace_svc.SaveOrgRow(ctx, in.UserID, row); err != nil {
		return nil, err
	}
	out := backendWriteView(doc, id, fingerprint)
	return out, s.saveCLIOverlay(ctx, in, id, fingerprint)
}

// UpdateBackend 只改请求涉及的载荷键：config 带了就整体替换，其余键（含服务端不认识
// 的键）原样保留。读、合并、写在同一个事务里并锁住该行（writeLockedBackend）。
func (s *engineSvc) UpdateBackend(ctx context.Context, in BackendWriteInput) (*BackendView, error) {
	if err := checkBackendConfig(ctx, in.Config); err != nil {
		return nil, err
	}
	var doc backendDoc
	row, err := writeLockedBackend(ctx, in.UserID, in.SyncID, func(ctx context.Context, row *sync_entity.SyncObject) error {
		stored, ok := parseBackendDoc(row.Payload)
		if !ok {
			return i18n.NewError(ctx, code.InvalidParameter)
		}
		stored.apply(in)
		if err := validateBackendWrite(ctx, stored, in); err != nil {
			return err
		}
		payload, err := stored.encode()
		if err != nil {
			return err
		}
		row.Payload = payload
		row.AgentredFingerprint = strings.TrimSpace(*in.DeviceFingerprint)
		doc = stored
		return nil
	})
	if err != nil {
		return nil, err
	}
	out := backendWriteView(doc, row.SyncID, row.AgentredFingerprint)
	return out, s.saveCLIOverlay(ctx, in, row.SyncID, row.AgentredFingerprint)
}

func (s *engineSvc) DeleteBackend(ctx context.Context, userID int64, id string) error {
	_, err := writeLockedBackend(ctx, userID, id, func(ctx context.Context, row *sync_entity.SyncObject) error {
		// 引用它的执行目标先落，与主行同一个事务：删到一半失败时两边一起回滚。
		if err := workspace_svc.TombstoneExecTargetsOfBackend(ctx, userID, row.SyncID); err != nil {
			return err
		}
		row.DeletedAt = s.now()
		return nil
	})
	return err
}

// writeLockedBackend 是后端改与删共用的那一段：读、改、写同在一个事务里，读带行锁
// （FindForUpdate），提交之后广播。
//
// 读在事务外时，设备在读与写之间推上来的那一版会被旧副本整行覆盖——WriteOrgRow 取到
// 的版本号更大，落库照样成立（规格 backend-config-sync 问题 7）。mutate 返回错误即
// 整体回滚、不烧版本号、不广播。
func writeLockedBackend(
	ctx context.Context, userID int64, id string,
	mutate func(ctx context.Context, row *sync_entity.SyncObject) error,
) (*sync_entity.SyncObject, error) {
	return writeLockedRow(ctx, userID, id, sync_entity.KindAgentBackend, code.EngineBackendNotFound, mutate)
}

// writeLockedProvider 是供应商改与删共用的那一段，规矩与 writeLockedBackend 相同：
// 读、改、写同在一个事务里，读带行锁（问题 7），单模型端点（provider_model.go）也
// 走这一条骨架，只是 mutate 改的是 models 数组里的一个元素。
func writeLockedProvider(
	ctx context.Context, userID int64, key string,
	mutate func(ctx context.Context, row *sync_entity.SyncObject) error,
) (*sync_entity.SyncObject, error) {
	return writeLockedRow(ctx, userID, key, sync_entity.KindLLMProvider, code.EngineProviderNotFound, mutate)
}

// writeLockedRow 是账号级引擎对象改/删共用的骨架：读、改、写同在一个事务里，读带
// 行锁（FindForUpdate），提交之后广播。
//
// 读在事务外时，设备在读与写之间推上来的那一版会被旧副本整行覆盖——WriteOrgRow 取到
// 的版本号更大，落库照样成立（规格 backend-config-sync 问题 7）。mutate 返回错误即
// 整体回滚、不烧版本号、不广播。
func writeLockedRow(
	ctx context.Context, userID int64, id, kind string, notFoundCode int,
	mutate func(ctx context.Context, row *sync_entity.SyncObject) error,
) (*sync_entity.SyncObject, error) {
	var locked *sync_entity.SyncObject
	if err := workspace_svc.WithOrgWriteTx(ctx, userID, func(ctx context.Context) error {
		row, err := sync_repo.SyncObject().FindForUpdate(ctx, userID, id)
		if err != nil {
			return err
		}
		if row == nil || row.IsDeleted() || row.Kind != kind {
			return i18n.NewNotFoundError(ctx, notFoundCode)
		}
		if err := mutate(ctx, row); err != nil {
			return err
		}
		locked = row
		return workspace_svc.WriteOrgRow(ctx, userID, row)
	}); err != nil {
		return nil, err
	}
	workspace_svc.BroadcastOrgWrite(ctx, userID, locked.Version)
	return locked, nil
}

func backendWriteView(doc backendDoc, id, fingerprint string) *BackendView {
	out := doc.view(id)
	out.DeviceFingerprint = fingerprint
	out.CLIByDevice = []CLIByDevice{}
	return &out
}

// saveCLIOverlay 把 cli_path 落到 (backend, 绑定设备) 这一条 agent_backend_cli 上。
//
// 路径**不进 backend 载荷**：同一条后端在不同机器上是不同的可执行文件，载荷是跨机
// 共享的，把路径塞进去就等于让一台机器的路径盖住另一台。身份因此是两段——
// ProjectSyncID 记后端，AgentredFingerprint 记机器。
//
// 只在浏览器显式送来 cli_path 时才动它：改名、换模型那种写不带这个字段，覆盖行
// 一次都不该多存（多存一版会让所有设备白拉一次同步）。
//
// 空串是合法取值，表示「不指定路径，用 $PATH 里的那个」——如实写下去，不删行，
// 这样 overlayStatus 仍然区分得出「配过但清空了」与「从没配过」。
//
// 既存的覆盖行在写入事务里加锁重读，只改 cli_path 这一个键，存着的其它键原样保留。
func (s *engineSvc) saveCLIOverlay(ctx context.Context, in BackendWriteInput, backendSyncID, fingerprint string) error {
	if in.CLIPath == nil {
		return nil
	}
	var saved *sync_entity.SyncObject
	if err := workspace_svc.WithOrgWriteTx(ctx, in.UserID, func(ctx context.Context) error {
		row, err := lockBoundOverlay(ctx, in.UserID, backendSyncID, fingerprint)
		if err != nil {
			return err
		}
		doc := map[string]json.RawMessage{}
		if row == nil {
			now := s.now()
			row = &sync_entity.SyncObject{
				UserID: in.UserID, Kind: sync_entity.KindAgentBackendCLI, SyncID: workspace_svc.NewOrgSyncID(now),
				ScopeSyncID: backendSyncID, AgentredFingerprint: fingerprint, Createtime: now,
			}
		} else if err := json.Unmarshal([]byte(row.Payload), &doc); err != nil || doc == nil {
			// 存着的正文不是 JSON 对象：没有可保留的键，按新行写。
			doc = map[string]json.RawMessage{}
		}
		path, err := json.Marshal(*in.CLIPath)
		if err != nil {
			return err
		}
		doc["cli_path"] = path
		payload, err := json.Marshal(doc)
		if err != nil {
			return err
		}
		row.Payload = string(payload)
		saved = row
		return workspace_svc.WriteOrgRow(ctx, in.UserID, row)
	}); err != nil {
		return err
	}
	workspace_svc.BroadcastOrgWrite(ctx, in.UserID, saved.Version)
	return nil
}

// lockBoundOverlay 在写入事务里找 (backend, 设备) 那一条活着的覆盖行并加锁重读；
// 没有就返回 nil。**只能在 WithOrgWriteTx 里调用。**
func lockBoundOverlay(ctx context.Context, userID int64, backendSyncID, fingerprint string) (*sync_entity.SyncObject, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindAgentBackendCLI})
	if err != nil {
		return nil, err
	}
	for _, candidate := range rows {
		if candidate.ScopeSyncID != backendSyncID || candidate.AgentredFingerprint != fingerprint || candidate.IsDeleted() {
			continue
		}
		locked, err := sync_repo.SyncObject().FindForUpdate(ctx, userID, candidate.SyncID)
		if err != nil {
			return nil, err
		}
		if locked == nil || locked.IsDeleted() || locked.Kind != sync_entity.KindAgentBackendCLI {
			return nil, nil
		}
		return locked, nil
	}
	return nil, nil
}

func (s *engineSvc) ListCLIOverlays(ctx context.Context, userID int64) ([]CLIOverlayView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindAgentBackendCLI})
	if err != nil {
		return nil, err
	}
	out := make([]CLIOverlayView, 0, len(rows))
	for _, row := range rows {
		if o, ok := decodeOverlay(row); ok {
			out = append(out, CLIOverlayView{BackendSyncID: row.ScopeSyncID, Fingerprint: row.AgentredFingerprint, Status: overlayStatus(o.CLIPath), CLIPath: o.CLIPath})
		}
	}
	return out, nil
}
func (s *engineSvc) Snapshot(ctx context.Context, userID int64, fingerprint string) (*SnapshotView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{
		sync_entity.KindLLMProvider, sync_entity.KindAgentBackendCLI, sync_entity.KindAgentBackend,
	})
	if err != nil {
		return nil, err
	}
	out := &SnapshotView{
		Providers:   []ProviderSnapshot{},
		CLIOverlays: []CLIOverlaySnapshot{},
		Backends:    []BackendSnapshot{},
	}
	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindLLMProvider:
			if p, ok := decodeProvider(row); ok {
				out.Providers = append(out.Providers, ProviderSnapshot{ProviderKey: row.SyncID, Name: p.Name, Type: p.Type, BaseURL: p.BaseURL, APIKey: p.APIKey, DefaultModelKey: p.DefaultModelKey, Models: viewModels(p.Models)})
			}
		case sync_entity.KindAgentBackendCLI:
			if row.AgentredFingerprint == fingerprint {
				if o, ok := decodeOverlay(row); ok {
					out.CLIOverlays = append(out.CLIOverlays, CLIOverlaySnapshot{BackendSyncID: row.ScopeSyncID, CLIPath: o.CLIPath})
				}
			}
		case sync_entity.KindAgentBackend:
			// 最小权限：只回这条后端**分配到的这台机器**，别的机器一条都不带。
			// 坏载荷（解不动）、没写运行设备的存量行与墓碑行直接跳过，不泄也不
			// panic。ListByKinds 已在 SQL 里排除墓碑，这里再判一次 IsDeleted 是
			// 防御性的——将来这条读路若换了仓储，也不至于把一条已删后端连 config
			// 一起发给设备。
			if row.IsDeleted() {
				continue
			}
			if row.AgentredFingerprint == fingerprint {
				doc, ok := parseBackendDoc(row.Payload)
				if !ok {
					continue
				}
				var config syncwire.AgentBackendConfig
				if err := json.Unmarshal(doc.config(), &config); err != nil {
					continue
				}
				out.Backends = append(out.Backends, BackendSnapshot{BackendSyncID: row.SyncID, Config: config})
			}
		}
	}
	return out, nil
}

func validateBackendWrite(ctx context.Context, doc backendDoc, in BackendWriteInput) error {
	name, typ := doc.str("name"), doc.str("type")
	if typ == "builtin" {
		return i18n.NewError(ctx, code.EngineBuiltinForbidden)
	}
	if strings.TrimSpace(name) == "" || strings.TrimSpace(typ) == "" ||
		in.DeviceFingerprint == nil || strings.TrimSpace(*in.DeviceFingerprint) == "" {
		return i18n.NewError(ctx, code.InvalidParameter)
	}
	return requireActiveAccountDevice(ctx, in.UserID, strings.TrimSpace(*in.DeviceFingerprint))
}

// requireActiveAccountDevice 判「所选设备在编辑期间被撤销」：指纹在这个账号下查不到，
// 或查到了但不是活跃状态（Device.IsActive 对 nil 接收者也安全），都拒同一个专属码，
// 不静默落一个指向撤销设备的取值。它与「没填设备」的 InvalidParameter 分开，好让浏览器
// 把「请选一台设备」和「该设备已不在账号内」分别提示。
func requireActiveAccountDevice(ctx context.Context, userID int64, fingerprint string) error {
	d, err := device_repo.Device().FindByFingerprint(ctx, userID, fingerprint)
	if err != nil {
		return err
	}
	if !d.IsActive() {
		return i18n.NewError(ctx, code.EngineBackendDeviceNotFound)
	}
	return nil
}
func decodeProvider(row *sync_entity.SyncObject) (syncwire.LLMProviderPayload, bool) {
	var p syncwire.LLMProviderPayload
	return p, json.Unmarshal([]byte(row.Payload), &p) == nil
}
func decodeOverlay(row *sync_entity.SyncObject) (syncwire.AgentBackendCLIPayload, bool) {
	var o syncwire.AgentBackendCLIPayload
	return o, json.Unmarshal([]byte(row.Payload), &o) == nil
}
func browserProvider(key string, p syncwire.LLMProviderPayload) ProviderView {
	return ProviderView{ProviderKey: key, Name: p.Name, Type: p.Type, BaseURL: p.BaseURL, MaskedTail: maskedTail(p.APIKey), DefaultModelKey: p.DefaultModelKey, Enabled: p.Enabled, Models: viewModels(p.Models)}
}

// contractModels / viewModels 把模型行在契约与 web view 两种表达之间搬运。
//
// 「未知的上下文窗口」在两边不是同一个写法：契约是 0（带 omitempty，因此在载荷里
// 缺席，桌面端逐字这么写），view 是 nil（REST 响应里同样是键缺席）。两边各自的
// 「缺席」都表达同一件事，所以这里显式互转，不靠隐式零值糊过去。
func contractModels(models []Model) []syncwire.LLMProviderModel {
	out := make([]syncwire.LLMProviderModel, len(models))
	for i, m := range models {
		out[i] = syncwire.LLMProviderModel{
			ModelKey: m.ModelKey, ModelID: m.ModelID, Name: m.Name, Enabled: m.Enabled,
			ContextWindow: intOrZero(m.ContextWindow), MaxOutput: intOrZero(m.MaxOutput),
		}
	}
	return out
}

func viewModels(models []syncwire.LLMProviderModel) []Model {
	out := make([]Model, len(models))
	for i, m := range models {
		out[i] = Model{
			ModelKey: m.ModelKey, ModelID: m.ModelID, Name: m.Name, Enabled: m.Enabled,
			ContextWindow: int64OrNil(m.ContextWindow), MaxOutput: int64OrNil(m.MaxOutput),
		}
	}
	return out
}

func intOrZero(v *int64) int {
	if v == nil {
		return 0
	}
	return int(*v)
}

func int64OrNil(v int) *int64 {
	if v == 0 {
		return nil
	}
	n := int64(v)
	return &n
}

func maskedTail(key string) string {
	r := []rune(key)
	if len(r) <= 4 {
		return key
	}
	return string(r[len(r)-4:])
}
func overlayStatus(path string) string {
	if path == "" {
		return "path"
	}
	return "recognized"
}
