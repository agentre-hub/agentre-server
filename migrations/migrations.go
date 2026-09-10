// Package migrations 汇总并执行 agentre-server MySQL 全部迁移。
//
// 规范：
//   - 迁移使用时间戳文件名（YYYYMMDDNNNN），按时间升序追加执行。
//   - 每个迁移返回一个 *gormigrate.Migration，一次迁移只做一件事。
//   - DDL 用原生 SQL，不依赖 GORM AutoMigrate。
//   - 禁止改动既有迁移；修复请新增补丁迁移。
package migrations

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/go-gormigrate/gormigrate/v2"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// migrationLockName 是迁移串行化用的 MySQL named lock。锁名携应用名，
// 避免同一 MySQL 实例上的其他应用迁移相互阻塞。
const migrationLockName = "github.com/agentre-hub/agentre-server/migrations"

// migrationLockPollInterval / migrationLockWaitBudget 是轮询 GET_LOCK 的
// 间隔与总预算，声明成变量是为了让测试能换成极小值而不必真的等待。
var (
	migrationLockPollInterval = 500 * time.Millisecond
	migrationLockWaitBudget   = 120 * time.Second
)

// RunMigrations 执行所有迁移。
//
// 副本可能并发启动：先在一条专用连接上取 named lock 把迁移串行化，拿到锁的副本才跑
// gormigrate，其余副本轮询等待；等待超过 migrationLockWaitBudget 就放弃并报错，交给
// main.go 的 log.Fatalf 退出，由 k8s 重启后重试。
func RunMigrations(db *gorm.DB) error {
	return withMigrationLock(db, func() error {
		m := gormigrate.New(db, gormigrate.DefaultOptions, migrationList())
		return m.Migrate()
	})
}

// withMigrationLock 在持有迁移 named lock 期间执行 fn。
//
// named lock 是会话级的，而 gorm 的 *gorm.DB 从连接池里取连接：如果直接用
// db.Exec("GET_LOCK") 加锁，锁可能落在连接 A 上，随后 fn 里的迁移语句却从
// 连接 B 跑，锁在归还连接池的那一刻就形同虚设。因此这里用 sqlDB.Conn(ctx) 单独要一条
// 连接、全程只用它做加锁/解锁；fn 内部的迁移仍然照常走连接池，named lock 不绑定数据，
// 这样是安全的。副本崩溃时这条专用连接断开，MySQL 会自动释放锁，无需人工介入。
func withMigrationLock(db *gorm.DB, fn func() error) error {
	sqlDB, err := db.DB()
	if err != nil {
		return fmt.Errorf("migrations: get *sql.DB: %w", err)
	}

	ctx := context.Background()
	conn, err := sqlDB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("migrations: acquire dedicated connection for migration lock: %w", err)
	}
	defer func() { _ = conn.Close() }()

	if err := acquireMigrationLock(ctx, conn); err != nil {
		return err
	}
	defer releaseMigrationLock(ctx, conn)

	return fn()
}

// acquireMigrationLock 轮询 GET_LOCK 直到拿到锁或等待预算耗尽。
//
// 超时参数写 0 而不是让 GET_LOCK 自己阻塞，是为了让等待有明确上界、可观测：拿不到锁
// 时立刻返回，不会让副本静默挂起到被存活探针杀掉。
//
// 返回值扫进 sql.NullInt64 而不是 int：GET_LOCK 有三种结果——1 拿到、0 没拿到、
// NULL 发生了错误（连接被杀、锁名超长）。只有 1 算拿到，另外两种都继续轮询、最终以
// 那条「等迁移锁超时」的错误收场。直接扫进 int 的话，NULL 会变成一个
// 「converting NULL to int is unsupported」的驱动错误——那条消息既不说明是等锁失败，
// 也会把排查引向「扫描类型」这个完全无关的方向。
func acquireMigrationLock(ctx context.Context, conn *sql.Conn) error {
	deadline := time.Now().Add(migrationLockWaitBudget)
	for {
		var locked sql.NullInt64
		if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, 0)", migrationLockName).Scan(&locked); err != nil {
			return fmt.Errorf("migrations: try named lock: %w", err)
		}
		if locked.Valid && locked.Int64 == 1 {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("migrations: timed out after %s waiting for the migration lock %q; another replica is likely still migrating",
				migrationLockWaitBudget, migrationLockName)
		}
		time.Sleep(migrationLockPollInterval)
	}
}

// releaseMigrationLock 解锁；专用连接紧接着就会被关闭，即便这里失败，MySQL 也会在
// 连接断开时释放这条会话级的锁，因此这里只记日志、不把错误抛给调用方。
//
// 同样扫进 sql.NullInt64：RELEASE_LOCK 在锁不存在时返回 NULL，扫进 int 会得到一条
// 与「解锁」毫无关系的类型转换告警。
func releaseMigrationLock(ctx context.Context, conn *sql.Conn) {
	var unlocked sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT RELEASE_LOCK(?)", migrationLockName).Scan(&unlocked); err != nil {
		logger.Ctx(ctx).Warn("release migration lock", zap.Error(err))
	}
}

// 退役号段（不得复用）
//
// 2026-09-04 发布前，产品尚未上线、所有开发/联调库一律删库重建，因此把当时的 16 条
// 迁移压缩成了下面这一套基线建表迁移，全部旧号一次性退役：
//
//   - 202608280001 ~ 202608280010（十个域的初始建表）
//   - 202609010001 ~ 202609010003（conversation_id 加列 / 回填 / 换身份键）
//   - 202609040001 ~ 202609040003（drop 死列 / drop email_verified / delete_todos 改名）
//
// 那些迁移的最终结果已经折进 202609040101 起的建表语句里：加过的列直接建在表上，
// drop 掉的列在基线里根本不建，纯回填迁移因为没有存量库需要回填而整条消失。
//
// **这些号一个都不许再用。** gormigrate 只认台账（migrations 表）里的 id 字符串：
// 一个曾经跑过的号再次出现时，它会认为那条迁移已经执行过而**静默跳过**，新迁移的
// DDL 一行都不会跑，而启动日志上什么都不会说。同类事故的记录见桌面仓库的
// agentre/migrations/migrations.go。新迁移一律取一个从未出现过的号，追加在下面这个
// 列表的末尾。
func migrationList() []*gormigrate.Migration {
	return []*gormigrate.Migration{
		migration202609040101(),
		migration202609040102(),
		migration202609040103(),
		migration202609040104(),
		migration202609040105(),
		migration202609040106(),
		migration202609040107(),
		migration202609040108(),
		migration202609040109(),
		migration202609040110(),
	}
}
