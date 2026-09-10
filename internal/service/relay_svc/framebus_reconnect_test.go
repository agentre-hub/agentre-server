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
