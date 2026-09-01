package migrations

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// 本文件测的是**回填的控制流**（选一批身份、逐条按决策 2 算出 uuid、写回、直到一行
// 不剩），不是 DDL 文本 —— docs/testing.md「Assert behaviour, not implementation text」
// 允许 sqlmock 覆盖迁移编排里这类可执行行为，而加列 / 换键那两次迁移的 schema 归手工
// 验证（docs/verification.md）。
//
// 这里逐字断言的 uuid 与 internal/pkg/conversationid 的向量测试是同一组值：那边证明
// 「本仓库与桌面端算得一样」，这里证明「回填真的把算出来的那个值写进了那一行」。

const (
	// 与 conversationid 的跨仓向量表同一组输入与输出。
	fpA          = "sha256:aaaa"
	fpB          = "sha256:bbbb"
	wantAOne     = "dd5414f5-0877-5e9d-9656-b3b44e49697f"
	wantATwo     = "4d7f58e9-9881-5189-a9cd-b62f817db549"
	wantBOne     = "88f2b427-8035-57d5-8e8b-64fa700ea77a"
	selectBatch  = `SELECT DISTINCT user_id, peer_fingerprint, peer_session_id FROM agent_sessions WHERE conversation_id = '' LIMIT \?`
	updateOneRow = `UPDATE agent_sessions SET conversation_id = \? WHERE user_id = \? AND peer_fingerprint = \? AND peer_session_id = \? AND conversation_id = ''`
)

func identityRows(rows ...[3]any) *sqlmock.Rows {
	out := sqlmock.NewRows([]string{"user_id", "peer_fingerprint", "peer_session_id"})
	for _, r := range rows {
		out.AddRow(r[0], r[1], r[2])
	}
	return out
}

// Given 三条还没有身份的存量对话，When 回填，Then 每一条都被写上决策 2 派生出来的
// 那个 uuid，而且循环在选不出行的那一轮停下。
//
// 「同一台机器上同号的两条对话是常态」正是这里的第三条（fpB/1 与 fpA/1 同号不同发起端）：
// 派生的两个输入都进指纹与会话号，所以它们必须落到两个不同的 uuid 上。
func TestBackfillConversationIDs_GivenLegacyRows_ThenWritesTheDecisionTwoDerivation(t *testing.T) {
	_, gormDB, mock := hubtest.Database(t)

	mock.ExpectQuery(selectBatch).WithArgs(backfillBatchSize).WillReturnRows(identityRows(
		[3]any{int64(7), fpA, "1"},
		[3]any{int64(7), fpA, "2"},
		[3]any{int64(9), fpB, "1"},
	))
	mock.ExpectExec(updateOneRow).WithArgs(wantAOne, int64(7), fpA, "1").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(updateOneRow).WithArgs(wantATwo, int64(7), fpA, "2").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(updateOneRow).WithArgs(wantBOne, int64(9), fpB, "1").
		WillReturnResult(sqlmock.NewResult(0, 4))
	// 补完之后这一轮选不出行，循环就此停下。
	mock.ExpectQuery(selectBatch).WithArgs(backfillBatchSize).WillReturnRows(identityRows())

	require.NoError(t, backfillConversationIDs(gormDB, "agent_sessions"))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// Given 一张已经回填过（或本来就空）的表，When 再跑一遍，Then 一条 UPDATE 都不发。
//
// 这是「回填幂等」的机械形态：判据是 `conversation_id = ”`，重跑选不出行，因此
// 既不会改写换键之后新写进来的行，也不会把同一条对话算成第二个值。
func TestBackfillConversationIDs_GivenEveryRowAlreadyHasAnIdentity_ThenChangesNothing(t *testing.T) {
	_, gormDB, mock := hubtest.Database(t)

	mock.ExpectQuery(selectBatch).WithArgs(backfillBatchSize).WillReturnRows(identityRows())

	require.NoError(t, backfillConversationIDs(gormDB, "agent_sessions"))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// Given 第一批补完之后还剩下没补的，When 回填，Then 它接着取下一批 ——
// 回填是**可分批**的，不是「一次取全」：agent_session_notification_journal 的体量没有上界。
func TestBackfillConversationIDs_GivenMoreIdentitiesThanOneBatch_ThenKeepsGoingUntilNoneAreLeft(t *testing.T) {
	_, gormDB, mock := hubtest.Database(t)

	mock.ExpectQuery(selectBatch).WithArgs(backfillBatchSize).
		WillReturnRows(identityRows([3]any{int64(7), fpA, "1"}))
	mock.ExpectExec(updateOneRow).WithArgs(wantAOne, int64(7), fpA, "1").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(selectBatch).WithArgs(backfillBatchSize).
		WillReturnRows(identityRows([3]any{int64(9), fpB, "1"}))
	mock.ExpectExec(updateOneRow).WithArgs(wantBOne, int64(9), fpB, "1").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(selectBatch).WithArgs(backfillBatchSize).WillReturnRows(identityRows())

	require.NoError(t, backfillConversationIDs(gormDB, "agent_sessions"))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// Given 取一批身份时数据库出错，When 回填，Then 错误原样上交、不继续往下写。
// 迁移失败要让 main.go 的 log.Fatalf 退出，而不是留下半张补过的表还报成功。
func TestBackfillConversationIDs_GivenTheBatchQueryFails_ThenReturnsTheError(t *testing.T) {
	_, gormDB, mock := hubtest.Database(t)

	mock.ExpectQuery(selectBatch).WithArgs(backfillBatchSize).WillReturnError(assert.AnError)

	assert.ErrorIs(t, backfillConversationIDs(gormDB, "agent_sessions"), assert.AnError)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// Given 写回某一条时数据库出错，When 回填，Then 错误原样上交。
func TestBackfillConversationIDs_GivenAnUpdateFails_ThenReturnsTheError(t *testing.T) {
	_, gormDB, mock := hubtest.Database(t)

	mock.ExpectQuery(selectBatch).WithArgs(backfillBatchSize).
		WillReturnRows(identityRows([3]any{int64(7), fpA, "1"}))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE agent_sessions")).WillReturnError(assert.AnError)

	assert.ErrorIs(t, backfillConversationIDs(gormDB, "agent_sessions"), assert.AnError)
	assert.NoError(t, mock.ExpectationsWereMet())
}
