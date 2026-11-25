package personal_token_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/personal_token_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// 解析整条链路挂在「摘要真的落进 token_hash、对端指纹真的落库」上，所以列名与这两列的值都钉死；
// createtime 没给时由仓储补上。
func TestCreate_WritesHashAndFingerprint(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `personal_tokens` (`user_id`,`name`,`token_hash`,`scopes`,`peer_fingerprint`,`created_by_device_id`,`lifetime_ms`,`expires_at`,`last_used_at`,`rotated_at`,`createtime`,`updatetime`)")).
		WithArgs(int64(7), "ci", "digest-1", "read,chat", "pat:fp", int64(3), int64(1000), int64(2000),
			int64(0), int64(0), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(11, 1))
	mock.ExpectCommit()

	e := &personal_token_entity.PersonalToken{
		UserID: 7, Name: "ci", TokenHash: "digest-1", Scopes: "read,chat", PeerFingerprint: "pat:fp",
		CreatedByDeviceID: 3, LifetimeMs: 1000, ExpiresAt: 2000,
	}
	require.NoError(t, NewPersonalToken().Create(ctx, e))
	assert.Equal(t, int64(11), e.ID)
	assert.NotZero(t, e.Createtime)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByHash(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	query := regexp.QuoteMeta("SELECT * FROM `personal_tokens` WHERE token_hash=? ORDER BY `personal_tokens`.`id` LIMIT ?")
	mock.ExpectQuery(query).WithArgs("digest-1", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "name"}).AddRow(int64(11), int64(7), "ci"))
	mock.ExpectQuery(query).WithArgs("digest-unknown", 1).WillReturnRows(sqlmock.NewRows([]string{"id"}))

	got, err := NewPersonalToken().FindByHash(ctx, "digest-1")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, int64(11), got.ID)
	assert.Equal(t, "ci", got.Name)

	got, err = NewPersonalToken().FindByHash(ctx, "digest-unknown")
	assert.NoError(t, err)
	assert.Nil(t, got, "查不到是 (nil, nil)")
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFind(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `personal_tokens` WHERE id=? ORDER BY `personal_tokens`.`id` LIMIT ?")).
		WithArgs(int64(11), 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "token_hash"}).AddRow(int64(11), "digest-1"))
	got, err := NewPersonalToken().Find(ctx, 11)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "digest-1", got.TokenHash)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 名字只在一个账号里唯一：查询必须同时带 user_id，否则会改到别人的 token。
func TestFindByName_IsScopedToTheAccount(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `personal_tokens` WHERE user_id=? AND name=? ORDER BY `personal_tokens`.`id` LIMIT ?")).
		WithArgs(int64(7), "ci", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))
	got, err := NewPersonalToken().FindByName(ctx, 7, "ci")
	assert.NoError(t, err)
	assert.Nil(t, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestListByUser(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `personal_tokens` WHERE user_id=? ORDER BY id")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(int64(1), "a").AddRow(int64(2), "b"))
	got, err := NewPersonalToken().ListByUser(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "a", got[0].Name)
	assert.Equal(t, "b", got[1].Name)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 轮换只改密钥与期限：名字、范围、对端指纹不在 SET 里（决策 19）。
func TestUpdateSecret_ChangesOnlySecretAndExpiry(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `personal_tokens` SET `expires_at`=?,`lifetime_ms`=?,`rotated_at`=?,`token_hash`=?,`updatetime`=? WHERE id=?")).
		WithArgs(int64(5000), int64(1000), int64(4000), "digest-2", sqlmock.AnyArg(), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	n, err := NewPersonalToken().UpdateSecret(ctx, &personal_token_entity.PersonalToken{
		ID: 11, TokenHash: "digest-2", LifetimeMs: 1000, ExpiresAt: 5000, RotatedAt: 4000,
		Name: "must-not-be-written", Scopes: "must-not-be-written", PeerFingerprint: "must-not-be-written",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestDeleteByName_IsScopedToTheAccount(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `personal_tokens` WHERE user_id=? AND name=?")).
		WithArgs(int64(7), "ci").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()
	n, err := NewPersonalToken().DeleteByName(ctx, 7, "ci")
	require.NoError(t, err)
	assert.Equal(t, int64(0), n, "影响行数原样交给 service 判「不存在」")
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestTouchLastUsed(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `personal_tokens` SET `last_used_at`=? WHERE id=?")).
		WithArgs(int64(9000), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	require.NoError(t, NewPersonalToken().TouchLastUsed(ctx, 11, 9000))
	assert.NoError(t, mock.ExpectationsWereMet())
}
