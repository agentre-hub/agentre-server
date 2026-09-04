package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609040002 退役 users.email_verified：唯一的写入点把它硬编码成 true
// （user_svc 建号那一路，账号只能由 GitHub OAuth 创建），没有任何一处读它，也不进
// 任何 API 响应。取值集合大小为 1 而又无人过问的标志位不表达任何东西。
//
// 留着它反而更糟：一个不被读的 email_verified 看上去像一道校验，实际上系统此刻就把
// 所有邮箱一视同仁 —— 它提供的是安全感而不是安全。
//
// 什么时候该把它加回来：接入第二种身份来源、而那一种**不**保证邮箱已验证时。届时
// 它要连同真正的读取点（拒绝未验证邮箱的那条判断）一起落地，而不是先建一列空着。
//
// 该列不在任何索引里（users 上只有主键与 uk_users_email_active(email, active_flag)），
// 所以是一条独立的 ALTER。
func migration202609040002() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609040002",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec("ALTER TABLE users DROP COLUMN email_verified").Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(
				"ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false").Error
		},
	}
}
