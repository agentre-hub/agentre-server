package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// baselineUsers 创建 users 表。
//
// email 用 utf8mb4_0900_as_ci：**大小写不敏感、但不折叠重音**。
//
// 大小写不敏感是产品决定：同一个人用 "A@b.C" 和 "a@b.c" 注册必须落在同一个账号上，
// 否则同一个邮箱能注册出两个账号。既然唯一键与 FindByEmail 都走这一列，把这件事交给
// 排序规则比在每个写入方各自 lower() 一遍更可靠——少一处就漏一处。
//
// 但不能图省事直接用表默认的 utf8mb4_0900_ai_ci：ai = accent-insensitive，它连重音
// 都折叠，会把 e@x.c 与 é@x.c 当成同一个邮箱，而那是两个不同的收件人。as_ci 正好是
// 「只折叠大小写」这一档。
//
// display_name / avatar_url 从不参与比较，留表默认排序规则即可。
//
// 注意所有显式排序规则都取 _0900_ 那一族，因为它们是 NO PAD。老的 utf8mb4_bin /
// utf8mb4_general_ci 是 PAD SPACE，会忽略尾随空格（'a@b.c ' 等于 'a@b.c'），
// 那和 PG 的 text 语义不一样。
//
// active_flag 是 MySQL 表达「部分唯一索引」的写法：唯一键里出现 NULL 的行不参与
// 约束，所以只有 status=1 的行会互相排斥，等价于 PG 的
// `CREATE UNIQUE INDEX ... ON users(email) WHERE status = 1`。
// 键写成 (email, active_flag) 而不是 (active_flag, email)，是为了让同一个索引
// 既做约束、又能被 user_repo.FindByEmail 的 `WHERE email=?` 当最左前缀用上——
// 否则 email 上就一个索引都没有，登录路径每次都是全表扫。
func baselineUsers() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "users",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE users (
				  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  email           varchar(320) COLLATE utf8mb4_0900_as_ci NOT NULL,
				  email_verified  boolean NOT NULL DEFAULT false,
				  display_name    varchar(255) NOT NULL DEFAULT '',
				  avatar_url      varchar(2048) NOT NULL DEFAULT '',
				  webauthn_handle varbinary(64) NOT NULL DEFAULT '',
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
