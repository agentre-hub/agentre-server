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
