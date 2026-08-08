package migrations

import (
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	hubtest "agentre-server/internal/testutils"
)

// withPatchedLockTiming 把轮询间隔和等待预算换成测试专用的小值，跑完自动还原，
// 避免真跑迁移锁默认的 120s 预算拖慢测试。
func withPatchedLockTiming(t *testing.T, interval, budget time.Duration) {
	t.Helper()
	origInterval, origBudget := migrationLockPollInterval, migrationLockWaitBudget
	migrationLockPollInterval, migrationLockWaitBudget = interval, budget
	t.Cleanup(func() {
		migrationLockPollInterval, migrationLockWaitBudget = origInterval, origBudget
	})
}

// TestWithMigrationLock_RetriesUntilAcquired 断言：拿不到锁时会重试（pg_try_advisory_lock
// 返回 false），拿到锁（返回 true）后才跑传入的迁移函数，结束后释放锁（pg_advisory_unlock）。
func TestWithMigrationLock_RetriesUntilAcquired(t *testing.T) {
	withPatchedLockTiming(t, time.Millisecond, 120*time.Second)
	_, gormDB, mock := hubtest.DatabasePG(t)

	mock.ExpectQuery(regexp.QuoteMeta("pg_try_advisory_lock")).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(false))
	mock.ExpectQuery(regexp.QuoteMeta("pg_try_advisory_lock")).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
	mock.ExpectQuery(regexp.QuoteMeta("pg_advisory_unlock")).
		WillReturnRows(sqlmock.NewRows([]string{"pg_advisory_unlock"}).AddRow(true))

	ran := false
	err := withMigrationLock(gormDB, func() error {
		ran = true
		return nil
	})

	assert.NoError(t, err)
	assert.True(t, ran, "migration func should run once the lock is acquired")
	assert.NoError(t, mock.ExpectationsWereMet())
}

// TestWithMigrationLock_PropagatesMigrateError 断言：迁移函数本身的失败会被如实返回，
// 但锁依然会在结束时释放（不会把连接晾在持锁状态）。
func TestWithMigrationLock_PropagatesMigrateError(t *testing.T) {
	withPatchedLockTiming(t, time.Millisecond, 120*time.Second)
	_, gormDB, mock := hubtest.DatabasePG(t)

	mock.ExpectQuery(regexp.QuoteMeta("pg_try_advisory_lock")).
		WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(true))
	mock.ExpectQuery(regexp.QuoteMeta("pg_advisory_unlock")).
		WillReturnRows(sqlmock.NewRows([]string{"pg_advisory_unlock"}).AddRow(true))

	wantErr := assert.AnError
	err := withMigrationLock(gormDB, func() error {
		return wantErr
	})

	assert.ErrorIs(t, err, wantErr)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// TestWithMigrationLock_TimesOut 断言：轮询超过等待预算后返回一个说明「等迁移锁超时」的
// 错误，且从未拿到锁，因此从不会调用传入的迁移函数，也不会尝试解锁。
func TestWithMigrationLock_TimesOut(t *testing.T) {
	const (
		interval = 5 * time.Millisecond
		budget   = 20 * time.Millisecond
	)
	withPatchedLockTiming(t, interval, budget)
	_, gormDB, mock := hubtest.DatabasePG(t)

	// 预算/间隔比很小，实际重试次数以真实时钟为准，注册一批足够多的「未拿到锁」响应。
	for i := 0; i < 50; i++ {
		mock.ExpectQuery(regexp.QuoteMeta("pg_try_advisory_lock")).
			WillReturnRows(sqlmock.NewRows([]string{"pg_try_advisory_lock"}).AddRow(false))
	}

	start := time.Now()
	ran := false
	err := withMigrationLock(gormDB, func() error {
		ran = true
		return nil
	})
	elapsed := time.Since(start)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "timed out")
	assert.Contains(t, err.Error(), "migration lock")
	assert.False(t, ran, "migration func must not run without the lock")
	assert.GreaterOrEqual(t, elapsed, budget, "must have actually waited out the budget via retries")
}
