package sync_entity

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ErrPayloadLocalID 表示载荷里出现了桌面端的本地自增 ID。
var ErrPayloadLocalID = errors.New("sync payload carries a local auto-increment id")

// ErrPayloadCredential 表示载荷里出现了凭据或 provider 行正文。
var ErrPayloadCredential = errors.New("sync payload carries a credential or a provider row")

// ErrPayloadNotObject 表示载荷不是一个 JSON 对象。
var ErrPayloadNotObject = errors.New("sync payload must be a json object")

// ErrPayloadAvatarContent 表示载荷里出现了头像正文而不是内容哈希。
var ErrPayloadAvatarContent = errors.New("sync payload carries avatar content instead of a content hash")

// ValidatePayload 是服务端对上行载荷的结构守卫。kind 让唯一可携带 API Key 的
// llm_provider 与所有其它对象明确分开；调用者不可省略它。它按**键名**挡住三类东西：
//
//   - 桌面端的本地自增 ID（键名以 id 结尾、取值是数字）。跨机引用一律用同步标识、
//     agentred 指纹或 provider_key 表达，它们全是字符串；这个形状只可能是某台
//     桌面端的本地主键，在别的机器上指向完全不同的对象。
//   - `api_key` 这个键，以及整行 provider 正文（`provider` / `providers` 取值是
//     对象或数组）。只有 kind=llm_provider 能携带 api_key；其它对象只传
//     provider_key 这个字符串。
//   - `avatar_data_url`：头像正文按内容哈希单独传，不进同步载荷。
//
// **它挡不住、也没打算挡的：载荷里以 JSON 字符串形式携带的正文。** 最要紧的一处是
// backend 的 `env_json`——它是用户自填的透传环境变量表，是 backend 配置的一部分，
// 按设计随 backend 同步，明文存在账号下。它不含 App 自管的凭据（ANTHROPIC_API_KEY /
// OPENAI_API_KEY 等 15 个保留键由桌面端的 agent_backend_entity.Check 拒绝入库），
// 但用户往里放的任何别的密钥都会原样过机。这条守卫不是凭据扫描器，别把它当成一个。
//
// 桌面端有一份同名同规则的守卫（syncwire.GuardPayload），两边规则必须一致，改一边
// 就要改另一边——两个仓库不能互相 import，只能靠这两段注释与各自的测试向量对齐。
// 服务端这一份保护账号里的其它设备；桌面端那一份让坏载荷根本发不出去。规则不一致
// 时坏的一边只会让单条被拒（见 sync_svc.PushRejectReasonPayload），不会堵住队列。
//
// 空载荷合法：墓碑不带正文。
func ValidatePayload(kind string, payload []byte) error {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	var root any
	if err := dec.Decode(&root); err != nil {
		return fmt.Errorf("decode sync payload: %w", err)
	}
	obj, ok := root.(map[string]any)
	if !ok {
		return ErrPayloadNotObject
	}
	return walkPayload(kind, obj)
}

func walkPayload(kind string, node any) error {
	switch t := node.(type) {
	case map[string]any:
		for key, value := range t {
			if err := checkPayloadKey(kind, key, value); err != nil {
				return err
			}
			if err := walkPayload(kind, value); err != nil {
				return err
			}
		}
	case []any:
		for _, value := range t {
			if err := walkPayload(kind, value); err != nil {
				return err
			}
		}
	}
	return nil
}

func checkPayloadKey(kind, key string, value any) error {
	norm := normalizePayloadKey(key)
	if norm == "apikey" && kind != KindLLMProvider {
		return ErrPayloadCredential
	}
	if norm == "clipath" && kind == KindAgentBackend {
		return ErrPayloadCredential
	}
	// 头像正文只按内容哈希单独传；这个键名一旦出现在载荷里，不论值是什么，都说明
	// 有代码路径想把正文塞进同步载荷——直接挡住，不看值的内容。
	if norm == "avatardataurl" {
		return ErrPayloadAvatarContent
	}
	if norm == "provider" || norm == "providers" {
		// provider_key 归一化后是 providerkey，不落进这一条：字符串引用照常放行，
		// 被挡住的是整行 provider 正文。
		switch value.(type) {
		case map[string]any, []any:
			return ErrPayloadCredential
		}
	}
	if strings.HasSuffix(norm, "id") {
		if _, isNumber := value.(json.Number); isNumber {
			return ErrPayloadLocalID
		}
	}
	return nil
}

// normalizePayloadKey 把 agent_backend_id / agentBackendId / agent-backend-id
// 归一成同一个形状，免得换个命名风格就绕过守卫。
func normalizePayloadKey(key string) string {
	var b strings.Builder
	b.Grow(len(key))
	for _, r := range strings.ToLower(key) {
		if r == '_' || r == '-' || r == ' ' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// ExecTargetBackendSyncID 取出一条 kind=agent_exec_target 的载荷里引用的 backend
// 同步标识（`backend_sync_id`），取不到时返回空串。
//
// 这个键名是跨仓库的约定，不是本文件新造的：桌面端 sync_svc/adapter_org.go 写出它
// （`json:"backend_sync_id"`），服务端 workspace_svc 的展示路径也读它。它是一个同步
// 标识——字符串、跨机稳定——因此正好落在 ValidatePayload 放行的那一侧（以 id 结尾但
// 取值不是数字），两条规则不冲突。
//
// **解析不出来一律当「不引用任何 backend」。** 它唯一的调用方是 R6 的级联删除
// （sync_svc.PurgeDeviceSyncObjects），那里宁可漏删一条也不能多删一条：漏的那条最坏
// 是接收端按 R2a 暂缓一次，多删的是用户还在用的配置。因此这里不返回 error——没有
// 任何一个调用方会想在「载荷读不懂」时把删除扩大化。
func ExecTargetBackendSyncID(payload string) string {
	var p struct {
		BackendSyncID string `json:"backend_sync_id"`
	}
	if err := json.Unmarshal([]byte(payload), &p); err != nil {
		return ""
	}
	return p.BackendSyncID
}
