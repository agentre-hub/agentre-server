package bootstrap

import (
	"context"
	"testing"

	"github.com/cago-frame/cago/configs/memory"
	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/database/redis"
	"github.com/stretchr/testify/assert"
)

func TestEnvOverlaySource_DSNFromEnvOverridesFile(t *testing.T) {
	inner := memory.NewSource(map[string]interface{}{
		"db": map[string]interface{}{
			"driver":      "mysql",
			"dsn":         "file:file@tcp(file:3306)/file",
			"prepareStmt": true,
		},
	})
	t.Setenv(EnvDBDSN, "env:env@tcp(env:3306)/env")

	var got db.Config
	err := newEnvOverlaySource(inner).Scan(context.Background(), "db", &got)

	assert.NoError(t, err)
	assert.Equal(t, "env:env@tcp(env:3306)/env", got.Dsn)
	assert.Equal(t, db.Driver("mysql"), got.Driver, "只覆盖 dsn，同段其余字段保持文件里的值")
	assert.True(t, got.PrepareStmt, "同段其余字段保持文件里的值")
}

func TestEnvOverlaySource_FileValueSurvivesWithoutEnv(t *testing.T) {
	inner := memory.NewSource(map[string]interface{}{
		"db": map[string]interface{}{"driver": "mysql", "dsn": "file:file@tcp(file:3306)/file"},
	})

	var got db.Config
	err := newEnvOverlaySource(inner).Scan(context.Background(), "db", &got)

	assert.NoError(t, err)
	assert.Equal(t, "file:file@tcp(file:3306)/file", got.Dsn)
}

// 少填一项的 .env 会以空串传进来；认了它就把配置文件里正确的 DSN 抹成空的。
func TestEnvOverlaySource_EmptyEnvIsTreatedAsUnset(t *testing.T) {
	inner := memory.NewSource(map[string]interface{}{
		"db": map[string]interface{}{"driver": "mysql", "dsn": "file:file@tcp(file:3306)/file"},
	})
	t.Setenv(EnvDBDSN, "")

	var got db.Config
	err := newEnvOverlaySource(inner).Scan(context.Background(), "db", &got)

	assert.NoError(t, err)
	assert.Equal(t, "file:file@tcp(file:3306)/file", got.Dsn)
}

// cago 起服务时要拿这一层读 env / debug / source / server 等一大堆段。
func TestEnvOverlaySource_PassesThroughOtherKeys(t *testing.T) {
	inner := memory.NewSource(map[string]interface{}{
		"env":    "prod",
		"server": map[string]interface{}{"public_url": "https://example.test"},
	})
	t.Setenv(EnvDBDSN, "env:env@tcp(env:3306)/env")
	src := newEnvOverlaySource(inner)

	var env string
	assert.NoError(t, src.Scan(context.Background(), "env", &env))
	assert.Equal(t, "prod", env)

	// 取原始 map 而不是带 yaml tag 的结构体：memory 源用 json 编解码，
	// public_url 匹配不上 PublicURL，那是这个假源的性质，不是透传的性质。
	var server map[string]interface{}
	assert.NoError(t, src.Scan(context.Background(), "server", &server))
	assert.Equal(t, "https://example.test", server["public_url"])

	has, err := src.Has(context.Background(), "server")
	assert.NoError(t, err)
	assert.True(t, has)
}

// 缺 db 段时报错要冒上去：拿一条只有 dsn 的配置起服务，driver 是空的，错更难查。
func TestEnvOverlaySource_PropagatesMissingSection(t *testing.T) {
	inner := memory.NewSource(map[string]interface{}{})
	t.Setenv(EnvDBDSN, "env:env@tcp(env:3306)/env")

	var got db.Config
	err := newEnvOverlaySource(inner).Scan(context.Background(), "db", &got)

	assert.Error(t, err)
}

// 顺带钉住数字字段：覆盖要把整段重新编解码一次，db 索引不能在往返里变成字符串。
func TestEnvOverlaySource_RedisAddrAndPasswordFromEnv(t *testing.T) {
	inner := memory.NewSource(map[string]interface{}{
		"redis": map[string]interface{}{"addr": "file:6379", "password": "", "db": 3},
	})
	t.Setenv(EnvRedisAddr, "env:6379")
	t.Setenv(EnvRedisPassword, "s3cret")

	var got redis.Config
	err := newEnvOverlaySource(inner).Scan(context.Background(), "redis", &got)

	assert.NoError(t, err)
	assert.Equal(t, "env:6379", got.Addr)
	assert.Equal(t, "s3cret", got.Password)
	assert.Equal(t, 3, got.DB, "没登记覆盖的字段（含数字字段）要原样保留")
}
