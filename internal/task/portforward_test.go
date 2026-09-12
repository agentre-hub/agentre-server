package task

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre/pkg/wire/protorpc"

	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
)

// noopDialer 从不真的被调用：下面两个用例要么在拨号之前就把池停了，要么池根本
// 没装配，都轮不到它。留一个会 panic 的实现，免得测试悄悄改成「其实拨了号」。
type noopDialer struct{}

func (noopDialer) DialPortForward(
	_ context.Context, _ int64, _ string, _ time.Duration,
) (*protorpc.Conn, func(), error) {
	panic("portforward_test: DialPortForward should not be reached")
}

// Given 端口转发连接池已经装配好；When 进程退出、cago 逐个关掉组件；
// Then 它当场收工——此后任何借用都被拒（ErrStopped）。少了这一步，进程退出时
// 池里还留着的连接与中继订阅没人收，得等对端自己发现连接断了。
func TestPortForwardResident_CloseHandle_StopsThePool(t *testing.T) {
	pool := portforward_svc.New(portforward_svc.Config{}, noopDialer{})
	portforward_svc.SetDefault(pool)
	t.Cleanup(func() { portforward_svc.SetDefault(nil) })
	component := PortForwardResident()
	require.NoError(t, component.Start(context.Background(), nil))

	component.CloseHandle()

	_, _, err := pool.Acquire(context.Background(), 7, "fp-daemon-1", 3000)
	require.ErrorIs(t, err, portforward_svc.ErrStopped, "收工之后不该再借出连接")
}

// Given 这个部署没有装配端口转发池；When 组件起停；Then 什么都不做，不 panic——
// 不跑端口转发的部署（以及不建整套依赖的测试）照样起得来、停得下。
func TestPortForwardResident_NotConfigured_StartsAndStopsQuietly(t *testing.T) {
	portforward_svc.SetDefault(nil)
	component := PortForwardResident()

	require.NoError(t, component.Start(context.Background(), nil))
	component.CloseHandle()
}
