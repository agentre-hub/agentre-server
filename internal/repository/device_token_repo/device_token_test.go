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
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(99)))
	mock.ExpectCommit()
	e := &device_token_entity.DeviceToken{DeviceID: 42, RefreshTokenHash: "h", RefreshExpiresAt: 1000}
	assert.NoError(t, r.Create(ctx, e))
	assert.NoError(t, mock.ExpectationsWereMet())
}
