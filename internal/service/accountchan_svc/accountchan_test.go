package accountchan_svc

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newClient(t *testing.T, mini *miniredis.Miniredis) *goredis.Client {
	t.Helper()
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	return client
}

func receiveFrame(t *testing.T, frames <-chan Frame, failure string) Frame {
	t.Helper()
	select {
	case frame, ok := <-frames:
		require.True(t, ok, failure+"：信号通道已关闭")
		return frame
	case <-time.After(2 * time.Second):
		t.Fatal(failure)
		return Frame{}
	}
}

// 广播是**一对多且跨副本**的：写入落在哪个副本上无关紧要，该账号挂在任意副本上的
// 每一条订阅都要收到同一条信号。进程内的扇出实现会让这个用例挂掉——两个 svc 是
// 两个独立实例，中间只有一份 Redis。
func TestBroadcastReachesEverySubscriberAcrossReplicas(t *testing.T) {
	ctx := context.Background()
	mini := miniredis.RunT(t)
	replicaA := New(newClient(t, mini))
	replicaB := New(newClient(t, mini))

	onA, err := replicaA.Subscribe(ctx, 7)
	require.NoError(t, err)
	t.Cleanup(onA.Close)
	onB, err := replicaB.Subscribe(ctx, 7)
	require.NoError(t, err)
	t.Cleanup(onB.Close)
	otherAccount, err := replicaB.Subscribe(ctx, 8)
	require.NoError(t, err)
	t.Cleanup(otherAccount.Close)

	require.NoError(t, replicaA.Broadcast(ctx, 7, Frame{Type: FrameTypeSyncVersion, Version: 42}))

	require.Equal(t, Frame{Type: FrameTypeSyncVersion, Version: 42},
		receiveFrame(t, onA.Signals(), "发起广播的那个副本上的连接没收到信号"))
	require.Equal(t, Frame{Type: FrameTypeSyncVersion, Version: 42},
		receiveFrame(t, onB.Signals(), "另一个副本上的连接没收到信号：扇出没有跨副本"))
	select {
	case frame := <-otherAccount.Signals():
		t.Fatalf("另一个账号的订阅收到了不属于它的信号：%+v", frame)
	case <-time.After(100 * time.Millisecond):
	}
}

// 帧是自描述的：一个类型标记加一个版本号，别的什么都不带（决策 18 / 20）。
// 类型标记是日后新增通知种类的扩展点，客户端按它分派。
func TestFrameCarriesTypeMarkerAndVersionAsJSON(t *testing.T) {
	payload, err := Frame{Type: FrameTypeSyncVersion, Version: 9}.Encode()
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"sync_version","version":9}`, string(payload))

	decoded, err := DecodeFrame(payload)
	require.NoError(t, err)
	require.Equal(t, Frame{Type: FrameTypeSyncVersion, Version: 9}, decoded)

	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(payload, &raw))
	require.Len(t, raw, 2, "帧只带类型与版本，不夹带对象内容")
}

// 信号只携带版本号，因此压在信箱里没发出去的那些可以合并成最新的一条：慢客户端
// 不需要背压，也不该把扇出堵住。乱序到达时合并的结果取版本更大的那条。
func TestPendingSignalsMergeIntoTheLatestVersion(t *testing.T) {
	box := newSignalBox()

	box.offer(Frame{Type: FrameTypeSyncVersion, Version: 1})
	box.offer(Frame{Type: FrameTypeSyncVersion, Version: 3})
	box.offer(Frame{Type: FrameTypeSyncVersion, Version: 2})

	require.Equal(t, Frame{Type: FrameTypeSyncVersion, Version: 3},
		receiveFrame(t, box.signals(), "没读走的信号没有合并成最新的一条"))
	select {
	case frame := <-box.signals():
		t.Fatalf("合并之后信箱里不该再有别的信号：%+v", frame)
	case <-time.After(50 * time.Millisecond):
	}
}

// 没装配过真实实现时（只跑了一部分 bootstrap 的测试或 handler），Default() 必须
// 给出一个明确报错的占位实现，而不是 nil 接口——调用方拿到的是错误，不是 panic。
func TestDefaultIsNeverNilWithoutRegistration(t *testing.T) {
	SetDefault(nil)
	require.NotNil(t, Default())
	require.ErrorIs(t, Broadcast(context.Background(), 7, Frame{Type: FrameTypeSyncVersion, Version: 1}), ErrChannelUnconfigured)
	_, err := Default().Subscribe(context.Background(), 7)
	require.ErrorIs(t, err, ErrChannelUnconfigured)
}

// 合并是**按种类**合的，不是整个信箱只留一条。通道日后会承载别的通知（帧上带类型
// 标记正是为此），而这些通知彼此无关：一条「镜像变了」不该因为信箱里压着一条
// 「同步版本推进了」就被丢掉，反过来也一样。单槽 + 按版本号取大的合并会让两者
// 互相吃掉——版本号在别的种类上根本没有意义，拿它去比等于随机丢一条。
func TestPendingSignalsOfDifferentTypesEachKeepTheirOwnSlot(t *testing.T) {
	box := newSignalBox()

	// 「别的种类」在这里用字面量：信箱不该认得任何具体种类，它只按 Type 分格。
	box.offer(Frame{Type: FrameTypeSyncVersion, Version: 7})
	box.offer(Frame{Type: "other"})

	got := map[string]Frame{}
	for range 2 {
		frame := receiveFrame(t, box.signals(), "按种类分格的信号被合掉了一条")
		got[frame.Type] = frame
	}
	require.Equal(t, Frame{Type: FrameTypeSyncVersion, Version: 7}, got[FrameTypeSyncVersion])
	require.Equal(t, Frame{Type: "other"}, got["other"])
}

// recordingSvc 记下广播出去的每一帧。SetDefault 换掉的是包级入口，所以两个
// BestEffort 帮手实际发了什么，只有在这一层才看得见。
type recordingSvc struct {
	mu     sync.Mutex
	frames []Frame
}

func (s *recordingSvc) Broadcast(_ context.Context, _ int64, frame Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, frame)
	return nil
}

func (s *recordingSvc) Subscribe(context.Context, int64) (Subscription, error) {
	return nil, ErrChannelUnconfigured
}

func (s *recordingSvc) recorded() []Frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Frame(nil), s.frames...)
}

func recordBroadcasts(t *testing.T) *recordingSvc {
	t.Helper()
	svc := &recordingSvc{}
	SetDefault(svc)
	t.Cleanup(func() { SetDefault(nil) })
	return svc
}

// 不在 sync_objects 版本序列上的变更（镜像会话、设备上下线）没有版本号可带，也不
// 需要：帧上的种类就是全部信息。它们不能借道 BroadcastBestEffort——那一条会把
// version<=0 当成「没有变化」直接丢掉，而且发出去的是 sync_version，桌面端收到会
// 白跑一次同步对象的 Pull。
func TestSignalWithoutVersionKeepsItsOwnTypeAndIsNotGatedOnVersion(t *testing.T) {
	svc := recordBroadcasts(t)

	BroadcastSignalBestEffort(context.Background(), 7, FrameTypeMirrorChanged)
	BroadcastSignalBestEffort(context.Background(), 7, FrameTypeDevicePresence)
	// 空种类是调用方的错，发一条读不懂的帧没有意义：什么都不发。
	BroadcastSignalBestEffort(context.Background(), 7, "")

	require.Equal(t, []Frame{
		{Type: FrameTypeMirrorChanged},
		{Type: FrameTypeDevicePresence},
	}, svc.recorded())
}

// 同步对象那一条的两条规矩没有因为改走同一个底座而丢：发的是 sync_version，
// 且 version<=0 什么都不发。
func TestSyncVersionSignalStillCarriesItsTypeAndDropsEmptyVersions(t *testing.T) {
	svc := recordBroadcasts(t)

	BroadcastBestEffort(context.Background(), 7, 42)
	BroadcastBestEffort(context.Background(), 7, 0)
	BroadcastBestEffort(context.Background(), 7, -1)

	require.Equal(t, []Frame{{Type: FrameTypeSyncVersion, Version: 42}}, svc.recorded())
}
