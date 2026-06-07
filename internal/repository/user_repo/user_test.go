package user_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"agentre-server/internal/model/entity/user_entity"
	hubtest "agentre-server/internal/testutils"
)

func TestCreate(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	repo := NewUser()

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`INSERT INTO "users"`)).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(42)))
	mock.ExpectCommit()

	u := &user_entity.User{Email: "a@b.com", Status: 1}
	err := repo.Create(ctx, u)
	assert.NoError(t, err)
	assert.Equal(t, int64(42), u.ID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByEmail_Found(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	repo := NewUser()

	mock.ExpectQuery(regexp.QuoteMeta(`SELECT * FROM "users" WHERE email=$1 AND status=$2 ORDER BY "users"."id" LIMIT $3`)).
		WithArgs("a@b.com", 1, 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email", "status"}).AddRow(int64(1), "a@b.com", 1))

	got, err := repo.FindByEmail(ctx, "a@b.com")
	assert.NoError(t, err)
	assert.Equal(t, int64(1), got.ID)
}

func TestFindByEmail_NotFound(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	repo := NewUser()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT * FROM "users" WHERE email=$1 AND status=$2 ORDER BY "users"."id" LIMIT $3`)).
		WithArgs("missing@x.com", 1, 1).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))
	got, err := repo.FindByEmail(ctx, "missing@x.com")
	assert.NoError(t, err)
	assert.Nil(t, got)
}
