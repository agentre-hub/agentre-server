package user_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

func TestCreate(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `users`")).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(42, 1))
	mock.ExpectCommit()

	u := &user_entity.User{Email: "a@b.com", Status: 1}
	err := repo.Create(ctx, u)
	assert.NoError(t, err)
	assert.Equal(t, int64(42), u.ID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindIgnoreStatus_ReturnsBannedRow(t *testing.T) {
	// FindIgnoreStatus 是给闸门用的：账号行不管什么状态都要取回来交给 user_entity.Check
	// 判定，不能像 Find 那样把封禁行过滤成 (nil, nil)。
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `users` WHERE id=? ORDER BY `users`.`id` LIMIT ?")).
		WithArgs(int64(7), 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email", "status"}).AddRow(int64(7), "a@b.com", 2))

	got, err := repo.FindIgnoreStatus(ctx, 7)
	assert.NoError(t, err)
	assert.Equal(t, int64(7), got.ID)
	assert.Equal(t, 2, got.Status)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindIgnoreStatus_NotFound(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `users` WHERE id=? ORDER BY `users`.`id` LIMIT ?")).
		WithArgs(int64(404), 1).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))
	got, err := repo.FindIgnoreStatus(ctx, 404)
	assert.NoError(t, err)
	assert.Nil(t, got)
}

func TestFindByEmail_Found(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `users` WHERE email=? AND status=? ORDER BY `users`.`id` LIMIT ?")).
		WithArgs("a@b.com", 1, 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email", "status"}).AddRow(int64(1), "a@b.com", 1))

	got, err := repo.FindByEmail(ctx, "a@b.com")
	assert.NoError(t, err)
	assert.Equal(t, int64(1), got.ID)
}

func TestFindByEmail_NotFound(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `users` WHERE email=? AND status=? ORDER BY `users`.`id` LIMIT ?")).
		WithArgs("missing@x.com", 1, 1).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))
	got, err := repo.FindByEmail(ctx, "missing@x.com")
	assert.NoError(t, err)
	assert.Nil(t, got)
}

// WebAuthnHandle 只取 webauthn_handle 一列。用 SELECT * 把整行读回来再取字段也能跑，
// 但 handle 的调用点是「每次注册通行密钥前问一次」，没有理由顺带把邮箱搬一遍。
func TestWebAuthnHandle_ReadsTheColumn(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT webauthn_handle FROM `users` WHERE id=? LIMIT ?")).
		WithArgs(int64(7), 1).
		WillReturnRows(sqlmock.NewRows([]string{"webauthn_handle"}).AddRow([]byte{0xde, 0xad}))

	got, err := repo.WebAuthnHandle(ctx, 7)
	assert.NoError(t, err)
	assert.Equal(t, []byte{0xde, 0xad}, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 还没生成过 handle 的账号返回空，而不是报错——「没有」是常态，不是故障。
func TestWebAuthnHandle_EmptyWhenNeverGenerated(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT webauthn_handle FROM `users` WHERE id=? LIMIT ?")).
		WithArgs(int64(7), 1).
		WillReturnRows(sqlmock.NewRows([]string{"webauthn_handle"}).AddRow([]byte{}))

	got, err := repo.WebAuthnHandle(ctx, 7)
	assert.NoError(t, err)
	assert.Empty(t, got)
}

// 首次生成必须是条件写：WHERE 里带「这一列还是空的」，由数据库裁决谁先写成。
// 两个副本同时给同一个账号首次注册通行密钥时，无条件 UPDATE 会让后写的那个把
// 已经发给认证器的 handle 换掉，那把刚注册的密钥从此对不上账号。
func TestSetWebAuthnHandleIfEmpty_OnlyWritesWhenStillEmpty(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `users` SET `webauthn_handle`=? WHERE id=? AND (webauthn_handle IS NULL OR webauthn_handle='')",
	)).WithArgs([]byte{0xbe, 0xef}, int64(7)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	won, err := repo.SetWebAuthnHandleIfEmpty(ctx, 7, []byte{0xbe, 0xef})
	assert.NoError(t, err)
	assert.True(t, won)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 竞败方（这一列已经有值了）得到 false 而不是错误：它该做的是回头把已落定的那份读回来。
func TestSetWebAuthnHandleIfEmpty_LoserReportsNotWritten(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	repo := NewUser()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `users` SET `webauthn_handle`=?")).
		WithArgs([]byte{0xbe, 0xef}, int64(7)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	won, err := repo.SetWebAuthnHandleIfEmpty(ctx, 7, []byte{0xbe, 0xef})
	assert.NoError(t, err)
	assert.False(t, won)
}
