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
			statements := []string{`
				CREATE TABLE sync_objects (
				  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  kind                 varchar(32) NOT NULL,
				  sync_id              varchar(255) NOT NULL,
				  project_sync_id      varchar(255) NOT NULL DEFAULT '',
				  agentred_fingerprint varchar(255) NOT NULL DEFAULT '',
				  payload              json NOT NULL,
				  version              bigint NOT NULL,
				  sync_updated_at      bigint NOT NULL DEFAULT 0,
				  source_device_id     bigint NOT NULL DEFAULT 0,
				  deleted_at           bigint NOT NULL DEFAULT 0,
				  createtime           bigint NOT NULL DEFAULT 0,
				  updatetime           bigint NOT NULL DEFAULT 0,
				  live_location_key varchar(511) GENERATED ALWAYS AS
				    (IF(kind = 'project_location' AND deleted_at = 0,
				      CONCAT(project_sync_id, CHAR(0), agentred_fingerprint), NULL)) STORED,
				  UNIQUE KEY uk_sync_objects_identity (user_id, sync_id),
				  UNIQUE KEY uk_sync_objects_location (user_id, live_location_key),
				  KEY idx_sync_objects_cursor (user_id, version),
				  KEY idx_sync_objects_fingerprint (user_id, agentred_fingerprint)
				)`, `
				CREATE TABLE sync_account_seqs (
				  user_id     bigint PRIMARY KEY,
				  version_seq bigint NOT NULL DEFAULT 0,
				  updatetime  bigint NOT NULL DEFAULT 0
				)`, `
				CREATE TABLE sync_device_states (
				  user_id      bigint NOT NULL,
				  device_id    bigint NOT NULL,
				  last_sync_at bigint NOT NULL DEFAULT 0,
				  updatetime   bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, device_id)
				)`, `
				CREATE TABLE sync_avatars (
				  user_id      bigint NOT NULL,
				  content_hash varchar(64) NOT NULL,
				  content_type varchar(255) NOT NULL DEFAULT '',
				  content      text NOT NULL,
				  byte_size    bigint NOT NULL DEFAULT 0,
				  createtime   bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, content_hash)
				)`, `
				CREATE TABLE device_local_paths (
				  user_id         bigint NOT NULL,
				  device_id       bigint NOT NULL,
				  project_sync_id varchar(255) NOT NULL,
				  path            text NOT NULL,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, device_id, project_sync_id)
				)`,
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
