package user_identity_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_identity_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

func TestFindByProviderUID_Found(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewUserIdentity()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT * FROM `user_identities` WHERE provider=? AND provider_uid=? ORDER BY `user_identities`.`id` LIMIT ?",
	)).WithArgs("github", "12345", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}).AddRow(int64(7), int64(99)))

	got, err := r.FindByProviderUID(ctx, "github", "12345")
	assert.NoError(t, err)
	assert.NotNil(t, got)
	assert.Equal(t, int64(99), got.UserID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByUserAndProvider_Found(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewUserIdentity()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT * FROM `user_identities` WHERE user_id=? AND provider=? ORDER BY `user_identities`.`id` LIMIT ?",
	)).WithArgs(int64(99), "github", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "provider", "provider_login"}).
			AddRow(int64(7), int64(99), "github", "testuser"))

	got, err := r.FindByUserAndProvider(ctx, 99, "github")
	assert.NoError(t, err)
	assert.NotNil(t, got)
	assert.Equal(t, int64(99), got.UserID)
	assert.Equal(t, "testuser", got.ProviderLogin)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByUserAndProvider_NotFound(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewUserIdentity()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT * FROM `user_identities` WHERE user_id=? AND provider=? ORDER BY `user_identities`.`id` LIMIT ?",
	)).WithArgs(int64(99), "github", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "provider", "provider_login"}))

	got, err := r.FindByUserAndProvider(ctx, 99, "github")
	assert.NoError(t, err)
	assert.Nil(t, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestCreate(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewUserIdentity()

	// raw_profile 排在末尾：它带 default，gorm 把有默认值的列放到列表最后。
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `user_identities` (`user_id`,`provider`,`provider_uid`,`provider_login`,"+
			"`email`,`createtime`,`updatetime`,`raw_profile`) VALUES (?,?,?,?,?,?,?,?)")).
		WithArgs(int64(99), "github", "1", "", "a@b.com",
			sqlmock.AnyArg(), sqlmock.AnyArg(), []byte(`{"login":"x"}`)).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	e := &user_identity_entity.UserIdentity{
		UserID: 99, Provider: "github", ProviderUID: "1", Email: "a@b.com",
		RawProfile: []byte(`{"login":"x"}`),
	}
	assert.NoError(t, r.Create(ctx, e))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// raw_profile 的「没有 profile 就存 {}」由 schema 的 DEFAULT ('{}') 表达，仓储层不再
// 兜一遍：调用方（user_svc.createIdentity）本来就已经规范化过一次，两处兜底意味着
// 同一个概念有两份实现，而删掉任一处都看不出坏在哪。这里断言仓储层**不写**
// raw_profile 这一列——列缺席时 MySQL 用列默认值填。
func TestCreate_GivenNoRawProfile_ThenLeavesTheColumnToItsSchemaDefault(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewUserIdentity()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `user_identities` (`user_id`,`provider`,`provider_uid`,`provider_login`,"+
			"`email`,`createtime`,`updatetime`) VALUES (?,?,?,?,?,?,?)")).
		WithArgs(int64(99), "github", "1", "", "a@b.com", sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	e := &user_identity_entity.UserIdentity{UserID: 99, Provider: "github", ProviderUID: "1", Email: "a@b.com"}
	assert.NoError(t, r.Create(ctx, e))
	assert.Empty(t, e.RawProfile, "仓储层不得回填实体字段")
	assert.NoError(t, mock.ExpectationsWereMet())
}
