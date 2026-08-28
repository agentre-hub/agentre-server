// Package sessionimport_ctr 是「导入本地会话」三个端点的控制器层：取调用方账号、
// 转成 service 入参、把视图对象转回响应结构，不做任何判定。
package sessionimport_ctr

import (
	"strings"

	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/sessionimport"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/sessionimport_svc"
)

type SessionImport struct{}

func New() *SessionImport { return &SessionImport{} }

// Candidates 列一台机器上可导的本地会话。**答不出的那几档不是错误**：它们随清单
// 一起以结构化的一档回去（见 api.ScanIssueItem）。
func (s *SessionImport) Candidates(
	c *gin.Context, req *api.CandidatesRequest,
) (*api.CandidatesResponse, error) {
	view, err := sessionimport_svc.Default().ListCandidates(c.Request.Context(),
		sessionimport_svc.ListCandidatesInput{
			UserID: ginctx.UserID(c), DeviceID: req.DeviceID,
			Backends:  splitBackends(req.Backends),
			CwdPrefix: req.CwdPrefix, TitleQuery: req.TitleQuery, Limit: req.Limit,
		})
	if err != nil {
		return nil, err
	}
	resp := &api.CandidatesResponse{
		Candidates: make([]api.CandidateItem, 0, len(view.Candidates)),
		Issues:     make([]api.ScanIssueItem, 0, len(view.Issues)),
	}
	for _, candidate := range view.Candidates {
		resp.Candidates = append(resp.Candidates, api.CandidateItem{
			Backend: candidate.Backend, ProviderSessionID: candidate.ProviderSessionID,
			Title: candidate.Title, Cwd: candidate.Cwd, StartedAt: candidate.StartedAt,
			EndedAt: candidate.EndedAt, Turns: candidate.Turns, Origin: candidate.Origin,
			Locator: candidate.Locator, Imported: candidate.Imported,
			ImportedSessionID: candidate.ImportedSessionID,
		})
	}
	for _, issue := range view.Issues {
		resp.Issues = append(resp.Issues, api.ScanIssueItem{
			Backend: issue.Backend, Status: issue.Status, Reason: issue.Reason,
		})
	}
	return resp, nil
}

// Preview 打开一条候选：元信息 + 缺口 + 前几轮真实转录。
func (s *SessionImport) Preview(c *gin.Context, req *api.PreviewRequest) (*api.PreviewResponse, error) {
	view, err := sessionimport_svc.Default().Preview(c.Request.Context(),
		sessionimport_svc.PreviewInput{
			UserID: ginctx.UserID(c), DeviceID: req.DeviceID,
			Backend: req.Backend, Locator: req.Locator, Turns: req.Turns,
		})
	if err != nil {
		return nil, err
	}
	resp := &api.PreviewResponse{
		Meta:           metaItem(view.Meta),
		Frames:         make([]api.TranscriptFrameItem, 0, len(view.Frames)),
		PreviewedTurns: view.PreviewedTurns,
		RemainingTurns: view.RemainingTurns,
	}
	for _, frame := range view.Frames {
		resp.Frames = append(resp.Frames, api.TranscriptFrameItem{
			Seq: frame.Seq, Method: frame.Method, Params: frame.Params,
		})
	}
	return resp, nil
}

// Run 让那台机器执行一次导入，并把导出来的会话收进账号。
func (s *SessionImport) Run(c *gin.Context, req *api.RunRequest) (*api.RunResponse, error) {
	view, err := sessionimport_svc.Default().Import(c.Request.Context(),
		sessionimport_svc.ImportInput{
			UserID: ginctx.UserID(c), DeviceID: req.DeviceID,
			Backend: req.Backend, Locator: req.Locator,
			SessionID: req.SessionID, AgentSyncID: req.AgentSyncID,
		})
	if err != nil {
		return nil, err
	}
	return &api.RunResponse{
		SessionID: view.SessionID, PeerFingerprint: view.PeerFingerprint,
		Cwd: view.Cwd, Title: view.Title, ProviderSessionID: view.ProviderSessionID,
		ImportedTurns: view.ImportedTurns, AlreadyImported: view.AlreadyImported,
	}, nil
}

func metaItem(meta sessionimport_svc.MetaView) api.TranscriptMetaItem {
	out := api.TranscriptMetaItem{
		Backend: meta.Backend, ProviderSessionID: meta.ProviderSessionID,
		Title: meta.Title, Cwd: meta.Cwd, Model: meta.Model, Turns: meta.Turns,
		ToolCalls: meta.ToolCalls, Compactions: meta.Compactions,
		StartedAt: meta.StartedAt, EndedAt: meta.EndedAt, Origin: meta.Origin,
		Gaps:     make([]api.GapItem, 0, len(meta.Gaps)),
		Imported: meta.Imported, ImportedSessionID: meta.ImportedSessionID,
	}
	for _, gap := range meta.Gaps {
		out.Gaps = append(out.Gaps, api.GapItem{Kind: gap.Kind, Count: gap.Count, Detail: gap.Detail})
	}
	return out
}

// splitBackends 把逗号分隔的后端类型拆开。空串交回 nil = 「这台机器上注册的全部」，
// 而不是一个空档的清单。
func splitBackends(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
