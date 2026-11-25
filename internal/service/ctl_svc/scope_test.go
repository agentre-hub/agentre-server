package ctl_svc

import (
	"testing"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

func patCaller(scopes ...string) Caller {
	return Caller{UserID: userID, Kind: device_svc.KindPersonalToken, Scopes: scopes}
}

func TestScope_GivenPATWithoutRead_WhenListOrGet_ThenForbiddenNamingScope(t *testing.T) {
	h := setup(t)
	for _, req := range []*agentrewire.CtlRequest{
		list(agentrewire.CtlKind_CTL_KIND_PROVIDER),
		get(agentrewire.CtlKind_CTL_KIND_PROVIDER, 50),
	} {
		_, err := h.do(t, patCaller("resources:write", "chat"), req, false)
		require.Error(t, err)
		assert.Equal(t, 403, statusOf(t, err))
		assert.Equal(t, "token lacks scope read", err.Error())
	}
}

func TestScope_GivenPATWithRead_WhenListOrGet_ThenServed(t *testing.T) {
	h := setup(t)
	resp, err := h.do(t, patCaller("read"), list(agentrewire.CtlKind_CTL_KIND_PROVIDER), false)
	require.NoError(t, err)
	assert.Len(t, resp.GetList().GetItems(), 1)
	_, err = h.do(t, patCaller("read"), get(agentrewire.CtlKind_CTL_KIND_PROVIDER, 50), false)
	require.NoError(t, err)
}

func TestScope_GivenPATWithoutResourcesWrite_WhenWrite_ThenForbiddenEvenAsPreview(t *testing.T) {
	h := setup(t) // 写端口没有任何期望：到达即失败
	for _, preview := range []bool{true, false} {
		_, err := h.do(t, patCaller("read", "devices:write"), updateProvider(), preview)
		require.Error(t, err)
		assert.Equal(t, 403, statusOf(t, err))
		assert.Equal(t, "token lacks scope resources:write", err.Error())
	}
}

func TestScope_GivenPATWithResourcesWrite_WhenWritePreview_ThenChangesComputedWithoutACallerDevice(t *testing.T) {
	h := setup(t)
	resp, err := h.do(t, patCaller("resources:write"), updateProvider(), true)
	require.NoError(t, err)
	assert.Len(t, resp.GetWrite().GetChanges()[0].GetFields(), 2)
}

func TestScope_GivenAgentredCallerWithoutScopes_ThenBehaviourIsUnchanged(t *testing.T) {
	h := setup(t)
	_, err := h.do(t, fromAgentred, list(agentrewire.CtlKind_CTL_KIND_PROVIDER), false)
	require.NoError(t, err)
	_, err = h.do(t, fromAgentred, updateProvider(), true)
	require.NoError(t, err)
}

func TestScope_GivenPATWritingProjectPath_ThenUnsupportedNotAPanic(t *testing.T) {
	h := setup(t)
	_, err := h.do(t, patCaller("resources:write"), write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_PROJECT, Id: 60,
		Fields:   []string{"path"},
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Project{Project: &agentrewire.CtlProject{Path: "/x"}}},
	}), true)
	require.Error(t, err)
	assert.Equal(t, 422, statusOf(t, err))
}
