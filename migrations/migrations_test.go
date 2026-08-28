package migrations

import (
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
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

// TestWithMigrationLock_RetriesUntilAcquired 断言：拿不到锁时会重试（GET_LOCK 的零
// 超时形式返回 0），拿到锁（返回 1）后才跑传入的迁移函数，结束后 RELEASE_LOCK。
func TestWithMigrationLock_RetriesUntilAcquired(t *testing.T) {
	withPatchedLockTiming(t, time.Millisecond, 120*time.Second)
	_, gormDB, mock := hubtest.Database(t)

	mock.ExpectQuery(regexp.QuoteMeta("GET_LOCK")).
		WillReturnRows(sqlmock.NewRows([]string{"GET_LOCK(?, 0)"}).AddRow(0))
	mock.ExpectQuery(regexp.QuoteMeta("GET_LOCK")).
		WillReturnRows(sqlmock.NewRows([]string{"GET_LOCK(?, 0)"}).AddRow(1))
	mock.ExpectQuery(regexp.QuoteMeta("RELEASE_LOCK")).
		WillReturnRows(sqlmock.NewRows([]string{"RELEASE_LOCK(?)"}).AddRow(1))

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
	_, gormDB, mock := hubtest.Database(t)

	mock.ExpectQuery(regexp.QuoteMeta("GET_LOCK")).
		WillReturnRows(sqlmock.NewRows([]string{"GET_LOCK(?, 0)"}).AddRow(1))
	mock.ExpectQuery(regexp.QuoteMeta("RELEASE_LOCK")).
		WillReturnRows(sqlmock.NewRows([]string{"RELEASE_LOCK(?)"}).AddRow(1))

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
	_, gormDB, mock := hubtest.Database(t)

	// 预算/间隔比很小，实际重试次数以真实时钟为准，注册一批足够多的「未拿到锁」响应。
	for i := 0; i < 50; i++ {
		mock.ExpectQuery(regexp.QuoteMeta("GET_LOCK")).
			WillReturnRows(sqlmock.NewRows([]string{"GET_LOCK(?, 0)"}).AddRow(0))
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

// TestWithMigrationLock_TreatsNullAsNotAcquired 断言：GET_LOCK 返回 NULL 时按「没拿到
// 锁」处理——继续轮询，最终以那条「等迁移锁超时」的错误收场。
//
// 这是 pg_try_advisory_lock 没有的形态：它只返回 true/false，而 GET_LOCK 在发生错误时
// （连接被杀、锁名超长）返回 NULL。把 NULL 直接扫进 int 会得到一个
// 「converting NULL to int is unsupported」的驱动错误——那条消息既不说明是等锁失败，
// 也让运维顺着「扫描类型」这个完全无关的方向去查。
func TestWithMigrationLock_TreatsNullAsNotAcquired(t *testing.T) {
	withPatchedLockTiming(t, time.Millisecond, 10*time.Millisecond)
	_, gormDB, mock := hubtest.Database(t)

	for i := 0; i < 50; i++ {
		mock.ExpectQuery(regexp.QuoteMeta("GET_LOCK")).
			WillReturnRows(sqlmock.NewRows([]string{"GET_LOCK(?, 0)"}).AddRow(nil))
	}

	ran := false
	err := withMigrationLock(gormDB, func() error {
		ran = true
		return nil
	})

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "timed out", "NULL 要走等锁超时那条路，而不是驱动的扫描错误")
	assert.Contains(t, err.Error(), "migration lock")
	assert.False(t, ran, "NULL 不是「拿到锁」，迁移绝不能在这种情况下开跑")
}
