package mirror_svc

import (
	"context"
	"sync"
	"testing"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// redisTrips 数一条 Redis 客户端上发出去的往返：单发一条命令算一次 command，一整个
// pipeline 算一次 pipeline。批量读取要证明的正是「单发为零、pipeline 不随台数增长」。
type redisTrips struct {
	mu        sync.Mutex
	commands  int
	pipelines int
}

func (h *redisTrips) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (h *redisTrips) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		h.mu.Lock()
		h.commands++
		h.mu.Unlock()
		return next(ctx, cmd)
	}
}

func (h *redisTrips) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		h.mu.Lock()
		h.pipelines++
		h.mu.Unlock()
		return next(ctx, cmds)
	}
}

func (h *redisTrips) reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.commands, h.pipelines = 0, 0
}

func (h *redisTrips) counts() (commands, pipelines int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.commands, h.pipelines
}

// batchRedis 起一个 miniredis 和连着它的客户端。RESP2 且不发 CLIENT SETINFO：连接
// 建立时不夹带握手命令，计数里只剩被测的读取；用例在准备好数据之后 reset 一次。
func batchRedis(t *testing.T) (*miniredis.Miniredis, *goredis.Client, *redisTrips) {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr(), Protocol: 2, DisableIdentity: true})
	t.Cleanup(func() { _ = client.Close() })
	trips := &redisTrips{}
	client.AddHook(trips)
	return mini, client, trips
}

// singleReads 是逐台读取时的答案（ProtocolMismatch + DaemonBuild），批量读取必须与它逐格相同。
func singleReads(ctx context.Context, s *Supervisor, userID int64, fingerprints []string) []HandshakeState {
	out := make([]HandshakeState, 0, len(fingerprints))
	for _, fp := range fingerprints {
		commit, known := s.DaemonBuild(ctx, userID, fp)
		out = append(out, HandshakeState{
			ProtocolMismatch: s.ProtocolMismatch(ctx, userID, fp),
			DaemonCommit:     commit,
			DaemonBuildKnown: known,
		})
	}
	return out
}

// Given 三台机器：一台协议不合且握手报了 commit，一台握手报的是空 commit，一台从没握过手；
// When 一次批量读取它们的握手状态；
// Then 一个 pipeline 读完、没有单发命令，每台的答案与逐台读取时逐格相同、顺序与入参一致。
func TestHandshakeStates_GivenSeveralMachines_ThenOnePipelineAnswersAsTheSingleReadsDo(t *testing.T) {
	ctx := context.Background()
	_, client, trips := batchRedis(t)
	sup := NewSupervisor(Config{InstanceID: "server-a"}, nil, nil, client)
	sup.RecordProtocolMismatch(ctx, 7, "fp-a")
	sup.RecordDaemonBuild(ctx, 7, "fp-a", "a1b2c3d")
	sup.RecordDaemonBuild(ctx, 7, "fp-b", "")
	// 别的账号下同一个指纹的记录不能串到这个账号上。
	sup.RecordProtocolMismatch(ctx, 8, "fp-c")
	fingerprints := []string{"fp-a", "fp-b", "fp-c"}
	trips.reset()

	got := sup.HandshakeStates(ctx, 7, fingerprints)

	commands, pipelines := trips.counts()
	assert.Zero(t, commands)
	assert.Equal(t, 1, pipelines)
	assert.Equal(t, []HandshakeState{
		{ProtocolMismatch: true, DaemonCommit: "a1b2c3d", DaemonBuildKnown: true},
		{DaemonCommit: "", DaemonBuildKnown: true},
		{},
	}, got)
	assert.Equal(t, singleReads(ctx, sup, 7, fingerprints), got)
}

// Given 只有一台机器的 commit 记录读不出来（键被写成了别的类型，GET 回 WRONGTYPE）；
// Then 只有那一台退回「不知道」，同一批里的其余机器照常作答——与逐台读取时一台失败
// 不牵连别台的行为相同。
func TestHandshakeStates_GivenOneMachinesRecordUnreadable_ThenOnlyThatMachineIsUnknown(t *testing.T) {
	ctx := context.Background()
	mini, client, _ := batchRedis(t)
	sup := NewSupervisor(Config{InstanceID: "server-a"}, nil, nil, client)
	sup.RecordDaemonBuild(ctx, 7, "fp-a", "a1b2c3d")
	sup.RecordDaemonBuild(ctx, 7, "fp-c", "c3c3c3c")
	mini.HSet(daemonBuildKey(machineKey{userID: 7, fingerprint: "fp-b"}), "field", "value")
	fingerprints := []string{"fp-a", "fp-b", "fp-c"}

	got := sup.HandshakeStates(ctx, 7, fingerprints)

	assert.Equal(t, []HandshakeState{
		{DaemonCommit: "a1b2c3d", DaemonBuildKnown: true},
		{},
		{DaemonCommit: "c3c3c3c", DaemonBuildKnown: true},
	}, got)
	assert.Equal(t, singleReads(ctx, sup, 7, fingerprints), got)
}

// Given Redis 整个读不出来；Then 每台机器都是「没有不匹配、不知道构建」，而不是报错
// ——握手状态是设备列表的增强列，fail-open 与逐台读取时相同。
func TestHandshakeStates_GivenRedisFailing_ThenEveryMachineReadsAsNothingKnown(t *testing.T) {
	ctx := context.Background()
	mini, client, _ := batchRedis(t)
	sup := NewSupervisor(Config{InstanceID: "server-a"}, nil, nil, client)
	sup.RecordProtocolMismatch(ctx, 7, "fp-a")
	sup.RecordDaemonBuild(ctx, 7, "fp-a", "a1b2c3d")
	mini.SetError("ERR redis is down")
	fingerprints := []string{"fp-a", "fp-b"}

	got := sup.HandshakeStates(ctx, 7, fingerprints)

	assert.Equal(t, []HandshakeState{{}, {}}, got)
	assert.Equal(t, singleReads(ctx, sup, 7, fingerprints), got)
}

// Given 没装配镜像（nil 接收者）或镜像没有 Redis；Then 每台机器照样有一格零值答案、不 panic。
func TestHandshakeStates_GivenNoMirrorOrNoRedis_ThenEveryMachineReadsAsNothingKnown(t *testing.T) {
	ctx := context.Background()
	var unconfigured *Supervisor
	require.Equal(t, []HandshakeState{{}, {}}, unconfigured.HandshakeStates(ctx, 7, []string{"fp-a", "fp-b"}))

	noRedis := NewSupervisor(Config{InstanceID: "server-a"}, nil, nil, nil)
	require.Equal(t, []HandshakeState{{}, {}}, noRedis.HandshakeStates(ctx, 7, []string{"fp-a", "fp-b"}))
}

// Given 账号下一台机器都没有；Then 不发任何 Redis 往返。
func TestHandshakeStates_GivenNoMachines_ThenNoRoundTrip(t *testing.T) {
	ctx := context.Background()
	_, client, trips := batchRedis(t)
	sup := NewSupervisor(Config{InstanceID: "server-a"}, nil, nil, client)

	got := sup.HandshakeStates(ctx, 7, nil)

	assert.Empty(t, got)
	commands, pipelines := trips.counts()
	assert.Zero(t, commands)
	assert.Zero(t, pipelines)
}
