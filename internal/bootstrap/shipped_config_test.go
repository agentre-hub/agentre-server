package bootstrap

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

// shippedConfigs 是本仓发出去的配置模板：一份 prod 参考、一份 e2e 参考，以及被
// Dockerfile COPY 进镜像、同时给 compose 挂载的那一份。新增模板时一并加进来。
var shippedConfigs = []string{
	"configs/config.example.yaml",
	"configs/config.e2e.example.yaml",
	"deploy/config.docker.yaml",
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	require.True(t, ok)
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
}

// R4 要求访问凭据是分钟级短有效期，靠刷新续期。既有的
// TestLoadServerConfig_AccessTTLDefaultIsMinuteLevel 只看得住**没配时**的缺省值——
// 模板里显式写一个大数字，它一句话都不会说，而模板正是真实部署照抄的东西。
//
// 这与连接池是同一类失败：判据只存在于配置文件里，代码测试一路全绿，症状要等到
// 线上才看得见（一张被盗的 access token 多活多久，就是这个数字）。
func TestShippedConfigsKeepAccessTTLMinuteLevel(t *testing.T) {
	t.Parallel()

	root := repoRoot(t)
	for _, rel := range shippedConfigs {
		t.Run(rel, func(t *testing.T) {
			t.Parallel()

			raw, err := os.ReadFile(filepath.Join(root, rel))
			require.NoError(t, err)

			var doc struct {
				Server struct {
					JWT struct {
						AccessTTL time.Duration `yaml:"access_ttl"`
					} `yaml:"jwt"`
				} `yaml:"server"`
			}
			require.NoError(t, yaml.Unmarshal(raw, &doc))

			ttl := doc.Server.JWT.AccessTTL
			if ttl == 0 {
				return // 没写就是走代码缺省值，那一条另有守卫
			}
			require.Less(t, ttl, time.Hour,
				"R4：访问凭据必须是分钟级短有效期，模板里不该写一个小时级的数字")
		})
	}
}

// 这几个键已经收成常量（会话 cookie 名、JWT 的 iss/aud、OAuth 回调路径）。留在模板里
// 不会报错，只会被静默忽略——而一个看得见、改了却没反应的键比没有这个键更糟。
func TestShippedConfigsDropRetiredKeys(t *testing.T) {
	t.Parallel()

	root := repoRoot(t)
	for _, rel := range shippedConfigs {
		t.Run(rel, func(t *testing.T) {
			t.Parallel()

			raw, err := os.ReadFile(filepath.Join(root, rel))
			require.NoError(t, err)

			var doc struct {
				Server struct {
					InsecureCookies *bool `yaml:"insecure_cookies"`
					Session         struct {
						CookieName *string `yaml:"cookie_name"`
						Secret     *string `yaml:"secret"`
					} `yaml:"session"`
					JWT struct {
						Issuer   *string `yaml:"issuer"`
						Audience *string `yaml:"audience"`
					} `yaml:"jwt"`
					OAuth struct {
						Github struct {
							CallbackPath *string `yaml:"callback_path"`
						} `yaml:"github"`
					} `yaml:"oauth"`
				} `yaml:"server"`
			}
			require.NoError(t, yaml.Unmarshal(raw, &doc))

			s := doc.Server
			require.Nil(t, s.Session.CookieName, "cookie 名是常量 session.CookieName")
			require.Nil(t, s.Session.Secret, "session.secret 没有任何读者，已删除")
			require.Nil(t, s.JWT.Issuer, "iss 是常量 bootstrap.JWTIssuer")
			require.Nil(t, s.JWT.Audience, "aud 是常量 bootstrap.JWTAudience")
			require.Nil(t, s.OAuth.Github.CallbackPath,
				"回调路径是常量 auth.GithubCallbackPath，与注册的路由同源")
			require.Nil(t, s.InsecureCookies, "Secure 由 public_url 的 scheme 推出")
		})
	}
}
