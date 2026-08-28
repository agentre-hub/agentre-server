// Package saved_session_ctr 是「账号里保存的对话」这一族端点的控制器层：取调用方账号、
// 转成 service 入参、把结果转回响应结构，不做任何判定。
//
// 端点归账号：user_id 一律取自鉴权中间件（会话 / 设备 JWT），不由请求体提供。
package saved_session_ctr

import (
	"net/http"

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
	userID := ginctx.UserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(c.Request.Context(), http.StatusUnauthorized, code.Unauthorized)
	}
	if err := saved_session_svc.Default().Save(c.Request.Context(), saved_session_svc.SessionRef{
		UserID:             userID,
		MachineFingerprint: req.MachineFingerprint,
		PeerFingerprint:    req.PeerFingerprint,
		SessionID:          req.SessionID,
	}); err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.SaveSessionResponse{}, nil
}

// Delete 删掉账号里的这条对话，并让执行端也删（幂等）。应答如实交代执行端那一份的
// 去向——server 那一份在成功返回时一定已经没了。
func (f *Follow) Delete(c *gin.Context, req *api.DeleteSessionRequest) (*api.DeleteSessionResponse, error) {
	userID := ginctx.UserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(c.Request.Context(), http.StatusUnauthorized, code.Unauthorized)
	}
	// 承载它的机器不由请求体提供：service 按身份从账号里查出来。
	outcome, err := saved_session_svc.Default().Delete(c.Request.Context(), saved_session_svc.SessionRef{
		UserID:          userID,
		PeerFingerprint: req.PeerFingerprint,
		SessionID:       req.SessionID,
	})
	if err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.DeleteSessionResponse{PeerStatus: string(outcome)}, nil
}

// List 返回账号里已保存的全部对话（R14：任一端读到同一份）。
func (f *Follow) List(c *gin.Context, _ *api.ListSavedSessionsRequest) (*api.ListSavedSessionsResponse, error) {
	items, err := saved_session_svc.Default().List(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	resp := &api.ListSavedSessionsResponse{Items: make([]api.SavedSessionRef, 0, len(items))}
	for _, it := range items {
		resp.Items = append(resp.Items, api.SavedSessionRef{
			DeviceFingerprint: it.DeviceFingerprint,
			SessionID:         it.SessionID,
			FollowedAt:        it.FollowedAt,
			Invalid:           it.Invalid,
		})
	}
	return resp, nil
}
