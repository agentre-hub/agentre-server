package workspace_svc

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// WithOrgWriteBatch：批里的几次完整写入并进一个事务，提交之后只广播一次、带最高版本。

func setupBatchTest(t *testing.T) (context.Context, *hubtest.TxLog, *workspaceSvc, *stubAccountChan) {
	t.Helper()
	ctx, txLog, mObj, _, _, svc := setupWorkspaceTxTest(t)
	ctrl := gomock.NewController(t)
	mState := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncState(mState)
	mState.EXPECT().LockAccountSeq(gomock.Any(), int64(7)).Return(nil).AnyTimes()
	var version int64 = 40
	mState.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).DoAndReturn(
		func(context.Context, int64, int64) (int64, error) { version++; return version, nil }).AnyTimes()
	mObj.EXPECT().Save(gomock.Any(), gomock.Any()).Return(nil).AnyTimes()
	return ctx, txLog, svc, registerAccountChanStub(t)
}

func createDept(ctx context.Context, svc *workspaceSvc, userID int64) error {
	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{UserID: userID, Kind: sync_entity.KindDepartment, Fields: map[string]any{"name": "QA"}})
	return err
}

func TestWithOrgWriteBatch_GivenTwoWritesAndANestedBatch_ThenOneCommitAndOneSignalWithTheHighestVersion(t *testing.T) {
	ctx, txLog, svc, chans := setupBatchTest(t)

	err := WithOrgWriteBatch(ctx, 7, func(ctx context.Context) error {
		if err := createDept(ctx, svc, 7); err != nil {
			return err
		}
		return WithOrgWriteBatch(ctx, 7, func(ctx context.Context) error { return createDept(ctx, svc, 7) })
	})

	require.NoError(t, err)
	assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxCommit}, txLog.Events())
	assert.Equal(t, []accountChanCall{{accountID: 7, frameType: accountchan_svc.FrameTypeSyncVersion, version: 42}}, chans.recordedCalls())
}

func TestWithOrgWriteBatch_GivenAWriteForAnotherAccount_ThenRollsBackAndSignalsNothing(t *testing.T) {
	ctx, txLog, svc, chans := setupBatchTest(t)

	err := WithOrgWriteBatch(ctx, 7, func(ctx context.Context) error {
		if err := createDept(ctx, svc, 7); err != nil {
			return err
		}
		return createDept(ctx, svc, 8)
	})

	require.Error(t, err)
	assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxRollback}, txLog.Events())
	assert.Empty(t, chans.recordedCalls())
}

func TestWithOrgWriteBatch_GivenNothingWritten_ThenNoSignal(t *testing.T) {
	ctx, txLog, _, chans := setupBatchTest(t)

	require.NoError(t, WithOrgWriteBatch(ctx, 7, func(context.Context) error { return nil }))
	assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxCommit}, txLog.Events())
	assert.Empty(t, chans.recordedCalls())
}
