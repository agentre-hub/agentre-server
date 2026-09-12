package testutils

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// 事务边界是 service 层自己的编排，因此 service 层要测得到它——而 service 单测按
// 约定不碰库（repo 一律由 mockgen 注入），这一层根本发不出 SQL。TxDatabase 提供的
// 正是这个缺口上唯一还需要的东西：一个只认 BEGIN/COMMIT/ROLLBACK、并把它们按序记
// 下来的连接。
//
// 为什么不用 Database 那个 sqlmock：sqlmock 要求每一次 BEGIN 都事先声明一条期望，
// 于是每一个走写路径的用例都得为「service 内部开了一个事务」这件实现细节补一行
// ExpectBegin/ExpectCommit，而它们真正断言的是仓储调用。反过来，事务本身该被断言
// 的时候，「声明了几条期望」也表达不出「五行写在**同一个**事务里」——那是 Events()
// 这样一份时序才说得清的事。

// TxLog 是一次测试里发生过的事务事件时序。
type TxLog struct {
	mu     sync.Mutex
	events []string
}

// 事务事件的三个取值。用常量而不是裸字符串：断言里写错一个字母只会得到一条
// 「期望 [BEGIN COMMIT] 实际 [BEGIN COMIT]」的困惑。
const (
	TxBegin    = "BEGIN"
	TxCommit   = "COMMIT"
	TxRollback = "ROLLBACK"
)

// Events 交回按发生顺序排列的事务事件。
func (l *TxLog) Events() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

func (l *TxLog) add(event string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, event)
}

// TxDatabase 返回一个只做事务控制的 ctx 与它的事件记录。
//
// db.Ctx(ctx).Transaction(...) 在它上面照常开事务、照常提交或回滚，事件按序进
// TxLog；任何一条真的 SQL 都会当场失败（errUnexpectedSQL）——service 单测不该发出
// SQL，发得出来说明有一层绕过了仓储接口。
func TxDatabase(t *testing.T) (context.Context, *TxLog) {
	t.Helper()
	log := &TxLog{}
	sqlDB := sql.OpenDB(txConnector{log: log})
	t.Cleanup(func() { _ = sqlDB.Close() })
	gormDB, err := gorm.Open(mysql.New(mysql.Config{
		Conn:                      sqlDB,
		SkipInitializeWithVersion: true,
	}), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	return db.WithContextDB(context.Background(), gormDB), log
}

// InTransaction 报告这个 ctx 是不是带着一段**已经开着**的事务。
//
// 判据是 gorm 自己的那一条：事务里的 *gorm.DB 连接池是 *sql.Tx，它实现
// gorm.TxCommitter（Commit/Rollback）；不在事务里时连接池是 *sql.DB，没有这两个方法。
// 「取版本号取在提交这批写入的事务里」这类不变量因此在 service 单测里断言得到。
func InTransaction(ctx context.Context) bool {
	_, ok := db.Ctx(ctx).Statement.ConnPool.(gorm.TxCommitter)
	return ok
}

var errUnexpectedSQL = errors.New(
	"testutils.TxDatabase: service 单测不发 SQL，数据访问一律走 mockgen 注入的仓储")

type txConnector struct{ log *TxLog }

func (c txConnector) Connect(context.Context) (driver.Conn, error) { return &txConn{log: c.log}, nil }
func (c txConnector) Driver() driver.Driver                        { return txDriver{} }

type txDriver struct{}

func (txDriver) Open(string) (driver.Conn, error) { return nil, errUnexpectedSQL }

type txConn struct{ log *TxLog }

func (c *txConn) Prepare(string) (driver.Stmt, error) { return nil, errUnexpectedSQL }
func (c *txConn) Close() error                        { return nil }
func (c *txConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *txConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	c.log.add(TxBegin)
	return &txTx{log: c.log}, nil
}

type txTx struct{ log *TxLog }

func (t *txTx) Commit() error   { t.log.add(TxCommit); return nil }
func (t *txTx) Rollback() error { t.log.add(TxRollback); return nil }
