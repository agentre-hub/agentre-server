package mirror_svc

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cago-frame/cago/pkg/logger"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// 本文件是「镜像范围变了」这条消息在**副本之间**的那一跳。
//
// 为什么需要它：跟着一台机器的副本由租约决定（同一台机器同一时刻只被一个副本跟），
// 而接住这次保存 / 删除请求的副本由负载均衡决定。两者独立，于是 N 个副本下每次变更
// 都有 (N-1)/N 的概率落在**手里没有这台机器的那个副本**上——它能做的只有清自己的库，
// 属主那条连接上的保存名单纹丝不动。少了这一跳，保存要等属主碰巧赢下一轮
// reconcile_session_mirrors 的周期锁（期望约 N 分钟、还带几何分布的长尾，用户看到的
// 是「存完转录空白好几分钟」），删除则更糟：属主那个仍然活着的 follower 会把刚清掉的
// 摘要与帧按下一帧原样写回来。
//
// 形状照 accountchan_svc 那条通道：Redis Pub/Sub + JSON 的 server-internal 载荷。
// 差别是寻址粒度——那条按账号广播给所有在线连接，这条按 (账号, 机器) 点给唯一的属主，
// 因为「谁该动手」正是租约已经回答过的问题。**不**改成每个副本都去 follow：租约存在
// 的理由（同一条对话不被镜像两遍）与这条延迟无关。
//
// 它是**加速**，不是正确性的依据：发不出去、订阅断了、缓冲满了，都退回每分钟一轮的
// 对账，与今天的行为一致。

// 提示的种类。收到不认识的种类记一条日志就跳过——与账号通道同一条规矩，让新增一种
// 可以先发后收。
const (
	// hintSaved：这台机器上又有对话被保存了。属主重读一次保存名单即可，名单是范围的
	// 唯一权威（决策 2），提示里那个 conversation_id 只用来记日志。
	hintSaved = "saved"
	// hintDeleted：这条对话被删了。它**不能**靠重读名单来兑现：删除的次序是「先清
	// server 那一份、再把这一条撤出账号」（saved_session_svc.Delete），提示到达时
	// 名单里那一行往往还在，重读只会把刚删掉的对话重新跟起来。
	hintDeleted = "deleted"
)

// hintBuffer 是属主那一侧提示在被常驻循环消化前的缓冲。保存与删除都是人手点出来的
// 动作，几十条的余量远超任何真实节奏；真的排满了就丢掉并排一次重同步（见 pumpHints）。
const hintBuffer = 64

// machineHint 是一条提示的载荷。跨副本以 JSON 编解码，与 accountchan_svc.Frame 同理：
// 它是 server 内部形状，不出现在任何客户端协议里。
type machineHint struct {
	// Kind 是种类，取值见 hint* 常量。
	Kind string `json:"kind"`
	// ConversationID 是这条提示说的那条对话。hintDeleted 靠它点名要摘掉哪一条，
	// hintSaved 只拿它记日志。
	ConversationID string `json:"conversationId,omitempty"`
}

// machineHintChannel 是一台机器的提示通道。
//
// 直接由租约的 key 派生：租约回答「谁是属主」，提示要送的正是那个属主，两者必须
// 严格同一个粒度（账号 + 设备指纹，指纹照样 base64，理由见 machineLeaseKey）。
func machineHintChannel(m machineKey) string { return machineLeaseKey(m) + ":hints" }

func (h machineHint) encode() ([]byte, error) {
	payload, err := json.Marshal(h)
	if err != nil {
		return nil, fmt.Errorf("encode mirror machine hint: %w", err)
	}
	return payload, nil
}

func decodeMachineHint(payload []byte) (machineHint, error) {
	var hint machineHint
	if err := json.Unmarshal(payload, &hint); err != nil {
		return machineHint{}, fmt.Errorf("decode mirror machine hint: %w", err)
	}
	if hint.Kind == "" {
		return machineHint{}, fmt.Errorf("decode mirror machine hint: missing kind")
	}
	return hint, nil
}

// hintOwner 把一条提示送给正跟着这台机器的那个副本。
//
// 尽力而为：送不到只记一条日志、绝不让它决定调用方的成败。保存那一路本来就允许
// 「镜像稍后由巡检接上」，删除那一路的权威是库里已经清掉的那些行——两者都不因为
// 一次 Redis 抖动而变得不正确，只是慢回到对账的节奏。
func (s *Supervisor) hintOwner(ctx context.Context, key machineKey, hint machineHint) {
	if s.redis == nil {
		// 没装配 Redis 的进程根本没有租约，也就没有别的副本可言。
		return
	}
	payload, err := hint.encode()
	if err == nil {
		err = s.redis.Publish(ctx, machineHintChannel(key), payload).Err()
	}
	if err != nil {
		logger.Ctx(ctx).Warn("mirror machine hint not delivered",
			zap.Int64("userId", key.userID), zap.String("machineFingerprint", key.fingerprint),
			zap.String("kind", hint.Kind), zap.String("conversationId", hint.ConversationID),
			zap.Error(err))
	}
}

// subscribeHints 订上这台机器的提示通道。
//
// 认领之后**立刻**订阅，早于拨号与首次补齐：首次补齐用的是 newFollower 那一刻的名单
// 快照，而握手是要走网络的。反过来（补齐完再订）会让这段窗口里发出的提示无人接收，
// 那条刚保存的对话又得等一轮对账。
//
// 订不上就让这次认领失败：一个没有提示订阅的 follower 会静静地退回「几分钟才看见新
// 保存」，而它自己一声不吭——那正是本轮要修掉的形态。租约当场交还，下一轮对账重来。
func (f *follower) subscribeHints(ctx context.Context) error {
	if f.sup.redis == nil {
		return nil
	}
	pubsub := f.sup.redis.Subscribe(ctx, machineHintChannel(f.key))
	// 等订阅确认再返回：SUBSCRIBE 还没到 Redis 就宣告订上了的话，紧接着发生的那条
	// 提示会从这条订阅底下溜过去（与 accountchan_svc.Subscribe 同一条理由）。
	if _, err := pubsub.Receive(ctx); err != nil {
		_ = pubsub.Close()
		return fmt.Errorf("subscribe mirror machine hints: %w", err)
	}
	f.hintSub = pubsub
	// 泵活得比这次调用久：ctx 的取消不该把常驻订阅一起带走，但它携带的日志上下文
	// 要留着（与 follower.run 同一处理）。
	go f.pumpHints(context.WithoutCancel(ctx), pubsub)
	return nil
}

// pumpHints 是这份订阅唯一的生产者：收到什么就排给常驻循环。
//
// 它自己**不动**镜像：兑现一条提示要与 Apply / Sync 严格不并发（删除那一路尤其——
// 摘掉与「摘完再清一次」之间夹进一帧实时通知，刚删掉的东西就回来了），而那个不并发
// 是靠「全都跑在 run 那一条 goroutine 上」保证的。
//
// ReceiveMessage 自带断线重连与重订阅；它返回错误意味着订阅真的没了（收尾时的
// Close，或 Redis 长期不可达），那时泵退出，本副本退回每分钟一轮的对账。
func (f *follower) pumpHints(ctx context.Context, pubsub *goredis.PubSub) {
	for {
		message, err := pubsub.ReceiveMessage(ctx)
		if err != nil {
			return
		}
		hint, err := decodeMachineHint([]byte(message.Payload))
		if err != nil {
			logger.Ctx(ctx).Warn("mirror machine hint dropped, cannot be decoded",
				zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
				zap.Error(err))
			continue
		}
		select {
		case f.hints <- hint:
		default:
			// 攒到缓冲都满了。丢掉这一条并排一次重同步：保存那一路照此收敛，删除
			// 那一路退回 Mirror.pruneUnwanted（摘得掉，但那一瞬写回去的行要等下一次
			// 删除或对账才清得掉）。提示是人手点出来的动作，这条路径实际到不了。
			logger.Ctx(ctx).Warn("mirror machine hint dropped, resyncing",
				zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
				zap.String("kind", hint.Kind))
			f.requestResync()
		}
	}
}

// closeHints 收掉提示订阅，泵随之退出。可重复调用。
func (f *follower) closeHints() {
	if f.hintSub == nil {
		return
	}
	_ = f.hintSub.Close()
	f.hintSub = nil
}

// applyHint 兑现一条提示。它跑在常驻循环那条 goroutine 上，因此与 Apply / Sync
// 天然不并发——两个分支都依赖这一点。
func (f *follower) applyHint(ctx context.Context, hint machineHint) {
	switch hint.Kind {
	case hintSaved:
		// 名单是范围的唯一权威，所以重读它、而不是把提示里那条对话拼进去：这一读
		// 顺带把这台机器上任何别的变化一起收敛掉。
		saved, err := savedOnMachine(ctx, f.key.userID, f.key.fingerprint)
		if err != nil {
			logger.Ctx(ctx).Warn("mirror machine hint: saved list unreadable, leaving it to the next pass",
				zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
				zap.String("conversationId", hint.ConversationID), zap.Error(err))
			return
		}
		f.want(saved)
	case hintDeleted:
		f.drop(SavedSession{ConversationID: hint.ConversationID})
		// 摘掉之前那一瞬可能刚有一帧把它写回来了：发起那个副本清库与本副本摘掉之间
		// 隔着一次 Redis 投递。再清一次——清除是幂等的，而这一次跑在摘掉**之后**，
		// 此后这条连接不会再提到这条对话。
		if err := purgeStoredCopy(ctx, f.key.userID, hint.ConversationID); err != nil {
			logger.Ctx(ctx).Warn("mirror machine hint: stored copy not cleared",
				zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
				zap.String("conversationId", hint.ConversationID), zap.Error(err))
		}
	default:
		logger.Ctx(ctx).Warn("mirror machine hint of an unknown kind ignored",
			zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
			zap.String("kind", hint.Kind))
	}
}
