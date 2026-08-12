package user_identity_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"agentre-server/internal/model/entity/user_identity_entity"
	hubtest "agentre-server/internal/testutils"
)

func TestFindByProviderUID_Found(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewUserIdentity()

	mock.ExpectQuery(regexp.QuoteMeta(
		`SELECT * FROM "user_identities" WHERE provider=$1 AND provider_uid=$2 ORDER BY "user_identities"."id" LIMIT $3`,
	)).WithArgs("github", "12345", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}).AddRow(int64(7), int64(99)))

	got, err := r.FindByProviderUID(ctx, "github", "12345")
	assert.NoError(t, err)
	assert.NotNil(t, got)
	assert.Equal(t, int64(99), got.UserID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestCreate(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewUserIdentity()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO "user_identities"`)).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), []byte("{}"), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	e := &user_identity_entity.UserIdentity{UserID: 99, Provider: "github", ProviderUID: "1", Email: "a@b.com"}
	assert.NoError(t, r.Create(ctx, e))
	assert.NoError(t, mock.ExpectationsWereMet())
}
