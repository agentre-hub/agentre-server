// Package bearertest 给测试发「说是谁就是谁」的设备 access token。
//
// 它只能被 _test.go 引用：Resolver 认它自己发出的每一枚令牌，装进生产路由就是一道绕过
// 鉴权的后门。isolation_test.go 钉住 cmd/server 的依赖图里没有它。
//
// 测试要的是「这一枚令牌代表这个身份」，不是 device_svc 查库的细节——后者由 device_svc
// 自己的用例与 middleware 里接真实解析方的用例覆盖。
package bearertest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"

	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// issued 是已发出的令牌到身份的登记表。令牌是随机串，不同用例之间互不相撞，
// 因此一张进程级的表就够，不必把它穿过每个装配函数。
var issued sync.Map

// Issue 登记一个身份，交回一枚能被 Resolver 解析成它的令牌。
func Issue(p device_svc.Principal) string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	token := "bearertest-" + hex.EncodeToString(buf)
	issued.Store(token, p)
	return token
}

// Resolver 解析 Issue 发出的令牌；其余一律答 device_svc.ErrBearerInvalid。
type Resolver struct{}

func (Resolver) ResolveBearer(_ context.Context, token string) (*device_svc.Principal, error) {
	value, ok := issued.Load(token)
	if !ok {
		return nil, device_svc.ErrBearerInvalid
	}
	p := value.(device_svc.Principal)
	return &p, nil
}
