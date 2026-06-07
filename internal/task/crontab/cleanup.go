// Package crontab 定时清理任务实现。
package crontab

import (
	"context"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"agentre-server/internal/repository/device_flow_repo"
	"agentre-server/internal/repository/device_token_repo"
)

// CleanupDeviceFlowCodes 删除 1 天前已过期的 flow 记录。
func CleanupDeviceFlowCodes(ctx context.Context) error {
	cutoff := time.Now().Add(-24 * time.Hour).UnixMilli()
	if err := device_flow_repo.DeviceFlow().DeleteExpiredBefore(ctx, cutoff); err != nil {
		logger.Ctx(ctx).Error("cleanup device_flow_codes", zap.Error(err))
		return err
	}
	return nil
}

// CleanupDeviceTokens 删除 30 天前已 revoke 或 7 天前已过期的 token。
func CleanupDeviceTokens(ctx context.Context) error {
	cutoff := time.Now().Add(-30 * 24 * time.Hour).UnixMilli()
	if err := device_token_repo.DeviceToken().DeleteRevokedBefore(ctx, cutoff); err != nil {
		logger.Ctx(ctx).Error("cleanup device_tokens", zap.Error(err))
		return err
	}
	return nil
}
