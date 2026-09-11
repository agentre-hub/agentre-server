package device_svc

import (
	"context"
	"errors"
	"strconv"

	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo"
)

// Principal 是一枚 Bearer 凭据解析出来的调用方身份。
//
// 凭据本身不带任何可解析的内容，身份全部来自 server 的记录：鉴权入口（DeviceJWT、
// SessionOrDeviceAuth、中继）按它放行，其余凭据种类解析出的也是这同一个形状。
type Principal struct {
	// AccountID 是凭据所属账号。
	AccountID int64
	// DeviceID 是凭据所属设备；不属于任何设备的凭据为 0。
	DeviceID int64
	// Kind 是调用方形态；设备凭据即 devices.kind。
	Kind string
	// PeerFingerprint 是这枚凭据说了算的对端身份（决策 8）；设备凭据即该设备的
	// devices.fingerprint。
	PeerFingerprint string
	// ExpiresAt 是凭据失效的时刻（unix 毫秒）。
	ExpiresAt int64
	// Handle 是这枚凭据在 server 上的非机密标识：可以记日志、可以交给长连接复查，从它
	// 推不回凭据本身。设备 access token 取 device_tokens.id。
	Handle string
}

// ErrBearerInvalid 表示凭据未知、已过期或所属设备已撤销。三种情形刻意不区分：
// 对调用方都是「这枚凭据不能用」，区分它们等于告诉持有者这串东西曾经有效。
var ErrBearerInvalid = errors.New("bearer credential invalid")

// ResolveBearer 按摘要解析一枚设备 access token。
//
// 有效 = 摘要存在、未过期（行 createtime + AccessTTL）、所属设备仍在用。行上的 revoked_at
// 不看：Refresh 轮换时会置位它，而轮换出的旧令牌在过期前照常可用；让设备名下令牌立即失效
// 的是 Revoke 落库的设备状态。
//
// 判定只读 MySQL，Redis 不可用不影响它。明文只在这里哈希一次、按摘要等值查找，不存在逐字节
// 比较明文的时序面。查库失败原样上抛，不冒充成 ErrBearerInvalid。
func (s *deviceSvc) ResolveBearer(ctx context.Context, token string) (*Principal, error) {
	if token == "" {
		return nil, ErrBearerInvalid
	}
	row, err := device_token_repo.DeviceToken().FindByAccessHash(ctx, sha256Hex(token))
	if err != nil {
		return nil, err
	}
	if !row.AccessValidAt(s.now(), s.cfg.AccessTTL) {
		return nil, ErrBearerInvalid
	}
	d, err := device_repo.Device().Find(ctx, row.DeviceID)
	if err != nil {
		return nil, err
	}
	if !d.IsActive() {
		return nil, ErrBearerInvalid
	}
	return &Principal{
		AccountID:       d.UserID,
		DeviceID:        d.ID,
		Kind:            d.Kind,
		PeerFingerprint: d.Fingerprint,
		ExpiresAt:       row.AccessExpiresAt(s.cfg.AccessTTL),
		Handle:          strconv.FormatInt(row.ID, 10),
	}, nil
}
