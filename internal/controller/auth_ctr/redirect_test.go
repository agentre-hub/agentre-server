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

// safeNext 是登录后「回到哪」的唯一判据，也就是这条 OAuth 流程有没有开放重定向。
// 它现在的规则是「以 / 开头、且不以 // 开头」——而按 WHATWG URL 规范，特殊 scheme
// （http/https）下反斜杠与斜杠等价，于是 /\evil.com 在浏览器里会被解析成
// protocol-relative URL，跳出本站。反斜杠与正斜杠必须同等对待。
func TestSafeNext(t *testing.T) {
	for _, c := range []struct {
		name string
		in   string
		want string
	}{
		{name: "空 → 首页", in: "", want: "/"},
		{name: "站内路径原样保留", in: "/devices?tab=all", want: "/devices?tab=all"},
		{name: "协议相对 URL", in: "//evil.com", want: "/"},
		{name: "绝对 URL", in: "https://evil.com", want: "/"},
		{name: "反斜杠的协议相对 URL", in: "/\\evil.com", want: "/"},
		{name: "反斜杠开头", in: "\\evil.com", want: "/"},
		{name: "反斜杠混斜杠", in: "/\\/evil.com", want: "/"},
		{name: "斜杠混反斜杠", in: "//\\evil.com", want: "/"},
		// 浏览器解析前会把 tab / CR / LF 从 URL 里剥掉，于是这几个也都是 //evil.com。
		{name: "tab 撑开的协议相对 URL", in: "/\t/evil.com", want: "/"},
		{name: "换行撑开的协议相对 URL", in: "/\n/evil.com", want: "/"},
		{name: "回车撑开的协议相对 URL", in: "/\r/evil.com", want: "/"},
	} {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, safeNext(c.in))
		})
	}
}

// user_code 是**请求方给的**（GithubAuthorizeRequest.UserCode 没有 binding 约束），
// 而它被拼进一个重定向目标的 query 里。不转义的话，一个带 & 或 # 的值就能往落点上
// 再挂一个参数、或者把 query 整段截断，用户看到的地址与本站以为的不是同一个。
func TestNextWithUserCode(t *testing.T) {
	for _, c := range []struct {
		name           string
		next, userCode string
		want           string
	}{
		{name: "没有 user_code 就只是落点", next: "/devices", userCode: "", want: "/devices"},
		{name: "落点没有 query 时用 ?", next: "/device", userCode: "A4F-7Q2", want: "/device?user_code=A4F-7Q2"},
		{
			name: "落点已有 query 时用 &", next: "/device?tab=all", userCode: "A4F-7Q2",
			want: "/device?tab=all&user_code=A4F-7Q2",
		},
		{
			name: "注入额外参数的值被转义", next: "/device", userCode: "A4F-7Q2&next=//evil.com",
			want: "/device?user_code=A4F-7Q2%26next%3D%2F%2Fevil.com",
		},
		{
			name: "井号不再截断 query", next: "/device", userCode: "x#fragment",
			want: "/device?user_code=x%23fragment",
		},
		{
			name: "落点不合法时仍然收敛到首页", next: "/\\evil.com", userCode: "A4F-7Q2",
			want: "/?user_code=A4F-7Q2",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, nextWithUserCode(c.next, c.userCode))
		})
	}
}
