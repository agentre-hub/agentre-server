package sync_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	mysqldriver "github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
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

// 只读序列的头，一个字都不推进：它回答的是「这个账号的历史到哪为止」，
// 设备送来的游标大于它就说明那段历史不是本账号发出的。
func TestCurrentVersion_GivenExistingSeq_ThenReadsHeadWithoutAdvancingIt(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncState()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT version_seq FROM sync_account_seqs WHERE user_id = ?")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"version_seq"}).AddRow(int64(3)))

	v, err := r.CurrentVersion(ctx, 7)
	assert.NoError(t, err)
	assert.Equal(t, int64(3), v)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 账号一个版本都没分配过（新账号，或库刚被重建）：那是「历史为空」，不是查不到，
// 返回 0 而不是错误——否则整条下行会因为一张空表而失败。
func TestCurrentVersion_GivenNoSeqRow_ThenZero(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncState()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT version_seq FROM sync_account_seqs WHERE user_id = ?")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"version_seq"}))

	v, err := r.CurrentVersion(ctx, 7)
	assert.NoError(t, err)
	assert.Zero(t, v)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 没有 last_sync_at 记录 = 首次登录，仓储层返回 (nil, nil) 而不是错误，
// R6a 的「不算超窗口」才判得出来。
func TestFindDeviceState_GivenNoRow_ThenNilNil(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncState()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `sync_device_states`")).
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

// 落库的第一步是一条带版本条件的 UPDATE：版本更大才覆盖，两个副本并发写同一行时
// 由行锁裁决，落后的那次条件不成立、改不动任何东西。
//
// 绑定值一并钉死：SET 里恰好 9 列、没有 createtime（命中已有行要保留它首次落地的
// 时间），WHERE 里 version 作为条件再绑一次——少了它就退化成「后到的一定赢」。
func TestSaveObject_GivenGreaterVersion_ThenConditionalUpdateWins(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `sync_objects` SET `agentred_fingerprint`=?,`deleted_at`=?,`kind`=?,"+
			"`origin_fingerprint`=?,`payload`=?,`project_sync_id`=?,`updated_at`=?,`updatetime`=?,`version`=? "+
			"WHERE user_id=? AND sync_id=? AND version<?")).
		WithArgs("", int64(0), sync_entity.KindProject, "", `{"name":"a"}`, "", int64(0), int64(0), int64(9),
			int64(7), "p1", int64(9)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	err := r.Save(ctx, &sync_entity.SyncObject{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "p1", Payload: `{"name":"a"}`, Version: 9,
	})
	assert.NoError(t, err)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// UPDATE 没命中（行还不存在）才走 INSERT。这条 INSERT **不能**带
// ON DUPLICATE KEY UPDATE：MySQL 的 ON DUPLICATE KEY 命中的是任意唯一键，而
// sync_objects 上还有 uk_sync_objects_natural，带上它就等于把自然键冲突也一起吞掉。
func TestSaveObject_GivenNoRow_ThenPlainInsertWithoutOnDuplicateKey(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `sync_objects` SET")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `sync_objects`")).
		WillReturnResult(sqlmock.NewResult(42, 1))
	mock.ExpectCommit()

	assert.NoError(t, r.Save(ctx, &sync_entity.SyncObject{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "p1", Payload: `{}`, Version: 9,
	}))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// UPDATE 没命中、INSERT 又撞上身份键 = 库里那一行的版本不比本次小，本次上行是 R4 的
// 竞败方。这是预期内的正常路径（并发的另一次上行抢先落了更新的一版），吞掉。
func TestSaveObject_GivenIdentityConflict_ThenSwallowedAsLostVersionRace(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `sync_objects` SET")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `sync_objects`")).
		WillReturnError(&mysqldriver.MySQLError{
			Number:  1062,
			Message: "Duplicate entry '7-p1' for key 'sync_objects.uk_sync_objects_identity'",
		})
	mock.ExpectRollback()

	assert.NoError(t, r.Save(ctx, &sync_entity.SyncObject{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "p1", Payload: `{}`, Version: 9,
	}))
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 撞上自然键是另一回事，必须响：自然键上另一个 sync_id 还活着，这是 R4b 的兜底。
// 吞掉它意味着本次上行的对象从来没落库、调用方却拿到成功——客户端会永远重推同一个
// sync_id，而库里那一行始终是别人的身份。这条断言就是为了挡住那种「静默成功」。
func TestSaveObject_GivenLocationConflict_ThenErrorIsLoud(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	locationConflict := &mysqldriver.MySQLError{
		Number:  1062,
		Message: "Duplicate entry '7-proj-1-fp-a-project_location' for key 'sync_objects.uk_sync_objects_natural'",
	}
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `sync_objects` SET")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `sync_objects`")).WillReturnError(locationConflict)
	mock.ExpectRollback()

	err := r.Save(ctx, &sync_entity.SyncObject{
		UserID: 7, Kind: sync_entity.KindProjectLocation, SyncID: "loc-B",
		ProjectSyncID: "proj-1", AgentredFingerprint: "fp-a", Payload: `{}`, Version: 9,
	})
	assert.ErrorIs(t, err, locationConflict)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 条件 UPDATE 自身的失败要如实上抛，不能被当成「没命中」而掉进 INSERT 分支——
// 那会把一个数据库错误变成一次多余的写入尝试。
func TestSaveObject_GivenUpdateFails_ThenErrorPropagatesWithoutInsert(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `sync_objects` SET")).WillReturnError(assert.AnError)
	mock.ExpectRollback()

	err := r.Save(ctx, &sync_entity.SyncObject{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "p1", Payload: `{}`, Version: 9,
	})
	assert.ErrorIs(t, err, assert.AnError)
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
// CLI 覆盖与项目路径一样，按（账号、backend sync id、设备指纹）天然去重；后端
// sync id 复用 project_sync_id 列，以便这个查询与新增的部分唯一键走同一套列。
func TestFindCLIOverlayByNaturalKey_GivenLiveOverlay_ThenFindsOnlyThatNaturalKey(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectQuery(regexp.QuoteMeta(`deleted_at=0`)).
		WithArgs(int64(7), sync_entity.KindAgentBackendCLI, "backend-1", "fp-a", sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "kind", "project_sync_id", "agentred_fingerprint"}).
			AddRow(int64(55), sync_entity.KindAgentBackendCLI, "backend-1", "fp-a"))

	got, err := r.FindCLIOverlayByNaturalKey(ctx, 7, "backend-1", "fp-a")
	assert.NoError(t, err)
	assert.Equal(t, int64(55), got.ID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestTombstone_GivenAlreadyTombstoned_ThenZeroRowsAffected(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE `sync_objects` SET")).
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

// 一台设备离开账号时要落墓碑的那些行，靠 agentred_fingerprint 这一列圈出来
// （它单独成列正是为了让 backend 与路径记录 join 得到 devices）。三个条件缺一不可：
// kind 限定住只碰这两类、指纹限定住只碰这台机器、deleted_at=0 把已经生效的墓碑
// 排除在外（再落一次只会白白多占一个版本号）。
func TestListLiveByFingerprint_GivenFingerprint_ThenOnlyLiveRowsOfThoseKinds(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	mock.ExpectQuery(
		regexp.QuoteMeta(`AND kind IN (`)+`.*`+
			regexp.QuoteMeta(`) AND agentred_fingerprint=? AND deleted_at=0`),
	).
		WithArgs(int64(7), sync_entity.KindAgentBackend, sync_entity.KindProjectLocation, "sha256:aaa").
		WillReturnRows(sqlmock.NewRows([]string{"id", "kind", "sync_id", "agentred_fingerprint"}).
			AddRow(int64(3), sync_entity.KindAgentBackend, "b1", "sha256:aaa").
			AddRow(int64(4), sync_entity.KindProjectLocation, "l1", "sha256:aaa"))

	got, err := r.ListLiveByFingerprint(ctx, 7, "sha256:aaa",
		[]string{sync_entity.KindAgentBackend, sync_entity.KindProjectLocation})
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
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `device_local_paths`")).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `device_local_paths`")).
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
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `device_local_paths`")).
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
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `device_local_paths` WHERE device_id=")).
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

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `device_local_paths` WHERE user_id=")).
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
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `sync_objects` WHERE deleted_at>0 AND deleted_at<")).
		WithArgs(int64(1700), int64(cleanupBatchSize)).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectCommit()

	n, err := r.DeleteTombstonesBefore(ctx, 1700)
	assert.NoError(t, err)
	assert.Equal(t, int64(3), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 回收必须分批。不分批的一条 DELETE 在 InnoDB 上会把 next-key 锁铺满它扫过的范围
// ——sync_objects 稳态几十万行,一次回收可能删掉其中一大片,期间该账号的上行全被挡
// 在那把锁后面。分批把锁的持有时间切成一小段一小段,每批各自提交。
//
// 循环的收敛条件是「这一批没删满」:删满说明后面大概率还有,必须继续。
func TestDeleteTombstonesBefore_GivenMoreThanOneBatch_ThenDeletesInBoundedChunks(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncObject()

	for _, affected := range []int64{cleanupBatchSize, 7} {
		mock.ExpectBegin()
		mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `sync_objects` WHERE deleted_at>0 AND deleted_at<")).
			WithArgs(int64(1700), int64(cleanupBatchSize)).
			WillReturnResult(sqlmock.NewResult(0, affected))
		mock.ExpectCommit()
	}

	n, err := r.DeleteTombstonesBefore(ctx, 1700)
	assert.NoError(t, err)
	assert.Equal(t, cleanupBatchSize+int64(7), n, "分批之后总数必须仍然是删掉的行数之和")
	assert.NoError(t, mock.ExpectationsWereMet(), "删满一批之后没有继续删下一批")
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
		WithArgs(int64(1700), int64(cleanupBatchSize)).
		WillReturnResult(sqlmock.NewResult(0, 2))

	n, err := r.DeleteUnreferencedBefore(ctx, 1700)
	assert.NoError(t, err)
	assert.Equal(t, int64(2), n)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 引用检查必须比**列**，不能在语句里现算 JSON。
//
// `JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.avatar_hash')) = a.content_hash` 是一个
// 函数谓词：优化器无法用它定位任何索引，于是每一个候选头像行都要把该账号的全部
// sync_objects 读上来、逐行解一次 JSON。哈希提成生成列 avatar_hash 之后，这一半才
// 落得到 idx_sync_objects_avatar 上——而只要语句还写着 JSON_EXTRACT，那条索引就是
// 白建的。所以这里正面钉住「比的是列」。
func TestDeleteUnreferencedAvatarsBefore_ComparesTheIndexedColumnNotAJSONExpression(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncAvatar()

	mock.ExpectExec(`(?s)DELETE FROM sync_avatars.*o\.avatar_hash = a\.content_hash`).
		WithArgs(int64(1700), int64(cleanupBatchSize)).
		WillReturnResult(sqlmock.NewResult(0, 0))

	_, err := r.DeleteUnreferencedBefore(ctx, 1700)
	assert.NoError(t, err)
	assert.NoError(t, mock.ExpectationsWereMet())
	assert.NotContains(t, deleteUnreferencedAvatarsSQL, "JSON_EXTRACT",
		"语句里现算 JSON 就等于宣告 idx_sync_objects_avatar 用不上")
}

// 头像行每行带一份 mediumtext,一条不分批的 DELETE 既锁得久、又要把删掉的正文全部
// 写进 undo/binlog。这里同样按批收敛。
func TestDeleteUnreferencedAvatarsBefore_GivenMoreThanOneBatch_ThenDeletesInBoundedChunks(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncAvatar()

	for _, affected := range []int64{cleanupBatchSize, 4} {
		mock.ExpectExec(`(?s)DELETE FROM sync_avatars.*LIMIT`).
			WithArgs(int64(1700), int64(cleanupBatchSize)).
			WillReturnResult(sqlmock.NewResult(0, affected))
	}

	n, err := r.DeleteUnreferencedBefore(ctx, 1700)
	assert.NoError(t, err)
	assert.Equal(t, cleanupBatchSize+int64(4), n)
	assert.NoError(t, mock.ExpectationsWereMet(), "删满一批之后没有继续删下一批")
}

func TestFindAvatar_GivenNoRow_ThenNilNil(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSyncAvatar()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `sync_avatars`")).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "content_hash"}))

	got, err := r.Find(ctx, 7, "h1")
	assert.NoError(t, err)
	assert.Nil(t, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}
