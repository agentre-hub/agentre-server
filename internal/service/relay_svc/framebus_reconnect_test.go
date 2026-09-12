package relay_svc

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

type staleFrameWriter struct{}

func (staleFrameWriter) WriteMessage(int, []byte) error {
	return errors.New("stale websocket")
}

func TestRedisForwarderNewDaemonAttachmentSupersedesOldConnection(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	forwarder := NewRedisForwarder(config, client)
	attachments := forwarder.(AttachmentForwarder)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}

	detachOld, err := attachments.Attach(
		context.Background(), route, PeerDaemon, "", staleFrameWriter{},
	)
	require.NoError(t, err)

	current := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	detachCurrent, err := attachments.Attach(
		context.Background(), route, PeerDaemon, "", current,
	)
	require.NoError(t, err)
	t.Cleanup(detachCurrent)

	require.NoError(t, forwarder.Forward(
		context.Background(), route, PeerClient, "client-1", 2, []byte("request"),
	))
	select {
	case received := <-current.frames:
		require.Equal(t, []byte("request"), received.frame)
	case <-time.After(time.Second):
		t.Fatal("request was not delivered to the current daemon websocket")
	}

	// 旧 websocket 的 handler 可能在新连接挂上之后才退出；它的清理不能摘掉新连接。
	detachOld()
	require.NoError(t, forwarder.Forward(
		context.Background(), route, PeerClient, "client-1", 2, []byte("after-old-detach"),
	))
	select {
	case received := <-current.frames:
		require.Equal(t, []byte("after-old-detach"), received.frame)
	case <-time.After(time.Second):
		t.Fatal("old daemon detach removed the current daemon websocket")
	}
}

// agentred 重启（换 websocket）之后，浏览器手里那条虚拟通道已经作废：它的鉴权状态
// 活在**旧那条** daemon 连接上，daemon 对新连接上没见过的通道号只会新建一条没握过
// 手的通道，于是那条通道上每个 session.* 都是 Unauthorized。
//
// 所以帧总线不能按指纹把旧通道的帧投给新连接：那是在把一条已经死掉的通道说成还活着
// ——浏览器既收不到实时帧、也没有任何东西告诉它该重开，只能刷新整页。判死它才对，
// 通道级失败会一路走到 clientChannels.fail，客户端据此重开一条。
func TestRedisForwarderClientChannelDoesNotOutliveItsDaemonConnection(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	forwarder := NewRedisForwarder(config, client)
	attachments := forwarder.(AttachmentForwarder)
	// 通道是在 conn-a 上开的（ResolveTarget 当时解出来的就是这一条链路）。
	opened := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID, ConnID: "conn-a"}
	// daemon 重启之后挂上来的是 conn-b。
	relinked := opened
	relinked.ConnID = "conn-b"

	current := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	detach, err := attachments.Attach(context.Background(), relinked, PeerDaemon, "", current)
	require.NoError(t, err)
	t.Cleanup(detach)

	err = forwarder.Forward(context.Background(), opened, PeerClient, "client-1", 2, []byte("request"))
	require.Error(t, err, "旧通道的帧不该被投给换过链路的 daemon")
	select {
	case received := <-current.frames:
		t.Fatalf("stale channel frame reached the relinked daemon: %q", received.frame)
	default:
	}

	// 新链路上开的通道照常走得通。
	require.NoError(t, forwarder.Forward(
		context.Background(), relinked, PeerClient, "client-2", 2, []byte("fresh"),
	))
	select {
	case received := <-current.frames:
		require.Equal(t, []byte("fresh"), received.frame)
	case <-time.After(time.Second):
		t.Fatal("frame on the current connection was not delivered")
	}
}
