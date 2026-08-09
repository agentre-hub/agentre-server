package crontab

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"

	"agentre-server/internal/service/sync_svc"
)

// stubSyncSvc 只关心 ReclaimExpired 被调了几次、失败时怎么传出去；其余方法凑齐
// 接口即可。
type stubSyncSvc struct {
	reclaims int
	err      error
}

func (s *stubSyncSvc) Push(context.Context, sync_svc.PushInput) (*sync_svc.PushOutput, error) {
	return &sync_svc.PushOutput{}, nil
}
func (s *stubSyncSvc) Pull(context.Context, sync_svc.PullInput) (*sync_svc.PullOutput, error) {
	return &sync_svc.PullOutput{}, nil
}
func (s *stubSyncSvc) ReportLocalPaths(context.Context, sync_svc.LocalPathsInput) error { return nil }
func (s *stubSyncSvc) PutAvatar(context.Context, sync_svc.AvatarInput) error            { return nil }
func (s *stubSyncSvc) GetAvatar(context.Context, int64, string) (*sync_svc.AvatarOutput, error) {
	return &sync_svc.AvatarOutput{}, nil
}
func (s *stubSyncSvc) PurgeDeviceLocalPaths(context.Context, int64) error { return nil }
func (s *stubSyncSvc) ReclaimExpired(context.Context) (*sync_svc.ReclaimOutput, error) {
	s.reclaims++
	if s.err != nil {
		return nil, s.err
	}
	return &sync_svc.ReclaimOutput{Tombstones: 3, Avatars: 2}, nil
}

var _ sync_svc.SyncSvc = (*stubSyncSvc)(nil)

func withStubSyncSvc(t *testing.T, stub *stubSyncSvc) {
	t.Helper()
	orig := sync_svc.Default()
	sync_svc.SetDefault(stub)
	t.Cleanup(func() { sync_svc.SetDefault(orig) })
}

// 决策 9 + R16a 的服务端那一半得真有人按周期触发，否则墓碑与无人引用的头像
// 只会一直堆着。这条锁住「定时任务确实走到了 service」这个连接。
func TestReclaimSyncGarbage_ThenDelegatesToSyncSvc(t *testing.T) {
	stub := &stubSyncSvc{}
	withStubSyncSvc(t, stub)

	assert.NoError(t, ReclaimSyncGarbage(context.Background()))
	assert.Equal(t, 1, stub.reclaims)
}

// 失败要如实返回给 cron 包装器，让它按一次任务失败记账，而不是被吞掉当成
// 「这一轮没有可回收的东西」。
func TestReclaimSyncGarbage_GivenServiceError_ThenPropagates(t *testing.T) {
	stub := &stubSyncSvc{err: assert.AnError}
	withStubSyncSvc(t, stub)

	assert.ErrorIs(t, ReclaimSyncGarbage(context.Background()), assert.AnError)
}
