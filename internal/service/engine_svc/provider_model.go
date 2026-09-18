package engine_svc

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/cago-frame/cago/pkg/i18n"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

// ModelWriteInput 是单模型写入（启停/编辑/新增/删除）的入参。ProviderKey 定位供应商；
// 编辑/删除时 ModelKey 是要改的那一个模型的稳定键（REST 路径里的 :model_key，不能
// 通过请求体改名）；新增时 ModelKey 是待建模型的键，由请求体给出。
//
// 其余字段都是可选指针：nil 表示这次不改那个键，与 ProviderWriteInput /
// BackendWriteInput 同一套「缺席即不改」的约定（规格问题 9：整页旧状态整体保存
// 的反面——单模型端点只送用户这次真正改动的那几个键）。
type ModelWriteInput struct {
	UserID        int64
	ProviderKey   string
	ModelKey      string
	ModelID       *string
	Name          *string
	Enabled       *bool
	ContextWindow *int64
	MaxOutput     *int64
}

// modelDoc 是内嵌在供应商载荷 models 数组里单个模型的 JSON 键表，规矩与 providerDoc /
// backendDoc 相同：只改请求涉及的键，本元素服务端不认识的键原样保留（规格
// 「模型开关」：只改一个模型，同一供应商的其它模型——含页面打开后其它设备新增或
// 改动的——保持服务端当前值，因此数组里除目标元素外的每一项都不解码、不重编，
// 原始字节直接搬运）。
type modelDoc map[string]json.RawMessage

func parseModelDoc(raw json.RawMessage) (modelDoc, bool) {
	var d modelDoc
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, false
	}
	if d == nil {
		d = modelDoc{}
	}
	return d, true
}

func (d modelDoc) str(key string) string {
	var v string
	_ = json.Unmarshal(d[key], &v)
	return v
}
func (d modelDoc) setString(key string, v *string) {
	if v == nil {
		return
	}
	raw, err := json.Marshal(*v)
	if err != nil {
		return
	}
	d[key] = raw
}
func (d modelDoc) setBool(key string, v *bool) {
	if v == nil {
		return
	}
	raw, err := json.Marshal(*v)
	if err != nil {
		return
	}
	d[key] = raw
}
func (d modelDoc) setInt64(key string, v *int64) {
	if v == nil {
		return
	}
	raw, err := json.Marshal(*v)
	if err != nil {
		return
	}
	d[key] = raw
}
func (d modelDoc) encode() (json.RawMessage, error) {
	return json.Marshal(d)
}

// CreateProviderModel 往供应商的 models 数组末尾加一个模型；键在这个供应商下须唯一。
func (s *engineSvc) CreateProviderModel(ctx context.Context, in ModelWriteInput) (*ProviderView, error) {
	key := strings.TrimSpace(in.ModelKey)
	return s.writeProviderModels(ctx, in.UserID, in.ProviderKey, func(ctx context.Context, models []json.RawMessage) ([]json.RawMessage, error) {
		if key == "" {
			return nil, i18n.NewError(ctx, code.InvalidParameter)
		}
		if modelIndex(models, key) >= 0 {
			return nil, i18n.NewError(ctx, code.InvalidParameter)
		}
		d := modelDoc{}
		d.setString("model_key", &key)
		d.setString("model_id", in.ModelID)
		d.setString("name", in.Name)
		enabled := in.Enabled
		if enabled == nil {
			v := true
			enabled = &v
		}
		d.setBool("enabled", enabled)
		d.setInt64("context_window", in.ContextWindow)
		d.setInt64("max_output", in.MaxOutput)
		raw, err := d.encode()
		if err != nil {
			return nil, err
		}
		return append(models, raw), nil
	})
}

// UpdateProviderModel 只改这一个模型：启停、改名、改 model_id / 上下文窗口 / 最大
// 输出，任一字段缺席都保留存着的值；model_key 本身不可经这里改名。
func (s *engineSvc) UpdateProviderModel(ctx context.Context, in ModelWriteInput) (*ProviderView, error) {
	return s.writeProviderModels(ctx, in.UserID, in.ProviderKey, func(ctx context.Context, models []json.RawMessage) ([]json.RawMessage, error) {
		idx := modelIndex(models, in.ModelKey)
		if idx < 0 {
			return nil, i18n.NewNotFoundError(ctx, code.NotFound)
		}
		d, ok := parseModelDoc(models[idx])
		if !ok {
			return nil, i18n.NewError(ctx, code.InvalidParameter)
		}
		d.setString("model_id", in.ModelID)
		d.setString("name", in.Name)
		d.setBool("enabled", in.Enabled)
		d.setInt64("context_window", in.ContextWindow)
		d.setInt64("max_output", in.MaxOutput)
		raw, err := d.encode()
		if err != nil {
			return nil, err
		}
		out := append([]json.RawMessage(nil), models...)
		out[idx] = raw
		return out, nil
	})
}

// DeleteProviderModel 只删这一个模型条目，数组里其它元素原样保留（含顺序）。
func (s *engineSvc) DeleteProviderModel(ctx context.Context, userID int64, providerKey, modelKey string) (*ProviderView, error) {
	return s.writeProviderModels(ctx, userID, providerKey, func(ctx context.Context, models []json.RawMessage) ([]json.RawMessage, error) {
		idx := modelIndex(models, modelKey)
		if idx < 0 {
			return nil, i18n.NewNotFoundError(ctx, code.NotFound)
		}
		out := append([]json.RawMessage(nil), models[:idx]...)
		return append(out, models[idx+1:]...), nil
	})
}

// writeProviderModels 在锁住的供应商行内改 models 数组；mutate 只改数组本身，数组里
// 每个模型元素的原始字节原样保留——不解进 syncwire.LLMProviderModel 再整体编码，那样
// 会抹掉服务端不认识的每模型键，也会连带牵动没被这次请求点名的模型（规格
// 「模型开关」；读、合并、写在同一个锁住的事务里，见 writeLockedProvider，问题 7）。
func (s *engineSvc) writeProviderModels(
	ctx context.Context, userID int64, providerKey string,
	mutate func(ctx context.Context, models []json.RawMessage) ([]json.RawMessage, error),
) (*ProviderView, error) {
	var view ProviderView
	if _, err := writeLockedProvider(ctx, userID, providerKey, func(ctx context.Context, row *sync_entity.SyncObject) error {
		doc, ok := parseProviderDoc(row.Payload)
		if !ok {
			return i18n.NewError(ctx, code.InvalidParameter)
		}
		var models []json.RawMessage
		if raw, exists := doc["models"]; exists && len(raw) > 0 {
			if err := json.Unmarshal(raw, &models); err != nil {
				return i18n.NewError(ctx, code.InvalidParameter)
			}
		}
		next, err := mutate(ctx, models)
		if err != nil {
			return err
		}
		if next == nil {
			// 删掉最后一个模型时 mutate 交回的是 nil 切片，直接编码会得到 null。
			// 契约里 models 没有 omitempty（桌面端逐字写 []），newProviderDoc 起手
			// 也是 []——键集只有一个样子，空数组就写空数组。
			next = []json.RawMessage{}
		}
		raw, err := json.Marshal(next)
		if err != nil {
			return err
		}
		doc["models"] = raw
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

func modelIndex(models []json.RawMessage, key string) int {
	for i, raw := range models {
		d, ok := parseModelDoc(raw)
		if !ok {
			continue
		}
		if d.str("model_key") == key {
			return i
		}
	}
	return -1
}
