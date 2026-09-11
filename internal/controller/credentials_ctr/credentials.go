// Package credentials_ctr 实现 POST /v1/credentials/introspect（规格
// 2026-09-11-opaque-credentials-auto-direct，S5）。
package credentials_ctr

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	api "github.com/agentre-hub/agentre-server/internal/api/credentials"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// Credentials 只有一个端点：核验调用方出示的**另一枚**令牌。
type Credentials struct {
	// resolver 认得 server 签发的全部 Bearer 凭据——设备 access token、中继票据、
	// server 自用凭据都可能是待核验的那一枚。生产上与 /v1/relay/client 用的是
	// 同一个 auth_svc.CredentialResolver（router.go 里的 relayBearer）。
	resolver auth_svc.BearerResolver
}

func New(resolver auth_svc.BearerResolver) *Credentials {
	return &Credentials{resolver: resolver}
}

// Introspect 核验请求体里的令牌：有效且与调用方同一账号才答出身份，其余一律
// CredentialInvalid——未知、过期、已撤销、跨账号刻意不区分，答复形状也完全相同，
// 不能让持有者或调用方从中分辨出到底是哪一种。令牌本身（调用方自己的与待核验的）
// 都不进日志。
func (h *Credentials) Introspect(c *gin.Context, req *api.IntrospectRequest) (*api.IntrospectResponse, error) {
	ctx := c.Request.Context()
	callerAccountID := ginctx.UserID(c)

	p, err := h.resolver.ResolveBearer(ctx, req.Token)
	switch {
	case err == nil && p.AccountID == callerAccountID:
		return &api.IntrospectResponse{
			AccountID:       strconv.FormatInt(p.AccountID, 10),
			DeviceID:        p.DeviceID,
			Kind:            p.Kind,
			PeerFingerprint: p.PeerFingerprint,
			ExpiresIn:       remainingSeconds(p.ExpiresAt),
		}, nil
	case err == nil, errors.Is(err, device_svc.ErrBearerInvalid):
		// err == nil 落到这一支时，是核验出了身份但账号与调用方不同（跨账号）。
		return nil, i18n.NewError(ctx, code.CredentialInvalid)
	case errors.Is(err, auth_svc.ErrCredentialUnverifiable):
		logger.Ctx(ctx).Warn("credentials_ctr.Introspect: 核验短效凭据所需的存储不可用",
			zap.Int64("callerAccountId", callerAccountID), zap.Error(err))
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusServiceUnavailable, code.ServerError)
	default:
		logger.Ctx(ctx).Error("credentials_ctr.Introspect: 解析待核验令牌失败",
			zap.Int64("callerAccountId", callerAccountID), zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
}

// remainingSeconds 把毫秒时间戳折成「从现在起还有多少整秒」，钳在 0 以下不出现负数
// ——resolver 已经把过期的令牌判成 ErrBearerInvalid，这里的负值只可能来自极小的
// 计算窗口本身。
func remainingSeconds(expiresAtMs int64) int64 {
	remaining := (expiresAtMs - time.Now().UnixMilli()) / 1000
	if remaining < 0 {
		return 0
	}
	return remaining
}
