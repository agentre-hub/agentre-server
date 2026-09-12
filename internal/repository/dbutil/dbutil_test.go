package dbutil

import (
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/database/db"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

type widget struct {
	ID   int64
	Name string
}

func (widget) TableName() string { return "widgets" }

func TestFindOne_ReturnsTheRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectQuery("SELECT \\* FROM `widgets` WHERE id=\\?").
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(int64(7), "w"))

	got, err := FindOne[widget](db.Ctx(ctx).Where("id=?", 7))

	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, int64(7), got.ID)
	assert.Equal(t, "w", got.Name)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 「查不到」不是错误，是 (nil, nil)——本仓所有 FindXxx 的既有约定，服务层据此写
// `if x == nil` 而不是判错误类型。
func TestFindOne_MissingRowIsNilNil(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	mock.ExpectQuery("SELECT \\* FROM `widgets`").WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))

	got, err := FindOne[widget](db.Ctx(ctx).Where("id=?", 7))

	assert.NoError(t, err)
	assert.Nil(t, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 真正的库错误必须原样上抛，且**不能**连带返回一个零值实体——否则调用方的
// `if x == nil` 会把一次连库失败当成「这条记录不存在」，静默地走进创建分支。
func TestFindOne_RealErrorPropagatesWithNilEntity(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	boom := errors.New("connection refused")
	mock.ExpectQuery("SELECT \\* FROM `widgets`").WillReturnError(boom)

	got, err := FindOne[widget](db.Ctx(ctx).Where("id=?", 7))

	assert.ErrorIs(t, err, boom)
	assert.Nil(t, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}
