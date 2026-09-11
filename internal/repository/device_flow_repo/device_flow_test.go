package device_flow_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

func TestApprove(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `device_flow_codes` SET `approved_at`=?,`authorized_user_id`=? WHERE user_code=? AND consumed_at=0 AND denied_at=0 AND expires_at > ?",
	)).WithArgs(int64(1000), int64(99), "A4F-7Q2", int64(1000)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	n, err := r.Approve(ctx, "A4F-7Q2", 99, 1000)
	assert.NoError(t, err)
	assert.Equal(t, int64(1), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 竞败方（行已被别人改过）必须能从返回的行数上看出来。
func TestApprove_ReturnsZeroRowsWhenNothingMatched(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `device_flow_codes` SET `approved_at`=?,`authorized_user_id`=? WHERE user_code=? AND consumed_at=0 AND denied_at=0 AND expires_at > ?",
	)).WithArgs(int64(1000), int64(99), "A4F-7Q2", int64(1000)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	n, err := r.Approve(ctx, "A4F-7Q2", 99, 1000)
	assert.NoError(t, err)
	assert.Equal(t, int64(0), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestDeny(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `device_flow_codes` SET `denied_at`=? WHERE user_code=? AND consumed_at=0 AND denied_at=0",
	)).WithArgs(int64(1000), "A4F-7Q2").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	n, err := r.Deny(ctx, "A4F-7Q2", 1000)
	assert.NoError(t, err)
	assert.Equal(t, int64(0), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 条件里必须同时有 consumed_at=0 和 denied_at=0，与 Approve / Deny 的条件集一致：
// 只有 consumed_at=0 的话，用户点「拒绝」的事务先提交、设备的换取事务随后跑这条
// UPDATE，denied_at 已经不为 0 却照样命中 1 行——用户明明拒绝了，设备还是拿到 token。
func TestMarkConsumed_RequiresUnsettledRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `device_flow_codes` SET `consumed_at`=? WHERE device_code=? AND consumed_at=0 AND denied_at=0",
	)).WithArgs(int64(1000), "dc-x").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	n, err := r.MarkConsumed(ctx, "dc-x", 1000)
	assert.NoError(t, err)
	assert.Equal(t, int64(1), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 行已被并发请求消费（或拒绝）时 UPDATE 命中 0 行，行数原样透传给 service。
func TestMarkConsumed_ReturnsZeroRowsWhenAlreadySettled(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `device_flow_codes` SET `consumed_at`=? WHERE device_code=? AND consumed_at=0 AND denied_at=0",
	)).WithArgs(int64(1000), "dc-x").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	n, err := r.MarkConsumed(ctx, "dc-x", 1000)
	assert.NoError(t, err)
	assert.Equal(t, int64(0), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByDeviceCode_Found(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `device_flow_codes` WHERE device_code=? ORDER BY `device_flow_codes`.`id` LIMIT ?")).
		WithArgs("dc-x", 1).
		WillReturnRows(sqlmock.NewRows([]string{"device_code", "user_code"}).AddRow("dc-x", "A4F-7Q2"))
	got, err := r.FindByDeviceCode(ctx, "dc-x")
	assert.NoError(t, err)
	assert.NotNil(t, got)
	assert.Equal(t, "A4F-7Q2", got.UserCode)
}

// 轮询限速从「先读 last_polled_at 判间隔、再无条件 UPDATE」改成一条条件 UPDATE：
// WHERE 里带 last_polled_at <= now-minGap，两个并发/重复的轮询请求打到同一行时，
// 数据库只让其中一条改到行，另一条凭 RowsAffected==0 判定该 slow_down——不再是
// service 先读一次再决定写不写的 check-then-act。
func TestUpdateLastPolledIfDue_UpdatesWhenDue(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `device_flow_codes` SET `last_polled_at`=? WHERE device_code=? AND last_polled_at <= ?",
	)).WithArgs(int64(15000), "dc-x", int64(10000)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	n, err := r.UpdateLastPolledIfDue(ctx, "dc-x", 15000, 5000)
	assert.NoError(t, err)
	assert.Equal(t, int64(1), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 另一个并发/重复请求撞上同一行时命中 0 行——它必须能从返回的行数上看出来，
// 而不是回头再读一次 last_polled_at。
func TestUpdateLastPolledIfDue_ReturnsZeroRowsWhenNotYetDue(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `device_flow_codes` SET `last_polled_at`=? WHERE device_code=? AND last_polled_at <= ?",
	)).WithArgs(int64(15000), "dc-x", int64(10000)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	n, err := r.UpdateLastPolledIfDue(ctx, "dc-x", 15000, 5000)
	assert.NoError(t, err)
	assert.Equal(t, int64(0), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 过期 device flow 码可能积到很大：不分批的一条 DELETE 会把 next-key 锁铺满它
// 扫过的范围。按 1000 行一批删，直到某一批没删满为止，与 device_token_repo.deleteBatched
// 是同一个理由、同一个常量。
func TestDeleteExpiredBefore_BatchesUntilUnderLimit(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()

	for _, affected := range []int64{cleanupBatchSize, 3} {
		mock.ExpectBegin()
		mock.ExpectExec(regexp.QuoteMeta(
			"DELETE FROM `device_flow_codes` WHERE expires_at < ?")).
			WithArgs(int64(1700), int64(cleanupBatchSize)).
			WillReturnResult(sqlmock.NewResult(0, affected))
		mock.ExpectCommit()
	}

	assert.NoError(t, r.DeleteExpiredBefore(ctx, 1700))
	assert.NoError(t, mock.ExpectationsWereMet())
}
