// Package saved_session_ctr 是「账号里保存的对话」这一族端点的控制器层：取调用方账号、
// 转成 service 入参、把结果转回响应结构，不做任何判定。
//
// 端点归账号：user_id 一律取自鉴权中间件（会话 / 设备 JWT），不由请求体提供。
package saved_session_ctr

import (
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/savedsession"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/saved_session_svc"
)

type Follow struct{}

func New() *Follow { return &Follow{} }

// Save 把一条对话收进账号（幂等）；镜像随即开始。账号取自上下文。
func (f *Follow) Save(c *gin.Context, req *api.SaveSessionRequest) (*api.SaveSessionResponse, error) {
	userID, err := ginctx.RequireUserID(c)
	if err != nil {
		return nil, err
	}
	if err := saved_session_svc.Default().Save(c.Request.Context(), saved_session_svc.SessionRef{
		UserID:             userID,
		MachineFingerprint: req.DeviceFingerprint,
		PeerFingerprint:    req.PeerFingerprint,
		ConversationID:     req.ConversationID,
	}); err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.SaveSessionResponse{}, nil
}

// Delete 删掉账号里的这条对话，并让执行端也删（幂等）。应答如实交代执行端那一份的
// 去向——server 那一份在成功返回时一定已经没了。
func (f *Follow) Delete(c *gin.Context, req *api.DeleteSessionRequest) (*api.DeleteSessionResponse, error) {
	userID, err := ginctx.RequireUserID(c)
	if err != nil {
		return nil, err
	}
	// 承载它的机器默认由 service 按身份从账号里查；请求体的 machine_fingerprint 只在
	// 没有索引行时由 service 采信。调用设备（设备 JWT）一并交下去，好让它不被回头通知。
	outcome, err := saved_session_svc.Default().Delete(c.Request.Context(), saved_session_svc.SessionRef{
		UserID:             userID,
		ConversationID:     req.ConversationID,
		MachineFingerprint: req.MachineFingerprint,
		CallerDeviceID:     ginctx.DeviceID(c),
	})
	if err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.DeleteSessionResponse{MachineStatus: string(outcome)}, nil
}

// CleanupPreview 数出账号已保存的对话里符合条件、可清理的那一批（只读）。
func (f *Follow) CleanupPreview(c *gin.Context, req *api.CleanupPreviewRequest) (*api.CleanupPreviewResponse, error) {
	userID, err := ginctx.RequireUserID(c)
	if err != nil {
		return nil, err
	}
	p, err := saved_session_svc.Default().PreviewCleanup(c.Request.Context(), userID, saved_session_svc.CleanupFilter{
		BeforeMs: req.BeforeMs, AgentSyncID: req.AgentSyncID, ProjectSyncID: req.ProjectSyncID,
	})
	if err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	machines := make([]api.CleanupMachineView, 0, len(p.Machines))
	for _, m := range p.Machines {
		machines = append(machines, api.CleanupMachineView{
			Fingerprint: m.Fingerprint, Name: m.Name, Online: m.Online, Count: m.Count,
		})
	}
	ids := p.ConversationIDs
	if ids == nil {
		ids = []string{}
	}
	return &api.CleanupPreviewResponse{
		Count: p.Count, Retained: p.Retained, Machines: machines, ConversationIDs: ids,
	}, nil
}

// Cleanup 逐条重新判断后删除预览给出的那一批；调用设备（设备 JWT）一并交下去。
func (f *Follow) Cleanup(c *gin.Context, req *api.CleanupRequest) (*api.CleanupResponse, error) {
	userID, err := ginctx.RequireUserID(c)
	if err != nil {
		return nil, err
	}
	r, err := saved_session_svc.Default().Cleanup(c.Request.Context(), userID, ginctx.DeviceID(c), req.ConversationIDs)
	if err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	failed := make([]api.CleanupFailureView, 0, len(r.Failed))
	for _, x := range r.Failed {
		failed = append(failed, api.CleanupFailureView{ConversationID: x.ConversationID, Reason: x.Reason})
	}
	pending := make([]api.CleanupPendingView, 0, len(r.Pending))
	for _, x := range r.Pending {
		pending = append(pending, api.CleanupPendingView{Fingerprint: x.Fingerprint, Name: x.Name, Count: x.Count})
	}
	return &api.CleanupResponse{Deleted: r.Deleted, Retained: r.Retained, Failed: failed, Pending: pending}, nil
}
