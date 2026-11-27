package device

import (
	"testing"

	"github.com/gin-gonic/gin/binding"
	"github.com/stretchr/testify/assert"
)

// Device Flow 的 device_kind 白名单必须收下 cli（agrctl 登录），并且仍然拒绝未知类型。
func TestDeviceAuthorizeRequest_DeviceKindWhitelist(t *testing.T) {
	for _, tc := range []struct {
		kind string
		ok   bool
	}{
		{"desktop", true}, {"agentred", true}, {"mobile", true},
		{"cli", true},
		{"web", false}, {"", false}, {"CLI", false},
	} {
		err := binding.Validator.ValidateStruct(&DeviceAuthorizeRequest{
			DeviceKind: tc.kind, Fingerprint: "fp-12345678",
		})
		assert.Equal(t, tc.ok, err == nil, "device_kind=%q err=%v", tc.kind, err)
	}
}
