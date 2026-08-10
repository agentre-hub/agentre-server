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
func migration202608090001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608090001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE sync_objects (
				  id                   bigserial PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  kind                 text NOT NULL,
				  sync_id              text NOT NULL,
				  project_sync_id      text NOT NULL DEFAULT '',
				  agentred_fingerprint text NOT NULL DEFAULT '',
				  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
				  version              bigint NOT NULL,
				  sync_updated_at      bigint NOT NULL DEFAULT 0,
				  source_device_id     bigint NOT NULL DEFAULT 0,
				  deleted_at           bigint NOT NULL DEFAULT 0,
				  createtime           bigint NOT NULL DEFAULT 0,
				  updatetime           bigint NOT NULL DEFAULT 0
				);
				CREATE UNIQUE INDEX uk_sync_objects_identity ON sync_objects(user_id, sync_id);
				CREATE INDEX idx_sync_objects_cursor ON sync_objects(user_id, version);
				-- agentred 路径的账号内自然键。只约束存活的行：墓碑不占自然键，
				-- 否则删掉再建就建不回来。R4b 的重复由它一次性挡住。
				CREATE UNIQUE INDEX uk_sync_objects_location
				  ON sync_objects(user_id, project_sync_id, agentred_fingerprint)
				  WHERE kind = 'project_location' AND deleted_at = 0;
				-- 指纹单独成列，可直接 join 到 devices.fingerprint：web 控制台不需要
				-- 额外的映射表就能说出「这条配置属于哪台机器」。
				CREATE INDEX idx_sync_objects_fingerprint
				  ON sync_objects(user_id, agentred_fingerprint)
				  WHERE agentred_fingerprint <> '';

				CREATE TABLE sync_account_seqs (
				  user_id     bigint PRIMARY KEY,
				  version_seq bigint NOT NULL DEFAULT 0,
				  updatetime  bigint NOT NULL DEFAULT 0
				);

				CREATE TABLE sync_device_states (
				  user_id      bigint NOT NULL,
				  device_id    bigint NOT NULL,
				  last_sync_at bigint NOT NULL DEFAULT 0,
				  updatetime   bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, device_id)
				);

				CREATE TABLE sync_avatars (
				  user_id      bigint NOT NULL,
				  content_hash text NOT NULL,
				  content_type text NOT NULL DEFAULT '',
				  content      text NOT NULL,
				  byte_size    bigint NOT NULL DEFAULT 0,
				  createtime   bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, content_hash)
				);

				CREATE TABLE device_local_paths (
				  user_id         bigint NOT NULL,
				  device_id       bigint NOT NULL,
				  project_sync_id text NOT NULL,
				  path            text NOT NULL,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, device_id, project_sync_id)
				);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`
				DROP TABLE IF EXISTS device_local_paths;
				DROP TABLE IF EXISTS sync_avatars;
				DROP TABLE IF EXISTS sync_device_states;
				DROP TABLE IF EXISTS sync_account_seqs;
				DROP TABLE IF EXISTS sync_objects;
			`).Error
		},
	}
}
