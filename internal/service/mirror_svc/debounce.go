package mirror_svc

import (
	"context"
	"sync"
	"time"
)

// debounceWindow 是「首发 + 尾补」攒批的公共状态机，账号级信号（notify.go）与摘要
// 写入（mirror.go）共用同一条形状：
//
//   - 首发：窗口外的第一条立刻执行。攒批是降噪，不是给每次变更加一个窗口的延迟。
//   - 尾补：窗口内被压住过的，在窗口结束时补一次。少了它，一轮对话最后那一次变更要
//     等下一个外部触发才看得到。
//
// 两个使用者的差异只在回调与一个可选的 forget 语义上，所以它们不是同一个对象，只是
// 同一台状态机：
//
//   - fire 是首发与尾补共用的动作。首发那次的错误由 touch 交回调用方；尾补跑在定时器
//     上，错误走 onTailError（可为 nil）。
//   - forget 之后，窗口里排着的一切与已经排队的尾补都作废（摘要写入在对话被删除时用）。
//   - onIdle 在「窗口收尾且一次都没被压住」时调用，让持有者可以丢掉这个窗口
//     （账号信号用它从 map 里删掉条目；摘要写入不传）。
type debounceWindow struct {
	window      time.Duration
	schedule    func(time.Duration, func())
	fire        func(ctx context.Context) error
	onTailError func(ctx context.Context, err error)
	onIdle      func()

	mu        sync.Mutex
	open      bool
	dirty     bool
	forgotten bool
}

// touch 记一次变更，返回首发那次的错误；被压住或已经 forget 时返回 nil。
func (w *debounceWindow) touch(ctx context.Context) error {
	w.mu.Lock()
	if w.forgotten {
		w.mu.Unlock()
		return nil
	}
	if w.open {
		w.dirty = true
		w.mu.Unlock()
		return nil
	}
	w.open = true
	w.mu.Unlock()

	err := w.fire(ctx)
	// 尾补跑在定时器上，那时触发它的这次调用早就返回了。带走一份不会被取消的副本：
	// ctx 上的 trace / logger 字段还留着，而取消不再牵连这一条。与 notify.go 的同款理由。
	tail := context.WithoutCancel(ctx)
	w.schedule(w.window, func() { w.elapsed(tail) })
	return err
}

// elapsed 收尾一个窗口：压住过就补一次并再开一个窗口（变更还在继续的话下一条照样先
// 被压住），没压住过就把窗口关掉，下一条变更重新走首发。
func (w *debounceWindow) elapsed(ctx context.Context) {
	w.mu.Lock()
	if w.forgotten || !w.dirty {
		w.open = false
		w.mu.Unlock()
		if w.onIdle != nil {
			w.onIdle()
		}
		return
	}
	w.dirty = false
	w.mu.Unlock()

	if err := w.fire(ctx); err != nil && w.onTailError != nil {
		w.onTailError(ctx, err)
	}
	w.schedule(w.window, func() { w.elapsed(ctx) })
}

// forget 作废这个窗口此刻与已排队尾补的一切：此后的 touch 不再执行任何动作。
func (w *debounceWindow) forget() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.forgotten = true
	w.dirty = false
}
