package exec_order_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/model/entity/exec_order_entity"
	hubtest "agentre-server/internal/testutils"
)

// 排列按 (user_id, device_id, agent_sync_id) 取：三段缺一不可。少绑 user_id 会让
// 一台设备读到别人账号的排列，少绑 agent_sync_id 会把另一个 Agent 的排列拿来用——
// 只验 SQL 文本看不出来，所以绑定值一并钉住。
func TestFind_GivenCompositeKey_ThenBindsAllThreeColumns(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewExecOrder()

	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `device_exec_target_orders` WHERE user_id=? AND device_id=? AND agent_sync_id=?",
	)).WithArgs(int64(7), int64(31), "agent-1", 1).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "device_id", "agent_sync_id", "order_json", "updatetime"}).
			AddRow(7, 31, "agent-1", `["backend-b","backend-a"]`, 1000))

	got, err := r.Find(ctx, 7, 31, "agent-1")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, []string{"backend-b", "backend-a"}, got.BackendSyncIDs())
	require.NoError(t, mock.ExpectationsWereMet())
}

// 没有行 = 这台设备对这个 Agent 没有自己的顺序，不是错误：调用方据此回落账号
// sort_order。返回 (nil, nil) 而不是 gorm.ErrRecordNotFound，让「没有排列」这个
// 常态不必在每个调用点被当成异常拆一次。
func TestFind_GivenNoRow_ThenNilWithoutError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewExecOrder()

	mock.ExpectQuery(regexp.QuoteMeta("FROM `device_exec_target_orders`")).
		WithArgs(int64(7), int64(31), "agent-1", 1).
		WillReturnRows(sqlmock.NewRows([]string{"user_id"}))

	got, err := r.Find(ctx, 7, 31, "agent-1")
	require.NoError(t, err)
	assert.Nil(t, got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// Save 是一条语句的 upsert：排列永远被整体替换（决策 13），同一 (user_id, device_id,
// agent_sync_id) 再排一次要覆盖旧排列而不是撞主键报错。先查再插会在两个标签页同时
// 提交时双双走到 INSERT，竞败方拿到一个主键冲突错误。
func TestSave_GivenExistingKey_ThenSingleStatementUpsert(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewExecOrder()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("ON DUPLICATE KEY UPDATE")).
		WithArgs(int64(7), int64(31), "agent-1", `["backend-b","backend-a"]`, int64(2000)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	o := &exec_order_entity.DeviceExecTargetOrder{
		UserID: 7, DeviceID: 31, AgentSyncID: "agent-1", Updatetime: 2000,
	}
	require.NoError(t, o.SetBackendSyncIDs([]string{"backend-b", "backend-a"}))
	require.NoError(t, r.Save(ctx, o))
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListByDevice 一次取这台设备对全部 Agent 的排列，供总览页一屏渲染多个 Agent 卡片时
// 不必按 Agent 逐条查库。同样按 (user_id, device_id) 双段过滤。
func TestListByDevice_GivenUserAndDevice_ThenScopedToBoth(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewExecOrder()

	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `device_exec_target_orders` WHERE user_id=? AND device_id=?",
	)).WithArgs(int64(7), int64(31)).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "device_id", "agent_sync_id", "order_json", "updatetime"}).
			AddRow(7, 31, "agent-1", `["backend-b"]`, 1000).
			AddRow(7, 31, "agent-2", `["backend-c"]`, 1000))

	got, err := r.ListByDevice(ctx, 7, 31)
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "agent-1", got[0].AgentSyncID)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 设备被解除授权 / 删除时，它的排列一并清除：顺序属于那台设备，设备没了它就没有
// 指代对象。device_id 是全局自增主键、天然只属于一个账号，不需要再传 user_id 校验
// 归属（与 sync_repo.SyncLocalPath().DeleteByDevice 同一约定）。
func TestDeleteByDevice_GivenDeviceID_ThenDeletesAllItsOrders(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewExecOrder()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `device_exec_target_orders` WHERE device_id=?")).
		WithArgs(int64(31)).WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectCommit()

	require.NoError(t, r.DeleteByDevice(ctx, 31))
	require.NoError(t, mock.ExpectationsWereMet())
}
