package mirror_svc

import (
	"context"
	"sync"
	"time"

	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// mirrorChangeWindow 是「这个账号的会话镜像变了」这条信号的攒批窗口。
//
// 取三秒，而不是更短：这条信号的收件人只有侧栏角标、会话索引与总览统计三处摘要，
// 没有一处是正在看的转录（那条走中继，不经过这条信号路），三秒的成组延迟在这三处
// 上看不出来，却挡掉了一轮活跃对话里成百上千次逐帧广播。这个数与浏览器侧
// accountChannel 的攒批窗口刻意取同一个值——两侧说的是同一件事「摘要多久刷新一次
// 算够」——但两侧各自声明各自的常量，不引入任何跨语言共享。
const mirrorChangeWindow = 3 * time.Second

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
	schedule  func(time.Duration, func())
	broadcast func(ctx context.Context, userID int64)

	mu   sync.Mutex
	open map[int64]*debounceWindow
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
		s.open = make(map[int64]*debounceWindow)
	}
	window, ok := s.open[userID]
	if !ok {
		window = &debounceWindow{
			window:   s.window,
			schedule: s.timer(),
			fire: func(ctx context.Context) error {
				s.broadcast(ctx, userID)
				return nil
			},
		}
		// 窗口空转收尾时把条目删掉，下一条变更重新建一个。若恰好与一次新变更擦肩
		// （空转判定与 touch 之间），至多多发一条幂等的「该拉了」——这条信号本来
		// 就可以重复，两个副本各发一条也是同一个意思。
		window.onIdle = func() { s.forgetIfIdle(userID, window) }
		s.open[userID] = window
	}
	s.mu.Unlock()

	_ = window.touch(ctx)
}

// timer 交出定时器：生产是 time.AfterFunc，用例可以注入。
func (s *changeSignals) timer() func(time.Duration, func()) {
	if s.schedule != nil {
		return s.schedule
	}
	return func(d time.Duration, f func()) { _ = time.AfterFunc(d, f) }
}

func (s *changeSignals) forgetIfIdle(userID int64, window *debounceWindow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.open[userID] == window {
		delete(s.open, userID)
	}
}

// changeSignaller 是 Mirror 看到的那一小片出口。留成接口是为了让 Mirror 的用例
// 直接观察「写完出没出声」，而不必绕过攒批的时序 —— 攒批本身由 changeSignals
// 自己的用例守。
type changeSignaller interface {
	changed(ctx context.Context, userID int64)
}

// summaryFlushWindow 是摘要写入的攒批窗口。它攒的是**落库次数**，收件人是数据库
// 而不是浏览器，与 mirrorChangeWindow 攒的那条信号不是一回事：两个数互相独立。
//
// 这一个不能比 mirrorChangeWindow 长：摘要行要是落后于信号，各端被信号叫醒去读，
// 读回来的却还是旧摘要。
const summaryFlushWindow = time.Second
