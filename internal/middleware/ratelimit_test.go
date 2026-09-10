package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubTaker 顶替限流器，让这一层的判定逻辑不需要任何 Redis 就能测。
// 被测的是「拿到某种结果之后放行还是拒绝」，不是 Redis 上怎么计数。
type stubTaker struct {
	err    error
	called int
}

func (s *stubTaker) Take(context.Context, string) (func() error, error) {
	s.called++
	return func() error { return nil }, s.err
}

func runLimited(t *testing.T, taker periodTaker) *httptest.ResponseRecorder {
	t.Helper()
	r := gin.New()
	r.GET("/x", perKeyLimitWith(taker, byIP), func(c *gin.Context) { c.String(http.StatusOK, "reached") })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	return w
}

func TestPerKeyLimit_UnderQuotaReachesTheHandler(t *testing.T) {
	w := runLimited(t, &stubTaker{err: nil})

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "reached", w.Body.String())
}

func TestPerKeyLimit_OverQuotaRejectsWithRetryAfter(t *testing.T) {
	over := httputils.NewError(http.StatusTooManyRequests, -1, "60秒内产生了太多请求")

	w := runLimited(t, &stubTaker{err: over})

	assert.Equal(t, http.StatusTooManyRequests, w.Code)
	assert.Equal(t, "60", w.Header().Get("Retry-After"), "429 必须带 Retry-After，客户端要靠它退避")
	assert.NotContains(t, w.Body.String(), "reached")
}

// 这一条是这次换实现最容易翻掉的地方，也是原来完全没有测试守着的地方。
//
// 限流是防滥用不是鉴权：Redis 抖一下不该把正常用户挡在门外。cago 的 PeriodLimit
// 把「被限流」和「Redis 故障」都从 Take 的 error 返回，两者只差一个 *httputils.Error
// 的 Status——判错一次，Redis 一断线整条限流路径就从 fail-open 变成全站 429。
func TestPerKeyLimit_RedisFailureFailsOpen(t *testing.T) {
	w := runLimited(t, &stubTaker{err: errors.New("dial tcp 127.0.0.1:6379: connect: connection refused")})

	assert.Equal(t, http.StatusOK, w.Code, "Redis 故障必须放行")
	assert.Equal(t, "reached", w.Body.String())
	assert.Empty(t, w.Header().Get("Retry-After"))
}

// 非 429 的 *httputils.Error 同样属于「判不出来」，一并放行。
func TestPerKeyLimit_NonRateLimitHTTPErrorFailsOpen(t *testing.T) {
	w := runLimited(t, &stubTaker{err: httputils.NewError(http.StatusInternalServerError, -1, "boom")})

	assert.Equal(t, http.StatusOK, w.Code)
}

// 不受这道限流管辖的请求根本不该去问限流器——按账号那道在没登录时就是这种情况，
// 多问一次就是白白往 Redis 上写一条计数。
func TestPerKeyLimit_OutOfScopeRequestNeverConsultsTheLimiter(t *testing.T) {
	taker := &stubTaker{}
	r := gin.New()
	r.GET("/x", perKeyLimitWith(taker, func(*gin.Context) (string, bool) { return "", false }),
		func(c *gin.Context) { c.String(http.StatusOK, "reached") })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Zero(t, taker.called, "不管辖就不该问限流器")
}
