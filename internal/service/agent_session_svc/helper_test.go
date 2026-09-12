package agent_session_svc

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// 这个文件只放本包测试共用的替身与小工具。与 sync_svc / workspace_svc 各自那一份
// 同形：账号通道的替身是**测试自己的**东西，各包按自己那条路要断言什么装配它，
// 不从别的包借。

// accountChanCall 是 stubAccountChan 记下的一次广播。
//
// 帧的种类也记：同一条通道上跑着两类帧（带版本号的 sync_version 与不带版本号的
// 信号），只比对账号与版本号的断言分不出「发出去的是哪一种」——把 mirror_changed
// 错发成 sync_version 会让桌面端白跑一次同步对象的 Pull，而版本号那一格恰好也是 0。
type accountChanCall struct {
	accountID int64
	frameType string
	version   int64
}

// stubAccountChan 是账号级实时通道在服务层测试里的替身（SetDefault 换掉真实的
// Redis 实现），只记调用、可选地模拟广播失败——web 组织面的写路径测试据此断言
// 「广播失败只记录、不回滚已经落库的写入」。
type stubAccountChan struct {
	mu    sync.Mutex
	err   error
	calls []accountChanCall
}

func (s *stubAccountChan) Broadcast(_ context.Context, accountID int64, frame accountchan_svc.Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, accountChanCall{
		accountID: accountID, frameType: frame.Type, version: frame.Version,
	})
	return s.err
}

func (s *stubAccountChan) Subscribe(context.Context, int64) (accountchan_svc.Subscription, error) {
	return nil, errors.New("stubAccountChan: Subscribe not used by write-path tests")
}

func (s *stubAccountChan) recordedCalls() []accountChanCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]accountChanCall(nil), s.calls...)
}

// registerAccountChanStub 换上替身并保证测试结束后恢复成未装配状态（Default() 的
// 安全占位），不让一个测试的广播替身漏到下一个测试里。
func registerAccountChanStub(t *testing.T) *stubAccountChan {
	t.Helper()
	stub := &stubAccountChan{}
	accountchan_svc.SetDefault(stub)
	t.Cleanup(func() { accountchan_svc.SetDefault(nil) })
	return stub
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}
