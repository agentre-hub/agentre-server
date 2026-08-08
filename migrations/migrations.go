// Package migrations 汇总并执行 agentre-server PostgreSQL 全部迁移。
//
// 规范：
//   - 文件名前缀 = 时间戳排序键（YYYYMMDDNNNN），调用顺序按时间升序。
//   - 每个迁移返回一个 *gormigrate.Migration。
//   - 一次迁移只做一件事。
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

// migrationLockID 是迁移串行化用的 PostgreSQL advisory lock id。
//
// 取值 = crc32.ChecksumIEEE([]byte("agentre-server/migrations"))，算好后写死在这里，
// 避免每次启动都重算。advisory lock 只按「当前数据库」隔离、不绑定任何表或行，因此只有
// 另一个连到同一个数据库的应用凑巧选中同一个 id 才会撞车。
const migrationLockID int64 = 4097874731

// migrationLockPollInterval / migrationLockWaitBudget 是轮询 pg_try_advisory_lock 的
// 间隔与总预算，声明成变量是为了让测试能换成极小值而不必真的等待。
var (
	migrationLockPollInterval = 500 * time.Millisecond
	migrationLockWaitBudget   = 120 * time.Second
)

// RunMigrations 执行所有迁移。
//
// 副本可能并发启动：先在一条专用连接上取 advisory lock 把迁移串行化，拿到锁的副本才跑
// gormigrate，其余副本轮询等待；等待超过 migrationLockWaitBudget 就放弃并报错，交给
// main.go 的 log.Fatalf 退出，由 k8s 重启后重试。
func RunMigrations(db *gorm.DB) error {
	return withMigrationLock(db, func() error {
		m := gormigrate.New(db, gormigrate.DefaultOptions, migrationList())
		return m.Migrate()
	})
}

// withMigrationLock 在持有迁移 advisory lock 期间执行 fn。
//
// advisory lock 是会话级的，而 gorm 的 *gorm.DB 从连接池里取连接：如果直接用
// db.Exec("pg_try_advisory_lock") 加锁，锁可能落在连接 A 上，随后 fn 里的迁移语句却从
// 连接 B 跑，锁在归还连接池的那一刻就形同虚设。因此这里用 sqlDB.Conn(ctx) 单独要一条
// 连接、全程只用它做加锁/解锁；fn 内部的迁移仍然照常走连接池，advisory lock 不绑定数据，
// 这样是安全的。副本崩溃时这条专用连接断开，PostgreSQL 会自动释放锁，无需人工介入。
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

// acquireMigrationLock 轮询 pg_try_advisory_lock 直到拿到锁或等待预算耗尽。
//
// 用轮询而非阻塞的 pg_advisory_lock，是为了让等待有明确上界、可观测：拿不到锁时立刻
// 返回，不会让副本静默挂起到被存活探针杀掉。
func acquireMigrationLock(ctx context.Context, conn *sql.Conn) error {
	deadline := time.Now().Add(migrationLockWaitBudget)
	for {
		var locked bool
		if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", migrationLockID).Scan(&locked); err != nil {
			return fmt.Errorf("migrations: try advisory lock: %w", err)
		}
		if locked {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("migrations: timed out after %s waiting for the migration lock (id %d); another replica is likely still migrating",
				migrationLockWaitBudget, migrationLockID)
		}
		time.Sleep(migrationLockPollInterval)
	}
}

// releaseMigrationLock 解锁；专用连接紧接着就会被关闭，即便这里失败，PostgreSQL 也会在
// 连接断开时释放这条会话级的锁，因此这里只记日志、不把错误抛给调用方。
func releaseMigrationLock(ctx context.Context, conn *sql.Conn) {
	var unlocked bool
	if err := conn.QueryRowContext(ctx, "SELECT pg_advisory_unlock($1)", migrationLockID).Scan(&unlocked); err != nil {
		logger.Ctx(ctx).Warn("release migration lock", zap.Error(err))
	}
}

func migrationList() []*gormigrate.Migration {
	return []*gormigrate.Migration{
		migration202605200001(),
		migration202605200002(),
		migration202605200003(),
		migration202605200004(),
		migration202605200005(),
		migration202608030001(),
		migration202608080001(),
	}
}
