package device_flow_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	hubtest "agentre-server/internal/testutils"
)

func TestApprove(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceFlow()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		`UPDATE "device_flow_codes" SET "approved_at"=$1,"authorized_user_id"=$2 WHERE user_code=$3 AND consumed_at=0 AND denied_at=0 AND expires_at > $4`,
	)).WithArgs(int64(1000), int64(99), "A4F-7Q2", int64(1000)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	assert.NoError(t, r.Approve(ctx, "A4F-7Q2", 99, 1000))
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByDeviceCode_Found(t *testing.T) {
	ctx, _, mock := hubtest.DatabasePG(t)
	r := NewDeviceFlow()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT * FROM "device_flow_codes" WHERE device_code=$1 ORDER BY "device_flow_codes"."device_code" LIMIT $2`)).
		WithArgs("dc-x", 1).
		WillReturnRows(sqlmock.NewRows([]string{"device_code", "user_code"}).AddRow("dc-x", "A4F-7Q2"))
	got, err := r.FindByDeviceCode(ctx, "dc-x")
	assert.NoError(t, err)
	assert.NotNil(t, got)
	assert.Equal(t, "A4F-7Q2", got.UserCode)
}
