package mirror_svc

import (
	"context"
	"sync"
	"time"

	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// mirrorChangeWindow 是「这个账号的会话镜像变了」这条信号的攒批窗口。
//
// 取一秒，而不是更短：这条信号只是让各端提前于 30 秒兜底轮询去拉一次，一秒的成组
// 延迟在这个量级上看不出来，而它挡掉的是一轮活跃对话里成百上千次逐帧广播。
const mirrorChangeWindow = time.Second

// changeSignals 把镜像写入攒成有限速率的信号。
//
// 镜像每收下一帧就写一行帧，逐条广播等于把账号级通道当转录流用——而它送的只是
// 「该拉了」，一秒里发一千条和发一条对收件方是同一个意思。所以按账号攒批，形状是
// **首发 + 尾补**：
//
//   - 首发：窗口外的第一条立刻发。攒批是降噪，不是给每次变更加一个窗口的延迟。
//   - 尾补：窗口内被压住过的，在窗口结束时补一条。少了它，一轮对话最后那一次变更
//     要等 30 秒兜底轮询才看得到——那正是本轮要修的东西。
//
// 每个副本各攒各的：信号是幂等的「该拉了」，两个副本各发一条只是让收件方多拉一次。
// 为此引一套跨副本的协调不值得。
type changeSignals struct {
	window    time.Duration
	broadcast func(ctx context.Context, userID int64)

	mu   sync.Mutex
	open map[int64]*changeWindow
}

// changeWindow 是一个账号此刻开着的那个窗口。它存在本身就表示「窗口开着」。
type changeWindow struct {
	// suppressed 记这个窗口里有没有压住过变更，也就是结束时该不该补一条。
	suppressed bool
}

// mirrorChanges 是本副本共用的那一份。跨连接共享：一个账号的多台机器各有一个
// Mirror，但它们变的是同一份镜像，攒批要按账号算，不是按连接算。
var mirrorChanges = &changeSignals{
	window: mirrorChangeWindow,
	broadcast: func(ctx context.Context, userID int64) {
		accountchan_svc.BroadcastSignalBestEffort(ctx, userID, accountchan_svc.FrameTypeMirrorChanged)
	},
}

// changed 记下「这个账号的镜像变了」。可以随便调，限频在这里面。
func (s *changeSignals) changed(ctx context.Context, userID int64) {
	// 尾补跑在定时器上，那时触发它的那次写入早就返回了。带走一份不会被取消的
	// 副本：ctx 上的 trace / logger 字段还留着，而取消不再牵连这一条。
	ctx = context.WithoutCancel(ctx)

	s.mu.Lock()
	if s.open == nil {
		s.open = make(map[int64]*changeWindow)
	}
	if window, ok := s.open[userID]; ok {
		window.suppressed = true
		s.mu.Unlock()
		return
	}
	s.open[userID] = &changeWindow{}
	s.mu.Unlock()

	s.broadcast(ctx, userID)
	time.AfterFunc(s.window, func() { s.windowElapsed(ctx, userID) })
}

// windowElapsed 收尾一个窗口：压住过就补一条并再开一个窗口（对话还在跑的话下一条
// 变更照样先被压住），没压住过就把窗口关掉，下一条变更重新走首发。
func (s *changeSignals) windowElapsed(ctx context.Context, userID int64) {
	s.mu.Lock()
	window, ok := s.open[userID]
	if !ok {
		s.mu.Unlock()
		return
	}
	if !window.suppressed {
		delete(s.open, userID)
		s.mu.Unlock()
		return
	}
	window.suppressed = false
	s.mu.Unlock()

	s.broadcast(ctx, userID)
	time.AfterFunc(s.window, func() { s.windowElapsed(ctx, userID) })
}

// changeSignaller 是 Mirror 看到的那一小片出口。留成接口是为了让 Mirror 的用例
// 直接观察「写完出没出声」，而不必绕过攒批的时序 —— 攒批本身由 changeSignals
// 自己的用例守。
type changeSignaller interface {
	changed(ctx context.Context, userID int64)
}

// summaryFlushWindow 是摘要写入的攒批窗口，与 mirrorChangeWindow 同一个量级：
// 让各端去读的是那条信号，摘要写得比信号还勤，多出来的那些次没有任何人看得见。
const summaryFlushWindow = time.Second
