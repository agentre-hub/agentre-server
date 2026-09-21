package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609210101 建端口转发子域前缀表（规格
// 2026-09-21-port-forward-subdomain「地址与路由」决策 3）：前缀不透明，服务端要能
// 从 Host 反查设备，只能自己存一份 (前缀, 账号, 设备, 映射 id)。映射本体仍然只存在
// 设备上，这张表不存目标。
//
// 新表用 ALGORITHM=INSTANT：MySQL 8.0+ 对 CREATE TABLE 本身不需要这个子句，写法
// 与其余补丁迁移的 ALTER TABLE 一致仅为可读性，这里按 develop.md 的约定省略——
// ALGORITHM/LOCK 只在 ALTER 时才有意义。
//
// prefix 用 utf8mb4_0900_bin：它是不透明的随机标识（12 位小写 base32），逐字节判等，
// 大小写不敏感只会放宽一个反查前缀该落到哪台设备上的匹配条件——与 devices.fingerprint
// 同一条约定（见首发迁移的「通用约定」）。
//
// 两个唯一键各自服务一条查询：
//   - uk_pfl_prefix 服务 FindByPrefix——S4 的 Host 分发按前缀反查 (账号, 设备,
//     映射 id)，也是「前缀全局唯一」这条不变量本身。
//   - uk_pfl_device_mapping 服务幂等分配——「每条映射一个固定前缀」（决策 2）靠它
//     实现：第一次调用插入新行，之后的调用查到已有行直接复用，不会生成第二个前缀。
func migration202609210101() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609210101",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE port_forward_links (
				  id          bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  prefix      varchar(12) COLLATE utf8mb4_0900_bin NOT NULL,
				  user_id     bigint NOT NULL,
				  device_id   bigint NOT NULL,
				  mapping_id  bigint NOT NULL,
				  createtime  bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_pfl_prefix (prefix),
				  UNIQUE KEY uk_pfl_device_mapping (device_id, mapping_id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec("DROP TABLE IF EXISTS port_forward_links").Error
		},
	}
}
