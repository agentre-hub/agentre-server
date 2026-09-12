package device_repo

import (
	"errors"
	"fmt"
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
		regexp.QuoteMeta("SELECT * FROM `devices` WHERE user_id IN (?,?) AND status=?")+
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

// 账号清单来自 ListEnabledUserIDs，没有上限：一条 IN 的占位符数量要封顶（DSN 没开
// interpolateParams 时服务端预处理语句最多 65535 个占位符，超了整轮都读不出清单），
// 超过一块就分块查、按账号合并。同一账号只落在一块里，块内的 last_seen_at 排序因此
// 就是它的完整排序。
func TestListActiveByUsers_GivenMoreThanOneBatch_ThenQueriesInBoundedChunks(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	const chunk = 500
	ids := make([]int64, chunk+1)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	mock.ExpectQuery(fmt.Sprintf(`user_id IN \((\?,){%d}\?\) AND status=\?`, chunk-1)).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "fingerprint", "status"}).
			AddRow(int64(1), int64(1), "fp-a", consts.ACTIVE))
	mock.ExpectQuery(`user_id IN \(\?\) AND status=\?`).
		WithArgs(ids[chunk], consts.ACTIVE).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "fingerprint", "status"}).
			AddRow(int64(2), ids[chunk], "fp-b", consts.ACTIVE))

	out, err := r.ListActiveByUsers(ctx, ids)
	assert.NoError(t, err)
	assert.Equal(t, []*device_entity.Device{{ID: 1, UserID: 1, Fingerprint: "fp-a", Status: consts.ACTIVE}}, out[1])
	assert.Equal(t, []*device_entity.Device{{ID: 2, UserID: ids[chunk], Fingerprint: "fp-b", Status: consts.ACTIVE}}, out[ids[chunk]])
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestListActiveByUsers_GivenNoAccounts_ThenNoQuery(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	out, err := r.ListActiveByUsers(ctx, nil)
	assert.NoError(t, err)
	assert.Empty(t, out)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// UpdateDisplayName 写的是账号级备注名那一列，只动 display_name 与 updatetime：
// 设备自报的 name 不能被这次改名碰到（它是那台机器下一次 claim 要覆盖的格子），
// last_seen_at 更不能——改个名字不是一次「它刚刚还在」。
func TestUpdateDisplayName_WritesOnlyDisplayNameAndUpdatetime(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `devices` SET `display_name`=?,`updatetime`=? WHERE id=?")+"$").
		WithArgs("办公室那台", int64(5000), int64(100)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	assert.NoError(t, r.UpdateDisplayName(ctx, 100, "办公室那台", 5000))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 清空备注名走同一条语句、写空串：清空是合法操作（回落到设备自报名），不是「不写」。
func TestUpdateDisplayName_ClearingWritesTheEmptyString(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `devices` SET `display_name`=?")).
		WithArgs("", int64(5000), int64(100)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	assert.NoError(t, r.UpdateDisplayName(ctx, 100, "", 5000))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 设备重新 claim 不能把用户设的备注名擦掉——那正是「不复用 devices.name」的全部理由。
// 判据是 ON DUPLICATE KEY UPDATE 的赋值列表里没有 display_name；正则钉住整段赋值
// 子句并锚到语句末尾，多赋一列就在这里变红。
func TestUpsert_DoesNotReassignTheAccountLevelDisplayName(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDevice()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"ON DUPLICATE KEY UPDATE `name`=VALUES(`name`),`kind`=VALUES(`kind`),"+
			"`platform`=VALUES(`platform`),`version`=VALUES(`version`),"+
			"`last_seen_at`=VALUES(`last_seen_at`),`status`=VALUES(`status`),"+
			"`updatetime`=VALUES(`updatetime`)") + "$").
		WillReturnResult(sqlmock.NewResult(100, 2))
	mock.ExpectQuery("SELECT \\* FROM `devices` WHERE user_id=\\? AND fingerprint=\\?").
		WillReturnRows(sqlmock.NewRows([]string{"id", "display_name"}).
			AddRow(int64(100), "办公室那台"))
	mock.ExpectCommit()

	d := &device_entity.Device{UserID: 7, Fingerprint: "fp-new", Kind: "agentred", Status: 1}
	assert.NoError(t, r.Upsert(ctx, d))
	// 事务内读回最终行，备注名因此原样还在实体上。
	assert.Equal(t, "办公室那台", d.DisplayName)
	assert.NoError(t, mock.ExpectationsWereMet())
}
