// Package dberr 把驱动层的数据库错误翻译成仓储层能分支的判断。
//
// 只放「读错误」的函数，不碰连接、不碰 gorm，因此 repository 可以导入它而不违反
// internal/pkg 的依赖方向。
package dberr

import (
	"errors"
	"strings"

	"github.com/go-sql-driver/mysql"
)

// errDupEntry 是 MySQL 的 ER_DUP_ENTRY。
const errDupEntry = 1062

// IsDuplicateKey 判断 err 是不是 index 这个唯一键上的重复键错误。
//
// 必须收敛到具体索引名，不能只判「是不是 1062」：一张表上有多个唯一键时，撞哪一个
// 决定了业务该吞掉还是该报错。sync_objects 就是这样——撞身份键是版本竞败（吞掉），
// 撞自然键是 R4b 兜底（必须响）。把两者混在一起等于把该抛的错吞掉。
//
// 索引名只出现在错误文本里（`Duplicate entry 'x' for key 'tbl.idx'`），这是 MySQL
// 唯一暴露它的地方。MySQL 8 起带表名前缀，5.7 不带，两种形态都认。用后缀而不是
// 包含匹配：uk_x 是 uk_x_v2 的前缀，包含匹配会把后者的冲突认成前者的。
func IsDuplicateKey(err error, index string) bool {
	var myErr *mysql.MySQLError
	if !errors.As(err, &myErr) || myErr.Number != errDupEntry {
		return false
	}
	return strings.HasSuffix(myErr.Message, "'"+index+"'") ||
		strings.HasSuffix(myErr.Message, "."+index+"'")
}
