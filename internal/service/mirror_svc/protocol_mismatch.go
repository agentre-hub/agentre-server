package mirror_svc

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
)

// protocolVersionRejectionCode 复述 daemon 一侧 rpcerror.CodeProtocolVersion
// (agentre/internal/pkg/rpcerror)：requireProtocolVersion 判定对端版本不合时,握手就是
// 拿着这个 JSON-RPC 错误码被拒的。这里没有直接引用那个常量——它挂在 pkg/relaywire
// 里,而这个包不在本次改动范围内(见 spec 决策 14 的落地边界),所以复述一份并注明来路,
// 与 relaywire.CodeMethodNotFound 同样的做法(那个常量倒是已经在这一侧存在)。
const protocolVersionRejectionCode int32 = -32006

// ErrProtocolVersionMismatch 是「daemon 判定这次握手的协议版本不合,拒绝了它」。
//
// 与 ErrMachineOffline 刻意分开：离线是暂时的、下一轮巡检就该再试；版本不合不是瞬时
// 故障——同一个 agentred 二进制不会自己变新，按秒重试没有意义（spec「控制台呈现与
// latest 来源」一节的最后一段）。调用方看见它不该像看见网络抖动那样立刻再拨一次。
var ErrProtocolVersionMismatch = errors.New("mirror machine rejected handshake for protocol version")

// protocolMismatchBackoff 是记下一次协议不匹配之后,在这台机器上跳过重新握手的时长。
//
// 它必须比 internal/task/task.go 里 ReconcileSessionMirrors 的对账周期（每分钟一次）
// 长得多——这条退避正是为了不让「协议不合」在那个周期上被当成普通的暂时性失败按分钟
// 重试。30 分钟不是精确值，只是「肉眼可见地不是快速路径」。
const protocolMismatchBackoff = 30 * time.Minute

// isProtocolVersionMismatch 判定 dialMachine 交出的错误是不是「对端按协议版本拒绝了
// 这次握手」（daemon 的 requireProtocolVersion / 桌面端 peer registry 的同名判定）——
// 而不是网络故障、超时或别的 RPC 错误。
func isProtocolVersionMismatch(err error) bool {
	var wireErr *relaywire.Error
	return errors.As(err, &wireErr) && wireErr.Code == protocolVersionRejectionCode
}

// protocolMismatchKey 是「(账号, 机器) 上一次握手被协议拒绝」这件事在 Redis 上的表示,
// 键形状照 machineLeaseKey 复刻——指纹是设备自报的任意字符串,按 base64 编码进 key
// 避免含冒号的值撞进别人的命名空间。
//
// 存在 Redis 而不是常驻连接的进程内存里,是因为这件事必须**跨副本共享**：巡检在任何
// 一个副本上跑,都不该对着同一台已知版本不合的机器重新握手一次（spec 决策 14 呼应的
// 那段「记成按 (账号, 机器) 的共享状态」）。TTL 本身就是退避——不需要另外记时间戳、
// 另外判断过期。
func protocolMismatchKey(m machineKey) string {
	return fmt.Sprintf("mirror:protocol-mismatch:%d:%s", m.userID,
		base64.RawURLEncoding.EncodeToString([]byte(m.fingerprint)))
}

// recordProtocolMismatch 记下这台机器刚刚因协议版本被拒,让退避覆盖的这段时间里,
// 任何副本上的下一次 dial 都不再重新握手。Redis 故障时只记日志：这一次的退避没生效,
// 下一次握手失败时还会再记一次——不是关键路径上的正确性依赖,不值得让整条 Follow
// 因为这一步而返回一个与「协议不合」无关的错误。
func (s *Supervisor) recordProtocolMismatch(ctx context.Context, key machineKey) {
	if s.redis == nil {
		return
	}
	if err := s.redis.Set(ctx, protocolMismatchKey(key), "1", protocolMismatchBackoff).Err(); err != nil {
		logger.Ctx(ctx).Warn("mirror protocol mismatch not recorded",
			zap.Int64("userId", key.userID), zap.String("machineFingerprint", key.fingerprint), zap.Error(err))
	}
}

// RecordProtocolMismatch 是 recordProtocolMismatch 面向包外的公开入口，与
// ProtocolMismatch 成对——写侧一样按 (账号, 机器) 定位、一样落 Redis。dial() 走的是
// 包内那个私有版本（它手里现成一个 machineKey），这一个供其余需要模拟或补记这份共享
// 状态的调用方使用（例如 device_svc 的测试要在不真的跑一次被拒握手的前提下断言读侧
// 接线），不重新导出 Redis key 的具体形状。
func (s *Supervisor) RecordProtocolMismatch(ctx context.Context, userID int64, fingerprint string) {
	if s == nil {
		return
	}
	s.recordProtocolMismatch(ctx, machineKey{userID: userID, fingerprint: fingerprint})
}

// protocolMismatchActive 回答「这台机器此刻还在协议不匹配的退避窗口里吗」。
//
// Redis 读不出来时 fail-open(视为不在退避里)：这一步只是为了不在快速路径上重试,
// 不是正确性依赖——最坏结果只是多拨一次已知会被拒的握手,而不是漏跟一台真正可用的
// 机器。
func (s *Supervisor) protocolMismatchActive(ctx context.Context, key machineKey) bool {
	if s.redis == nil {
		return false
	}
	n, err := s.redis.Exists(ctx, protocolMismatchKey(key)).Result()
	if err != nil {
		return false
	}
	return n > 0
}

// ProtocolMismatch 供设备读端点消费（device_svc.ListUserDevices，与
// relay_svc.Default().IsDaemonOnline 同一形状）：这台机器最近一次握手是不是被判定
// 协议不合而拒绝。未装配镜像时 s 为 nil，调用方已经在别处判过 mirror_svc.Default()，
// 这里再兜底一次，保持与包内其余方法一致的 nil-safe 习惯。
func (s *Supervisor) ProtocolMismatch(ctx context.Context, userID int64, fingerprint string) bool {
	if s == nil {
		return false
	}
	return s.protocolMismatchActive(ctx, machineKey{userID: userID, fingerprint: fingerprint})
}
