// Package task 注册所有后台任务。
package task

import (
	"context"

	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/server/cron"

	"agentre-server/internal/task/crontab"
)

// Task cago FuncComponent 入口。
func Task(ctx context.Context, _ *configs.Config) error {
	_, _ = cron.Default().AddFunc("*/5 * * * *", crontab.CleanupDeviceFlowCodes)
	_, _ = cron.Default().AddFunc("0 * * * *", crontab.CleanupDeviceTokens)
	return nil
}
