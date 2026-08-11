package sync_entity

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// R2 守卫：跨机引用一律不带本地自增 ID 过机。判据是「键名以 id 结尾且取值是数字」
// ——同步标识与指纹都是字符串，只有桌面端的本地主键才会以数字出现在这个位置。
func TestValidatePayload_GivenNumericIDFields_ThenRejected(t *testing.T) {
	cases := map[string]string{
		"顶层 agent_backend_id": `{"name":"a","agent_backend_id":12}`,
		"顶层 id":               `{"id":3,"name":"a"}`,
		"驼峰 parentId":         `{"parentId":7}`,
		"嵌套对象里":               `{"target":{"backend_id":9}}`,
		"数组元素里":               `{"targets":[{"sort_order":0,"agent_id":4}]}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			assert.ErrorIs(t, ValidatePayload([]byte(payload)), ErrPayloadLocalID)
		})
	}
}

// 同步标识、指纹、provider_key、model_key 都是字符串引用，照常放行；device_id
// 为空串是「当前这台桌面端」这个相对引用，也必须放行。model_key 是 2026-08-11
// LLM Provider 多模型契约新增的稳定模型引用（Provider 与 Model 配置均不进入账号
// 同步，业务对象只携带 provider_key / model_key 字符串），归一化后是 modelkey，
// 不落进 apikey / provider / *id 任何一条守卫，必须显式放行。
func TestValidatePayload_GivenStringReferences_ThenAccepted(t *testing.T) {
	cases := map[string]string{
		"同步标识":            `{"parent_id":"01J0-uuid","name":"a"}`,
		"指纹":              `{"agentred_fingerprint":"fp-a"}`,
		"相对引用的空设备":        `{"device_id":"","provider_key":"openai"}`,
		"model_key 字符串引用": `{"provider_key":"anthropic-main","model_key":"anthropic-opus-01"}`,
		"驼峰 modelKey":     `{"modelKey":"anthropic-opus-01"}`,
		"非 id 的数字":        `{"sort_order":2,"enabled":true}`,
		"空载荷":             `{}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			assert.NoError(t, ValidatePayload([]byte(payload)))
		})
	}
}

// 凭据不上报：llm_providers 整行（含 APIKey）不出本机，跨机只传 provider_key。
func TestValidatePayload_GivenCredentialOrProviderRow_ThenRejected(t *testing.T) {
	cases := map[string]string{
		"api_key":      `{"api_key":"sk-x"}`,
		"apiKey":       `{"apiKey":"sk-x"}`,
		"provider 对象":  `{"provider":{"provider_key":"openai"}}`,
		"providers 数组": `{"providers":[{"provider_key":"openai"}]}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			assert.ErrorIs(t, ValidatePayload([]byte(payload)), ErrPayloadCredential)
		})
	}
}

func TestValidatePayload_GivenNonObject_ThenRejected(t *testing.T) {
	assert.ErrorIs(t, ValidatePayload([]byte(`[{"name":"a"}]`)), ErrPayloadNotObject)
	assert.ErrorIs(t, ValidatePayload([]byte(`"a"`)), ErrPayloadNotObject)
	assert.Error(t, ValidatePayload([]byte(`{oops`)))
}

// 墓碑不带正文：空载荷是合法的。
func TestValidatePayload_GivenEmpty_ThenAccepted(t *testing.T) {
	assert.NoError(t, ValidatePayload(nil))
	assert.NoError(t, ValidatePayload([]byte("")))
}

// 头像正文按内容哈希单独传，不进同步载荷。
func TestValidatePayload_GivenAvatarContent_ThenRejected(t *testing.T) {
	for _, payload := range []string{
		`{"name":"x","avatar_data_url":"data:image/png;base64,AAAA"}`,
		`{"avatarDataUrl":"data:image/png;base64,AAAA"}`,
	} {
		assert.ErrorIs(t, ValidatePayload([]byte(payload)), ErrPayloadAvatarContent, payload)
	}
	// avatar_hash 是内容哈希这个字符串引用，不是正文，照常放行。
	assert.NoError(t, ValidatePayload([]byte(`{"avatar_hash":"deadbeef"}`)))
}

// 这一组向量与桌面端 syncwire.GuardPayload 的同名测试**逐条一致**：两个仓库不能
// 互相 import，规则只能靠两份相同的向量对齐。任何一边加规则，这张表要同步改。
//
// 最后一条是刻意的**反向**断言：`env_json` 是用户自填的透传环境变量表，按设计随
// backend 明文过机，守卫不看 JSON 字符串内部。守卫的注释不承诺它会被过滤，这条
// 测试把「不过滤」钉死，免得日后有人照着注释误以为凭据一定进不了同步载荷。
func TestValidatePayload_GivenTheSharedVectors_ThenMatchesTheDesktopGuard(t *testing.T) {
	rejected := []string{
		`{"parent_id":7}`,
		`{"agentBackendId":7}`,
		`{"targets":[{"agent-backend-id":7}]}`,
		`{"nested":{"department_id":1}}`,
		`{"api_key":"sk-x"}`,
		`{"apiKey":"sk-x"}`,
		`{"provider":{"api_key":"sk-x"}}`,
		`{"providers":[{"name":"p"}]}`,
		`{"avatar_data_url":"data:image/png;base64,AAAA"}`,
		`{"avatarDataUrl":"data:image/png;base64,AAAA"}`,
	}
	accepted := []string{
		`{"name":"x","parent_sync_id":"01ARZ3ND"}`,
		`{"provider_key":"anthropic-main"}`,
		`{"agent_sync_id":"a","backend_sync_id":"b","sort_order":2}`,
		`{"avatar_hash":"deadbeef"}`,
		`{}`,
		``,
		`{"env_json":"{\"MY_TOKEN\":\"secret\"}"}`,
	}
	for _, payload := range rejected {
		assert.Error(t, ValidatePayload([]byte(payload)), payload)
	}
	for _, payload := range accepted {
		assert.NoError(t, ValidatePayload([]byte(payload)), payload)
	}
}
