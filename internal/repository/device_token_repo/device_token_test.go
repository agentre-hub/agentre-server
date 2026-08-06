package device_token_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"agentre-server/internal/model/entity/device_token_entity"
	hubtest "agentre-server/internal/testutils"
)

func TestRevokeChain(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceToken()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE "device_tokens" SET "revoked_at"=$1 WHERE device_id=$2 AND revoked_at=0`)).
		WithArgs(int64(1700000000000), int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectCommit()

	assert.NoError(t, r.RevokeChain(ctx, 42, 1700000000000))
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByHash_Found(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceToken()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT * FROM "device_tokens" WHERE refresh_token_hash=$1 ORDER BY "device_tokens"."id" LIMIT $2`)).
		WithArgs("h1", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "device_id"}).AddRow(int64(11), int64(42)))
	got, err := r.FindByHash(ctx, "h1")
	assert.NoError(t, err)
	assert.NotNil(t, got)
	assert.Equal(t, int64(11), got.ID)
}

func TestCreate(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceToken()
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`INSERT INTO "device_tokens"`)).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(99)))
	mock.ExpectCommit()
	e := &device_token_entity.DeviceToken{DeviceID: 42, RefreshTokenHash: "h", RefreshExpiresAt: 1000, AccessJTI: "jti-1"}
	assert.NoError(t, r.Create(ctx, e))
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestListAccessJTIByDevice(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceToken()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT "access_jti" FROM "device_tokens" WHERE device_id=$1 AND access_jti != ''`)).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows([]string{"access_jti"}).AddRow("jti-aaa").AddRow("jti-bbb"))
	got, err := r.ListAccessJTIByDevice(ctx, 42)
	assert.NoError(t, err)
	assert.Equal(t, []string{"jti-aaa", "jti-bbb"}, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestListRevokedJTIByUser(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceToken()
	mock.ExpectQuery(regexp.QuoteMeta(
		`SELECT "device_tokens"."access_jti" FROM "device_tokens" JOIN devices ON devices.id = device_tokens.device_id WHERE devices.user_id = $1 AND device_tokens.revoked_at != 0 AND device_tokens.access_jti != '' AND device_tokens.createtime >= $2`)).
		WithArgs(int64(7), int64(1000)).
		WillReturnRows(sqlmock.NewRows([]string{"access_jti"}).AddRow("jti-revoked-1").AddRow("jti-revoked-2"))
	got, err := r.ListRevokedJTIByUser(ctx, 7, 1000)
	assert.NoError(t, err)
	assert.Equal(t, []string{"jti-revoked-1", "jti-revoked-2"}, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 同一条 device_tokens 行既是 Revoke() 的写入目标，也是本查询的读取来源：
// 撤销与分发之间没有缓存/队列，写入即刻可读——这是 R4「reflects a Revoke immediately」成立的机制。
func TestListRevokedJTIByUser_ReflectsRevokeImmediately(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceToken()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE "device_tokens" SET "revoked_at"=$1 WHERE id=$2`)).
		WithArgs(int64(2000), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	assert.NoError(t, r.Revoke(ctx, 11, 2000))

	mock.ExpectQuery(regexp.QuoteMeta(
		`SELECT "device_tokens"."access_jti" FROM "device_tokens" JOIN devices ON devices.id = device_tokens.device_id WHERE devices.user_id = $1 AND device_tokens.revoked_at != 0 AND device_tokens.access_jti != '' AND device_tokens.createtime >= $2`)).
		WithArgs(int64(7), int64(1000)).
		WillReturnRows(sqlmock.NewRows([]string{"access_jti"}).AddRow("jti-aaa"))
	got, err := r.ListRevokedJTIByUser(ctx, 7, 1000)
	assert.NoError(t, err)
	assert.Equal(t, []string{"jti-aaa"}, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestListRevokedJTIByUser_ExcludesOutsideAccessTTLWindow(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceToken()
	// windowStartMs 之前签发的行已被数据库端的 createtime >= ? 条件排除，
	// mock 只按预期 SQL 返回窗口内的一行——验证调用方传入的 windowStartMs 确实被当成查询条件。
	mock.ExpectQuery(regexp.QuoteMeta(
		`SELECT "device_tokens"."access_jti" FROM "device_tokens" JOIN devices ON devices.id = device_tokens.device_id WHERE devices.user_id = $1 AND device_tokens.revoked_at != 0 AND device_tokens.access_jti != '' AND device_tokens.createtime >= $2`)).
		WithArgs(int64(7), int64(5000)).
		WillReturnRows(sqlmock.NewRows([]string{"access_jti"}).AddRow("jti-in-window"))
	got, err := r.ListRevokedJTIByUser(ctx, 7, 5000)
	assert.NoError(t, err)
	assert.Equal(t, []string{"jti-in-window"}, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}
