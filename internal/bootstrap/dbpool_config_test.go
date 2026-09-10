package bootstrap

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/cago-frame/cago/database/db"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

// 连接池曾经由本仓自己兜底：LoadServerConfig 给 server.db_pool 填 40/20/30m/5m，
// 再由 ApplyDBPool 写进 database/sql。cago 支持连接池之后那一段没了——框架每项零值
// 表示不调 setter，谁都不再替配置文件补缺省值。
//
// 于是「配置文件里到底写没写、键名对不对」成了唯一判据，而写漏或拼错都不会报错，
// 只会静默退回 database/sql 的默认值：空闲上限 2（并发下不停重建连接）、连接数无
// 上限（一次尖峰顶穿 MySQL 的 max_connections）、连接永不过期（主从切换后攥着指向
// 旧主的死连接）。三种症状都要压上负载才看得见，本地和 e2e 一路全绿。
//
// 判据用 cago 自己的 db.Config，解析方式也和 cago 一致（configs 的 file source 就是
// gopkg.in/yaml.v3 直接 Unmarshal 进这个结构体）：cago 改了字段名，这里就红。
func TestShippedConfigsSetDBPool(t *testing.T) {
	t.Parallel()

	_, filename, _, ok := runtime.Caller(0)
	require.True(t, ok)
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))

	// 本仓所有带 db: 的配置模板。新增模板时一并加进来。
	for _, rel := range []string{
		"configs/config.example.yaml",
		"configs/config.e2e.example.yaml",
		"deploy/config.docker.yaml",
	} {
		t.Run(rel, func(t *testing.T) {
			t.Parallel()

			raw, err := os.ReadFile(filepath.Join(root, rel))
			require.NoError(t, err)

			var doc struct {
				DB db.Config `yaml:"db"`
			}
			require.NoError(t, yaml.Unmarshal(raw, &doc))

			require.Positive(t, doc.DB.MaxOpenConns,
				"连接数必须有上限，否则尖峰会顶穿 MySQL 的 max_connections")
			require.Greater(t, doc.DB.MaxIdleConns, 2,
				"空闲上限停在 database/sql 的默认 2 会让并发下不停重建连接")
			require.LessOrEqual(t, doc.DB.MaxIdleConns, doc.DB.MaxOpenConns,
				"空闲上限高于总上限没有意义，database/sql 会自己压下来，配置读起来却像是生效了")
			require.Positive(t, doc.DB.ConnMaxLifetime,
				"连接必须有寿命，否则主从切换后会一直攥着指向旧主的死连接")
			require.Positive(t, doc.DB.ConnMaxIdleTime)
		})
	}
}
