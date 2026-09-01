package sessionimport_svc

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
)

const (
	testUserID      = int64(7)
	testDeviceID    = int64(11)
	testFingerprint = "sha256:aaaa"
)

// ── 假的那台机器：只记下收到了什么，按剧本作答 ──────────────────────────────

type fakePeer struct {
	scan     *agentrewire.TranscriptImportScanResponse
	open     *agentrewire.TranscriptImportOpenResponse
	turns    *agentrewire.TranscriptImportTurnsResponse
	execute  *agentrewire.TranscriptImportExecuteResponse
	callErr  error
	scanned  []*agentrewire.TranscriptImportScanRequest
	turned   []*agentrewire.TranscriptImportTurnsRequest
	executed []*agentrewire.TranscriptImportExecuteRequest
}

// 浏览器这次铸的号，与库里那条早就存在的号（导入路径允许交回后者）。
const (
	mintedConversation = "3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"
	storedConversation = "5b8c9d2e-1f30-7c55-b214-9d7e3a6b0c11"
)

func (p *fakePeer) TranscriptImportScan(_ context.Context, request *agentrewire.TranscriptImportScanRequest) (*agentrewire.TranscriptImportScanResponse, error) {
	p.scanned = append(p.scanned, request)
	if p.callErr != nil {
		return nil, p.callErr
	}
	return p.scan, nil
}

func (p *fakePeer) TranscriptImportOpen(_ context.Context, _ *agentrewire.TranscriptImportOpenRequest) (*agentrewire.TranscriptImportOpenResponse, error) {
	if p.callErr != nil {
		return nil, p.callErr
	}
	return p.open, nil
}

func (p *fakePeer) TranscriptImportTurns(_ context.Context, request *agentrewire.TranscriptImportTurnsRequest) (*agentrewire.TranscriptImportTurnsResponse, error) {
	p.turned = append(p.turned, request)
	if p.callErr != nil {
		return nil, p.callErr
	}
	return p.turns, nil
}

func (p *fakePeer) TranscriptImportExecute(_ context.Context, request *agentrewire.TranscriptImportExecuteRequest) (*agentrewire.TranscriptImportExecuteResponse, error) {
	p.executed = append(p.executed, request)
	if p.callErr != nil {
		return nil, p.callErr
	}
	return p.execute, nil
}

type fakeMachines struct {
	peer    *fakePeer
	dialErr error
	dialed  []string
}

func (m *fakeMachines) WithPeer(
	ctx context.Context, _ int64, fingerprint string,
	fn func(context.Context, TranscriptImportPeer) error,
) error {
	m.dialed = append(m.dialed, fingerprint)
	if m.dialErr != nil {
		return m.dialErr
	}
	return fn(ctx, m.peer)
}

type fakeSaved struct {
	refs []SessionRef
	err  error
}

func (s *fakeSaved) Save(_ context.Context, ref SessionRef) error {
	s.refs = append(s.refs, ref)
	return s.err
}

// rig 装配一次调用要的全部依赖：一台归本账号的在线机器 + 一份空的镜像摘要。
type rig struct {
	machines *fakeMachines
	peer     *fakePeer
	saved    *fakeSaved
	svc      SessionImportSvc
}

func newRig(t *testing.T) *rig {
	t.Helper()
	ctrl := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	devices.EXPECT().Find(gomock.Any(), testDeviceID).Return(&device_entity.Device{
		ID: testDeviceID, UserID: testUserID, Fingerprint: testFingerprint,
		Kind: device_entity.KindAgentred, Name: "build box", Status: consts.ACTIVE,
	}, nil).AnyTimes()
	device_repo.RegisterDevice(devices)

	summaries := mock_agent_session_repo.NewMockSummaryRepo(ctrl)
	summaries.EXPECT().ListSummariesByUser(gomock.Any(), testUserID).
		Return(nil, nil).AnyTimes()
	agent_session_repo.RegisterSummary(summaries)

	peer := &fakePeer{}
	machines := &fakeMachines{peer: peer}
	saved := &fakeSaved{}
	return &rig{
		machines: machines, peer: peer, saved: saved,
		svc: New(machines, saved),
	}
}

// ── 发现：三态各自活着到浏览器 ──────────────────────────────────────────────

// Given 一台在线机器上 claudecode 答出一条候选、codex 那一档答不出;
// When 列候选;Then 那一条候选照给,codex 那一档以**按后端**的一档如实交代 ——
// 一档答不出不该把另一档一起吞掉。
func TestListCandidates_PerBackendFailureKeepsTheOtherBackendsAnswers(t *testing.T) {
	r := newRig(t)
	r.peer.scan = &agentrewire.TranscriptImportScanResponse{
		Backends: []*agentrewire.TranscriptImportBackendResult{
			{Backend: "claudecode", Status: "ok", Candidates: []*agentrewire.TranscriptImportCandidate{{
				Backend: "claudecode", ProviderSessionId: "prov-1", Title: "写个爬虫",
				Cwd: "/repos/spider", StartedAt: 1000, EndedAt: 2000, Turns: 12,
				Origin: "terminal", Locator: "loc-1",
			}}},
			{Backend: "codex", Status: "unavailable", Reason: "codex 没装"},
		},
	}

	view, err := r.svc.ListCandidates(context.Background(), ListCandidatesInput{
		UserID: testUserID, DeviceID: testDeviceID, CwdPrefix: "/repos", TitleQuery: "爬",
	})

	require.NoError(t, err)
	require.Len(t, view.Candidates, 1)
	assert.Equal(t, "prov-1", view.Candidates[0].ProviderSessionID)
	assert.Equal(t, "/repos/spider", view.Candidates[0].Cwd)
	assert.Equal(t, "loc-1", view.Candidates[0].Locator)
	require.Len(t, view.Issues, 1)
	assert.Equal(t, ScanIssueView{Backend: "codex", Status: StatusUnavailable, Reason: "codex 没装"}, view.Issues[0])
	assert.Equal(t, []string{testFingerprint}, r.machines.dialed, "问的是这台设备的指纹")
	require.Len(t, r.peer.scanned, 1)
	assert.Equal(t, "/repos", r.peer.scanned[0].GetFilter().GetCwdPrefix(), "筛选原样带到那台机器上")
	assert.Equal(t, "爬", r.peer.scanned[0].GetFilter().GetTitleQuery())
}

// Given 一台机器某一档**没给判别值**（旧的 / 有毛病的应答）;When 列候选;
// Then 那一档算「答不出」而不是「这个后端没有会话」——空清单必须自带理由，
// 空串读成 ok 的话，答不出会在界面上长成「问出来就是没有」。
func TestListCandidates_BackendWithoutAStatus_CountsAsUnavailable(t *testing.T) {
	r := newRig(t)
	r.peer.scan = &agentrewire.TranscriptImportScanResponse{
		Backends: []*agentrewire.TranscriptImportBackendResult{{Backend: "codex"}},
	}

	view, err := r.svc.ListCandidates(context.Background(), ListCandidatesInput{
		UserID: testUserID, DeviceID: testDeviceID,
	})

	require.NoError(t, err)
	assert.Empty(t, view.Candidates)
	require.Len(t, view.Issues, 1)
	assert.Equal(t, "codex", view.Issues[0].Backend)
	assert.Equal(t, StatusUnavailable, view.Issues[0].Status)
}

// Given 账号里已经镜像着这条 provider 会话（早先导过一次）;When 列候选;
// Then 它照常列出但标成「已导入」并带上库里那条的会话号 —— 用户要的是「打开它」，
// 不是再导一份。
func TestListCandidates_AlreadyMirroredProviderSession_IsMarkedImported(t *testing.T) {
	r := newRig(t)
	// 换掉 rig 里那份空摘要:gomock 按登记顺序取第一条没用尽的期望,而 AnyTimes 那条
	// 永远用不尽,直接再 EXPECT 一条是盖不住它的。
	summaries := mock_agent_session_repo.NewMockSummaryRepo(gomock.NewController(t))
	summaries.EXPECT().ListSummariesByUser(gomock.Any(), testUserID).Return(
		[]*agent_session_entity.SessionSummary{{
			UserID: testUserID, PeerFingerprint: testFingerprint,
			ConversationID: storedConversation, ProviderSessionID: "prov-1",
		}}, nil).AnyTimes()
	agent_session_repo.RegisterSummary(summaries)
	r.peer.scan = &agentrewire.TranscriptImportScanResponse{
		Backends: []*agentrewire.TranscriptImportBackendResult{{
			Backend: "claudecode", Status: "ok", Candidates: []*agentrewire.TranscriptImportCandidate{{
				Backend: "claudecode", ProviderSessionId: "prov-1", Locator: "loc-1",
			}},
		}},
	}

	view, err := r.svc.ListCandidates(context.Background(), ListCandidatesInput{
		UserID: testUserID, DeviceID: testDeviceID,
	})

	require.NoError(t, err)
	require.Len(t, view.Candidates, 1)
	assert.True(t, view.Candidates[0].Imported)
	assert.Equal(t, storedConversation, view.Candidates[0].ImportedSessionID)
}

// Given 那台机器现在联系不上;When 列候选;Then 交回一份空清单 + 一条**设备级**的
// 理由,而不是一个错误 —— 「问出来就是没有」与「这台机器答不上话」在界面上是两句
// 不同的话,折成同一个报错会让用户去别处找一份其实就在那儿的会话。
func TestListCandidates_MachineOffline_IsADeviceLevelIssueNotAnError(t *testing.T) {
	r := newRig(t)
	r.machines.dialErr = ErrMachineOffline

	view, err := r.svc.ListCandidates(context.Background(), ListCandidatesInput{
		UserID: testUserID, DeviceID: testDeviceID,
	})

	require.NoError(t, err)
	assert.Empty(t, view.Candidates)
	require.Len(t, view.Issues, 1)
	assert.Empty(t, view.Issues[0].Backend, "设备级的一档不挂在任何后端上")
	assert.Equal(t, StatusUnavailable, view.Issues[0].Status)
	assert.Equal(t, i18n.T(context.Background(), code.SessionImportMachineOffline),
		view.Issues[0].Reason, "这一句界面原样显示,不能是内部哨兵那句英文")
}

// Given 那台机器上的 agentred 还不认识这个方法族;When 列候选;
// Then 交回设备级的 **unsupported** 一档 —— 它与「不在线」也必须分开:一个要升级
// 那台 agentred,另一个只要把机器开起来。
func TestListCandidates_PeerProtocolError_ReturnsFailure(t *testing.T) {
	r := newRig(t)
	r.machines.dialErr = errors.New("peer violated the negotiated protocol")

	view, err := r.svc.ListCandidates(context.Background(), ListCandidatesInput{
		UserID: testUserID, DeviceID: testDeviceID,
	})

	require.Error(t, err)
	assert.Nil(t, view)
}

// Given 一台不属于这个账号的设备;When 列它的候选;Then 报「设备不存在」——
// 跨账号读别人机器上的磁盘转录必须在服务端拦住,而且不区分「不存在」与「不属于你」。
func TestListCandidates_DeviceOfAnotherAccount_IsRefused(t *testing.T) {
	ctrl := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	devices.EXPECT().Find(gomock.Any(), testDeviceID).Return(&device_entity.Device{
		ID: testDeviceID, UserID: testUserID + 1, Fingerprint: "sha256:bbbb",
	}, nil)
	device_repo.RegisterDevice(devices)
	machines := &fakeMachines{peer: &fakePeer{}}

	_, err := New(machines, &fakeSaved{}).ListCandidates(context.Background(),
		ListCandidatesInput{UserID: testUserID, DeviceID: testDeviceID})

	require.Error(t, err)
	assert.Empty(t, machines.dialed, "拦在拨号之前:别人的机器一次都不该被问到")
}

// ── 预览：与真实转录同一条渲染链 ────────────────────────────────────────────

// Given 一条转录的前两轮（一轮有用户那一行与助手正文，一轮只有助手正文）;
// When 预览;Then 交回的帧与账号镜像那条转录端点**逐字段同形**,而且每一轮自带
// 收尾的 done —— 少了它,没有用户那一行的下一轮会和上一轮并进同一条助手消息。
func TestPreview_ProjectsTurnsIntoFramesShapedLikeTheMirroredTranscript(t *testing.T) {
	r := newRig(t)
	r.peer.open = &agentrewire.TranscriptImportOpenResponse{Meta: &agentrewire.TranscriptImportMeta{
		Backend: "claudecode", ProviderSessionId: "prov-1", Title: "写个爬虫",
		Cwd: "/repos/spider", Turns: 12, ToolCalls: 40, StartedAt: 1000,
		Gaps: []*agentrewire.TranscriptImportGap{{Kind: "encrypted_thinking", Count: 3, Detail: "3 段"}},
	}}
	r.peer.turns = &agentrewire.TranscriptImportTurnsResponse{
		Turns: []*agentrewire.TranscriptImportTurn{
			{
				Index: 0, UserText: "帮我写个爬虫",
				Events: []*agentrewire.RuntimeEventNotification{{
					Event: &agentrewire.RuntimeEventNotification_TextDelta{
						TextDelta: &agentrewire.TextDelta{Text: "好的"},
					},
				}},
			},
			{
				Index: 1,
				Events: []*agentrewire.RuntimeEventNotification{{
					Event: &agentrewire.RuntimeEventNotification_TextDelta{
						TextDelta: &agentrewire.TextDelta{Text: "继续"},
					},
				}},
			},
		},
		NextIndex: 2,
	}

	view, err := r.svc.Preview(context.Background(), PreviewInput{
		UserID: testUserID, DeviceID: testDeviceID, Backend: "claudecode", Locator: "loc-1", Turns: 2,
	})

	require.NoError(t, err)
	assert.Equal(t, "prov-1", view.Meta.ProviderSessionID)
	assert.Equal(t, []GapView{{Kind: "encrypted_thinking", Count: 3, Detail: "3 段"}}, view.Meta.Gaps)
	assert.Equal(t, 2, view.PreviewedTurns)
	assert.Equal(t, 10, view.RemainingTurns, "元信息说共 12 轮,解了 2 轮")
	assert.Equal(t, []string{"user_message", "text_delta", "done", "text_delta", "done"}, frameKinds(t, view.Frames))
	for i, f := range view.Frames {
		assert.Equal(t, "runtime.event", f.Method)
		assert.Equal(t, int64(i+1), f.Seq, "seq 必须递增:渲染链按它排序")
	}
	require.Len(t, r.peer.turned, 1)
	assert.Equal(t, int32(2), r.peer.turned[0].GetMaxTurns())
}

// Given 元信息里没有轮数（磁盘上就没记）;When 预览;Then 剩余轮数报 -1 而不是 0 ——
// 报 0 会让界面说「没有更多了」,而其实说不出还有多少。
func TestPreview_TranscriptWithoutTurnCount_ReportsRemainingUnknown(t *testing.T) {
	r := newRig(t)
	r.peer.open = &agentrewire.TranscriptImportOpenResponse{
		Meta: &agentrewire.TranscriptImportMeta{Backend: "codex", ProviderSessionId: "prov-2"},
	}
	r.peer.turns = &agentrewire.TranscriptImportTurnsResponse{
		Turns: []*agentrewire.TranscriptImportTurn{{Index: 0, UserText: "你好"}},
	}

	view, err := r.svc.Preview(context.Background(), PreviewInput{
		UserID: testUserID, DeviceID: testDeviceID, Backend: "codex", Locator: "loc-2",
	})

	require.NoError(t, err)
	assert.Equal(t, -1, view.RemainingTurns)
}

// Given 那台机器联系不上;When 预览;Then 如实报错 —— 预览没有「部分成功」这一档,
// 一份空转录会被当成「这条会话是空的」。
func TestPreview_MachineOffline_ReportsFailure(t *testing.T) {
	r := newRig(t)
	r.machines.dialErr = ErrMachineOffline

	_, err := r.svc.Preview(context.Background(), PreviewInput{
		UserID: testUserID, DeviceID: testDeviceID, Backend: "claudecode", Locator: "loc-1",
	})

	assert.Equal(t, code.SessionImportMachineOffline, errorCode(t, err),
		"「机器不在线」必须带着自己的码上去:界面据它说得出去处")
}

// ── 执行：机器在导，导完这条会话必须进账号 ──────────────────────────────────

// Given 浏览器铸好了 conversation_id、选了一台机器;When 执行导入;
// Then 请求带着铸好的标识与**点名的发起端**过去,而且导完这条会话被收进账号 ——
// 少了收进账号这一步,会话在机器上真的建起来了,账号里却一行都没有(镜像的范围
// 就是保存过的那些对话)。
func TestImport_RunsOnTheMachineAndSavesTheSessionIntoTheAccount(t *testing.T) {
	r := newRig(t)
	r.peer.execute = &agentrewire.TranscriptImportExecuteResponse{
		ConversationId: mintedConversation, ProviderSessionId: "prov-1", Cwd: "/repos/spider",
		Title: "写个爬虫", Turns: 12,
	}

	view, err := r.svc.Import(context.Background(), ImportInput{
		UserID: testUserID, DeviceID: testDeviceID, Backend: "claudecode",
		Locator: "loc-1", ConversationID: mintedConversation, AgentSyncID: "agent-1",
	})

	require.NoError(t, err)
	assert.Equal(t, mintedConversation, view.ConversationID)
	assert.Equal(t, 12, view.ImportedTurns)
	assert.Equal(t, testFingerprint, view.PeerFingerprint)
	require.Len(t, r.peer.executed, 1)
	assert.Equal(t, mintedConversation, r.peer.executed[0].GetConversationId())
	assert.Equal(t, "agent-1", r.peer.executed[0].GetAgentSyncId())
	assert.Equal(t, testFingerprint, r.peer.executed[0].GetPeerFingerprint(),
		"点名发起端:不点名的话这条会话会落在 server 那个合成指纹名下")
	require.Len(t, r.saved.refs, 1)
	assert.Equal(t, SessionRef{
		UserID: testUserID, MachineFingerprint: testFingerprint,
		PeerFingerprint: testFingerprint, ConversationID: mintedConversation,
	}, r.saved.refs[0])
}

// Given 这条转录在那台机器上早就导过一次;When 再导一次;
// Then 交回**库里那条**的标识（未必是这次铸的），并且照样收进账号 ——
// 「机器上有」与「账号里保存了」是两件事,前一次导入可能根本没在这个账号里。
func TestImport_AlreadyImportedOnThatMachine_StillEntersTheAccount(t *testing.T) {
	r := newRig(t)
	r.peer.execute = &agentrewire.TranscriptImportExecuteResponse{
		ConversationId: storedConversation, ProviderSessionId: "prov-1", AlreadyImported: true,
	}

	view, err := r.svc.Import(context.Background(), ImportInput{
		UserID: testUserID, DeviceID: testDeviceID, Backend: "claudecode",
		Locator: "loc-1", ConversationID: mintedConversation,
	})

	require.NoError(t, err)
	assert.True(t, view.AlreadyImported)
	assert.Equal(t, storedConversation, view.ConversationID, "指向库里那条,不是这次铸的号")
	require.Len(t, r.saved.refs, 1)
	assert.Equal(t, storedConversation, r.saved.refs[0].ConversationID)
}

// Given 导入本身成了,但把它收进账号那一步失败了;When 执行导入;
// Then 如实报错 —— 报成功会让用户对着一条永远不出现在列表里的会话等下去;
// 而重试是安全的:那台机器上的导入判重会认出同一条 provider 会话。
func TestImport_SavingIntoTheAccountFails_IsReportedNotSwallowed(t *testing.T) {
	r := newRig(t)
	r.peer.execute = &agentrewire.TranscriptImportExecuteResponse{ConversationId: mintedConversation}
	r.saved.err = errors.New("库写不进去")

	_, err := r.svc.Import(context.Background(), ImportInput{
		UserID: testUserID, DeviceID: testDeviceID, Backend: "claudecode",
		Locator: "loc-1", ConversationID: mintedConversation,
	})

	require.Error(t, err)
}

// Given 浏览器没给 conversation_id;When 执行导入;Then 就地拒掉,一次连接都不拨 ——
// 给不出身份的对话在那台机器上建不出来,拨过去只会被拒。
func TestImport_WithoutAMintedConversationID_IsRefusedBeforeDialing(t *testing.T) {
	r := newRig(t)

	_, err := r.svc.Import(context.Background(), ImportInput{
		UserID: testUserID, DeviceID: testDeviceID, Backend: "claudecode", Locator: "loc-1",
	})

	require.Error(t, err)
	assert.Empty(t, r.machines.dialed)
}

// errorCode 抽出错误里的业务码：浏览器看到的就是它。
func errorCode(t *testing.T, err error) int {
	t.Helper()
	var httpErr *httputils.Error
	if !errors.As(err, &httpErr) {
		t.Fatalf("expected httputils.Error, got %T: %v", err, err)
	}
	return httpErr.Code
}

// frameKinds 抽出每一帧的 event.kind，供顺序断言。
func frameKinds(t *testing.T, frames []FrameView) []string {
	t.Helper()
	out := make([]string, 0, len(frames))
	for _, f := range frames {
		var params struct {
			Event struct {
				Kind string `json:"kind"`
			} `json:"event"`
		}
		require.NoError(t, json.Unmarshal(f.Params, &params))
		out = append(out, params.Event.Kind)
	}
	return out
}
