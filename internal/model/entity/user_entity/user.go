// Package user_entity 维护账号实体。
package user_entity

import (
	"context"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/i18n"

	"agentre-server/internal/pkg/code"
)

// User 账号记录。
type User struct {
	ID            int64  `gorm:"column:id;primaryKey;autoIncrement"`
	Email         string `gorm:"column:email;type:text;not null"`
	EmailVerified bool   `gorm:"column:email_verified;type:boolean;not null;default:false"`
	DisplayName   string `gorm:"column:display_name;type:text;not null;default:''"`
	AvatarURL     string `gorm:"column:avatar_url;type:text;not null;default:''"`
	Status        int    `gorm:"column:status;type:smallint;not null;default:1"`
	Createtime    int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime    int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*User) TableName() string { return "users" }

func (u *User) IsActive() bool { return u != nil && u.Status == consts.ACTIVE }

// Check 校验账号可用性。
func (u *User) Check(ctx context.Context) error {
	if u == nil {
		return i18n.NewError(ctx, code.UserNotFound)
	}
	if u.Status == consts.BAN {
		return i18n.NewError(ctx, code.UserBanned)
	}
	if !u.IsActive() {
		return i18n.NewError(ctx, code.UserNotFound)
	}
	return nil
}
