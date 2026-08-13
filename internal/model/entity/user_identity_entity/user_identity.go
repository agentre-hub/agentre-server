// Package user_identity_entity 维护第三方 OAuth 绑定关系。
package user_identity_entity

const ProviderGithub = "github"

type UserIdentity struct {
	ID            int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID        int64  `gorm:"column:user_id;type:bigint;not null"`
	Provider      string `gorm:"column:provider;type:text;not null"`
	ProviderUID   string `gorm:"column:provider_uid;type:text;not null"`
	ProviderLogin string `gorm:"column:provider_login;type:text;not null;default:''"`
	Email         string `gorm:"column:email;type:text;not null"`
	// RawProfile 带 default：空值时 gorm 会把这一列整个从 INSERT 里省掉，交给
	// schema 的 DEFAULT ('{}')。「没有 profile 就存 {}」因此只有一处实现。
	RawProfile []byte `gorm:"column:raw_profile;type:json;not null;default:'{}'"`
	Createtime int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*UserIdentity) TableName() string { return "user_identities" }
