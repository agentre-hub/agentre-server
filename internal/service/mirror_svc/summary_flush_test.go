package mirror_svc

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// fakeFlushClock 把「窗口到点」变成用例显式调用,窗口边界因此完全确定 ——
// 不睡、不轮询,也就没有跨 goroutine 的断言竞争。
type fakeFlushClock struct {
	mu      sync.Mutex
	pending []func()
}

func (c *fakeFlushClock) schedule(_ time.Duration, f func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pending = append(c.pending, f)
}

// fire 触发所有已排期的尾补(通常只有一个)。
func (c *fakeFlushClock) fire() {
	c.mu.Lock()
	fns := c.pending
	c.pending = nil
	c.mu.Unlock()
	for _, f := range fns {
		f()
	}
}

func (c *fakeFlushClock) scheduled() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending)
}

// syncedRig 起一条已保存、已接入的对话,并把摘要写入的定时器换成可控的假时钟。
func syncedRig(t *testing.T) (*rig, *fakeFlushClock) {
	t.Helper()
	r := newRig(t)
	clock := &fakeFlushClock{}
	r.mirror.schedule = clock.schedule
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))
	return r, clock
}

// TestApply_SummaryWriteIsCoalescedNotPerFrame
//
// Given 一条已接入的对话;
// When  一轮活跃回复连着推来几十帧;
// Then  帧照旧一帧一行**立刻**落库(内容可见性一点不打折),
//
//	而摘要不再每帧写一次 —— 那是纯粹的重复写。
//
// 为什么这里可以攒批,而 Apply 的注释原本说「没有一个诚实的攒批点」:摘要那一行在
// **Apply 这条路上唯一会变的字段就是游标**(元数据只由 Sync 经 setSummary 改)。
// 而 latest_seq 只有一个读者 —— storedCursor,也就是重启后从哪儿接着拉;它落后一点的
// 代价,Apply 的注释自己写着:「one idempotent re-pull, nothing more」(帧表是
// OnConflict DoNothing)。没有任何用户可见的东西读它。
func TestApply_SummaryWriteIsCoalescedNotPerFrame(t *testing.T) {
	r, _ := syncedRig(t)
	ctx := context.Background()
	before := r.upsertCount()

	const frames = 40
	for seq := int64(1); seq <= frames; seq++ {
		require.NoError(t, r.mirror.Apply(ctx, notification(conv42, seq, fmt.Sprintf("t%d", seq))))
	}

	require.Len(t, r.seqs(), frames, "帧必须照旧一帧一行立刻落库")
	assert.LessOrEqual(t, r.upsertCount()-before, 1,
		"一轮 %d 帧不该写 %d 次摘要:窗口内只该首发那一次", frames, frames)
}

// TestApply_CoalescedSummaryStillPersistsTheFinalCursor
//
// 尾补不能省。窗口内被压住的那些次里,最后一次带着这一轮真正的游标 —— 少了尾补,
// 库里的游标会一直停在首发那一刻,重连时白白重拉一整轮。
func TestApply_CoalescedSummaryStillPersistsTheFinalCursor(t *testing.T) {
	r, clock := syncedRig(t)
	ctx := context.Background()

	const frames = 40
	for seq := int64(1); seq <= frames; seq++ {
		require.NoError(t, r.mirror.Apply(ctx, notification(conv42, seq, fmt.Sprintf("t%d", seq))))
	}
	require.Equal(t, 1, clock.scheduled(), "首发之后必须排上一次尾补")

	clock.fire()

	assert.Equal(t, int64(frames), r.lastCursor(t), "尾补要把这一轮最终的游标带出去")
}

// TestApply_QuietWindowDoesNotWriteAgain 窗口内一次都没被压住时,到点不该再写一遍
// —— 那是一次纯粹多余的 UPSERT。
func TestApply_QuietWindowDoesNotWriteAgain(t *testing.T) {
	r, clock := syncedRig(t)
	ctx := context.Background()

	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 1, "只有一帧")))
	afterFirst := r.upsertCount()
	require.Equal(t, int64(1), r.lastCursor(t), "第一帧的游标要立刻落库,不等窗口")

	clock.fire()

	assert.Equal(t, afterFirst, r.upsertCount(), "窗口里没压住过就不该补写")
}

// TestApply_NewWindowOpensAfterTheTail 尾补之后必须重新开窗,否则第二轮对话的
// 摘要再也没人写。
func TestApply_NewWindowOpensAfterTheTail(t *testing.T) {
	r, clock := syncedRig(t)
	ctx := context.Background()

	for seq := int64(1); seq <= 5; seq++ {
		require.NoError(t, r.mirror.Apply(ctx, notification(conv42, seq, "第一轮")))
	}
	clock.fire()
	require.Equal(t, int64(5), r.lastCursor(t))

	for seq := int64(6); seq <= 10; seq++ {
		require.NoError(t, r.mirror.Apply(ctx, notification(conv42, seq, "第二轮")))
	}
	clock.fire()

	assert.Equal(t, int64(10), r.lastCursor(t), "第二轮的游标也要落库")
}

// TestForget_PendingSummaryFlushDoesNotResurrectTheRow
//
// Given 一轮活跃对话把摘要写入压进了窗口里(欠着一次尾补);
// When  账号在这中间把这条对话删了(删除路径先 Forget 再清行);
// Then  那次尾补必须作废 —— 一个字都不能再替它写。
//
// 这正是 Forget 的注释点名的那条窗口:「a live frame writes the conversation
// straight back in, and what the account just deleted quietly returns」。攒批把
// 写入推后了,如果不在 Forget 里把欠着的那次作废,就等于亲手把那条窗口重新打开。
func TestForget_PendingSummaryFlushDoesNotResurrectTheRow(t *testing.T) {
	r, clock := syncedRig(t)
	ctx := context.Background()

	for seq := int64(1); seq <= 10; seq++ {
		require.NoError(t, r.mirror.Apply(ctx, notification(conv42, seq, "还在说")))
	}
	beforeForget := r.upsertCount()

	r.mirror.Forget(SavedSession{ConversationID: conv42})
	clock.fire()

	assert.Equal(t, beforeForget, r.upsertCount(),
		"删掉之后还补写一次摘要,等于把账号刚删掉的对话又写回去")
}
