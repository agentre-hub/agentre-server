package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609110105 把 device_tokens.access_jti 改名为 access_token_hash，并给它加唯一索引。
//
// access token 不再是 JWT，而是不透明随机串；server 只存明文的 sha256 十六进制（恒为 64 位
// 小写），Bearer 校验按它等值查找——这就要一根索引，而唯一键同时保证一个摘要只认一行。
// 列定义 varchar(64) COLLATE utf8mb4_0900_bin 原样沿用：摘要正好 64 位，按凭据逐字节判等。
//
// 存量行里是旧 JWT 的 jti（ULID，逐行唯一），没有任何明文哈希得成它们：改名之后旧 access
// token 一律解析不出身份，客户端照常走一次刷新，因此不清洗旧值；唯一索引也建得起来。
//
// 两条语句分开执行：改名只改元数据，建二级唯一索引不重建表，二者都能 INPLACE + LOCK=NONE。
func migration202609110105() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609110105",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.Exec(`
				ALTER TABLE device_tokens
				RENAME COLUMN access_jti TO access_token_hash,
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error; err != nil {
				return err
			}
			return tx.Exec(`
				ALTER TABLE device_tokens
				ADD UNIQUE INDEX uk_dtokens_access_hash (access_token_hash),
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			if err := tx.Exec(`
				ALTER TABLE device_tokens
				DROP INDEX uk_dtokens_access_hash,
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error; err != nil {
				return err
			}
			return tx.Exec(`
				ALTER TABLE device_tokens
				RENAME COLUMN access_token_hash TO access_jti,
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error
		},
	}
}
