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

// 同步标识、指纹、provider_key 都是字符串引用，照常放行；device_id 为空串是
// 「当前这台桌面端」这个相对引用，也必须放行。
func TestValidatePayload_GivenStringReferences_ThenAccepted(t *testing.T) {
	cases := map[string]string{
		"同步标识":     `{"parent_id":"01J0-uuid","name":"a"}`,
		"指纹":       `{"agentred_fingerprint":"fp-a"}`,
		"相对引用的空设备": `{"device_id":"","provider_key":"openai"}`,
		"非 id 的数字": `{"sort_order":2,"enabled":true}`,
		"空载荷":      `{}`,
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
