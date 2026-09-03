package mirror_svc

import (
	"context"
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
