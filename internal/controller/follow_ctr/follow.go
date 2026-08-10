// Package follow_ctr 是账号级关注名单端点的控制器层（R12 后端 / R14）：
// 取调用方账号、转成 service 入参、把视图对象转回响应结构，不做任何判定。
//
// 端点归账号：user_id 一律取自鉴权中间件（会话 / 设备 JWT），不由请求体提供。
package follow_ctr

import (
	"net/http"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	api "agentre-server/internal/api/follow"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/service/follow_svc"
)

type Follow struct{}

func New() *Follow { return &Follow{} }

func callerUserID(c *gin.Context) int64 {
	uid, _ := c.Get("user_id")
	userID, _ := uid.(int64)
	return userID
}

// Follow 关注一条会话（R12）。幂等；账号取自上下文。
func (f *Follow) Follow(c *gin.Context, req *api.FollowRequest) (*api.FollowResponse, error) {
	userID := callerUserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(c.Request.Context(), http.StatusUnauthorized, code.Unauthorized)
	}
	if err := follow_svc.Default().Follow(c.Request.Context(), follow_svc.FollowInput{
		UserID:            userID,
		DeviceFingerprint: req.DeviceFingerprint,
		SessionID:         req.SessionID,
	}); err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.FollowResponse{}, nil
}

// Unfollow 取消关注（R12）。幂等；只去掉这一条。
func (f *Follow) Unfollow(c *gin.Context, req *api.UnfollowRequest) (*api.UnfollowResponse, error) {
	userID := callerUserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(c.Request.Context(), http.StatusUnauthorized, code.Unauthorized)
	}
	if err := follow_svc.Default().Unfollow(c.Request.Context(), follow_svc.FollowInput{
		UserID:            userID,
		DeviceFingerprint: req.DeviceFingerprint,
		SessionID:         req.SessionID,
	}); err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.UnfollowResponse{}, nil
}

// List 返回账号全部关注（R14：任一端读到同一份）。
func (f *Follow) List(c *gin.Context, _ *api.ListFollowsRequest) (*api.ListFollowsResponse, error) {
	items, err := follow_svc.Default().List(c.Request.Context(), callerUserID(c))
	if err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	resp := &api.ListFollowsResponse{Items: make([]api.FollowItem, 0, len(items))}
	for _, it := range items {
		resp.Items = append(resp.Items, api.FollowItem{
			DeviceFingerprint: it.DeviceFingerprint,
			SessionID:         it.SessionID,
			FollowedAt:        it.FollowedAt,
			Invalid:           it.Invalid,
		})
	}
	return resp, nil
}
