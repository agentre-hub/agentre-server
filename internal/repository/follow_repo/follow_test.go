package follow_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/model/entity/follow_entity"
	hubtest "agentre-server/internal/testutils"
)

// Follow 必须是一条语句：一条 INSERT，命中 uk_followed_sessions_identity
// (user_id, device_fingerprint, session_id) 时什么都不改。重复关注（同账号、同一目标会话）是
// no-op，由数据库原子裁决：不新增行、也不重置首次关注时间——R12「关注幂等」在
// 数据层的落点。这里用 0 行受影响的结果模拟「已关注」的那次重复请求。
func TestFollow_SingleStatementOnConflictDoNothing(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewFollow()

	mock.ExpectBegin()
	// 绑定值也一并钉住：少绑一列（比如把 user_id 漏在 WHERE 之外）时唯一索引的
	// 裁决对象就变了，只验 SQL 文本看不出来。
	mock.ExpectExec(regexp.QuoteMeta(
		`ON DUPLICATE KEY UPDATE`,
	)).WithArgs(int64(7), "fp-daemon-1", "sess-9", int64(1000), int64(1000), int64(1000)).
		WillReturnResult(sqlmock.NewResult(0, 0)) // 0 行 = 已关注，冲突 no-op
	mock.ExpectCommit()

	f := &follow_entity.FollowedSession{
		UserID: 7, DeviceFingerprint: "fp-daemon-1", SessionID: "sess-9",
		FollowedAt: 1000, Createtime: 1000, Updatetime: 1000,
	}
	require.NoError(t, r.Follow(ctx, f))
	require.NoError(t, mock.ExpectationsWereMet())
}

// Unfollow 是一条 DELETE：从未关注 / 已取消时删不到行，仍是成功——R12「取消幂等」。
func TestUnfollow_DeleteIsIdempotent(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewFollow()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `followed_sessions`")).
		WithArgs(int64(7), "fp-daemon-1", "sess-9").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	require.NoError(t, r.Unfollow(ctx, 7, "fp-daemon-1", "sess-9"))
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListByUser 只按账号过滤：名单属于账号，不属于某一台设备或某一个浏览器（R14）。
// 不按在线态过滤——机器离线时该条仍在名单里（R13）。
func TestListByUser_AccountScoped(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewFollow()

	rows := sqlmock.NewRows([]string{
		"id", "user_id", "device_fingerprint", "session_id", "followed_at", "createtime", "updatetime",
	}).
		AddRow(1, 7, "fp-daemon-1", "sess-9", 2000, 2000, 2000).
		AddRow(2, 7, "fp-daemon-1", "sess-8", 1000, 1000, 1000)
	// 排序也钉在 SQL 上：sqlmock 按给定顺序回行，光比第一行的内容，把 ORDER BY
	// 整句删掉这个用例照样绿。「最近关注的排在前面」是 R13 列表的顺序承诺。
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `followed_sessions` WHERE user_id=? ORDER BY followed_at DESC, id DESC",
	)).WithArgs(int64(7)).WillReturnRows(rows)

	out, err := r.ListByUser(ctx, 7)
	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, "sess-9", out[0].SessionID)
	assert.Equal(t, "fp-daemon-1", out[0].DeviceFingerprint)
	require.NoError(t, mock.ExpectationsWereMet())
}
