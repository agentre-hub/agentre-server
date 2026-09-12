package issue_svc

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// 这个文件只放本包测试共用的装配与小工具，与 workspace_svc 那一份同形而各自独立：
// 测试替身是各包自己的东西，借过来会把两个包的装配拴在一起。

// setupBoardTest 装配看板这一族用得上的那一个仓储替身与事务连接。
//
// 写路径把「取版本号 + 落库」钉在同一个事务里（workspace_svc.SaveOrgRow），ctx 因此
// 必须真的带着一个开得起事务的连接；hubtest.TxDatabase 提供的正是它——只认
// BEGIN/COMMIT/ROLLBACK，任何一条真的 SQL 都会当场失败（这一层的数据访问一律走
// mockgen 注入的仓储）。
func setupBoardTest(t *testing.T) (context.Context, *mock_sync_repo.MockSyncObjectRepo) {
	t.Helper()
	ctx, _, mObj := setupBoardTxTest(t)
	return ctx, mObj
}

// setupBoardTxTest 与 setupBoardTest 只差一件东西：它还交回事务事件记录。
//
// 断言事务边界本身的用例需要那份记录——「取号与落库在同一个 BEGIN…COMMIT 里」与
// 「一次用户操作是一个事务」这两条只有一份时序说得清（TxLog.Events）；其余的走
// setupBoardTest。与 workspace_svc 那一份同形而各自独立。
func setupBoardTxTest(t *testing.T) (
	context.Context, *hubtest.TxLog, *mock_sync_repo.MockSyncObjectRepo,
) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mObj := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(mObj)
	ctx, txLog := hubtest.TxDatabase(t)
	return ctx, txLog, mObj
}

func registerSyncStateMock(t *testing.T) *mock_sync_repo.MockSyncStateRepo {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	m := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncState(m)
	t.Cleanup(func() { sync_repo.RegisterSyncState(nil) })
	return m
}

// orgRow 造一行存活的同步对象。
func orgRow(t *testing.T, kind, syncID string, payload map[string]any) *sync_entity.SyncObject {
	t.Helper()
	return &sync_entity.SyncObject{Kind: kind, SyncID: syncID, Payload: mustJSON(t, payload)}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}

func payloadKey(t *testing.T, payload, key string) any {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(payload), &m))
	return m[key]
}

func assertWriteCode(t *testing.T, err error, want int) {
	t.Helper()
	var he *httputils.Error
	require.ErrorAs(t, err, &he)
	assert.Equal(t, want, he.Code)
}
