package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609040001 退役两列死列：写了、但没有任何一处读回来过。
//
//   - device_tokens.rotated_from_id 记「这条 token 是轮换掉哪一条得来的」。轮换链
//     从来没有被消费：撤销按 device_id 整批走（RevokeByDevice），清理按时间窗走
//     （CleanupDeviceTokens），没有任何一条路径顺着这一列往回走。
//   - sync_avatars.byte_size 记正文字节数。配额校验在写入前对 in.Content 当场算
//     （sync_svc.MaxAvatarBytes），回收按引用计数走（idx_sync_objects_avatar），
//     两条路都不看这一列；正文就在同一行上，长度随时算得出来。
//
// 两列都不在任何索引里（device_tokens 的四条键与 sync_avatars 的主键 +
// idx_sync_avatars_createtime 都不含它们），所以各是一条独立的 ALTER，不需要先拆键。
//
// 这两张表都在持续写入，DROP COLUMN 会让 InnoDB 重建整表；device_tokens 的体量随
// 设备数与轮换频率走，上线前按 docs/verification.md 估一次行数再执行。
func migration202609040001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609040001",
		Migrate: func(tx *gorm.DB) error {
			return execAll(tx, []string{
				"ALTER TABLE device_tokens DROP COLUMN rotated_from_id",
				"ALTER TABLE sync_avatars DROP COLUMN byte_size",
			})
		},
		// 回滚只把列的形状建回来，不还原内容：两列存的都是无人读取的值，没有任何
		// 一处会因为它们回到默认值而改变行为。
		Rollback: func(tx *gorm.DB) error {
			return execAll(tx, []string{
				"ALTER TABLE device_tokens ADD COLUMN rotated_from_id bigint NOT NULL DEFAULT 0",
				"ALTER TABLE sync_avatars ADD COLUMN byte_size bigint NOT NULL DEFAULT 0",
			})
		},
	}
}
