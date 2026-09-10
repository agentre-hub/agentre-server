package testutils

import (
	"testing"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

var observedLogs *observer.ObservedLogs

// 观测点在 init 里装，而不是等某个用例第一次调用 Logs 时才装。
//
// cago 的 logger.SetLogger 写的是一个没有锁的包级变量（pkg/logger/global.go）。生产里
// 它只在启动期被调用一次，那时还没有任何 goroutine，所以无锁是成立的；测试里若等到
// 半途才装，同一个包里更早的用例留下的后台 goroutine（帧总线的消费循环就是一个）
// 正在 logger.Ctx 里读它，-race 会当场报警——而且是真的读写并发，不是误报。
//
// init 在任何用例、任何 goroutine 之前跑完，写与读因此不可能重叠。代价是装上就不摘：
// 本进程后续所有日志都进这份内存记录，谁也不再往 stdout 写。这不改变任何东西——
// 测试里从来没跑过 logger.Logger() 组件，全局实例本来就是 zap.L() 那个空实现。
func init() {
	core, logs := observer.New(zapcore.DebugLevel)
	observedLogs = logs
	logger.SetLogger(zap.New(core))
}

// Logs 让本次测试看得见被测代码记了什么：交回那份内存记录，并先把上一个用例留下的
// 条目倒空。
//
// 取全局 logger 而不是往 ctx 里塞：`logger.Ctx(ctx)` 在 ctx 里没有 logger 时回落到
// 全局实例，而需要观测的两类代码恰好都走这条回落——muxtest 的 gin.Default() 不挂
// cago 的 middleware.Logger，帧总线的消费 goroutine 则跑在 context.Background() 上。
// 换成「构造一个带 logger 的 ctx 传进去」只能测到被测代码把 ctx 转交下去了，测不到
// 它到底记没记。
//
// 记录是全进程共用的，倒空挡不住上一个用例尚未退出的 goroutine。所以断言要连同
// 身份字段（stream / accountId / 指纹之类）一起过滤，别只按消息名捞；也别在用到它的
// 用例上开 t.Parallel()。
func Logs(t *testing.T) *observer.ObservedLogs {
	t.Helper()
	observedLogs.TakeAll()
	return observedLogs
}
