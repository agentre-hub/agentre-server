package relay_svc

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// tripCounter 数一条 Redis 客户端上发出去的往返：单发一条命令算一次 command，一整个
// pipeline 算一次 pipeline。与 countingHook（数命令条数）不同，这里要分清的是
// 「逐台单发」与「一批读完」。
type tripCounter struct {
	mu        sync.Mutex
	commands  int
	pipelines int
}

func (h *tripCounter) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (h *tripCounter) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		h.mu.Lock()
		h.commands++
		h.mu.Unlock()
		return next(ctx, cmd)
	}
}

func (h *tripCounter) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		h.mu.Lock()
		h.pipelines++
		h.mu.Unlock()
		return next(ctx, cmds)
	}
}

func (h *tripCounter) reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.commands, h.pipelines = 0, 0
}

func (h *tripCounter) counts() (commands, pipelines int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.commands, h.pipelines
}

// newPresenceRelay 起一份真实 relaySvc，客户端上挂着往返计数。RESP2 且不发
// CLIENT SETINFO：连接建立时不夹带握手命令，用例准备好数据之后 reset 一次。
func newPresenceRelay(t *testing.T) (*relaySvc, *miniredis.Miniredis, *tripCounter) {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr(), Protocol: 2, DisableIdentity: true})
	t.Cleanup(func() { _ = client.Close() })
	trips := &tripCounter{}
	client.AddHook(trips)
	svc := New(Config{InstanceID: "server-a", OnlineTTL: time.Minute}, nil, nil, client, fakeForwarder{})
	return svc.(*relaySvc), mini, trips
}

// singleOnline 是逐台 IsDaemonOnline 的答案，批量读取必须与它逐格相同。
func singleOnline(ctx context.Context, svc *relaySvc, accountID int64, fingerprints []string) []bool {
	out := make([]bool, 0, len(fingerprints))
	for _, fp := range fingerprints {
		online, _ := svc.IsDaemonOnline(ctx, accountID, fp)
		out = append(out, online)
	}
	return out
}

// Given 三台机器里两台登记了在线（另一个账号下还有一台同指纹的在线登记）；
// When 一次批量问这个账号下三台的在线态；
// Then 一个 pipeline 读完、没有单发命令，答案顺序与入参一致，并与逐台 IsDaemonOnline 相同。
func TestDaemonsOnline_GivenSeveralMachines_ThenOnePipelineAnswersAsIsDaemonOnlineDoes(t *testing.T) {
	ctx := context.Background()
	svc, _, trips := newPresenceRelay(t)
	require.NoError(t, svc.RegisterDaemon(ctx, Route{AccountID: 7, Fingerprint: "fp-a", InstanceID: "server-a"}))
	require.NoError(t, svc.RegisterDaemon(ctx, Route{AccountID: 7, Fingerprint: "fp-c", InstanceID: "server-a"}))
	require.NoError(t, svc.RegisterDaemon(ctx, Route{AccountID: 8, Fingerprint: "fp-b", InstanceID: "server-a"}))
	fingerprints := []string{"fp-a", "fp-b", "fp-c"}
	trips.reset()

	got, err := svc.DaemonsOnline(ctx, 7, fingerprints)

	require.NoError(t, err)
	commands, pipelines := trips.counts()
	assert.Zero(t, commands)
	assert.Equal(t, 1, pipelines)
	assert.Equal(t, []bool{true, false, true}, got)
	assert.Equal(t, singleOnline(ctx, svc, 7, fingerprints), got)
}

// Given 登记会过期（R20：无人续期即离线）；Then 批量读取同样认过期，与逐台读取相同。
func TestDaemonsOnline_GivenARegistrationExpired_ThenThatMachineIsOffline(t *testing.T) {
	ctx := context.Background()
	svc, mini, _ := newPresenceRelay(t)
	require.NoError(t, svc.RegisterDaemon(ctx, Route{AccountID: 7, Fingerprint: "fp-a", InstanceID: "server-a"}))
	mini.FastForward(2 * time.Minute)

	got, err := svc.DaemonsOnline(ctx, 7, []string{"fp-a"})

	require.NoError(t, err)
	assert.Equal(t, []bool{false}, got)
}

// Given Redis 读不出来；Then 每台机器都答离线、并把错误交给调用方——与逐台
// IsDaemonOnline 的 (false, err) 同一出口，要不要 fail-open 由调用方决定。
func TestDaemonsOnline_GivenRedisFailing_ThenEveryMachineIsOfflineAndTheErrorIsReported(t *testing.T) {
	ctx := context.Background()
	svc, mini, _ := newPresenceRelay(t)
	require.NoError(t, svc.RegisterDaemon(ctx, Route{AccountID: 7, Fingerprint: "fp-a", InstanceID: "server-a"}))
	mini.SetError("ERR redis is down")

	got, err := svc.DaemonsOnline(ctx, 7, []string{"fp-a", "fp-b"})

	require.Error(t, err)
	assert.Equal(t, []bool{false, false}, got)
	_, singleErr := svc.IsDaemonOnline(ctx, 7, "fp-a")
	require.Error(t, singleErr)
}

// Given 一台机器都没有；Then 不发任何 Redis 往返。
func TestDaemonsOnline_GivenNoMachines_ThenNoRoundTrip(t *testing.T) {
	ctx := context.Background()
	svc, _, trips := newPresenceRelay(t)

	got, err := svc.DaemonsOnline(ctx, 7, nil)

	require.NoError(t, err)
	assert.Empty(t, got)
	commands, pipelines := trips.counts()
	assert.Zero(t, commands)
	assert.Zero(t, pipelines)
}
