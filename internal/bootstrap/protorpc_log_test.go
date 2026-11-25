package bootstrap

import (
	"context"
	"testing"
	"time"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/protorpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// Given 服务端启动时交出了 protorpc 的 logger 来源,
// When 对端的 RPC handler panic,
// Then protorpc 的 panic 行落进服务端 logger(而不是被丢进 zap 的空实现)。
func TestInstallProtorpcLogger_GivenHandlerPanic_ThenPanicLineReachesServerLogger(t *testing.T) {
	InstallProtorpcLogger()
	logs := testutils.Logs(t)

	clientTransport, deviceTransport := testutils.NewFramePipe()
	client := protorpc.NewConn(clientTransport, protorpc.NewRegistry(), protorpc.WithCallTimeout(5*time.Second))
	device := protorpc.NewConn(deviceTransport, protorpc.NewRegistry())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go client.Serve(ctx)
	go device.Serve(ctx)
	method := uint32(agentrewire.RpcMethod_RPC_METHOD_PORT_FORWARD_OPEN)
	protorpc.RegisterMethod(device.Registry(), method,
		func() *agentrewire.PortForwardOpenRequest { return &agentrewire.PortForwardOpenRequest{} },
		func(_ context.Context, _ *agentrewire.PortForwardOpenRequest) (*agentrewire.PortForwardOpenResponse, error) {
			panic("boom")
		})

	err := protorpc.CallMessage(ctx, client, method,
		&agentrewire.PortForwardOpenRequest{}, &agentrewire.PortForwardOpenResponse{})
	require.Error(t, err, "panic 翻成错误交回对端")
	assert.Equal(t, 1, logs.FilterMessage("protorpc: rpc handler panic").Len())
}
