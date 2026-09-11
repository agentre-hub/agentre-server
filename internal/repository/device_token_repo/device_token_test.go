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
	// Bearer 校验整条链路都挂在 access token 的摘要真的被写进去上。一串 AnyArg 的期望
	// 连列名都不看，删掉 AccessTokenHash 字段照样绿，所以这里把列名和那一列的值都钉死。
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `device_tokens` (`device_id`,`refresh_token_hash`,`access_token_hash`")).
		WithArgs(int64(42), "h", "digest-1", sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(99, 1))
	mock.ExpectCommit()
	e := &device_token_entity.DeviceToken{DeviceID: 42, RefreshTokenHash: "h", RefreshExpiresAt: 1000, AccessTokenHash: "digest-1"}
	assert.NoError(t, r.Create(ctx, e))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// Bearer 校验按摘要取行，走 uk_dtokens_access_hash 的等值查找。
func TestFindByAccessHash_Found(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `device_tokens` WHERE access_token_hash=? ORDER BY `device_tokens`.`id` LIMIT ?")).
		WithArgs("digest-1", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "device_id", "createtime"}).AddRow(int64(11), int64(42), int64(1000)))
	got, err := r.FindByAccessHash(ctx, "digest-1")
	assert.NoError(t, err)
	if assert.NotNil(t, got) {
		assert.Equal(t, int64(11), got.ID)
		assert.Equal(t, int64(42), got.DeviceID)
		assert.Equal(t, int64(1000), got.Createtime)
	}
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByAccessHash_NotFound(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDeviceToken()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `device_tokens` WHERE access_token_hash=? ORDER BY `device_tokens`.`id` LIMIT ?")).
		WithArgs("digest-unknown", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))
	got, err := r.FindByAccessHash(ctx, "digest-unknown")
	assert.NoError(t, err)
	assert.Nil(t, got)
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
