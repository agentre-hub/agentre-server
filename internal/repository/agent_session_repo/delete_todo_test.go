package agent_session_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// AddDeleteTodo 是一条条件插入：命中 uk_agent_session_delete_todos_identity
// (user_id, conversation_id) 时什么都不改——同一条待办不会被记两遍
// （执行机离线期间账号侧可能因为别的原因重复触发同一次清理）。
func TestAddDeleteTodo_OnConflictDoNothing(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeleteTodo()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `agent_session_delete_todos`")).
		WithArgs(int64(7), "conv-9", "fp-desktop-1", int64(1000)).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	require.NoError(t, r.AddDeleteTodo(ctx, &agent_session_entity.DeleteTodo{
		UserID: 7, ConversationID: "conv-9", DeviceFingerprint: "fp-desktop-1", Createtime: 1000,
	}))
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListDeleteTodosByDevice 按账号 + 这台机器过滤：待办要执行的机器是身份的一部分，
// 少了 user_id 就是跨账号读到别的账号压在这台机器上的待办。
func TestListDeleteTodosByDevice_AccountAndPeerScoped(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeleteTodo()

	rows := sqlmock.NewRows([]string{"id", "user_id", "conversation_id", "device_fingerprint", "createtime"}).
		AddRow(1, 7, "conv-9", "fp-desktop-1", 1000).
		AddRow(2, 7, "conv-8", "fp-desktop-1", 900)
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `agent_session_delete_todos` WHERE user_id=? AND device_fingerprint=? ORDER BY id ASC",
	)).WithArgs(int64(7), "fp-desktop-1").WillReturnRows(rows)

	out, err := r.ListDeleteTodosByDevice(ctx, 7, "fp-desktop-1")
	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, "conv-9", out[0].ConversationID)
	require.NoError(t, mock.ExpectationsWereMet())
}

// RemoveDeleteTodo 是一条 DELETE：待办被执行完之后撤掉；从未记过时删不到行，
// 仍然成功（幂等，与设备撤销时顺带清理同一条路径）。
func TestRemoveDeleteTodo_DeleteIsIdempotent(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeleteTodo()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `agent_session_delete_todos`")).
		WithArgs(int64(7), "conv-9").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	require.NoError(t, r.RemoveDeleteTodo(ctx, 7, "conv-9"))
	require.NoError(t, mock.ExpectationsWereMet())
}

// RemoveDeleteTodosByDevice 清掉挂在一台机器上的全部待办：设备被撤销之后那些删除
// 指令永远执行不了（决策 7），留着没有意义。按账号 + 这台机器圈定，别的机器上
// 的待办一条都不能碰。
func TestRemoveDeleteTodosByDevice_ClearsOnlyThatMachine(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeleteTodo()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"DELETE FROM `agent_session_delete_todos` WHERE user_id=? AND device_fingerprint=?",
	)).WithArgs(int64(7), "fp-desktop-1").WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectCommit()

	require.NoError(t, r.RemoveDeleteTodosByDevice(ctx, 7, "fp-desktop-1"))
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListPendingMachines 是巡检的取材面：全库范围内还欠着删除的机器，按
// (user_id, device_fingerprint) 去重。它按定义没有账号作用域——巡检问的是「整个部署里
// 哪些机器欠着删除」，而请求路径上的每一次读都限定在调用方自己的账号里
// （那是 ListDeleteTodosByDevice 的事）。
//
// 取材必须来自待办表本身，不能借用保存名单：删掉一台离线机器上**最后**一条对话
// 之后，那台机器就再也不出现在保存名单里，而它恰恰还欠着一条删除。
func TestListPendingMachines_DistinctByAccountAndPeer(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeleteTodo()

	rows := sqlmock.NewRows([]string{"user_id", "device_fingerprint"}).
		AddRow(7, "fp-desktop-1").
		AddRow(9, "fp-agentred-2")
	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT DISTINCT `user_id`,`device_fingerprint` FROM `agent_session_delete_todos` ORDER BY user_id ASC",
	)).WillReturnRows(rows)

	out, err := r.ListPendingMachines(ctx)
	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, PendingMachine{UserID: 7, DeviceFingerprint: "fp-desktop-1"}, out[0])
	assert.Equal(t, PendingMachine{UserID: 9, DeviceFingerprint: "fp-agentred-2"}, out[1])
	require.NoError(t, mock.ExpectationsWereMet())
}
