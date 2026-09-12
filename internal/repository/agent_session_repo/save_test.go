package agent_session_repo

import (
	"errors"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// Follow 必须是一条语句：一条 INSERT，命中 uk_agent_session_saves_identity
// (user_id, conversation_id) 时什么都不改。重复关注（同账号、同一目标会话）是
// no-op，由数据库原子裁决：不新增行、也不重置首次关注时间——R12「关注幂等」在
// 数据层的落点。这里用 0 行受影响的结果模拟「已关注」的那次重复请求。
func TestFollow_SingleStatementOnConflictDoNothing(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	mock.ExpectBegin()
	// 绑定值也一并钉住：少绑一列（比如把 user_id 漏在 WHERE 之外）时唯一索引的
	// 裁决对象就变了，只验 SQL 文本看不出来。
	mock.ExpectExec(regexp.QuoteMeta(
		`ON DUPLICATE KEY UPDATE`,
	)).WithArgs(int64(7), "conv-9", "fp-daemon-1", "fp-browser-1",
		int64(1000), int64(1000), int64(1000)).
		WillReturnResult(sqlmock.NewResult(0, 0)) // 0 行 = 已关注，冲突 no-op
	mock.ExpectCommit()

	f := &agent_session_entity.SessionSave{
		UserID: 7, ConversationID: "conv-9", DeviceFingerprint: "fp-daemon-1",
		PeerFingerprint: "fp-browser-1", FollowedAt: 1000, Createtime: 1000, Updatetime: 1000,
	}
	require.NoError(t, r.Save(ctx, f))
	require.NoError(t, mock.ExpectationsWereMet())
}

// Unfollow 是一条 DELETE：从未关注 / 已取消时删不到行，仍是成功——R12「取消幂等」。
func TestUnfollow_DeleteIsIdempotent(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `agent_session_saves`")).
		WithArgs(int64(7), "conv-9").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	require.NoError(t, r.Delete(ctx, 7, "conv-9"))
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListByUser 只按账号过滤：名单属于账号，不属于某一台设备或某一个浏览器（R14）。
// 不按在线态过滤——机器离线时该条仍在名单里（R13）。
//
// 不再钉排序：调用方要么按机器分组（savedByMachine）、要么当集合比较
// （sameSavedSet），没有谁依赖返回顺序（决策 8）。SQL 里也不该再有 ORDER BY——
// 那是一次全账号扫描后的 filesort，真库上 4750 行要 5.51ms，而没人读它排出来的序。
func TestListByUser_AccountScoped(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	rows := sqlmock.NewRows([]string{
		"id", "user_id", "conversation_id", "device_fingerprint", "followed_at", "createtime", "updatetime",
	}).
		AddRow(1, 7, "conv-9", "fp-daemon-1", 2000, 2000, 2000).
		AddRow(2, 7, "conv-8", "fp-daemon-1", 1000, 1000, 1000)
	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT * FROM `agent_session_saves` WHERE user_id=?",
	)).WithArgs(int64(7)).WillReturnRows(rows)

	out, err := r.ListByUser(ctx, 7)
	require.NoError(t, err)
	require.Len(t, out, 2)
	ids := []string{out[0].ConversationID, out[1].ConversationID}
	assert.ElementsMatch(t, []string{"conv-9", "conv-8"}, ids)
	require.NoError(t, mock.ExpectationsWereMet())
}

// CountByUser 数出账号保存名单的条数，供设置页「已保存对话数」那一个数字用——
// 不该为了数数把整张名单读回来（要求 9）。
func TestCountByUser_CountsOnly(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT count(*) FROM `agent_session_saves` WHERE user_id=?",
	)).WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))

	n, err := r.CountByUser(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, int64(3), n)
	require.NoError(t, mock.ExpectationsWereMet())
}

// CountByUser 把底层错误如实上抛，不吞掉。
func TestCountByUser_PropagatesError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT count(*) FROM `agent_session_saves` WHERE user_id=?",
	)).WithArgs(int64(7)).WillReturnError(errors.New("boom"))

	_, err := r.CountByUser(ctx, 7)
	require.Error(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListConversationIDsByMachine 只取一台机器上的对话 id，走
// idx_agent_session_saves_machine(user_id, device_fingerprint)——镜像巡检按机器
// 取范围时不该读整个账号的保存名单（要求 9）。
func TestListConversationIDsByMachine_ScopedToOneMachine(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT `conversation_id` FROM `agent_session_saves` WHERE user_id=? AND device_fingerprint=?",
	)).WithArgs(int64(7), "fp-daemon-1").
		WillReturnRows(sqlmock.NewRows([]string{"conversation_id"}).AddRow("conv-9").AddRow("conv-8"))

	out, err := r.ListConversationIDsByMachine(ctx, 7, "fp-daemon-1")
	require.NoError(t, err)
	assert.Equal(t, []string{"conv-9", "conv-8"}, out)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 机器上没有保存过任何对话时交回空清单而不是错误：巡检与保存路径都会常态性地
// 问到这种机器。
func TestListConversationIDsByMachine_NothingSaved_IsEmpty(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT `conversation_id` FROM `agent_session_saves` WHERE user_id=? AND device_fingerprint=?",
	)).WithArgs(int64(7), "fp-daemon-1").
		WillReturnRows(sqlmock.NewRows([]string{"conversation_id"}))

	out, err := r.ListConversationIDsByMachine(ctx, 7, "fp-daemon-1")
	require.NoError(t, err)
	assert.Empty(t, out)
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListConversationIDsByMachine 把底层错误如实上抛，不吞掉。
func TestListConversationIDsByMachine_PropagatesError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT `conversation_id` FROM `agent_session_saves` WHERE user_id=? AND device_fingerprint=?",
	)).WithArgs(int64(7), "fp-daemon-1").WillReturnError(errors.New("boom"))

	_, err := r.ListConversationIDsByMachine(ctx, 7, "fp-daemon-1")
	require.Error(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListMachines 是**全库**的一次扫描：镜像的巡检要回答「哪些机器上有账号保存过的
// 对话」，这个问题按定义没有账号作用域。同一台机器上保存了多少条对话不影响答案，
// 因此按 (user_id, device_fingerprint) 去重——巡检要的是机器，不是对话。
func TestListMachines_DistinctUserAndFingerprint(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	rows := sqlmock.NewRows([]string{"user_id", "device_fingerprint"}).
		AddRow(7, "fp-daemon-1").
		AddRow(7, "fp-desktop-2").
		AddRow(9, "fp-daemon-1")
	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT DISTINCT `user_id`,`device_fingerprint` FROM `agent_session_saves`",
	)).WillReturnRows(rows)

	out, err := r.ListMachines(ctx)
	require.NoError(t, err)
	require.Len(t, out, 3)
	assert.Equal(t, Machine{UserID: 7, Fingerprint: "fp-daemon-1"}, out[0])
	// 同一个指纹值在两个账号下是两台互不相干的机器，两条都要在。
	assert.Equal(t, Machine{UserID: 9, Fingerprint: "fp-daemon-1"}, out[2])
	require.NoError(t, mock.ExpectationsWereMet())
}

// 一条保存记录都没有时交出空清单而不是错误：巡检每个周期都会问一次，账号里空着
// 是最常见的情形。
func TestListMachines_NothingSaved_IsEmpty(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSave()

	mock.ExpectQuery(regexp.QuoteMeta("FROM `agent_session_saves`")).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "device_fingerprint"}))

	out, err := r.ListMachines(ctx)
	require.NoError(t, err)
	assert.Empty(t, out)
	require.NoError(t, mock.ExpectationsWereMet())
}
