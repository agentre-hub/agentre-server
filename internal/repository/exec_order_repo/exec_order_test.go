package exec_order_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/model/entity/exec_order_entity"
	hubtest "agentre-server/internal/testutils"
)

func TestFind_GivenBrowserCompositeKey_ThenBindsAllColumns(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewExecOrder()
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `browser_exec_target_orders` WHERE user_id=? AND client_id=? AND agent_sync_id=?",
	)).WithArgs(int64(7), "client-31", "agent-1", 1).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "client_id", "agent_sync_id", "order_json", "updatetime"}).
			AddRow(7, "client-31", "agent-1", `["backend-b","backend-a"]`, 1000))
	got, err := r.Find(ctx, 7, "client-31", "agent-1")
	require.NoError(t, err)
	assert.Equal(t, []string{"backend-b", "backend-a"}, got.BackendSyncIDs())
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestSave_GivenExistingBrowserKey_ThenUpserts(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewExecOrder()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("ON DUPLICATE KEY UPDATE")).
		WithArgs(int64(7), "client-31", "agent-1", `["backend-b"]`, int64(2000)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	o := &exec_order_entity.DeviceExecTargetOrder{UserID: 7, ClientID: "client-31", AgentSyncID: "agent-1", Updatetime: 2000}
	require.NoError(t, o.SetBackendSyncIDs([]string{"backend-b"}))
	require.NoError(t, r.Save(ctx, o))
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestListByClient_GivenAccountAndClient_ThenScopedToBoth(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewExecOrder()
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `browser_exec_target_orders` WHERE user_id=? AND client_id=?",
	)).WithArgs(int64(7), "client-31").
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "client_id", "agent_sync_id", "order_json", "updatetime"}).
			AddRow(7, "client-31", "agent-1", `["backend-b"]`, 1000))
	got, err := r.ListByClient(ctx, 7, "client-31")
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.NoError(t, mock.ExpectationsWereMet())
}
