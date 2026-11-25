// Package personal_token_ctr 实现 /v1/personal-tokens*（规格 2026-11-25-agrctl-account-peer
// 「个人 token 与范围」）。谁能管理 token 由 personal_token_svc 判，这里只搬运身份与映射形状。
package personal_token_ctr

import (
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/personaltoken"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/personal_token_svc"
)

type PersonalToken struct {
	// svc 留给测试注入；为 nil 时每次请求取 personal_token_svc.Default()。
	svc personal_token_svc.PersonalTokenSvc
}

func New(svc personal_token_svc.PersonalTokenSvc) *PersonalToken {
	return &PersonalToken{svc: svc}
}

func (h *PersonalToken) service() personal_token_svc.PersonalTokenSvc {
	if h.svc != nil {
		return h.svc
	}
	return personal_token_svc.Default()
}

// selfService 取查自己的实现：注入的 svc 同时实现了 SelfSvc 就用它，否则用默认实现。
func (h *PersonalToken) selfService() personal_token_svc.SelfSvc {
	if s, ok := h.svc.(personal_token_svc.SelfSvc); ok {
		return s
	}
	return personal_token_svc.DefaultSelf()
}

// caller 取鉴权中间件放进上下文的身份：浏览器会话没有设备号与设备形态。
func caller(c *gin.Context) (personal_token_svc.Caller, error) {
	userID, err := ginctx.RequireUserID(c)
	if err != nil {
		return personal_token_svc.Caller{}, err
	}
	return personal_token_svc.Caller{AccountID: userID, DeviceID: ginctx.DeviceID(c), Kind: ginctx.DeviceKind(c)}, nil
}

func (h *PersonalToken) Create(c *gin.Context, req *api.CreateRequest) (*api.IssueResponse, error) {
	who, err := caller(c)
	if err != nil {
		return nil, err
	}
	out, err := h.service().Create(c.Request.Context(), who, personal_token_svc.CreateInput{
		Name: req.Name, Scopes: req.Scopes,
		Lifetime: personal_token_svc.Lifetime{Seconds: req.ExpiresIn, Never: req.NoExpiry},
	})
	if err != nil {
		return nil, err
	}
	return &api.IssueResponse{Token: out.Token, Item: toToken(out.TokenView)}, nil
}

func (h *PersonalToken) List(c *gin.Context, _ *api.ListRequest) (*api.ListResponse, error) {
	who, err := caller(c)
	if err != nil {
		return nil, err
	}
	views, err := h.service().List(c.Request.Context(), who)
	if err != nil {
		return nil, err
	}
	items := make([]api.Token, 0, len(views))
	for _, view := range views {
		items = append(items, toToken(view))
	}
	return &api.ListResponse{Tokens: items}, nil
}

func (h *PersonalToken) Self(c *gin.Context, _ *api.SelfRequest) (*api.SelfResponse, error) {
	who, err := caller(c)
	if err != nil {
		return nil, err
	}
	// 只有「查自己」要认出是哪一枚凭据；管理接口不需要句柄。
	who.Handle = ginctx.CredentialHandle(c)
	view, err := h.selfService().Self(c.Request.Context(), who)
	if err != nil {
		return nil, err
	}
	return &api.SelfResponse{Item: toToken(view)}, nil
}

func (h *PersonalToken) Rotate(c *gin.Context, req *api.RotateRequest) (*api.IssueResponse, error) {
	who, err := caller(c)
	if err != nil {
		return nil, err
	}
	out, err := h.service().Rotate(c.Request.Context(), who, personal_token_svc.RotateInput{
		Name:     req.Name,
		Lifetime: personal_token_svc.Lifetime{Seconds: req.ExpiresIn, Never: req.NoExpiry},
	})
	if err != nil {
		return nil, err
	}
	return &api.IssueResponse{Token: out.Token, Item: toToken(out.TokenView)}, nil
}

func (h *PersonalToken) Delete(c *gin.Context, req *api.DeleteRequest) (*api.DeleteResponse, error) {
	who, err := caller(c)
	if err != nil {
		return nil, err
	}
	if err := h.service().Delete(c.Request.Context(), who, req.Name); err != nil {
		return nil, err
	}
	return &api.DeleteResponse{}, nil
}

func toToken(view personal_token_svc.TokenView) api.Token {
	return api.Token{
		Name: view.Name, Scopes: view.Scopes, CreatedAt: view.Createtime, ExpiresAt: view.ExpiresAt,
		LastUsedAt: view.LastUsedAt, RotatedAt: view.RotatedAt,
		CreatedByDeviceID: view.CreatedByDeviceID, CreatedByDeviceName: view.CreatedByDeviceName,
	}
}
