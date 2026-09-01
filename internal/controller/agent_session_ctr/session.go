// Package agent_session_ctr 是账号里 agent 会话那几个端点的控制器：取调用方账号、转 service
// 入参、把视图对象转回响应结构，不做任何判定。业务逻辑（含项目归属就地判定，
// 决策 12）全在 workspace_svc——本包只搬数据。
package agent_session_ctr

import (
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/agentsession"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

type AgentSession struct{}

func New() *AgentSession { return &AgentSession{} }

// savedSessionItems 把服务层的视图搬成响应项。cwd 在视图上就没有字段，这里因此
// 想漏也漏不出去（R19）。
func savedSessionItems(views []workspace_svc.SavedSessionSummaryView) []api.SavedSessionItem {
	items := make([]api.SavedSessionItem, 0, len(views))
	for _, it := range views {
		items = append(items, api.SavedSessionItem{
			ConversationID:     it.ConversationID,
			PeerFingerprint:    it.PeerFingerprint,
			MachineFingerprint: it.MachineFingerprint,
			Title:              it.Title,
			AgentSyncID:        it.AgentSyncID,
			ProjectSyncID:      it.ProjectSyncID,
			BackendType:        it.BackendType,
			LifecycleState:     it.LifecycleState,
			WaitingForInput:    it.WaitingForInput,
			LastMessageAt:      it.LastMessageAt,
			LastReadAt:         it.LastReadAt,
			ProviderKey:        it.ProviderKey,
			ModelKey:           it.ModelKey,
		})
	}
	return items
}

// MarkSessionRead 记下「这个账号此刻读到这条对话为止」。时刻由服务端取，请求体里
// 没有它 —— 客户端的钟不可信，而这个时刻要跟服务端自己记的 updated_at 相比。
func (m *AgentSession) MarkSessionRead(
	c *gin.Context, req *api.MarkSessionReadRequest,
) (*api.MarkSessionReadResponse, error) {
	at, err := workspace_svc.SessionRead().MarkSessionRead(
		c.Request.Context(), ginctx.UserID(c), req.ConversationID,
	)
	if err != nil {
		return nil, err
	}
	return &api.MarkSessionReadResponse{LastReadAt: at}, nil
}

// SavedSessions 是 web 会话索引的主数据源：不带 scope 时给该轴全部组的骨架，
// 带 scope 时按游标翻那一组（2026-08-19-session-index-pagination.md）。
//
// Axis 不填按时间轴：那是「一个平铺组、按最后活动时间倒序」，也是没有偏好时最不会
// 出错的一档。其余入参一律原样转给服务层，判定（夹取、scope 认不认得、游标合不合法）
// 全在那边——本包不做判定。
func (m *AgentSession) SavedSessions(c *gin.Context, req *api.SavedSessionsRequest) (*api.SavedSessionsResponse, error) {
	axis := workspace_svc.SessionIndexAxis(req.Axis)
	if axis == "" {
		axis = workspace_svc.AxisTime
	}
	filter := workspace_svc.SessionFilter(req.Filter)
	if filter == "all" {
		filter = workspace_svc.SessionFilterAll
	}
	page, err := workspace_svc.SessionRead().SessionIndex(c.Request.Context(), workspace_svc.SessionIndexQuery{
		UserID:         ginctx.UserID(c),
		Axis:           axis,
		Scope:          req.Scope,
		Search:         req.Q,
		Filter:         filter,
		ConversationID: req.ConversationID,
		Cursor:         req.Cursor,
		Limit:          req.Limit,
		PerGroup:       req.PerGroup,
	})
	if err != nil {
		return nil, err
	}
	resp := &api.SavedSessionsResponse{
		Cursor:  page.Cursor,
		HasMore: page.HasMore,
		Total:   page.Total,
	}
	if page.Groups != nil {
		resp.Groups = make([]api.SavedSessionGroup, 0, len(page.Groups))
		for _, g := range page.Groups {
			resp.Groups = append(resp.Groups, api.SavedSessionGroup{
				Scope:   g.Scope,
				Total:   g.Total,
				Items:   savedSessionItems(g.Items),
				Cursor:  g.Cursor,
				HasMore: g.HasMore,
			})
		}
		return resp, nil
	}
	resp.Items = savedSessionItems(page.Items)
	return resp, nil
}

// directionBackward 是反向读那个方向的取值（api 层已用 oneof 校验过取值范围）。
const directionBackward = "backward"

// Transcript 翻一条对话镜像里的帧，供详情页与中继实时流按 seq 拼接。
// 缺省正向（从游标往后），direction=backward 时从最新往回按预算取一页。
func (m *AgentSession) Transcript(c *gin.Context, req *api.TranscriptRequest) (*api.TranscriptResponse, error) {
	// Cursor 在两个方向上是两件事：正向是「我读到哪了」（不含），反向是「比这个更早」
	// （不含）。所以按方向送进不同的入参，而不是让服务层去猜调用方的意思。
	q := workspace_svc.TranscriptQuery{
		UserID:         ginctx.UserID(c),
		ConversationID: req.ConversationID,
		Limit:          req.Limit,
	}
	if req.Direction == directionBackward {
		q.Backward = true
		q.BeforeSeq = req.Cursor
	} else {
		q.AfterSeq = req.Cursor
	}
	page, err := workspace_svc.SessionRead().Transcript(c.Request.Context(), q)
	if err != nil {
		return nil, err
	}
	resp := &api.TranscriptResponse{
		Frames:    make([]api.TranscriptFrameItem, 0, len(page.Frames)),
		Cursor:    page.Cursor,
		HasMore:   page.HasMore,
		OldestSeq: page.OldestSeq,
		HasBefore: page.HasBefore,
	}
	for _, f := range page.Frames {
		resp.Frames = append(resp.Frames, api.TranscriptFrameItem{Seq: f.Seq, Method: f.Method, Params: f.Params})
	}
	return resp, nil
}

// WaitingCount 交出账号里此刻等你处理的对话条数，供侧栏那颗角标用。
//
// 判据不在这里：它与索引上「等你处理」那个 chip 共用仓储那一侧同一个
// LifecycleWaiting（workspace_svc.WaitingCount 的注释）。侧栏说有 3 条等你、点进去
// 筛选却是 2 条，是一种没有任何地方会报错、而用户一眼就能看见的错。
func (m *AgentSession) WaitingCount(
	c *gin.Context, _ *api.WaitingCountRequest,
) (*api.WaitingCountResponse, error) {
	n, err := workspace_svc.SessionRead().WaitingCount(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	return &api.WaitingCountResponse{Waiting: n}, nil
}
