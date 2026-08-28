package device_token_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_token_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

func TestRevokeChain(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `device_tokens` SET `revoked_at`=? WHERE device_id=? AND revoked_at=0")).
		WithArgs(int64(1700000000000), int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectCommit()

	assert.NoError(t, r.RevokeChain(ctx, 42, 1700000000000))
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestRevoke_RequiresUnrevokedRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `device_tokens` SET `revoked_at`=? WHERE id=? AND revoked_at=0")).
		WithArgs(int64(1700000000000), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	n, err := r.Revoke(ctx, 11, 1700000000000)
	assert.NoError(t, err)
	assert.Equal(t, int64(1), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 行已被并发请求轮换时 UPDATE 命中 0 行，行数原样透传给 service。
func TestRevoke_ReturnsZeroRowsWhenAlreadyRevoked(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `device_tokens` SET `revoked_at`=? WHERE id=? AND revoked_at=0")).
		WithArgs(int64(1700000000000), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	n, err := r.Revoke(ctx, 11, 1700000000000)
	assert.NoError(t, err)
	assert.Equal(t, int64(0), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByHash_Found(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `device_tokens` WHERE refresh_token_hash=? ORDER BY `device_tokens`.`id` LIMIT ?")).
		WithArgs("h1", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "device_id"}).AddRow(int64(11), int64(42)))
	got, err := r.FindByHash(ctx, "h1")
	assert.NoError(t, err)
	assert.NotNil(t, got)
	assert.Equal(t, int64(11), got.ID)
}

func TestCreate(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()
	mock.ExpectBegin()
	// R4 整条链路都挂在 access_jti 真的被写进去上（Revoke 拉黑它、吊销列表分发它）。
	// 十个 AnyArg 的期望连列名都不看，删掉 AccessJTI 字段照样绿，所以这里把列名和
	// 那一列的值都钉死。
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `device_tokens` (`device_id`,`refresh_token_hash`,`access_jti`")).
		WithArgs(int64(42), "h", "jti-1", sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(99, 1))
	mock.ExpectCommit()
	e := &device_token_entity.DeviceToken{DeviceID: 42, RefreshTokenHash: "h", RefreshExpiresAt: 1000, AccessJTI: "jti-1"}
	assert.NoError(t, r.Create(ctx, e))
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestListAccessJTIByDevice(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT `access_jti` FROM `device_tokens` WHERE device_id=? AND access_jti != ''")).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows([]string{"access_jti"}).AddRow("jti-aaa").AddRow("jti-bbb"))
	got, err := r.ListAccessJTIByDevice(ctx, 42)
	assert.NoError(t, err)
	assert.Equal(t, []string{"jti-aaa", "jti-bbb"}, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestListRevokedJTIByUser(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()
	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT `device_tokens`.`access_jti` FROM `device_tokens` JOIN devices ON devices.id = device_tokens.device_id WHERE devices.user_id = ? AND device_tokens.revoked_at != 0 AND device_tokens.access_jti != '' AND device_tokens.createtime >= ?")).
		WithArgs(int64(7), int64(1000)).
		WillReturnRows(sqlmock.NewRows([]string{"access_jti"}).AddRow("jti-revoked-1").AddRow("jti-revoked-2"))
	got, err := r.ListRevokedJTIByUser(ctx, 7, 1000)
	assert.NoError(t, err)
	assert.Equal(t, []string{"jti-revoked-1", "jti-revoked-2"}, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestListRevokedJTIByUser_ExcludesOutsideAccessTTLWindow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()
	// windowStartMs 之前签发的行已被数据库端的 createtime >= ? 条件排除，
	// mock 只按预期 SQL 返回窗口内的一行——验证调用方传入的 windowStartMs 确实被当成查询条件。
	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT `device_tokens`.`access_jti` FROM `device_tokens` JOIN devices ON devices.id = device_tokens.device_id WHERE devices.user_id = ? AND device_tokens.revoked_at != 0 AND device_tokens.access_jti != '' AND device_tokens.createtime >= ?")).
		WithArgs(int64(7), int64(5000)).
		WillReturnRows(sqlmock.NewRows([]string{"access_jti"}).AddRow("jti-in-window"))
	got, err := r.ListRevokedJTIByUser(ctx, 7, 5000)
	assert.NoError(t, err)
	assert.Equal(t, []string{"jti-in-window"}, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 每小时一次的令牌清理从前是一条语句:
//
//	(revoked_at != 0 AND revoked_at < ?) OR refresh_expires_at < ?
//
// 两个毛病叠在一起。其一,OR 只要有一侧定位不了,整条就退化成全表扫——而
// refresh_expires_at 当时不在任何索引里(现在有 idx_dtokens_refresh_expiry)。其二,不分批:
// 这张表的增长很快(access TTL 15 分钟、refresh 每次轮换插一行,90 天窗口下稳态几
// 百万行),一次删掉几十万行会把 next-key 锁铺满整张表,期间所有设备都刷不了令牌。
//
// 拆成两条各自带索引的语句,行集合与原来完全相同:同时满足两侧的行由第一条删走,
// 第二条自然找不到它。
func TestDeleteRevokedBefore_ThenEachSideIsItsOwnBoundedRangeScan(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()

	// 已撤销的那一侧:第一批删满,于是必须再来一批。
	for _, affected := range []int64{cleanupBatchSize, 2} {
		mock.ExpectBegin()
		mock.ExpectExec(regexp.QuoteMeta(
			"DELETE FROM `device_tokens` WHERE revoked_at != 0 AND revoked_at < ?")).
			WithArgs(int64(1700), int64(cleanupBatchSize)).
			WillReturnResult(sqlmock.NewResult(0, affected))
		mock.ExpectCommit()
	}
	// 刷新令牌过期的那一侧。
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"DELETE FROM `device_tokens` WHERE refresh_expires_at < ?")).
		WithArgs(int64(1700), int64(cleanupBatchSize)).
		WillReturnResult(sqlmock.NewResult(0, 5))
	mock.ExpectCommit()

	assert.NoError(t, r.DeleteRevokedBefore(ctx, 1700))
	assert.NoError(t, mock.ExpectationsWereMet())
}
