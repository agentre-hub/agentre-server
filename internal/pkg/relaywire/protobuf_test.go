package relaywire

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// EncodeRequest 那条编码用例随实现一起搬走了：请求/取消帧现在由共享协议引擎
// pkg/wire/protorpc 编,它在自己的 module 里有用例。「carrier 是二进制、method ID
// 稳定」这条性质仍然被守着,位置在 mirror_svc 的 decodeForwardedRequest —— 那里断言
// 的是真的经中继发出去的那一帧。
func TestDecodeFrameRejectsMalformedBinary(t *testing.T) {
	_, err := DecodeFrame([]byte{0xff, 0xff})
	require.Error(t, err)
}
