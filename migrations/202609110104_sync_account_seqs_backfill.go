package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609110104 给每个还没有 sync_account_seqs 行的存量账号补一行
// （version_seq = 0）。
//
// 建号从这一轮起在同一个事务里预建这一行（决策 20）：两个都没有行的账号在重叠事务里
// 首次取号，NextVersion 的空 UPDATE 各持一把间隙锁、随后的 INSERT 互等，其中一个
// ERROR 1213。新账号由建号兜住，存量账号靠这一条补齐。
//
// 覆盖全部账号、不看 status：NextVersion 本身不按状态过滤，封禁或其它状态的账号
// 行若缺着，照样会在首次取号时走进那条会死锁的回落分支。
//
// 只插缺行的账号（LEFT JOIN … IS NULL），已有行一列都不碰——它们可能已被 NextVersion
// 推进过，拨回 0 会让设备手里的游标越过序列头。条件本身就是幂等的：重跑一次什么都不插。
// 这是 DML 不是 DDL，没有 ALGORITHM/LOCK 可声明；updatetime 用库端当前毫秒，与业务代码
// 写入的 UnixMilli 同一口径。
func migration202609110104() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609110104",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				INSERT INTO sync_account_seqs (user_id, version_seq, updatetime)
				SELECT u.id, 0, CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED)
				FROM users u
				LEFT JOIN sync_account_seqs s ON s.user_id = u.id
				WHERE s.user_id IS NULL;
			`).Error
		},
		// 回滚不删行：补进去的行与建号预建、NextVersion 首次取号建出的行无从区分，
		// 其中不少在迁移之后已被推进过；删掉它们就是把这些账号的版本序列清零。
		// 行多出来对旧代码无害——NextVersion 命中已有行时本就走普通 UPDATE。
		Rollback: func(tx *gorm.DB) error {
			return nil
		},
	}
}
