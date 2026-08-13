package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202605200001 创建 users 表。
//
// email 用 utf8mb4_bin：它是账号的自然键，必须逐字节判等。表默认的
// utf8mb4_0900_ai_ci 是大小写与重音都不敏感的，唯一键落在它上面意味着
// "a@b.c" 与 "A@B.C" 算同一个账号——那是一个产品决定，不该由排序规则的默认值
// 顺手替我们做掉。display_name / avatar_url 是给人看的文本，留默认排序规则。
//
// active_flag 是 MySQL 表达「部分唯一索引」的写法：唯一键里出现 NULL 的行不参与
// 约束，所以只有 status=1 的行会互相排斥，等价于 PG 的
// `CREATE UNIQUE INDEX ... ON users(email) WHERE status = 1`。
// 键写成 (email, active_flag) 而不是 (active_flag, email)，是为了让同一个索引
// 既做约束、又能被 user_repo.FindByEmail 的 `WHERE email=?` 当最左前缀用上——
// 否则 email 上就一个索引都没有，登录路径每次都是全表扫。
func migration202605200001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605200001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE users (
				  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  email           varchar(320) COLLATE utf8mb4_bin NOT NULL,
				  email_verified  boolean NOT NULL DEFAULT false,
				  display_name    varchar(255) NOT NULL DEFAULT '',
				  avatar_url      varchar(2048) NOT NULL DEFAULT '',
				  status          smallint NOT NULL DEFAULT 1,
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  active_flag     tinyint GENERATED ALWAYS AS (IF(status = 1, 1, NULL)) STORED,
				  UNIQUE KEY uk_users_email_active (email, active_flag)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS users`).Error
		},
	}
}
