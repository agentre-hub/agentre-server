package bootstrap

import (
	"context"
	"os"
	"strings"

	"github.com/cago-frame/cago/configs/file"
	"github.com/cago-frame/cago/configs/source"
)

// 只登记字符串字段：覆盖要把整段重新编解码一次，往 int 字段塞字符串会解码失败。
const (
	EnvDBDSN         = "AGENTRE_SERVER_DB_DSN"
	EnvRedisAddr     = "AGENTRE_SERVER_REDIS_ADDR"
	EnvRedisPassword = "AGENTRE_SERVER_REDIS_PASSWORD"
)

// 配置段 -> 段内字段 -> 环境变量名。
//
// server.* 的覆盖能在 LoadServerConfig 里做，是因为那段由本仓库自己 Scan；
// db 与 redis 由 cago 的组件自己读，而 configs.Config 只有 Scan 没有 Set，
// 覆盖只能发生在配置源这一层。
var envSectionOverrides = map[string]map[string]string{
	"db":    {"dsn": EnvDBDSN},
	"redis": {"addr": EnvRedisAddr, "password": EnvRedisPassword},
}

// envOverlaySource 只对 `source: file` 生效：配置源是 etcd 时，cago 会在
// Config.init 里换掉整个源，这一层就不在链路上了。
type envOverlaySource struct {
	inner         source.Source
	serialization file.Serialization
}

func newEnvOverlaySource(inner source.Source) source.Source {
	return &envOverlaySource{inner: inner, serialization: file.Yaml()}
}

// NewConfigSource 按 path 读配置文件，并套上环境变量覆盖层。
func NewConfigSource(path string) (source.Source, error) {
	serialization := file.Yaml()
	inner, err := file.NewSource(path, serialization)
	if err != nil {
		return nil, err
	}
	return newEnvOverlaySource(inner), nil
}

func (s *envOverlaySource) Scan(ctx context.Context, key string, value interface{}) error {
	applied := make(map[string]string)
	for field, env := range envSectionOverrides[key] {
		// 空串当「没给」：compose 里没写进 .env 的变量以空串传进来，认了它就会把
		// 配置文件里本来正确的值抹掉。
		if v := os.Getenv(env); v != "" {
			applied[field] = v
		}
	}
	if len(applied) == 0 {
		return s.inner.Scan(ctx, key, value)
	}
	raw := make(map[string]interface{})
	// 缺段照旧报错：环境变量是覆盖手段，不是「缺配置也能起」的兜底。
	if err := s.inner.Scan(ctx, key, &raw); err != nil {
		return err
	}
	for field, v := range applied {
		raw[field] = v
	}
	b, err := s.serialization.Marshal(raw)
	if err != nil {
		return err
	}
	return s.serialization.Unmarshal(b, value)
}

func (s *envOverlaySource) Has(ctx context.Context, key string) (bool, error) {
	return s.inner.Has(ctx, key)
}

func (s *envOverlaySource) Watch(ctx context.Context, key string, callback func(event source.Event)) error {
	return s.inner.Watch(ctx, key, callback)
}

// envTruthy 只认显式的开关值，空串与未设置一律当关。
func envTruthy(name string) bool {
	v := os.Getenv(name)
	return v == "1" || strings.EqualFold(v, "true")
}
