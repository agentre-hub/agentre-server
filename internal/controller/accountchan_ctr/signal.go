// Package accountchan_ctr 把账号级实时信号编成线上帧，交给中继客户端连接上的
// 保留通道运送（决策 13）。
//
// 它**不再是一个 websocket 端点**：`/v1/account/channel` 已经删除，账号信号与 RPC
// 共用同一条多路复用连接。合并的是传输，不是总线——每副本一份 Redis Pub/Sub 订阅
// 的 accountchan_svc 原样保留，这里只负责「一份订阅 → 一条已编码的帧流」。
package accountchan_ctr

import (
	"context"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// Signals 是保留通道的信号来源。它实现 relay_ctr.AccountSignals，两个包因此
// 互不 import：中继那侧只认「订阅一个账号，拿一条帧流」这一小块能力（ISP）。
type Signals struct {
	svc accountchan_svc.AccountChanSvc
}

func New(svc accountchan_svc.AccountChanSvc) *Signals { return &Signals{svc: svc} }

// SubscribeSignals 为一条中继客户端连接开一份账号订阅。
//
// 调用点刻意排在 upgrade **之前**：一来订阅建不起来时还来得及决定怎么作答，二来
// upgrade 成功之后发生的每一次广播都必然落在这份订阅上，不留「刚连上就漏掉一条」
// 的窗口——通道不保存未送达的信号，也不需要保存。
//
// 交回的帧已经是线上字节：保留通道只运送，不解释内容。流关闭意味着这份订阅没了
// （Redis 订阅彻底失败，或正在收尾），中继那侧据此只关掉那一条保留通道。
func (s *Signals) SubscribeSignals(
	ctx context.Context, accountID int64,
) (<-chan []byte, func(), error) {
	subscription, err := s.svc.Subscribe(ctx, accountID)
	if err != nil {
		return nil, nil, err
	}
	frames := make(chan []byte)
	go encodeSignals(ctx, subscription, frames)
	return frames, subscription.Close, nil
}

// encodeSignals 把信号逐条编成线上帧。编不出来的一条**丢掉但不断流**：那是本副本
// 认不出的信号种类（先发后收），为它掐掉整条信号路等于把一次可加的协议变更升级成
// 一次故障。
func encodeSignals(
	ctx context.Context, subscription accountchan_svc.Subscription, frames chan<- []byte,
) {
	defer close(frames)
	for signal := range subscription.Signals() {
		payload, err := encodeNotification(signal)
		if err != nil {
			logger.Ctx(ctx).Warn("encode account signal", zap.Error(err), zap.String("type", signal.Type))
			continue
		}
		select {
		case frames <- payload:
		case <-ctx.Done():
			return
		}
	}
}
