package device_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"agentre-server/internal/model/entity/device_entity"
	hubtest "agentre-server/internal/testutils"
)

func TestUpsert_InsertPath(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDevice()

	mock.ExpectQuery(regexp.QuoteMeta(
		`SELECT * FROM "devices" WHERE user_id=$1 AND fingerprint=$2 ORDER BY "devices"."id" LIMIT $3`,
	)).WithArgs(int64(7), "fp-new", 1).WillReturnRows(sqlmock.NewRows([]string{"id"}))

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`INSERT INTO "devices"`)).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "capabilities"}).AddRow(int64(100), []byte("{}")))
	mock.ExpectCommit()

	d := &device_entity.Device{UserID: 7, Fingerprint: "fp-new", Kind: "agentred", Status: 1}
	assert.NoError(t, r.Upsert(ctx, d))
	assert.Equal(t, int64(100), d.ID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestUpsert_UpdatePath(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDevice()

	mock.ExpectQuery(regexp.QuoteMeta(
		`SELECT * FROM "devices" WHERE user_id=$1 AND fingerprint=$2 ORDER BY "devices"."id" LIMIT $3`,
	)).WithArgs(int64(7), "fp-exist", 1).
		WillReturnRows(sqlmock.NewRows([]string{"id", "createtime"}).AddRow(int64(50), int64(1000)))

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE "devices"`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	d := &device_entity.Device{UserID: 7, Fingerprint: "fp-exist", Kind: "agentred", Status: 1}
	assert.NoError(t, r.Upsert(ctx, d))
	assert.Equal(t, int64(50), d.ID)
	assert.Equal(t, int64(1000), d.Createtime)
	assert.NoError(t, mock.ExpectationsWereMet())
}
