package mirror_svc

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// notifyWindow 是这些用例用的攒批窗口。取得比生产值小得多，但仍远大于一次
// broadcast 回调的耗时——用例断言的是攒批的形状，不是任何一段真实时长。
const notifyWindow = 50 * time.Millisecond

type broadcastLog struct {
	mu   sync.Mutex
	seen []int64
}

func (l *broadcastLog) record(_ context.Context, userID int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seen = append(l.seen, userID)
}

func (l *broadcastLog) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.seen)
}

// countFor 只数某一个账号的广播。打共享单例 mirrorChanges 的用例必须用它：那份
// broadcast 出口是**进程级**的，包里别的用例经 New() 建出来的 Mirror 同样接在它上面，
// 那些账号留下的窗口会在三秒后把尾补送进这里的 log 里，冒充成本用例自己的那一条。
func (l *broadcastLog) countFor(userID int64) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, seen := range l.seen {
		if seen == userID {
			n++
		}
	}
	return n
}

func (l *broadcastLog) accounts() []int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]int64(nil), l.seen...)
}

func newTestSignals(t *testing.T) (*changeSignals, *broadcastLog) {
	t.Helper()
	log := &broadcastLog{}
	return &changeSignals{window: notifyWindow, broadcast: log.record}, log
}

// 第一条变更**立刻**发出去，不等窗口。攒批是给活跃对话降噪用的，不是给每一次变更
// 都加一个窗口的延迟：用户发完消息看到的第一条回复不该先等一个窗口。
func TestFirstChangeSignalsImmediately(t *testing.T) {
	signals, log := newTestSignals(t)

	signals.changed(context.Background(), 7)

	require.Equal(t, 1, log.count(), "第一条变更没有立刻发出去")
}

// 窗口内连着来的变更压成一条：窗口结束时补发一次，把这段时间里最后的状态带出去。
// 补发不能省——否则一轮对话最后那一次变更要等 30 秒兜底轮询才看得到。
func TestChangesInsideTheWindowCoalesceIntoOneTrailingSignal(t *testing.T) {
	signals, log := newTestSignals(t)

	for range 20 {
		signals.changed(context.Background(), 7)
	}

	require.Equal(t, 1, log.count(), "窗口内的后续变更没有被压住")
	require.Eventually(t, func() bool { return log.count() == 2 },
		2*time.Second, 5*time.Millisecond, "窗口结束时没有补发那一条")
	time.Sleep(3 * notifyWindow)
	require.Equal(t, 2, log.count(), "补发之后又凭空多发了")
}

// 窗口内只来了一条时不补发：那一条已经在窗口开头发出去了，再补一条只会让所有在线
// 连接白拉一页。
func TestASingleChangeDoesNotTrailAnExtraSignal(t *testing.T) {
	signals, log := newTestSignals(t)

	signals.changed(context.Background(), 7)
	time.Sleep(3 * notifyWindow)

	require.Equal(t, 1, log.count(), "只有一条变更时不该补发")
}

// 窗口是**按账号**算的：一个账号很吵不能让另一个账号的变更被压住。
func TestWindowsAreCountedPerAccount(t *testing.T) {
	signals, log := newTestSignals(t)

	signals.changed(context.Background(), 7)
	signals.changed(context.Background(), 8)

	require.ElementsMatch(t, []int64{7, 8}, log.accounts(),
		"两个账号的第一条变更都该立刻发出去")
}

// 上面四例全部注入了 50ms 的 notifyWindow 替身，一次都没打到共享单例
// mirrorChanges——它的 window 到底是不是来自 mirrorChangeWindow 常量，从没被验过。
// 这条用例直接打生产单例（只换掉它的 broadcast 出口，window 原样留给生产接线），
// 靠真实时长把接线暴露出来。
//
// 断言写成「实测的尾补时长够不够一个 mirrorChangeWindow」，而不是「在某个写死的时刻
// 尾补还没出现」：后者要把这个常量的值再抄一遍到用例里，于是把常量调成别的数时，
// 明明接线好好的，用例却会红——而它的名字说的是「单例接的是这个常量」。
func TestMirrorChangesSingletonUsesTheProductionWindow(t *testing.T) {
	const userID = 90210

	log := &broadcastLog{}
	originalBroadcast := mirrorChanges.broadcast
	mirrorChanges.broadcast = log.record
	t.Cleanup(func() {
		mirrorChanges.mu.Lock()
		// 只收拾自己这个账号：单例是生产接线上那一份，别把别人的窗口一起抹掉。
		delete(mirrorChanges.open, userID)
		mirrorChanges.mu.Unlock()
		mirrorChanges.broadcast = originalBroadcast
	})

	ctx := context.Background()

	armed := time.Now()
	mirrorChanges.changed(ctx, userID)
	// 数的是 countFor 而不是 count：出口是进程级的，包里别的用例留下的窗口会往这个
	// log 里送尾补（实测见过账号 7 在第 2.6 秒落进来），按总数算就会把别人的那一条
	// 当成自己的，于是用例在自己的窗口还没到的时候就绿了。
	require.Equal(t, 1, log.countFor(userID), "首发没有立刻发出去")

	mirrorChanges.changed(ctx, userID) // 压在窗口里，等窗口结束时补发

	require.Eventually(t, func() bool { return log.countFor(userID) == 2 },
		2*mirrorChangeWindow, 10*time.Millisecond,
		"两个 mirrorChangeWindow 过去了还没补发：单例接的窗口比这个常量长得多，或者压根没接")

	// 定时器只会在到点**之后**触发，所以「补发时至少过了整整一个窗口」是可以逐字断言
	// 的下沿。单例要是接了个更短的窗口（还是旧的一秒、或者写死了一个数），实测时长就
	// 够不上 mirrorChangeWindow；而机器卡顿只会让实测时长更长，永远不会让这条假红。
	require.GreaterOrEqual(t, time.Since(armed), mirrorChangeWindow,
		"尾补来得比 mirrorChangeWindow 早：单例实际用的窗口跟不上这个常量")
}
