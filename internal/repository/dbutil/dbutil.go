// Package dbutil 放仓储层各 repo 共用的查询样板。
package dbutil

import (
	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"
)

// FindOne 取一行，查不到返回 (nil, nil)。
//
// 「查不到不是错误」是本仓所有 FindXxx 的既有约定：服务层据此写 `if x == nil`，
// 而不是去判错误类型。这段 if err != nil { if RecordNotFound → nil,nil } 的样板
// 曾在 9 个 repo 里出现 15 次；漏掉里层那个 RecordNotFound 分支，调用方就会把一次
// 正常的「不存在」当成 500，反过来在错误分支里返回零值实体，则会把一次连库失败当成
// 「不存在」而静默走进创建分支。所以它只保留这一份。
//
// 传进来的是已经拼好 Where/Order/Select 的链，本函数只负责收尾。
func FindOne[T any](tx *gorm.DB) (*T, error) {
	ret := new(T)
	if err := tx.First(ret).Error; err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}
