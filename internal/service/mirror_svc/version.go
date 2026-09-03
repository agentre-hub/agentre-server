package mirror_svc

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
)

// refreshDeviceVersion 把这台机器刚刚在握手里自报的构建版本刷回 devices.version
// （spec「控制台呈现与 latest 来源」一节：「devices.version 改为每次镜像握手成功后
// 按新值刷新」；决策 14：「值不同才写」）。
//
// 判定在这里做，UpdateVersion 本身不再带条件：读出当前值、与自报值比过再决定要不要
// 调写方法，这样「版本没变就不写」在服务层就能直接断言——落到一条带 WHERE 的 UPDATE
// 上就只能靠 RowsAffected，而调用方要的是「这次调用有没有发生」，不是「这一行有没有
// 被改」。
//
// 这条 check-then-write 在多副本下不构成 architecture.md 说的那种竞态：同一台机器同一
// 时刻只有一个副本在跟（machineLease），能触发这条写的连接只有一条；即便竞态真的发生，
// 两个写者也只会写同一个值（daemon 这次握手自报的版本），不是两个互斥的结果分叉。
//
// 空版本(daemon_version 未注入构建变量的本地构建)不写：写了会把已经落库的正式版本
// 覆盖成空白,库里那一列反而比不写更不可读。
func (s *Supervisor) refreshDeviceVersion(ctx context.Context, key machineKey, reported string) {
	if reported == "" {
		return
	}
	repo := device_repo.Device()
	if repo == nil {
		// 未装配 device_repo(测试、或只跑 device flow 没有整套 bootstrap 的调用方)：
		// 版本回写是镜像握手之外的增强，不是它的必要条件，fail-open 与
		// device_svc.ListUserDevices 的在线态同一习惯。
		return
	}
	d, err := repo.FindByFingerprint(ctx, key.userID, key.fingerprint)
	if err != nil {
		logger.Ctx(ctx).Warn("mirror machine version not refreshed: find device failed",
			zap.Int64("userId", key.userID), zap.String("machineFingerprint", key.fingerprint), zap.Error(err))
		return
	}
	if d == nil || d.Version == reported {
		return
	}
	if err := repo.UpdateVersion(ctx, d.ID, reported, time.Now().UnixMilli()); err != nil {
		logger.Ctx(ctx).Warn("mirror machine version not refreshed: update failed",
			zap.Int64("userId", key.userID), zap.String("machineFingerprint", key.fingerprint), zap.Error(err))
	}
}

// ── 这台机器自报的短 commit（spec「协议：版本窗口与自报版本」，决策 5）──────────
//
// 版本号落 devices.version（上面那条），短 commit 落这里的共享状态：它不是设备的
// 登记信息，而是「最近一次握手时这台机器跑的是不是发布构建」这一个瞬时事实，加一列
// 数据库列去存一个每分钟都会重写、且只有在线期间才有意义的值并不划算。
//
// 「知不知道」必须与「commit 是空串」分开。空串是 daemon 自报的确定答案（未注入构建
// 变量的本地构建 —— 消费端据此显示为开发构建、永不劝升），而「从没握过手」是没有答案；
// 把后者读成前者，会把一台正式版机器说成开发构建。Redis 上这两者是 EXISTS 的差别，
// 因此读侧回的是 (commit, known) 而不是一个字符串。

// daemonBuildTTL 是这份记录的存活时间。在线机器每一轮对账（每分钟）握手都会重写它，
// TTL 因此只对**离线之后**的机器起作用：一台机器下线一个月之后，server 对它的构建
// 到底是什么已经不再有把握，如实退回「不知道」比留着一个越来越旧的答案诚实。
const daemonBuildTTL = 30 * 24 * time.Hour

// daemonBuildKey 是「(账号, 机器) 最近一次握手自报的短 commit」在 Redis 上的表示，
// 键形状照 protocolMismatchKey 复刻（指纹按 base64 编码，避免含冒号的值撞进别人的
// 命名空间）。存 Redis 而不是进程内存，理由与那一条相同：任何副本读到的都该是同一个
// 答案，而设备读端点未必落在跟着这台机器的那个副本上。
func daemonBuildKey(m machineKey) string {
	return fmt.Sprintf("mirror:daemon-build:%d:%s", m.userID,
		base64.RawURLEncoding.EncodeToString([]byte(m.fingerprint)))
}

// recordDaemonBuild 记下这台机器这次握手自报的短 commit。
//
// 与 refreshDeviceVersion 不同，这里不做「值不同才写」：那条判断是为了不往数据库发无谓
// 的 UPDATE，而这里每次都得写——续期本身就是写的目的，读一次再写一次反而更贵。
//
// Redis 故障时只记日志：设备卡少一条判断依据（退回「不下判断」），不值得让整条 Follow
// 因为这一步失败。
func (s *Supervisor) recordDaemonBuild(ctx context.Context, key machineKey, commit string) {
	if s.redis == nil {
		return
	}
	if err := s.redis.Set(ctx, daemonBuildKey(key), commit, daemonBuildTTL).Err(); err != nil {
		logger.Ctx(ctx).Warn("mirror daemon build not recorded",
			zap.Int64("userId", key.userID), zap.String("machineFingerprint", key.fingerprint), zap.Error(err))
	}
}

// RecordDaemonBuild 是 recordDaemonBuild 面向包外的公开入口，与 DaemonBuild 成对
// （对照 RecordProtocolMismatch / ProtocolMismatch）：dial() 走包内那个私有版本，
// 这一个供需要补记这份共享状态的调用方使用（例如设备读端点的测试要在不真的握一次手
// 的前提下断言读侧接线）。
func (s *Supervisor) RecordDaemonBuild(ctx context.Context, userID int64, fingerprint, commit string) {
	if s == nil {
		return
	}
	s.recordDaemonBuild(ctx, machineKey{userID: userID, fingerprint: fingerprint}, commit)
}

// DaemonBuild 回答「这台机器最近一次握手自报的短 commit 是什么」，第二个返回值是
// 「server 到底知不知道」。
//
// 供设备读端点消费（device_svc.ListUserDevices）。未装配镜像、Redis 读不出来、以及
// 从没握过手，都回 known=false —— 三者的可观察结果相同：不知道，因此不下判断。
func (s *Supervisor) DaemonBuild(ctx context.Context, userID int64, fingerprint string) (string, bool) {
	if s == nil || s.redis == nil {
		return "", false
	}
	commit, err := s.redis.Get(ctx, daemonBuildKey(machineKey{userID: userID, fingerprint: fingerprint})).Result()
	if err != nil {
		return "", false
	}
	return commit, true
}
