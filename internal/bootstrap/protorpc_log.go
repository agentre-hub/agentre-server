package bootstrap

import (
	"github.com/agentre-hub/agentre/pkg/wire/protorpc"
	"github.com/cago-frame/cago/pkg/logger"
)

// InstallProtorpcLogger 把 cago 的按 ctx 取 logger 交给 protorpc。
//
// protorpc 是共用的协议引擎，不绑宿主的日志框架；未交出时它的 panic / 丢帧日志落到
// zap 的空实现里，服务端 relay 与端口转发连接上的这些行就无声消失。必须在 cago 的
// Core 组件（装好 logger）之后、任何 protorpc 连接建立之前调用。
func InstallProtorpcLogger() {
	protorpc.SetLogger(logger.Ctx)
}
