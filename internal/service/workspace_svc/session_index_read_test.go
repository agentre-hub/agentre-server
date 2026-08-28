package workspace_svc

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
)

// 这一组测试盯的是「索引读到什么」那一节的契约
// （2026-08-19-session-index-pagination.md）。判据全部落在**服务端交给仓储的判据**
// 与**回给调用方的形状**上：cwd 一路只参与比较、不进任何返回值（R19）。

// 时间轴是一个平铺组：它没有组头，因此组的 total 就是账号级 total，两者必须是同一个数。
func TestSessionIndex_TimeAxis_IsOneFlatGroupCarryingTheAccountTotal(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	mSummary.EXPECT().CountSummaries(ctx, agent_session_repo.SummaryQuery{UserID: 7}).Return(int64(137), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: agent_session_repo.SummaryQuery{UserID: 7}, Limit: 31,
	}).Return([]*agent_session_entity.SessionSummary{
		{PeerFingerprint: "fp-a", PeerSessionID: "9", Title: "调试登录页", LastMessageAt: 1700, ID: 42},
	}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisTime})
	require.NoError(t, err)
	assert.Equal(t, int64(137), page.Total)
	require.Len(t, page.Groups, 1)
	assert.Equal(t, "time", page.Groups[0].Scope)
	assert.Equal(t, int64(137), page.Groups[0].Total)
	require.Len(t, page.Groups[0].Items, 1)
	assert.Equal(t, "调试登录页", page.Groups[0].Items[0].Title)
	assert.False(t, page.Groups[0].HasMore, "只有一条,没有下一页")
}

// Agent 轴每个 Agent 一组，空的 agent_sync_id 是「未命名 Agent」那一组的真实键，
// 不是「没有分组」。每组的 total 来自一次按组聚合，不是把行拉回来数。
func TestSessionIndex_AgentAxis_GroupPerAgentIncludingTheUnnamedOne(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	mSummary.EXPECT().CountSummaries(ctx, agent_session_repo.SummaryQuery{UserID: 7}).Return(int64(11), nil)
	mSummary.EXPECT().CountSummariesByAgent(ctx, agent_session_repo.SummaryQuery{UserID: 7}).
		Return(map[string]int64{"agent-1": 9, "": 2}, nil)

	named, unnamed := "agent-1", ""
	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: agent_session_repo.SummaryQuery{UserID: 7, AgentSyncID: &named}, Limit: 6,
	}).Return([]*agent_session_entity.SessionSummary{{PeerFingerprint: "fp-a", PeerSessionID: "1"}}, nil)
	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: agent_session_repo.SummaryQuery{UserID: 7, AgentSyncID: &unnamed}, Limit: 6,
	}).Return([]*agent_session_entity.SessionSummary{{PeerFingerprint: "fp-b", PeerSessionID: "2"}}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisAgent})
	require.NoError(t, err)
	require.Len(t, page.Groups, 2)
	byScope := map[string]SessionIndexGroup{}
	for _, g := range page.Groups {
		byScope[g.Scope] = g
	}
	assert.Equal(t, int64(9), byScope["agent:agent-1"].Total)
	assert.Equal(t, int64(2), byScope["unnamed-agent"].Total)
}

// 项目轴的每组计数只能由服务端折算：SQL 数得出的是位置 (指纹, cwd)，把位置折成项目
// 是决策 12 的判据。配不上任何项目位置的那些落进「未归项目」。
func TestSessionIndex_ProjectAxis_FoldsLocationCountsIntoProjects(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-1"},
			{Kind: sync_entity.KindProjectLocation, ProjectSyncID: "proj-1",
				AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/repo/x"})},
			{Kind: sync_entity.KindProjectLocation, ProjectSyncID: "proj-1",
				AgentredFingerprint: "fp-b", Payload: mustJSON(t, map[string]any{"path": "/repo/y"})},
		}, nil).AnyTimes()
	mSummary.EXPECT().CountSummaries(ctx, agent_session_repo.SummaryQuery{UserID: 7}).Return(int64(10), nil)
	mSummary.EXPECT().CountSummariesByProjectKey(ctx, agent_session_repo.SummaryQuery{UserID: 7}).Return(
		[]agent_session_repo.SummaryProjectKeyCount{
			{SummaryProjectKey: agent_session_repo.SummaryProjectKey{PeerFingerprint: "fp-a", Cwd: "/repo/x"}, Total: 4},
			{SummaryProjectKey: agent_session_repo.SummaryProjectKey{PeerFingerprint: "fp-b", Cwd: "/repo/y"}, Total: 3},
			{SummaryProjectKey: agent_session_repo.SummaryProjectKey{PeerFingerprint: "fp-c", Cwd: "/elsewhere"}, Total: 3},
		}, nil)
	mSummary.EXPECT().ListSummariesPage(ctx, gomock.Any()).
		Return([]*agent_session_entity.SessionSummary{}, nil).AnyTimes()

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisProject})
	require.NoError(t, err)
	byScope := map[string]int64{}
	for _, g := range page.Groups {
		byScope[g.Scope] = g.Total
	}
	assert.Equal(t, int64(7), byScope["project:proj-1"], "同一个项目的两处位置要合到一起")
	assert.Equal(t, int64(3), byScope["unassigned-project"])
}

// 带 scope 时只翻那一组：判据里带上这一组的身份，多取一条用来判 HasMore，游标是
// 这一页最后一行的 (updated_at, id)。
func TestSessionIndex_ScopedRead_PagesOnlyThatGroup(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	fp := "fp-a"
	mSummary.EXPECT().CountSummaries(ctx, agent_session_repo.SummaryQuery{
		UserID: 7, PeerFingerprint: &fp,
	}).Return(int64(9), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: agent_session_repo.SummaryQuery{UserID: 7, PeerFingerprint: &fp},
		Cursor:       agent_session_repo.SummaryCursor{LastMessageAt: 1800, ID: 50},
		Limit:        3,
	}).Return([]*agent_session_entity.SessionSummary{
		{PeerFingerprint: "fp-a", PeerSessionID: "1", LastMessageAt: 1700, ID: 42},
		{PeerFingerprint: "fp-a", PeerSessionID: "2", LastMessageAt: 1600, ID: 41},
		{PeerFingerprint: "fp-a", PeerSessionID: "3", LastMessageAt: 1500, ID: 40},
	}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{
		UserID: 7, Axis: AxisMachine, Scope: "machine:fp-a", Cursor: "1800.50", Limit: 2,
	})
	require.NoError(t, err)
	assert.Empty(t, page.Groups, "带 scope 时给的是这一组的行,不是整个轴的骨架")
	require.Len(t, page.Items, 2, "多取的那一条只用来判 HasMore,不发给调用方")
	assert.True(t, page.HasMore)
	assert.Equal(t, "1600.41", page.Cursor, "游标是本页最后一行的复合位置")
	assert.Equal(t, int64(9), page.Total)
}

// 空页上游标原样退回调用方送来的位置，不回退到起点——回退会让调用方把整组从头翻一遍。
func TestSessionIndex_EmptyPage_KeepsTheIncomingCursor(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	mSummary.EXPECT().CountSummaries(ctx, gomock.Any()).Return(int64(9), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, gomock.Any()).
		Return([]*agent_session_entity.SessionSummary{}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{
		UserID: 7, Axis: AxisMachine, Scope: "machine:fp-a", Cursor: "1800.50",
	})
	require.NoError(t, err)
	assert.Equal(t, "1800.50", page.Cursor)
	assert.False(t, page.HasMore)
}

// limit / per_group 不填走默认档、超上限就地夹住——调用方要不到一页一万条。
func TestSessionIndex_ClampsLimitAndPerGroup(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	mSummary.EXPECT().CountSummaries(ctx, gomock.Any()).Return(int64(0), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: agent_session_repo.SummaryQuery{UserID: 7}, Limit: maxIndexLimit + 1,
	}).Return(nil, nil)

	_, err := svc.SessionIndex(ctx, SessionIndexQuery{
		UserID: 7, Axis: AxisTime, Scope: "time", Limit: 100000,
	})
	require.NoError(t, err)
}

// 搜索与筛选是**范围**：它们必须同时进到计数与翻页的判据里，否则「这一组显示 N 条,
// 翻出来却是另一批」。搜索只按标题（决策 8）。
func TestSessionIndex_SearchAndFilterReachBothCountAndPage(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	want := agent_session_repo.SummaryQuery{
		UserID: 7, TitleLike: "登录", Lifecycle: agent_session_repo.LifecycleWaiting,
	}
	mSummary.EXPECT().CountSummaries(ctx, want).Return(int64(2), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: want, Limit: 31,
	}).Return(nil, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{
		UserID: 7, Axis: AxisTime, Search: "登录", Filter: SessionFilterWaiting,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), page.Total)
}

// 按会话号精确认领（决策 13）：它要的不是一页，因此不分组、不限条数，同号多条时如实
// 全给——由调用方去判「是不是只有一条」。
func TestSessionIndex_SessionIDLookup_IgnoresGroupingAndPaging(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: agent_session_repo.SummaryQuery{UserID: 7, PeerSessionID: "42"},
	}).Return([]*agent_session_entity.SessionSummary{
		{PeerFingerprint: "fp-a", PeerSessionID: "42"},
		{PeerFingerprint: "fp-b", PeerSessionID: "42"},
	}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, SessionID: "42"})
	require.NoError(t, err)
	assert.Empty(t, page.Groups)
	require.Len(t, page.Items, 2)
	assert.False(t, page.HasMore)
}

// 「未归项目」那一组是**不落在任何已知项目位置**上的那些。名单取自账号项目树的全部
// 位置，不是这一批摘要里出现过的那些——后者会把「有位置但这次没会话」的项目漏掉，
// 让本该未归的行混进来。
func TestSessionIndex_UnassignedProjectScope_NegatesEveryKnownLocation(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-1"},
			{Kind: sync_entity.KindProjectLocation, ProjectSyncID: "proj-1",
				AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/repo/x"})},
		}, nil).AnyTimes()
	want := agent_session_repo.SummaryQuery{
		UserID:      7,
		ProjectMode: agent_session_repo.ProjectUnassigned,
		Locations:   []agent_session_repo.SummaryLocation{{PeerFingerprint: "fp-a", Cwd: "/repo/x"}},
	}
	mSummary.EXPECT().CountSummaries(ctx, want).Return(int64(3), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: want, Limit: defaultIndexLimit + 1,
	}).Return(nil, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{
		UserID: 7, Axis: AxisProject, Scope: "unassigned-project",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(3), page.Total)
}

// 认不出来的 scope 与游标是调用方的错，不是「当成没传」——静默忽略会把用户要的那一组
// 悄悄换成整个账号。
func TestSessionIndex_RejectsUnknownScopeAndMalformedCursor(t *testing.T) {
	ctx, _, _, _, svc := setupMirrorReadTest(t)

	_, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisAgent, Scope: "banana:1"})
	require.Error(t, err)

	_, err = svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisTime, Scope: "time", Cursor: "不是游标"})
	require.Error(t, err)
}

// scope 必须属于当前的轴：machine 的组配 agent 轴是调用方拼错了 URL，如实报错，
// 而不是给出一份「看起来对」的别的答案。
func TestSessionIndex_RejectsScopeFromAnotherAxis(t *testing.T) {
	ctx, _, _, _, svc := setupMirrorReadTest(t)

	_, err := svc.SessionIndex(ctx, SessionIndexQuery{
		UserID: 7, Axis: AxisAgent, Scope: "machine:fp-a",
	})
	require.Error(t, err)
}

// 行上的项目归属仍然就地判定（决策 12），并且 cwd 一路只参与比较：View 上根本没有
// 能装它的字段（R19，由 internal/api/workspace 的反射守卫在响应根上再守一道）。
func TestSessionIndex_RowsCarryProjectAttributionWithoutCwd(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-1"},
			{Kind: sync_entity.KindProjectLocation, ProjectSyncID: "proj-1",
				AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/repo/x"})},
		}, nil).AnyTimes()
	mSummary.EXPECT().CountSummaries(ctx, gomock.Any()).Return(int64(1), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, gomock.Any()).Return([]*agent_session_entity.SessionSummary{
		{PeerFingerprint: "fp-a", PeerSessionID: "1", Cwd: "/repo/x", Title: "t"},
	}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisTime, Scope: "time"})
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Equal(t, "proj-1", page.Items[0].ProjectSyncID)
}

// 一次索引读取只查一遍项目位置表。轴骨架把一次请求摊成「每组各取几条」，而每组的
// 每一行都要判项目归属——这份名单在一次请求里不会变，逐组各查一遍等于把同一份数据
// 查上几十遍（账号里有几十台机器 / 几十个项目时就是几十次），也与 projectLocations
// 自己写的「取一次用到底，不为同一次请求查两遍」自相矛盾。
func TestSessionIndex_AxisSkeleton_ReadsProjectLocationsOnce(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-1"},
			{Kind: sync_entity.KindProjectLocation, ProjectSyncID: "proj-1",
				AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/repo/x"})},
		}, nil).Times(1)
	mSummary.EXPECT().CountSummaries(ctx, gomock.Any()).Return(int64(3), nil)
	mSummary.EXPECT().CountSummariesByPeer(ctx, gomock.Any()).
		Return(map[string]int64{"fp-a": 1, "fp-b": 1, "fp-c": 1}, nil)
	mSummary.EXPECT().ListSummariesPage(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, q agent_session_repo.SummaryPageQuery) ([]*agent_session_entity.SessionSummary, error) {
			return []*agent_session_entity.SessionSummary{
				{PeerFingerprint: *q.PeerFingerprint, PeerSessionID: "1", Cwd: "/repo/x"},
			}, nil
		}).Times(3)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisMachine})
	require.NoError(t, err)
	require.Len(t, page.Groups, 3)
	// 名单只查一遍，但每一组的行仍然各判各的归属——省掉的是重复查询，不是判定。
	byScope := map[string]SessionIndexGroup{}
	for _, g := range page.Groups {
		require.Len(t, g.Items, 1)
		byScope[g.Scope] = g
	}
	assert.Equal(t, "proj-1", byScope["machine:fp-a"].Items[0].ProjectSyncID)
	assert.Empty(t, byScope["machine:fp-b"].Items[0].ProjectSyncID,
		"同一个路径在另一台机器上是另一个地方，位置的键是 (指纹, cwd) 这个对")
}

// ── 对端自己说出来的项目归属（桌面端） ─────────────────────────────────────

// 桌面端在会话清单里直接点名这条对话属于哪个项目，服务端就用它，不再去比路径。
//
// 拿 (指纹, cwd) 比 agentred 项目路径的那条老路（决策 12）在桌面端上恒判不出结果：
// 桌面端根本没有「这条会话的 cwd」这一列可报（工作目录是每轮按项目本机路径现算的），
// 而且它的本机路径存在另一张表（device_local_paths）里、压根不在这份名单中。两头
// 都对不上，于是它的每一条对话都掉进「随手对话」——这条测试盯的就是那个缺口。
func TestSessionIndex_RowReportedByDesktop_UsesTheProjectItNamed(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-1"},
		}, nil).AnyTimes()
	mSummary.EXPECT().CountSummaries(ctx, gomock.Any()).Return(int64(1), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, gomock.Any()).Return([]*agent_session_entity.SessionSummary{
		{PeerFingerprint: "fp-desktop", PeerSessionID: "1", ProjectSyncID: "proj-1", Title: "t"},
	}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisTime, Scope: "time"})
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Equal(t, "proj-1", page.Items[0].ProjectSyncID,
		"对端点了名，服务端不该再去猜一个别的答案")
}

// 项目被删之后，指着它的那些对话落回「随手对话」——决策 13 明写「删项目一条对话都
// 不删，它们回到未归项目组」。存下来的那个标识不能凭自己就把一个已经不存在的项目
// 变回来：那样索引上会长出一个只有标识、没有名字的幽灵组。
func TestSessionIndex_ReportedProjectThatNoLongerExists_FallsBackToUnassigned(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	// 名单里没有 proj-gone：它已经被删了（墓碑不进 ListByKinds）。
	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).
		Return([]*sync_entity.SyncObject{}, nil).AnyTimes()
	mSummary.EXPECT().CountSummaries(ctx, gomock.Any()).Return(int64(1), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, gomock.Any()).Return([]*agent_session_entity.SessionSummary{
		{PeerFingerprint: "fp-desktop", PeerSessionID: "1", ProjectSyncID: "proj-gone", Title: "t"},
	}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisTime, Scope: "time"})
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Empty(t, page.Items[0].ProjectSyncID)
}

// agentred 那条路一步没变：它不报项目，服务端照旧拿 (指纹, cwd) 去比项目路径。
// 两种判法在同一次读取里共存，不是后者替掉前者。
func TestSessionIndex_RowFromAgentred_StillResolvedByLocation(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-1"},
			{Kind: sync_entity.KindProjectLocation, ProjectSyncID: "proj-1",
				AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/repo/x"})},
		}, nil).AnyTimes()
	mSummary.EXPECT().CountSummaries(ctx, gomock.Any()).Return(int64(1), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, gomock.Any()).Return([]*agent_session_entity.SessionSummary{
		{PeerFingerprint: "fp-a", PeerSessionID: "1", Cwd: "/repo/x", Title: "t"},
	}, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisTime, Scope: "time"})
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Equal(t, "proj-1", page.Items[0].ProjectSyncID)
}

// 组骨架上的数也要认这一维：SQL 数得出「报了项目的按项目、没报的按位置」这两拨，
// 折算成项目是服务层的事。数不对的话，组头上的「查看全部 N」与真的翻出来的行对不上。
func TestSessionIndex_ProjectAxis_CountsReportedProjectsAlongsideLocations(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-1"},
			{Kind: sync_entity.KindProjectLocation, ProjectSyncID: "proj-1",
				AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/repo/x"})},
		}, nil).AnyTimes()
	mSummary.EXPECT().CountSummaries(ctx, agent_session_repo.SummaryQuery{UserID: 7}).Return(int64(9), nil)
	mSummary.EXPECT().CountSummariesByProjectKey(ctx, agent_session_repo.SummaryQuery{UserID: 7}).Return(
		[]agent_session_repo.SummaryProjectKeyCount{
			// agentred：没报项目，位置配得上 proj-1。
			{SummaryProjectKey: agent_session_repo.SummaryProjectKey{
				PeerFingerprint: "fp-a", Cwd: "/repo/x"}, Total: 4},
			// 桌面端：报了 proj-1，没有 cwd。
			{SummaryProjectKey: agent_session_repo.SummaryProjectKey{
				PeerFingerprint: "fp-desktop", ProjectSyncID: "proj-1"}, Total: 3},
			// 哪一头都对不上。
			{SummaryProjectKey: agent_session_repo.SummaryProjectKey{
				PeerFingerprint: "fp-c", Cwd: "/elsewhere"}, Total: 2},
		}, nil)
	mSummary.EXPECT().ListSummariesPage(ctx, gomock.Any()).
		Return([]*agent_session_entity.SessionSummary{}, nil).AnyTimes()

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{UserID: 7, Axis: AxisProject})
	require.NoError(t, err)
	byScope := map[string]int64{}
	for _, g := range page.Groups {
		byScope[g.Scope] = g.Total
	}
	assert.Equal(t, int64(7), byScope["project:proj-1"], "两种判法数出来的要合到同一组")
	assert.Equal(t, int64(2), byScope["unassigned-project"])
}

// 翻某个项目那一组时，判据要把两拨都圈进来：报了这个项目的，加上没报项目、但位置
// 落在这个项目名下的。少一半就等于这一组翻到一半没了——而组头上的 N 数的是全部。
func TestSessionIndex_ProjectScope_AsksForBothReportedAndLocated(t *testing.T) {
	ctx, mSummary, _, mObj, svc := setupMirrorReadTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), projectAffinityKinds).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-1"},
			{Kind: sync_entity.KindProjectLocation, ProjectSyncID: "proj-1",
				AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/repo/x"})},
		}, nil).AnyTimes()
	want := agent_session_repo.SummaryQuery{
		UserID:        7,
		ProjectMode:   agent_session_repo.ProjectIs,
		ProjectSyncID: "proj-1",
		Locations:     []agent_session_repo.SummaryLocation{{PeerFingerprint: "fp-a", Cwd: "/repo/x"}},
	}
	mSummary.EXPECT().CountSummaries(ctx, want).Return(int64(7), nil)
	mSummary.EXPECT().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: want, Limit: defaultIndexLimit + 1,
	}).Return(nil, nil)

	page, err := svc.SessionIndex(ctx, SessionIndexQuery{
		UserID: 7, Axis: AxisProject, Scope: "project:proj-1",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(7), page.Total)
}

// TestWaitingCount_AsksTheDatabaseToCountRatherThanFetching 覆盖侧栏「对话」那颗角标
// 的取数：它要的只是一个数字。
//
// 判据与索引上「等你处理」那个 chip 是**同一个**（LifecycleWaiting），这一点必须由
// 仓储判据本身保证而不是靠两处各写一遍：侧栏说有 3 条等你，点进去筛选却是 2 条，是
// 一种没有任何地方会报错、而用户一眼就能看见的错。
//
// 走 CountSummaries 而不是拉一页回来数长度：这条路在每一次进入任何页面时都会跑一遍，
// 而拉回来的那些标题、转录游标、项目归属，一个都不会被用到。
func TestWaitingCount_AsksTheDatabaseToCountRatherThanFetching(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	mSummary.EXPECT().CountSummaries(ctx, agent_session_repo.SummaryQuery{
		UserID: 7, Lifecycle: agent_session_repo.LifecycleWaiting,
	}).Return(int64(3), nil)

	got, err := svc.WaitingCount(ctx, 7)

	require.NoError(t, err)
	assert.Equal(t, int64(3), got)
}

// TestWaitingCount_NothingWaitingIsZeroNotAnError 守空账号：0 是一个答案。
// 侧栏那颗角标只在 > 0 时才画（ConsoleNavItem），所以 0 会让它整个不出现 —— 那正是
// 对的，而一次失败会让调用方分不清「没人等你」和「问不出来」。
func TestWaitingCount_NothingWaitingIsZeroNotAnError(t *testing.T) {
	ctx, mSummary, _, _, svc := setupMirrorReadTest(t)

	mSummary.EXPECT().CountSummaries(ctx, gomock.Any()).Return(int64(0), nil)

	got, err := svc.WaitingCount(ctx, 7)

	require.NoError(t, err)
	assert.Zero(t, got)
}
