package relay_svc

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// 消费循环的退避重试本身已经有用例钉住（TestRedisForwarderConsumerRecoversFrom
// TransientRedisFailure）。这里钉的是另一件事：它退避的时候得说出来。
//
// 从前 consumeOnce 只交回一个 bool，Redis 的错误连函数都出不去，于是一次主从切换
// 的现场是「每一帧都等满 deliveryWaitTimeout，服务端一行日志都没有」——排查的人
// 手上只有「慢」，没有「为什么慢」。

// attachedForwarderForOutage 起一个只服务本用例的 forwarder，并让它的 stream key
// 带上用例名：日志观测点是全进程共用的，用例之间必须靠字段分得开。
func attachedForwarderForOutage(t *testing.T) (*miniredis.Miniredis, string) {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-b", OnlineTTL: time.Second}
	forwarder := NewRedisForwarder(config, client)
	route := Route{AccountID: 7, Fingerprint: t.Name(), InstanceID: config.InstanceID}

	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	detach, err := forwarder.(AttachmentForwarder).Attach(
		context.Background(), route, PeerDaemon, "", writer,
	)
	require.NoError(t, err)
	t.Cleanup(detach)
	return mini, streamKey(route)
}

func outageLines(logs *observer.ObservedLogs, message, stream string) []observer.LoggedEntry {
	return logs.Filter(func(entry observer.LoggedEntry) bool {
		return entry.Message == message && entry.ContextMap()["stream"] == stream
	}).All()
}

func awaitOutageLine(
	t *testing.T, logs *observer.ObservedLogs, message, stream string, within time.Duration,
) observer.LoggedEntry {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if found := outageLines(logs, message, stream); len(found) > 0 {
			return found[0]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("日志里始终没有出现 %q（stream=%s）；实际记下的是 %v",
		message, stream, logs.AllUntimed())
	return observer.LoggedEntry{}
}

// 一次抖动：说一次「断了，正在退避」，恢复之后说一次「回来了」，中间的每一次重试
// 不再各说一遍——50ms 起步的阶梯会把一次十分钟的故障刷成几万行，那等于没有日志。
func TestRedisForwarderConsumerWarnsOnceOnATransientOutageAndSaysWhenItRecovers(t *testing.T) {
	logs := testutils.Logs(t)
	mini, stream := attachedForwarderForOutage(t)

	mini.SetError("LOADING Redis is loading the dataset in memory")
	interrupted := awaitOutageLine(t, logs,
		"relay frame bus consumer interrupted, retrying", stream, 2*time.Second)
	time.Sleep(300 * time.Millisecond)
	mini.SetError("")

	fields := interrupted.ContextMap()
	require.Equal(t, zapcore.WarnLevel, interrupted.Level, "一次能自愈的抖动是 Warn，不是 Error")
	require.Equal(t, "server-b", fields["instanceId"])
	require.Contains(t, fields["error"], "LOADING", "Redis 交回的原因必须留在日志里")

	recovered := awaitOutageLine(t, logs,
		"relay frame bus consumer recovered", stream, 3*time.Second)
	require.Equal(t, zapcore.InfoLevel, recovered.Level)
	require.Positive(t, recovered.ContextMap()["attempts"], "恢复那一行要带上试了多少次")

	require.Len(t, outageLines(logs, "relay frame bus consumer interrupted, retrying", stream), 1,
		"一次故障只说一遍，重试不逐次刷屏")
	require.Empty(t, outageLines(logs, "relay frame bus consumer down", stream),
		"能自愈的抖动不该升到 Error——Error 是要人来看的")
}

// 持续故障：退避打满之后升一级到 Error。这是「不是抖动，是真的挂了」的那条线，
// 也是告警该挂的那一行；升级之后同样只说一遍，不随重试刷屏。
func TestRedisForwarderConsumerEscalatesToErrorWhenTheOutagePersists(t *testing.T) {
	logs := testutils.Logs(t)
	mini, stream := attachedForwarderForOutage(t)

	mini.SetError("CLUSTERDOWN The cluster is down")
	t.Cleanup(func() { mini.SetError("") })

	down := awaitOutageLine(t, logs, "relay frame bus consumer down", stream, 10*time.Second)
	fields := down.ContextMap()
	require.Equal(t, zapcore.ErrorLevel, down.Level)
	require.Equal(t, "server-b", fields["instanceId"])
	require.Equal(t, int64(consumerOutageEscalation), fields["attempts"],
		"升级点就是退避打满那一刻，不是随便一个数")
	require.Contains(t, fields["error"], "CLUSTERDOWN")
	require.NotEmpty(t, fields["outage"], "要能一眼看出断了多久")

	time.Sleep(2 * time.Second)
	require.Len(t, outageLines(logs, "relay frame bus consumer down", stream), 1,
		"升级之后不再逐次重复，一次故障在 Error 上只留一行")
	require.Len(t, outageLines(logs, "relay frame bus consumer interrupted, retrying", stream), 1)
}
