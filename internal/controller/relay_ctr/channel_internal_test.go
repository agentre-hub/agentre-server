package relay_ctr

import (
	"context"
	"fmt"
	"testing"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// 通道级失败每一种都要有一个自己的码，而且拿得出中英文案。
//
// 文案不另起一套：它就是 upgrade 前那一版业务码的文案（internal/pkg/code 的语言包）。
// 这里逐条解析而不是抽查——漏一条的表现是客户端收到一个有码无文案的错误，而那正是
// 用户唯一看得见的东西。
func TestChannelFailure_GivenEveryRelayFailure_ThenHasADistinctCodeAndBilingualText(t *testing.T) {
	seen := map[int32]error{}
	for _, tc := range []struct {
		err      error
		expected int32
		business int
	}{
		{err: relay_svc.ErrTargetInvalid, expected: relay_svc.ChannelCodeTargetInvalid, business: code.InvalidParameter},
		{err: relay_svc.ErrDaemonNotFound, expected: relay_svc.ChannelCodeTargetNotFound, business: code.RelayDaemonNotFound},
		{err: relay_svc.ErrDaemonOffline, expected: relay_svc.ChannelCodeTargetOffline, business: code.RelayDaemonOffline},
		{err: relay_svc.ErrForwardFailed, expected: relay_svc.ChannelCodeForwardFailed, business: code.RelayForwardFailed},
		{err: relay_svc.ErrDaemonForbidden, expected: relay_svc.ChannelCodeTargetForbidden, business: code.Forbidden},
		{err: fmt.Errorf("something else"), expected: relay_svc.ChannelCodeInternal, business: code.ServerError},
	} {
		t.Run(tc.err.Error(), func(t *testing.T) {
			// 包装一层：控制器拿到的从来不是裸 sentinel，服务层会 %w 进去。
			channelCode, businessCode := channelFailure(fmt.Errorf("resolve target: %w", tc.err))
			require.Equal(t, tc.expected, channelCode)
			require.Equal(t, tc.business, businessCode)
			for _, lang := range []string{"zh-CN", "en"} {
				require.NotEmptyf(t, i18n.T(i18n.WithLanguage(context.Background(), lang), businessCode),
					"业务码 %d 在 %s 下解析不出文案", businessCode, lang)
			}
		})
	}

	// 保留通道那一路不经过 channelFailure（它不是一次目标解析失败），但它的码同样
	// 要与别的通道级码区分得开。
	for _, channelCode := range []int32{
		relay_svc.ChannelCodeTargetInvalid, relay_svc.ChannelCodeTargetNotFound,
		relay_svc.ChannelCodeTargetOffline, relay_svc.ChannelCodeForwardFailed,
		relay_svc.ChannelCodeReserved, relay_svc.ChannelCodeSignalUnavailable,
		relay_svc.ChannelCodeTargetForbidden,
		relay_svc.ChannelCodeInternal,
	} {
		require.NotContains(t, seen, channelCode, "两种通道级失败共用了同一个码")
		seen[channelCode] = nil
	}
}
