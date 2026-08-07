// Package jwtblacklist 保存「已吊销、但还没过期」的 access token jti。
//
// 它住在 internal/pkg 而不是 internal/middleware：写入方是 device_svc（Revoke
// 时拉黑该设备已签发的全部 jti），读取方是 middleware 的两个鉴权中间件。放在
// middleware 里会让 service 反向 import 边缘层，而 middleware 自己又 import
// auth_svc —— 形成 service → middleware → service 的环形依赖，违反
// 「api/controller → service → repository → model/entity」的单向流。
package jwtblacklist

import (
	"context"
	"errors"
	"time"

	"github.com/cago-frame/cago/database/redis"
	goredis "github.com/redis/go-redis/v9"
)

const keyPrefix = "jwt_blacklist:"

// Add 把 jti 写入黑名单，TTL 通常取该 access token 的完整有效期。
func Add(ctx context.Context, jti string, ttlSec int) error {
	if jti == "" {
		return errors.New("empty jti")
	}
	return redis.Default().Set(ctx, keyPrefix+jti, "1", time.Duration(ttlSec)*time.Second).Err()
}

// Has 报告 jti 是否已被拉黑。Redis 不可用时 fail-open（spec §6.5）：黑名单只是
// 短有效期之外的加速手段，不该让整个鉴权在 Redis 抖动时全面拒绝。
func Has(ctx context.Context, jti string) bool {
	err := redis.Default().Get(ctx, keyPrefix+jti).Err()
	if errors.Is(err, goredis.Nil) {
		return false
	}
	return err == nil
}
