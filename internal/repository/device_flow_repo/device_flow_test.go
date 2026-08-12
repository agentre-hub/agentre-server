package device_flow_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	hubtest "agentre-server/internal/testutils"
)

func TestApprove(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		`UPDATE "device_flow_codes" SET "approved_at"=$1,"authorized_user_id"=$2 WHERE user_code=$3 AND consumed_at=0 AND denied_at=0 AND expires_at > $4`,
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
		`UPDATE "device_flow_codes" SET "approved_at"=$1,"authorized_user_id"=$2 WHERE user_code=$3 AND consumed_at=0 AND denied_at=0 AND expires_at > $4`,
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
		`UPDATE "device_flow_codes" SET "denied_at"=$1 WHERE user_code=$2 AND consumed_at=0 AND denied_at=0`,
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
		`UPDATE "device_flow_codes" SET "consumed_at"=$1 WHERE device_code=$2 AND consumed_at=0 AND denied_at=0`,
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
		`UPDATE "device_flow_codes" SET "consumed_at"=$1 WHERE device_code=$2 AND consumed_at=0 AND denied_at=0`,
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
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT * FROM "device_flow_codes" WHERE device_code=$1 ORDER BY "device_flow_codes"."device_code" LIMIT $2`)).
		WithArgs("dc-x", 1).
		WillReturnRows(sqlmock.NewRows([]string{"device_code", "user_code"}).AddRow("dc-x", "A4F-7Q2"))
	got, err := r.FindByDeviceCode(ctx, "dc-x")
	assert.NoError(t, err)
	assert.NotNil(t, got)
	assert.Equal(t, "A4F-7Q2", got.UserCode)
}
