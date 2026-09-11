package auth_svc

import (
	"context"
	"errors"

	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// BearerResolver 是「这一枚 Bearer 凭据属于谁」的解析方。device_svc.DeviceSvc 与
// CredentialResolver 都满足它。
type BearerResolver interface {
	ResolveBearer(ctx context.Context, token string) (*device_svc.Principal, error)
}

// CredentialResolver 是 server 签发的全部 Bearer 凭据的唯一解析入口：设备 access token
// 交给设备服务（按摘要查 MySQL），中继票据与 server 自用凭据交给短效凭据存储（Redis）。
// 解析出的身份各自带着自己的类型，入口据此决定放不放行——谁也冒充不了谁。
type CredentialResolver struct {
	devices     BearerResolver
	credentials AuthSvc
}

// NewCredentialResolver 组合两个解析方。任一为 nil 时它那一半一律无效。
func NewCredentialResolver(devices BearerResolver, credentials AuthSvc) *CredentialResolver {
	return &CredentialResolver{devices: devices, credentials: credentials}
}

// ResolveBearer 先问设备服务：设备 access token 的判定因此不经 Redis，Redis 不可用时照常。
// 设备服务认不下的才去短效凭据存储里找；设备服务自己判不出来（查库失败）原样上交，不拿同一
// 串去问第二个存储。
//
// 未知、过期、已撤销一律 device_svc.ErrBearerInvalid；短效凭据判不出来是
// ErrCredentialUnverifiable。
func (r *CredentialResolver) ResolveBearer(ctx context.Context, token string) (*device_svc.Principal, error) {
	if token == "" {
		return nil, device_svc.ErrBearerInvalid
	}
	if r.devices != nil {
		p, err := r.devices.ResolveBearer(ctx, token)
		switch {
		case err == nil && p != nil:
			return p, nil
		case err != nil && !errors.Is(err, device_svc.ErrBearerInvalid):
			return nil, err
		}
	}
	if r.credentials == nil {
		return nil, device_svc.ErrBearerInvalid
	}
	return r.credentials.ResolveCredential(ctx, token)
}
