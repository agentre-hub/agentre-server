// Package dbutil 放仓储层各 repo 共用的查询样板。
package dbutil

import (
	"context"

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

// 不分批的一条 DELETE 会把 next-key 锁铺满它扫过的整个范围：真库实测 30000 行一次
// 删掉锁了 36404 行、写出 34MB 的 binlog 事务；同样的数据换成 LIMIT 1000 一批，一批
// 只经唯一键锁 2005 行。这几张表都是稳态几十万到几百万行、一次回收可能删掉其中一大片
// 的形状，期间落在同一范围上的写全被挡在那把锁后面。分批之后每批各自提交，锁的持有
// 时间被切成一小段一小段，而不是整段攒在一次提交里。
const CleanupBatchSize = 1000

// DeleteBatched 按 CleanupBatchSize 一批一批地删，直到某一批没删满——没删满就说明
// 够到底了；删满一批说明后面大概率还有，必须继续。返回删掉的总行数。
//
// 分批的理由见 CleanupBatchSize。某一批中途出错时把已删的部分留在库里、把错误原样
// 传回去：删除是幂等的，调用方可以整体重试，不需要靠这里悄悄兜底。
func DeleteBatched(ctx context.Context, entity any, cond string, args ...any) (int64, error) {
	var total int64
	for {
		res := db.Ctx(ctx).Where(cond, args...).Limit(CleanupBatchSize).Delete(entity)
		if res.Error != nil {
			return total, res.Error
		}
		total += res.RowsAffected
		if res.RowsAffected < CleanupBatchSize {
			return total, nil
		}
	}
}
