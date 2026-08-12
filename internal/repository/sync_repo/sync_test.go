package sync_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"agentre-server/internal/model/entity/sync_entity"
	hubtest "agentre-server/internal/testutils"
)

// 版本序列必须是一条语句：多副本并发上行时，先读后写会双双读到同一个值，
// 两次上行拿到同一个版本号，R4 的「较大者胜」立刻失去可比性。
func TestNextVersion_GivenConcurrentReplicas_ThenSingleAtomicStatement(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncState()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO sync_account_seqs`)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT LAST_INSERT_ID()`)).
		WillReturnRows(sqlmock.NewRows([]string{"LAST_INSERT_ID()"}).AddRow(int64(42)))
	mock.ExpectCommit()

	v, err := r.NextVersion(ctx, 7, 1)
	assert.NoError(t, err)
	assert.Equal(t, int64(42), v)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestNextVersion_GivenBatch_ThenTakesNAtOnce(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncState()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`ON DUPLICATE KEY UPDATE`)).
		WithArgs(int64(7), int64(3), sqlmock.AnyArg(), int64(3), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT LAST_INSERT_ID()`)).
		WillReturnRows(sqlmock.NewRows([]string{"LAST_INSERT_ID()"}).AddRow(int64(45)))
	mock.ExpectCommit()

	v, err := r.NextVersion(ctx, 7, 3)
	assert.NoError(t, err)
	assert.Equal(t, int64(45), v)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 没有 last_sync_at 记录 = 首次登录，仓储层返回 (nil, nil) 而不是错误，
// R6a 的「不算超窗口」才判得出来。
func TestFindDeviceState_GivenNoRow_ThenNilNil(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncState()

	mock.ExpectQuery(regexp.QuoteMeta(`SELECT * FROM "sync_device_states"`)).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "device_id", "last_sync_at"}))

	st, err := r.FindDeviceState(ctx, 7, 2)
	assert.NoError(t, err)
	assert.Nil(t, st)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// last_sync_at 也是一条语句的 upsert：同一台设备的上行与下行会并发落到不同副本，
// 先查后写会漏掉其中一次。
func TestTouchDeviceState_GivenNoRow_ThenUpsertsInOneStatement(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncState()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`ON DUPLICATE KEY UPDATE`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	assert.NoError(t, r.TouchDeviceState(ctx, 7, 2, 1700))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 落库要在版本号更大时才覆盖：两个副本并发写同一行时由数据库裁决，
// 落后的那次不能把更新的那一版盖掉。
func TestSaveObject_GivenExistingRow_ThenUpsertOnlyWhenVersionIsGreater(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`ON DUPLICATE KEY UPDATE`)).WillReturnResult(sqlmock.NewResult(1, 2))
	mock.ExpectCommit()

	err := r.Save(ctx, &sync_entity.SyncObject{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "p1", Payload: `{"name":"a"}`, Version: 9,
	})
	assert.NoError(t, err)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestSaveObject_GivenExistingRow_ThenConditionalWhereIsPresent(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec("`version`=IF\\(VALUES\\(`version`\\) > `version`, VALUES\\(`version`\\), `version`\\)").
		WillReturnResult(sqlmock.NewResult(1, 2))
	mock.ExpectCommit()

	assert.NoError(t, r.Save(ctx, &sync_entity.SyncObject{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "p1", Payload: `{}`, Version: 9,
	}))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 自然键查重只看存活的那一行：墓碑不占（账号, 项目, 指纹），否则删掉再建就建不回来。
func TestFindLocationByNaturalKey_GivenTombstones_ThenOnlyLiveRowMatches(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectQuery(regexp.QuoteMeta(`deleted_at=0`)).
		WithArgs(int64(7), sync_entity.KindProjectLocation, "proj-1", "fp-a", sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "sync_id", "version"}).AddRow(int64(55), "loc-A", int64(4)))

	got, err := r.FindLocationByNaturalKey(ctx, 7, "proj-1", "fp-a")
	assert.NoError(t, err)
	assert.Equal(t, "loc-A", got.SyncID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 打墓碑是条件更新，返回受影响行数：已经是墓碑时为 0，由 service 决定这意味着什么。
func TestTombstone_GivenAlreadyTombstoned_ThenZeroRowsAffected(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE "sync_objects" SET`)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	n, err := r.Tombstone(ctx, 55, 9, 1700)
	assert.NoError(t, err)
	assert.Equal(t, int64(0), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 下行游标：版本升序、严格大于游标、按 limit 截断。
func TestListSince_GivenCursor_ThenOrderedByVersionAscending(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectQuery(regexp.QuoteMeta(`ORDER BY version ASC`)).
		WithArgs(int64(7), int64(12), 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "sync_id", "version"}).
			AddRow(int64(1), "p1", int64(13)).
			AddRow(int64(2), "p2", int64(14)))

	got, err := r.ListSince(ctx, 7, 12, 50)
	assert.NoError(t, err)
	assert.Len(t, got, 2)
	assert.Equal(t, int64(13), got[0].Version)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// web 控制台读账号级快照：按 kind 取全部存活行，不分页、不看游标——
// 这条路径服务的是「总览页列 Agent」「设备展开列项目」，需要的是当前状态的
// 完整集合，不是增量。墓碑必须被过滤掉，否则已删除的 Agent 会在总览重新出现。
func TestListByKinds_GivenKinds_ThenOnlyLiveRowsOfThoseKinds(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectQuery(regexp.QuoteMeta(`AND kind IN (`)+`.*`+regexp.QuoteMeta(`) AND deleted_at=0`)).
		WithArgs(int64(7), sync_entity.KindAgent, sync_entity.KindAgentBackend).
		WillReturnRows(sqlmock.NewRows([]string{"id", "kind", "sync_id"}).
			AddRow(int64(1), sync_entity.KindAgent, "a1").
			AddRow(int64(2), sync_entity.KindAgentBackend, "b1"))

	got, err := r.ListByKinds(ctx, 7, []string{sync_entity.KindAgent, sync_entity.KindAgentBackend})
	assert.NoError(t, err)
	assert.Len(t, got, 2)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 上报组整份替换：先清掉这台设备的旧清单，再写新的，且两步在同一个事务里，
// 否则中途失败会让服务端的清单空掉。
func TestReplaceSnapshot_GivenItems_ThenDeletesThenInsertsInOneTransaction(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncLocalPath()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM "device_local_paths"`)).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO "device_local_paths"`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	err := r.ReplaceSnapshot(ctx, 7, 2, []*sync_entity.DeviceLocalPath{
		{UserID: 7, DeviceID: 2, ProjectSyncID: "p1", Path: "/srv/p1"},
	})
	assert.NoError(t, err)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestReplaceSnapshot_GivenEmptySnapshot_ThenOnlyDeletes(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncLocalPath()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM "device_local_paths"`)).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectCommit()

	assert.NoError(t, r.ReplaceSnapshot(ctx, 7, 2, nil))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// R18：设备记录被删除时，它上报的本机路径清单一并消失。device_id 全局唯一，
// 不需要再传 user_id 校验归属，也不是一个事务（单条 DELETE，没有后续要写的东西）。
func TestDeleteByDevice_GivenDeviceID_ThenDeletesAllRowsForThatDevice(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncLocalPath()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM "device_local_paths" WHERE device_id=`)).
		WithArgs(int64(2)).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectCommit()

	assert.NoError(t, r.DeleteByDevice(ctx, 2))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 设备展开页要知道「这台设备上配了路径的项目有哪些」——只看这台设备名下的
// 上报行，不看它的正文（web 端不展示路径，R19），这里只验证按设备取全部行。
func TestListByDevice_GivenDeviceID_ThenReturnsItsReportedRows(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncLocalPath()

	mock.ExpectQuery(regexp.QuoteMeta(`SELECT * FROM "device_local_paths" WHERE user_id=`)).
		WithArgs(int64(7), int64(2)).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "device_id", "project_sync_id", "path"}).
			AddRow(int64(7), int64(2), "p1", "/srv/p1"))

	got, err := r.ListByDevice(ctx, 7, 2)
	assert.NoError(t, err)
	assert.Len(t, got, 1)
	assert.Equal(t, "p1", got[0].ProjectSyncID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 同一份头像重复上传不该产生第二行，也不该覆盖已有正文。
func TestSaveAvatar_GivenSameContentTwice_ThenOnConflictDoNothing(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncAvatar()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`ON DUPLICATE KEY UPDATE`)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	assert.NoError(t, r.Save(ctx, &sync_entity.SyncAvatar{
		UserID: 7, ContentHash: "h1", Content: "data:image/png;base64,AAAA",
	}))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 决策 9：墓碑保留 30 天，超期由服务端回收。回收语句必须同时带上下界——
// 没有 deleted_at>0 就把存活的行一起删了；没有 deleted_at<cutoff 就把窗口内的
// 墓碑也删了，而那正是还没拉取过的设备赖以知道「这行被删了」的唯一凭据（R6）。
func TestDeleteTombstonesBefore_GivenCutoff_ThenOnlyExpiredTombstonesAreDeleted(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM "sync_objects" WHERE deleted_at>0 AND deleted_at<`)).
		WithArgs(int64(1700)).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectCommit()

	n, err := r.DeleteTombstonesBefore(ctx, 1700)
	assert.NoError(t, err)
	assert.Equal(t, int64(3), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// R16a：头像按哈希存一份，被任何 Agent 引用即保留，无人引用即可回收。
//
// 三个条件缺一不可：引用检查必须按账号相关联（sync_avatars 的主键是「账号 + 哈希」，
// 同一张图完全可能同时存在于两个账号下，拿别人账号的引用决定这一行的生死既会误留
// 也会误删）；只有 kind=agent 的行才算引用；且只有存活的行算数（墓碑不是引用）。
func TestDeleteUnreferencedAvatarsBefore_GivenAccounts_ThenReferenceCheckIsPerAccountAndLiveOnly(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncAvatar()

	mock.ExpectExec(`(?s)DELETE FROM sync_avatars.*NOT EXISTS.*o\.user_id = a\.user_id.*o\.kind = 'agent'.*o\.deleted_at = 0`).
		WithArgs(int64(1700)).
		WillReturnResult(sqlmock.NewResult(0, 2))

	n, err := r.DeleteUnreferencedBefore(ctx, 1700)
	assert.NoError(t, err)
	assert.Equal(t, int64(2), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindAvatar_GivenNoRow_ThenNilNil(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncAvatar()

	mock.ExpectQuery(regexp.QuoteMeta(`SELECT * FROM "sync_avatars"`)).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "content_hash"}))

	got, err := r.Find(ctx, 7, "h1")
	assert.NoError(t, err)
	assert.Nil(t, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}
