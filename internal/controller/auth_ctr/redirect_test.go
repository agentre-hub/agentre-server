package auth_ctr

import (
	"context"
	"errors"
	"testing"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

// TestGithubAccountErrRedirect 钉住 GithubCallback 在 user_svc.FindOrCreateFromGithub
// 返回错误时的分流：被封账号必须拿到一个成形的重定向而不是走 500；其它错误必须留给
// 调用方按 500 处理，不能被这里误吞。
func TestGithubAccountErrRedirect(t *testing.T) {
	ctx := context.Background()

	t.Run("UserBanned → 重定向且带 user_banned 码", func(t *testing.T) {
		target, ok := githubAccountErrRedirect(i18n.NewError(ctx, code.UserBanned))
		assert.True(t, ok)
		assert.Equal(t, "/login?err=user_banned", target)
	})

	t.Run("UserNotFound → 不拦截，留给 500", func(t *testing.T) {
		_, ok := githubAccountErrRedirect(i18n.NewError(ctx, code.UserNotFound))
		assert.False(t, ok)
	})

	t.Run("非 httputils.Error 的基础设施故障 → 不拦截，留给 500", func(t *testing.T) {
		_, ok := githubAccountErrRedirect(errors.New("db down"))
		assert.False(t, ok)
	})
}
