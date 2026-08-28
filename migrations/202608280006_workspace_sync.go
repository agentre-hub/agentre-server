package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608280006 建工作区多端同步的两组表、账号级版本序列、每台设备的
// 最近一次成功同步时间，以及按内容哈希存放的头像表。
//
// 同步组（sync_objects）与上报组（device_local_paths）语义不同，所以不是一张表：
// 同步组双向同步、有版本号与墓碑；上报组按设备分命名空间、整份快照替换，
// 没有删除时间也没有冲突元数据。
//
// sync_id / project_sync_id / agentred_fingerprint / kind 都是客户端自带的不透明
// 标识，一律 utf8mb4_0900_bin 逐字节判等，同步的一切都建立在这个标识精确可比上。
// 两个坑都要躲开：表默认的 utf8mb4_0900_ai_ci 大小写不敏感，会让 "abc" 与 "ABC"
// 两个不同的 sync_id 撞上 uk_sync_objects_identity、`WHERE sync_id=?` 还会取回另一行；
// 而老的 utf8mb4_bin 虽然逐字节比较，却是 PAD SPACE，会忽略尾随空格，"x" 与 "x "
// 同样会互相顶掉。_0900_bin 才是既逐字节、又 NO PAD 的那一个。
//
// agentred_fingerprint 要能和 devices.fingerprint 比较，两列排序规则必须一致。
//
// uk_sync_objects_natural 是 agentred 路径的账号内自然键，只约束存活的行：墓碑不占
// 自然键，否则删掉再建就建不回来。用 live_natural_key（存活且属于带自然键的那几种
// kind 时取 kind 本身、否则为 NULL）把墓碑摘出去——唯一键里出现 NULL 的行不参与约束，
// 这正是 MySQL 表达部分唯一索引的写法，等价于 PG 那条带
// `WHERE kind IN (…) AND deleted_at = 0` 的
// (user_id, project_sync_id, agentred_fingerprint, kind) 部分唯一索引。
//
// 末尾放的是 **kind 本身而不是常数 1**，这样一条键就够了：
// ('project_location', proj, fp) 与 ('agent_backend_cli', proj, fp) 在键上是不同的
// 两点，不必各占一根生成列 + 一条索引（那种写法每多一种带自然键的 kind 就多一列一键，
// 而两条键的前三列完全相同）。
//
// **名单必须保持最小。** 九种 kind 里只有 project_location 与 agent_backend_cli 在
// 写入侧被强制要求 project_sync_id 与 agentred_fingerprint 非空（sync_svc 的
// rejectReason、workspace_svc 的 checkLocationNaturalKey）。其余七种这两列恒为空串，
// 放进名单会让该 kind 下所有存活行退化成同一个键 (user_id, ”, ”, kind) 而互相顶掉
// ——用户建第二个 Agent 就撞唯一索引。守卫见
// sync_object_natural_key_test.go 的 NaturalKeyKindListStaysMinimal。
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
// avatar_hash 是 payload 里那个头像哈希的生成列。R16a 的回收语句要回答「还有谁引用着
// 这份头像」，原本写成 JSON_UNQUOTE(JSON_EXTRACT(payload,'$.avatar_hash')) = content_hash
// ——函数谓词落不到任何索引上，于是每一个候选头像行都要把该账号的全部 sync_objects
// 读上来逐行解 JSON。提成列之后它才有地方落，idx_sync_objects_avatar 的前三列
// (user_id, kind, deleted_at) 顺带也服务 objectRepo.ListByKinds。
//
// sync_avatars.content 用 mediumtext 而不是 text：MySQL 的 text 上限是 65535 字节，
// 而 sync_svc.MaxAvatarBytes 允许 4 MiB，用 text 会让超过 64 KB 的头像直接写不进去
// （ER_DATA_TOO_LONG）。mediumtext 是 16 MiB，覆盖得住那个上限。
func migration202608280006() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608280006",
		Migrate: func(tx *gorm.DB) error {
			statements := []string{`
				CREATE TABLE sync_objects (
				  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  kind                 varchar(32) COLLATE utf8mb4_0900_bin NOT NULL,
				  sync_id              varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  project_sync_id      varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  agentred_fingerprint varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  payload              json NOT NULL DEFAULT ('{}'),
				  version              bigint NOT NULL,
				  -- 客户端提交的最后修改时间。这张表是同步元数据的专表，前缀冗余
				  -- （2026-08-27-schema-overhaul.md 决策 13）；实体那一侧的字段刻意不叫
				  -- UpdatedAt，见 sync_entity.SyncObject 上的注释。
				  updated_at           bigint NOT NULL DEFAULT 0,
				  -- 最后一次修改来自哪台机器。存**指纹**而不是 devices.id：数值是这个
				  -- server 的本地主键，桌面端离线创建的行没有它，而工作区里其余跨机引用
				  -- 一律用指纹（决策 14）。空串 = 服务端直写（决策 21）。
				  origin_fingerprint   varchar(128) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  deleted_at           bigint NOT NULL DEFAULT 0,
				  createtime           bigint NOT NULL DEFAULT 0,
				  updatetime           bigint NOT NULL DEFAULT 0,
				  -- 存活自然键，只用来把墓碑和「不带自然键的那些 kind」从下面那条唯一键里
				  -- 摘出去（见函数注释）。放的是 kind 本身而不是常数 1，两种 kind 因此
				  -- 在同一条键上互不相撞。
				  live_natural_key     varchar(32) COLLATE utf8mb4_0900_bin
				    GENERATED ALWAYS AS (IF(deleted_at = 0 AND
				    kind IN ('project_location', 'agent_backend_cli'), kind, NULL)) STORED,
				  -- 头像哈希从 payload 里提出来单独成列，是为了让它有地方落索引：
				  -- 回收语句的引用检查原本写成 JSON_EXTRACT(...) = content_hash，
				  -- 那是个函数谓词，优化器定位不了任何索引（见函数注释）。
				  -- 排序规则必须跟 sync_avatars.content_hash 一致，两列要直接比较；
				  -- 不显式写的话它会继承 JSON 那一族的默认排序规则，而那一档是
				  -- PAD SPACE，会忽略尾随空格。
				  avatar_hash          varchar(64) COLLATE utf8mb4_0900_bin
				    GENERATED ALWAYS AS
				    (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.avatar_hash'))) STORED,
				  UNIQUE KEY uk_sync_objects_identity (user_id, sync_id),
				  UNIQUE KEY uk_sync_objects_natural
				    (user_id, project_sync_id, agentred_fingerprint, live_natural_key),
				  KEY idx_sync_objects_cursor (user_id, version),
				  KEY idx_sync_objects_fingerprint (user_id, agentred_fingerprint),
				  KEY idx_sync_objects_tombstone (deleted_at),
				  -- 四列全是等值谓词，顺序对头像回收无所谓；把 deleted_at 放在
				  -- avatar_hash 前面是为了让前三列同时当 ListByKinds
				  -- （user_id + kind IN ? + deleted_at=0）的完整前缀用。
				  KEY idx_sync_objects_avatar (user_id, kind, deleted_at, avatar_hash)
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
				  content_hash varchar(64) COLLATE utf8mb4_0900_bin NOT NULL,
				  content_type varchar(255) NOT NULL DEFAULT '',
				  content      mediumtext NOT NULL,
				  byte_size    bigint NOT NULL DEFAULT 0,
				  createtime   bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, content_hash),
				  KEY idx_sync_avatars_createtime (createtime)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE device_local_paths (
				  user_id         bigint NOT NULL,
				  device_id       bigint NOT NULL,
				  project_sync_id varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  path            text NOT NULL,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, device_id, project_sync_id),
				  -- 撤销设备时按 device_id 单列清这台机器的清单，而主键以 user_id 打头，
				  -- device_id 不是它的最左前缀（见 sync_repo 的 DeleteByDevice）。
				  KEY idx_dlp_device (device_id)
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
