// Package testutils 提供 server 仓库测试用的 MySQL-dialect sqlmock 工厂。
package testutils

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/database/db"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// Database 返回带 MySQL 方言 sqlmock 的 ctx + gormDB + mock。
//
// db.Ctx(ctx) 自动命中该 mock；其它 redis/cache 组件不影响。
//
// 期望值按 MySQL 方言原样写：反引号引标识符、`?` 占位符。这里**刻意没有**方言翻译层
// ——把实际发出的 SQL 改写成别的方言再去匹配，等于让测试断言一段数据库根本不会收到的
// 文本，读测试的人也会据此以为服务连的是另一种库。
func Database(t *testing.T) (context.Context, *gorm.DB, sqlmock.Sqlmock) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	gormDB, err := gorm.Open(mysql.New(mysql.Config{
		Conn:                      sqlDB,
		SkipInitializeWithVersion: true,
	}), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	return db.WithContextDB(context.Background(), gormDB), gormDB, mock
}
