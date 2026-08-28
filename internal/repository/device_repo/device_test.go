package device_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// Upsert 必须是一条语句。先 SELECT 再 INSERT/UPDATE 的写法在并发下会双双走到
// INSERT：两个已授权的 device_code 共用同一 (user_id, fingerprint) 同时换取时，
// 竞败方撞上 uk_devices_user_fingerprint，拿到的是一个唯一约束错误（映射成 500），
// 而不是任何约定的 OAuth 错误。ON DUPLICATE KEY UPDATE 由数据库原子裁决，
// 两边都拿到同一行、都成功。
func TestUpsert_AtomicWriteThenReadsFinalRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	mock.ExpectBegin()
	// 赋值列里没有 createtime：命中已有设备时首次注册时间不能被这次换取的 nowMs 抹掉。
	mock.ExpectExec(regexp.QuoteMeta("ON DUPLICATE KEY UPDATE")).
		WillReturnResult(sqlmock.NewResult(100, 2))
	mock.ExpectQuery("SELECT \\* FROM `devices` WHERE user_id=\\? AND fingerprint=\\?").
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "fingerprint", "createtime"}).
			AddRow(int64(100), int64(7), "fp-new", int64(1000)))
	mock.ExpectCommit()

	d := &device_entity.Device{UserID: 7, Fingerprint: "fp-new", Kind: "agentred", Status: 1, Createtime: 2000}
	assert.NoError(t, r.Upsert(ctx, d))
	// 事务内读回最终行：命中已有设备时拿到的是它原来的 id 和 createtime。
	assert.Equal(t, int64(100), d.ID)
	assert.Equal(t, int64(1000), d.Createtime)
	assert.NoError(t, mock.ExpectationsWereMet())
}
