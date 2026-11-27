package relay_ctr_test

import (
	"errors"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zapcore"

	"github.com/agentre-hub/agentre-server/internal/testutils"
)

func receiveDevice(t *testing.T, ch <-chan int64, msg string) int64 {
	t.Helper()
	select {
	case id := <-ch:
		return id
	case <-time.After(relayWait):
		t.Fatal(msg)
		return 0
	}
}

// K2：连上刷新一次、断开再刷新一次（正常关闭），各一次，不随帧 / 心跳增加。
func TestRelayDaemonTouchesLastSeenOnConnectAndOnOrderlyDisconnect(t *testing.T) {
	stub := daemonStub(t)
	stub.touched = make(chan int64, 8)
	conn := dialDaemon(t, stub)

	require.Equal(t, int64(9), receiveDevice(t, stub.touched, "连上时没有刷新最后在线"))
	require.Empty(t, stub.touched, "连上只写一次")

	require.NoError(t, conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second)))
	require.NoError(t, conn.Close())

	require.Equal(t, int64(9), receiveDevice(t, stub.touched, "断开时没有刷新最后在线"))
}

// 异常断开（进程被杀）同样要在断开那一刻刷新。
func TestRelayDaemonTouchesLastSeenOnAbruptDisconnect(t *testing.T) {
	stub := daemonStub(t)
	stub.touched = make(chan int64, 8)
	conn := dialDaemon(t, stub)
	receiveDevice(t, stub.touched, "连上时没有刷新最后在线")

	require.NoError(t, conn.UnderlyingConn().Close())

	require.Equal(t, int64(9), receiveDevice(t, stub.touched, "异常断开时没有刷新最后在线"))
}

// 写失败只记 Warn，不得断开连接，断开那次也照常尝试。
func TestRelayDaemonLastSeenWriteFailureDoesNotBreakTheConnection(t *testing.T) {
	logs := testutils.Logs(t)
	stub := daemonStub(t)
	stub.touched = make(chan int64, 8)
	stub.touchErr = errors.New("db down")
	conn := dialDaemon(t, stub)
	receiveDevice(t, stub.touched, "连上时没有刷新最后在线")

	warn := awaitRelayLog(t, logs, "relay daemon last_seen refresh failed", byFingerprint(t.Name()), relayWait)
	require.Equal(t, zapcore.WarnLevel, warn.Level)

	// 连接仍然可用：服务端没有因为写失败把它关掉。
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, []byte("x")))
	receiveWithin(t, stub.daemonFrames, relayWait, "写失败后连接不可用")

	require.NoError(t, conn.Close())
	receiveDevice(t, stub.touched, "断开时没有刷新最后在线")
}
