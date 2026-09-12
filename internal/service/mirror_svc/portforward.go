package mirror_svc

import (
	"context"
	"time"

	"github.com/agentre-hub/agentre/pkg/wire/protorpc"
)

// DialPortForward 为控制台的端口转发拨一条通往这台机器的专用连接，并把连接的**寿命
// 交给调用方**。
//
// 它是这个包里唯一不「拨了就收」的导出拨号面。既有那四个消费者（活跃统计、导入、
// 删除传播、一键升级）都是发一次请求就走，defer Close 是对的；端口转发不是：一个
// dev server 页面就是几十个请求，每个都签一张 JWT、读一次 Redis、查一次中继路由、
// 再跑一次 auth.account 往返（dialWithTimeout），体验上等于「每张图片一次 SSH 登录」。
// 所以这一条按（账号, 设备）复用，而**复用的账在 internal/service/portforward_svc**
// —— 那条池刻意不要 Redis 租约（规格 2026-09-09-console-port-forward-host 决策 3），
// 与这个包里那份常驻的排他性不变量（resident.go 的 machineLease）正相反，混住会让
// 下一个读者以为它也受租约管辖。
//
// 交回的第二个值收掉这条连接（关引擎、摘中继订阅），幂等。
//
// timeout 是这条连接上的调用预算，同时也是中继那一跳的期限（relayframeconn.go 的
// WriteFrame 没有 ctx 可用）。转发另给一个预算、不沿用会话 RPC 那 15 秒，理由与取值
// 都在 portforward_svc 的 defaultCallTimeout 上（决策 9），照一键升级的做法
// （upgradeCallTimeout）。
//
// ctx 是这条连接的**基座**：协议引擎的读循环与中继那一跳的 WriteFrame 都挂在它上面。
// 递一个会随请求结束而取消的 ctx 进来，第一个请求一收尾整条池化连接就死了；调用方
// 因此必须递一个脱开单次请求的 ctx（portforward_svc.Pool.dial 用的是
// context.WithoutCancel）。
//
// 机器联系不上时交出 ErrMachineOffline，对端判定版本不合时交出
// ErrProtocolVersionMismatch，两者都原样上交——控制台据此分出「等它回来」与
// 「去升级那台机器」，折成一句「转发失败」就把这个区别丢了。
//
// 这条连接上**不收实时通知**：端口转发那几路通知由共享包的 Proxy 自己订
// （portforwardhost.NewProxy 里的 SubscribeNotification，是多订阅者机制），镜像那一
// 侧的 onNotify 与它无关。
func (s *Supervisor) DialPortForward(
	ctx context.Context, userID int64, fingerprint string, timeout time.Duration,
) (*protorpc.Conn, func(), error) {
	if s == nil {
		return nil, nil, ErrMirrorUnavailable
	}
	conn, err := s.dialWithTimeout(
		ctx, machineKey{userID: userID, fingerprint: fingerprint}, nil, timeout)
	if err != nil {
		return nil, nil, err
	}
	return conn.Conn(), conn.Close, nil
}
