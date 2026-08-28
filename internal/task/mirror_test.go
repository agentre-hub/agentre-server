package task

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
)

// Given 常驻镜像已经装配好；When 进程退出、cago 逐个关掉组件；
// Then 它当场收工——此后任何认领都被拒（ErrStopped），手里的租约立刻让出，
// 接手的副本不必等一整个 TTL。少了这一步，退出的副本会带着一份没人续期的租约走人。
func TestMirrorResident_CloseHandle_StopsTheResident(t *testing.T) {
	sup := mirror_svc.NewSupervisor(mirror_svc.Config{InstanceID: "task-test"}, nil, nil, nil)
	mirror_svc.SetDefault(sup)
	t.Cleanup(func() { mirror_svc.SetDefault(nil) })
	component := MirrorResident()
	require.NoError(t, component.Start(context.Background(), nil))

	component.CloseHandle()

	_, err := sup.Follow(context.Background(), 7, "fp-daemon-1",
		[]mirror_svc.SavedSession{{PeerFingerprint: "fp-daemon-1", SessionID: "42"}})
	require.ErrorIs(t, err, mirror_svc.ErrStopped, "收工之后不该再认领机器")
}

// Given 这个部署没有装配镜像；When 组件起停；Then 什么都不做，不 panic——
// 只跑 device flow 的部署（以及不建整套依赖的测试）照样起得来、停得下。
func TestMirrorResident_NotConfigured_StartsAndStopsQuietly(t *testing.T) {
	mirror_svc.SetDefault(nil)
	component := MirrorResident()

	require.NoError(t, component.Start(context.Background(), nil))
	component.CloseHandle()
}
