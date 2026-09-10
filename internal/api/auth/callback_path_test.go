package auth

import (
	"reflect"
	"testing"

	"github.com/stretchr/testify/require"
)

// GithubCallbackPath 曾经是配置项 server.oauth.github.callback_path。它不是部署要
// 做的选择：oauth_svc 拿它拼 redirect_uri 发给 GitHub，而真正接住回调的是下面这个
// 结构体上写死的路由。两处不同值时没有任何一层会报错——GitHub 照常把用户送回来，
// 落到一个 404 上，表现为「GitHub 登录点了没反应」。
//
// 收成常量之后仍有两处字面量：mux.Meta 是 struct tag，只能写字面量。所以由这道
// 守卫钉住它们同值。
func TestGithubCallbackPathMatchesRoute(t *testing.T) {
	t.Parallel()

	field, ok := reflect.TypeFor[GithubCallbackRequest]().FieldByName("Meta")
	require.True(t, ok, "GithubCallbackRequest 必须内嵌 mux.Meta")

	require.Equal(t, field.Tag.Get("path"), GithubCallbackPath,
		"回调常量与注册的路由必须同值，否则 GitHub 会把用户送到一个 404 上")
}
