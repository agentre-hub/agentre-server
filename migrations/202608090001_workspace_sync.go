package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608090001 建工作区多端同步的两组表、账号级版本序列、每台设备的
// 最近一次成功同步时间，以及按内容哈希存放的头像表。
//
// 同步组（sync_objects）与上报组（device_local_paths）语义不同，所以不是一张表：
// 同步组双向同步、有版本号与墓碑；上报组按设备分命名空间、整份快照替换，
// 没有删除时间也没有冲突元数据。
//
// sync_id / project_sync_id / agentred_fingerprint / kind 都是客户端自带的不透明
// 标识，一律 utf8mb4_bin 逐字节判等。表默认的 utf8mb4_0900_ai_ci 大小写不敏感，
// 会让 "abc" 与 "ABC" 两个不同的 sync_id 撞上 uk_sync_objects_identity，
// 而且 `WHERE sync_id=?` 会取回另一行——同步的一切都建立在这个标识精确可比上。
//
// uk_sync_objects_location 是 agentred 路径的账号内自然键，只约束存活的行：墓碑不占
// 自然键，否则删掉再建就建不回来。用 live_location_flag（存活时为 1、否则为 NULL）
// 把墓碑摘出去——唯一键里出现 NULL 的行不参与约束，这正是 MySQL 表达部分唯一索引的
// 写法，等价于 PG 那条带 `WHERE kind = 'project_location' AND deleted_at = 0` 的
// (user_id, project_sync_id, agentred_fingerprint) 部分唯一索引。
//
// 键里放的是三个真列而不是把它们拼成一个字符串：拼接需要一个分隔符，而在
// utf8mb4_0900_ai_ci 下 CHAR(0) 这类控制字符的排序权重为空、会被直接忽略，
// ('proj','Xdev') 与 ('projX','dev') 会拼成同一个键、误判成重复。放真列既没有这个
// 问题，又能让 objectRepo.FindLocationByNaturalKey 走
// (user_id, project_sync_id, agentred_fingerprint) 这个最左前缀。
//
// idx_sync_objects_fingerprint 让指纹能直接 join 到 devices.fingerprint：web 控制台
// 不需要额外的映射表就能说出「这条配置属于哪台机器」。PG 那边它带一个「指纹非空」的
// 条件，MySQL 这里收全部行——多收的是空指纹那一批，不值得为此再加一个生成列。
//
// sync_avatars.content 用 mediumtext 而不是 text：MySQL 的 text 上限是 65535 字节，
// 而 sync_svc.MaxAvatarBytes 允许 4 MiB，用 text 会让超过 64 KB 的头像直接写不进去
// （ER_DATA_TOO_LONG）。mediumtext 是 16 MiB，覆盖得住那个上限。
func migration202608090001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608090001",
		Migrate: func(tx *gorm.DB) error {
			statements := []string{`
				CREATE TABLE sync_objects (
				  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  kind                 varchar(32) COLLATE utf8mb4_bin NOT NULL,
				  sync_id              varchar(255) COLLATE utf8mb4_bin NOT NULL,
				  project_sync_id      varchar(255) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
				  agentred_fingerprint varchar(255) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
				  payload              json NOT NULL DEFAULT ('{}'),
				  version              bigint NOT NULL,
				  sync_updated_at      bigint NOT NULL DEFAULT 0,
				  source_device_id     bigint NOT NULL DEFAULT 0,
				  deleted_at           bigint NOT NULL DEFAULT 0,
				  createtime           bigint NOT NULL DEFAULT 0,
				  updatetime           bigint NOT NULL DEFAULT 0,
				  -- 存活标志，只用来把墓碑从下面那个唯一键里摘出去（见函数注释）。
				  live_location_flag   tinyint GENERATED ALWAYS AS
				    (IF(kind = 'project_location' AND deleted_at = 0, 1, NULL)) STORED,
				  UNIQUE KEY uk_sync_objects_identity (user_id, sync_id),
				  UNIQUE KEY uk_sync_objects_location
				    (user_id, project_sync_id, agentred_fingerprint, live_location_flag),
				  KEY idx_sync_objects_cursor (user_id, version),
				  KEY idx_sync_objects_fingerprint (user_id, agentred_fingerprint)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE sync_account_seqs (
				  user_id     bigint PRIMARY KEY,
				  version_seq bigint NOT NULL DEFAULT 0,
				  updatetime  bigint NOT NULL DEFAULT 0
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE sync_device_states (
				  user_id      bigint NOT NULL,
				  device_id    bigint NOT NULL,
				  last_sync_at bigint NOT NULL DEFAULT 0,
				  updatetime   bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, device_id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE sync_avatars (
				  user_id      bigint NOT NULL,
				  content_hash varchar(64) COLLATE utf8mb4_bin NOT NULL,
				  content_type varchar(255) NOT NULL DEFAULT '',
				  content      mediumtext NOT NULL,
				  byte_size    bigint NOT NULL DEFAULT 0,
				  createtime   bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, content_hash)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE device_local_paths (
				  user_id         bigint NOT NULL,
				  device_id       bigint NOT NULL,
				  project_sync_id varchar(255) COLLATE utf8mb4_bin NOT NULL,
				  path            text NOT NULL,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, device_id, project_sync_id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
			}
			for _, statement := range statements {
				if err := tx.Exec(statement).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			for _, table := range []string{
				"device_local_paths", "sync_avatars", "sync_device_states",
				"sync_account_seqs", "sync_objects",
			} {
				if err := tx.Exec("DROP TABLE IF EXISTS " + table).Error; err != nil {
					return err
				}
			}
			return nil
		},
	}
}
