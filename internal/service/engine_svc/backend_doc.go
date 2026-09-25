package engine_svc

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/agentre-hub/agentre/pkg/syncwire"
	"github.com/cago-frame/cago/pkg/i18n"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

// backendDoc 是 agent_backend 载荷的顶层 JSON 键表。
//
// 控制台写后端时不把载荷解进 syncwire.AgentBackendPayload 再整体编码：那样结构体没
// 声明的键（桌面端比本仓 pin 先加的键）每编辑一次就被抹掉一次（规格 backend-config-sync
// 问题 6）。这里只按键改请求涉及的那几个，其余原文保留。
type backendDoc map[string]json.RawMessage

// newBackendDoc 是新建后端的起点：契约的每个顶层键都在（空串、config 为 {}），
// 与桌面端写出的键集一致。
func newBackendDoc() backendDoc {
	raw, err := json.Marshal(syncwire.AgentBackendPayload{})
	if err != nil {
		panic(err) // 零值结构体的编码不会失败
	}
	doc, _ := parseBackendDoc(string(raw))
	return doc
}

// parseBackendDoc 解出存着的载荷；不是 JSON 对象时 ok=false。
func parseBackendDoc(payload string) (backendDoc, bool) {
	var doc backendDoc
	if err := json.Unmarshal([]byte(payload), &doc); err != nil {
		return nil, false
	}
	if doc == nil {
		doc = backendDoc{}
	}
	return doc, true
}

func (d backendDoc) apply(in BackendWriteInput) {
	d.setString("name", in.Name)
	d.setString("type", in.Type)
	d.setString("provider_key", in.ProviderKey)
	d.setString("model_key", in.ModelKey)
	// env_json 给了就是整表覆写（与桌面端同语义）；nil 表示这次不改。
	d.setString("env_json", in.EnvJSON)
	d.setString("reasoning_effort", in.ReasoningEffort)
	if len(in.Config) > 0 {
		d["config"] = in.Config
	}
}

func (d backendDoc) setString(key string, v *string) {
	if v == nil {
		return
	}
	raw, err := json.Marshal(*v)
	if err != nil {
		return
	}
	d[key] = raw
}

// str 读一个字符串键；缺席或不是字符串都读作空串。
func (d backendDoc) str(key string) string {
	var v string
	_ = json.Unmarshal(d[key], &v)
	return v
}

// config 读出存着的 config 对象原文。旧平铺格式的行没有这个键，读作 {}；
// 不是对象的取值同样读作 {}，不让一行坏数据挡住整张列表。
func (d backendDoc) config() json.RawMessage {
	if raw := d["config"]; isJSONObject(raw) {
		return raw
	}
	return json.RawMessage(`{}`)
}

func (d backendDoc) encode() (string, error) {
	raw, err := json.Marshal(d)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func (d backendDoc) view(syncID string) BackendView {
	return BackendView{
		SyncID: syncID, Name: d.str("name"), Type: d.str("type"),
		ProviderKey: d.str("provider_key"), ModelKey: d.str("model_key"),
		EnvJSON: d.str("env_json"), ReasoningEffort: d.str("reasoning_effort"),
		Config: d.config(),
	}
}

// normalizeConfig 按桌面端的规则校验并规范化存着的 config（NormalizeBackendConfig）。
// 规范化没有改动时不碰 config 键，旧平铺格式的行因此不会凭空多出一个 config。
func (d backendDoc) normalizeConfig(ctx context.Context) error {
	current := d.config()
	out, err := NormalizeBackendConfig(ctx, BackendFields{
		Type: d.str("type"), ProviderKey: d.str("provider_key"), ModelKey: d.str("model_key"),
		EnvJSON: d.str("env_json"), ReasoningEffort: d.str("reasoning_effort"), Config: current,
	})
	if err != nil {
		return err
	}
	if !bytes.Equal(out, current) {
		d["config"] = out
	}
	return nil
}

// checkBackendConfig 拒绝不是 JSON 对象的 config（含 null）。缺席（空）表示不改，放行。
// 它在任何读写之前判，拒绝时不开事务、不落库。
func checkBackendConfig(ctx context.Context, config json.RawMessage) error {
	if len(config) == 0 || isJSONObject(config) {
		return nil
	}
	return i18n.NewError(ctx, code.InvalidParameter)
}

func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{' && json.Valid(trimmed)
}
