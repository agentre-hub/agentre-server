// Package testutils 提供 server 仓库测试用的 MySQL-dialect sqlmock 工厂。
package testutils

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/database/db"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

type mysqlQueryMatcher struct{}

func (mysqlQueryMatcher) Match(expectedSQL, actualSQL string) error {
	if !strings.Contains(expectedSQL, "`") {
		actualSQL = strings.ReplaceAll(actualSQL, "`", `"`)
		placeholder := 0
		actualSQL = regexp.MustCompile(`\?`).ReplaceAllStringFunc(actualSQL, func(string) string {
			placeholder++
			return fmt.Sprintf("$%d", placeholder)
		})
	}
	return sqlmock.QueryMatcherRegexp.Match(expectedSQL, actualSQL)
}

// Database 返回带 MySQL 方言 sqlmock 的 ctx + gormDB + mock。
//
// db.Ctx(ctx) 自动命中该 mock；其它 redis/cache 组件不影响。
func Database(t *testing.T) (context.Context, *gorm.DB, sqlmock.Sqlmock) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(mysqlQueryMatcher{}))
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
