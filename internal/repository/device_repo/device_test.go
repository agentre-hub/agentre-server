package device_repo

import (
	"errors"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/pkg/consts"
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

// UpdateVersion 是镜像握手成功后按新值刷新 devices.version 的写入侧（spec「控制台呈现
// 与 latest 来源」一节：值不同才写）。调用方（mirror_svc）自己先比过版本才落到这里，
// 因此这条 UPDATE 本身不必再带条件——它只管把这一次决定要写的值写进去。
func TestUpdateVersion_WritesVersionAndUpdatetime(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `devices` SET")).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	assert.NoError(t, r.UpdateVersion(ctx, 100, "0.4.2", 5000))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// ListActiveByUsers 是设备清单的批量入口（activity 定时任务规格「要求 13」）：一批
// 账号一次查询，而不是每个账号各发一条 SELECT——过滤与排序要跟原来逐账号查询
// （ListByUser：user_id=? AND status=? ORDER BY last_seen_at DESC）保持同一个含义，
// 只是把 user_id 从等值换成 IN。
func TestListActiveByUsers_OneQueryFiltersActiveAndOrdersByLastSeen(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	mock.ExpectQuery(
		regexp.QuoteMeta("SELECT * FROM `devices` WHERE user_id IN (?,?) AND status=?") +
			".*last_seen_at DESC",
	).
		WithArgs(int64(7), int64(9), consts.ACTIVE).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "fingerprint", "status"}).
			AddRow(int64(1), int64(7), "fp-a", consts.ACTIVE).
			AddRow(int64(2), int64(9), "fp-b", consts.ACTIVE))

	out, err := r.ListActiveByUsers(ctx, []int64{7, 9})
	assert.NoError(t, err)
	assert.Equal(t, []*device_entity.Device{{ID: 1, UserID: 7, Fingerprint: "fp-a", Status: consts.ACTIVE}}, out[7])
	assert.Equal(t, []*device_entity.Device{{ID: 2, UserID: 9, Fingerprint: "fp-b", Status: consts.ACTIVE}}, out[9])
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 查询本身失败要原样上抛，不能吞成「这批账号都没有设备」——调用方（crontab）会把
// 空清单当成「没人开着这个开关」处理，那会让一整批账号的机器悄悄不被拉取。
func TestListActiveByUsers_QueryError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	broken := errors.New("库读不出来")
	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `devices` WHERE user_id IN")).
		WillReturnError(broken)

	out, err := r.ListActiveByUsers(ctx, []int64{7})
	assert.ErrorIs(t, err, broken)
	assert.Nil(t, out)
	assert.NoError(t, mock.ExpectationsWereMet())
}
