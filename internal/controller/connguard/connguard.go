// Package connguard 是「一条**已经建好**的 websocket 还能不能继续」这条判据的唯一
// 实现，中继的 daemon 与客户端两条连接共用（账号信号已并入后者）。
//
// websocket 只在 upgrade 那一刻过一次鉴权中间件，登出、设备撤销与账号封禁因此都只
// 挡得住**新**连接；只有挂在心跳上的逐次复查，才能把它们落到一条已经建好的连接上。
// 判据在两个控制器里曾是两份逐字节相同的拷贝——同一条安全判据漂移一次就是一条本该
// 断开的连接继续活着，所以它只能有一份。
//
// 本包在控制器层，依赖 service 接口，方向合规。
package connguard

import (
	"context"

	"github.com/agentre-hub/agentre-server/internal/controller/relay_ctr/relayws"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

// New 为一条刚建好的连接组装逐次复查：调用方把返回的函数挂到传输层的心跳上，
// 返回非 nil 即断开。撤销判定在建连时取一次（它自己内部会反复查），账号闸门则
// 每次复查现取——一条长连接可能跨过装配完成的那一刻。
func New(ctx context.Context, accountID int64, jti string) func() error {
	revoked := watch(ctx, jti)
	return func() error { return check(ctx, accountID, revoked, user_svc.Gate()) }
}

// watch 取「这条连接背后的凭据是否已被撤销」的判定。auth_svc 未装配（只装了 device
// flow、没跑完整 bootstrap 的装配）或连接没带 jti 时判不出来，返回 nil 按不撤销处理。
func watch(ctx context.Context, jti string) auth_svc.RelayCredentialWatch {
	svc := auth_svc.Default()
	if svc == nil || jti == "" {
		return nil
	}
	return svc.WatchRelayCredential(ctx, jti)
}

// check 把「这条连接还能继续吗」翻译成传输层认得的终止信号。
//
// 两条判据的失败方向刻意相反，别顺手统一掉：凭据撤销判不出来时不断开
// （auth_svc.WatchRelayCredential 的 fail-open，那只是一次早已生效的撤销的收尾），
// 账号闸门判不出来时断开（user_svc.AccountGate 的 fail-closed，那是授权判定本身）。
// 闸门未装配时判不出来，与 watch 同向按不断开处理：装配不全不该让连接建不起来。
func check(ctx context.Context, accountID int64, revoked auth_svc.RelayCredentialWatch, gate user_svc.AccountGate) error {
	if revoked != nil && revoked(ctx) {
		return relayws.ErrCredentialRevoked
	}
	if gate != nil && gate.Check(ctx, accountID) != nil {
		return relayws.ErrCredentialRevoked
	}
	return nil
}
