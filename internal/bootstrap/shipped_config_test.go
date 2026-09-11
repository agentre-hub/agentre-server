package bootstrap

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/assert"
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

// 访问凭据靠刷新续期，有效期有上限。既有的
// TestLoadServerConfig_AccessTTLDefaultIsWithinBound 只看得住**没配时**的缺省值——
// 模板里显式写一个大数字，它一句话都不会说，而模板正是真实部署照抄的东西。
//
// 这与连接池是同一类失败：判据只存在于配置文件里，代码测试一路全绿，症状要等到
// 线上才看得见（一张被盗的 access token 多活多久，就是这个数字）。刷新凭据同理：
// 它决定一台失联设备还能自证多久。
func TestShippedConfigsKeepTokenTTLWithinBound(t *testing.T) {
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
						AccessTTL  time.Duration `yaml:"access_ttl"`
						RefreshTTL time.Duration `yaml:"refresh_ttl"`
					} `yaml:"jwt"`
				} `yaml:"server"`
			}
			require.NoError(t, yaml.Unmarshal(raw, &doc))

			// 没写就是走代码缺省值，那一条另有守卫
			if ttl := doc.Server.JWT.AccessTTL; ttl != 0 {
				require.LessOrEqual(t, ttl, 2*time.Hour,
					"访问凭据有效期上限 2h，模板里不该写一个更大的数字")
			}
			if ttl := doc.Server.JWT.RefreshTTL; ttl != 0 {
				require.LessOrEqual(t, ttl, 30*24*time.Hour,
					"刷新凭据有效期上限 30d，模板里不该写一个更大的数字")
			}
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

// shippedDSNTemplates 是随仓库发出去的、字面写着一条 DSN 的每一份模板：三份
// bootstrap 配置模板之外，compose 的默认值、.env 示例与 README 里 docker run 的
// 示例同属一类，缺一个都会有人原样抄进生产。新增模板时一并加进来。
var shippedDSNTemplates = append(append([]string{}, shippedConfigs...),
	"deploy/docker-compose.yml", "deploy/.env.example", "deploy/README.md")

// go-sql-driver/mysql v1.10 对 timeout / readTimeout / writeTimeout 的零值是「不设」——
// 网络黑洞时它只在 ctx 取消才放手（connection.go 的 watchCancel）。maxOpenConns 是
// 40，一条连接被网络黑洞吃住就少一条可用连接，直到 OS 的 TCP 重传超时（Linux 上约
// 15 分钟）才收得回来。要求 14：所有随仓库发布的 DSN 模板都要带三个超时参数。
func TestShippedDSNTemplatesCarryTimeouts(t *testing.T) {
	t.Parallel()
	root := repoRoot(t)

	for _, rel := range shippedDSNTemplates {
		t.Run(rel, func(t *testing.T) {
			t.Parallel()
			raw, err := os.ReadFile(filepath.Join(root, rel))
			require.NoError(t, err)
			dsn := extractShippedDSN(t, rel, raw)
			cfg, err := mysql.ParseDSN(dsn)
			require.NoError(t, err, "%s: DSN 解析失败: %q", rel, dsn)
			assert.Positive(t, cfg.Timeout, "%s: 缺 timeout，网络黑洞时连接会一直悬到 TCP 重传超时", rel)
			assert.Positive(t, cfg.ReadTimeout, "%s: 缺 readTimeout", rel)
			assert.Positive(t, cfg.WriteTimeout, "%s: 缺 writeTimeout", rel)
		})
	}
}

// extractShippedDSN 从每份模板里把那一条 DSN 抠出来 —— 四种模板各自的格式不同：
// 三份 bootstrap 配置模板是 YAML 的 db.dsn；compose 是环境变量的默认值，还嵌着
// DB_USER / DB_PASSWORD / DB_NAME 三层 shell 变量替换；.env 示例是被注释掉的
// DB_DSN=...；README 是 docker run 示例里的 -e 参数。
func extractShippedDSN(t *testing.T, rel string, raw []byte) string {
	t.Helper()
	switch rel {
	case "deploy/docker-compose.yml":
		match := regexp.MustCompile(`AGENTRE_SERVER_DB_DSN:\s*"([^\n]+)"`).FindSubmatch(raw)
		require.NotNil(t, match, "%s: 找不到 AGENTRE_SERVER_DB_DSN", rel)
		return resolveComposeDefaultEnvVar(string(match[1]))
	case "deploy/.env.example":
		match := regexp.MustCompile(`(?m)^#?DB_DSN=(.+)$`).FindSubmatch(raw)
		require.NotNil(t, match, "%s: 找不到 DB_DSN 示例", rel)
		return string(match[1])
	case "deploy/README.md":
		match := regexp.MustCompile(`AGENTRE_SERVER_DB_DSN="([^"]+)"`).FindSubmatch(raw)
		require.NotNil(t, match, "%s: 找不到 docker run 示例里的 AGENTRE_SERVER_DB_DSN", rel)
		return string(match[1])
	default:
		var doc struct {
			DB struct {
				DSN string `yaml:"dsn"`
			} `yaml:"db"`
		}
		require.NoError(t, yaml.Unmarshal(raw, &doc))
		require.NotEmpty(t, doc.DB.DSN, "%s: db.dsn 是空的", rel)
		return doc.DB.DSN
	}
}

// resolveComposeDefaultEnvVar 展开形如 ${VAR:-default} 的 shell 变量替换，环境视为
// 全部未设置（未设置时才会走 default 分支），支持任意深度嵌套 —— compose 里 DB_DSN
// 的默认值本身还嵌着 DB_USER / DB_PASSWORD / DB_NAME 三层。每轮只处理最内层（最后
// 一个 "${"，它的第一个 "}" 必然是自己的收口，因为内部不可能再嵌一层）。
func resolveComposeDefaultEnvVar(s string) string {
	for {
		start := strings.LastIndex(s, "${")
		if start == -1 {
			return s
		}
		end := strings.Index(s[start:], "}")
		if end == -1 {
			return s
		}
		end += start
		inner := s[start+2 : end]
		_, def, _ := strings.Cut(inner, ":-")
		s = s[:start] + def + s[end+1:]
	}
}
