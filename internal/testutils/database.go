// Package testutils 提供 server 仓库测试用的 PG-dialect sqlmock 工厂。
package testutils

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/database/db"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// DatabasePG 返回带 PG 方言 sqlmock 的 ctx + gormDB + mock。
//
// db.Ctx(ctx) 自动命中该 mock；其它 redis/cache 组件不影响。
func DatabasePG(t *testing.T) (context.Context, *gorm.DB, sqlmock.Sqlmock) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	gormDB, err := gorm.Open(postgres.New(postgres.Config{
		Conn:                 sqlDB,
		PreferSimpleProtocol: true,
	}), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	return db.WithContextDB(context.Background(), gormDB), gormDB, mock
}
