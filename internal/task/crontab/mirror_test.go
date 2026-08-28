package crontab

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
)

// Given 这个部署没有装配常驻镜像；When 巡检到点；Then 安静跳过——
// 不 panic，也不每个周期在日志里留一条假故障。
func TestReconcileSessionMirrors_NotConfigured_IsQuiet(t *testing.T) {
	mirror_svc.SetDefault(nil)

	require.NoError(t, ReconcileSessionMirrors(context.Background()))
}

// Given 这个部署没有装配常驻镜像；When 补做删除待办到点；Then 同样安静跳过。
func TestReplayPendingSessionDeletes_NotConfigured_IsQuiet(t *testing.T) {
	mirror_svc.SetDefault(nil)

	require.NoError(t, ReplayPendingSessionDeletes(context.Background()))
}
