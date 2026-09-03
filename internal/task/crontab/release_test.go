package crontab

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/service/release_svc"
)

// stubReleaseSvc 只记下 Pull 被调了几次、失败时怎么传出去。
type stubReleaseSvc struct {
	release_svc.ReleaseSvc
	pulls int
	err   error
}

func (s *stubReleaseSvc) Pull(context.Context) error {
	s.pulls++
	return s.err
}

func withStubRelease(t *testing.T, stub *stubReleaseSvc) {
	t.Helper()
	orig := release_svc.Release()
	release_svc.SetDefault(stub)
	t.Cleanup(func() { release_svc.SetDefault(orig) })
}

// 定时任务确实要触到 release_svc.Pull，否则控制台的 latest 永远停在「不知道」。
func TestPullLatestRelease_ThenDelegatesToReleaseSvc(t *testing.T) {
	stub := &stubReleaseSvc{}
	withStubRelease(t, stub)

	assert.NoError(t, PullLatestRelease(context.Background()))
	assert.Equal(t, 1, stub.pulls)
}

// 上游失败时把错误交回给调用方（withPeriodLock 上一层记日志），而不是吞掉——吞掉的话
// 一次持续性的上游故障永远不会被任何人看到。
func TestPullLatestRelease_UpstreamFails_ReturnsError(t *testing.T) {
	stub := &stubReleaseSvc{err: errors.New("upstream unreachable")}
	withStubRelease(t, stub)

	assert.Error(t, PullLatestRelease(context.Background()))
}

// 没装配这个服务的部署（只跑 device flow 的场合，或者本来就没打开这条链路）：
// 什么都不做、不 panic——与 mirror_svc / sync_svc 的既有先例同理。
func TestPullLatestRelease_NotConfigured_NoOp(t *testing.T) {
	orig := release_svc.Release()
	release_svc.SetDefault(nil)
	t.Cleanup(func() { release_svc.SetDefault(orig) })

	assert.NoError(t, PullLatestRelease(context.Background()))
}
