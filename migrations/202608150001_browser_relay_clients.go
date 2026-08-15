package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608150001 将浏览器偏好从设备身份中拆出，并清理旧网页设备。
func migration202608150001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608150001",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.Exec(`CREATE TABLE browser_exec_target_orders (
				  user_id bigint NOT NULL,
				  client_id varchar(128) COLLATE utf8mb4_0900_bin NOT NULL,
				  agent_sync_id varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  order_json text NOT NULL,
				  updatetime bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, client_id, agent_sync_id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`).Error; err != nil {
				return err
			}
			if err := tx.Exec(`INSERT INTO browser_exec_target_orders
					(user_id, client_id, agent_sync_id, order_json, updatetime)
					SELECT o.user_id, d.fingerprint, o.agent_sync_id, o.order_json, o.updatetime
					FROM device_exec_target_orders o JOIN devices d ON d.id=o.device_id
					WHERE d.kind='web'`).Error; err != nil {
				return err
			}
			if err := tx.Exec(`DELETE t FROM device_tokens t JOIN devices d ON d.id=t.device_id WHERE d.kind='web'`).Error; err != nil {
				return err
			}
			if err := tx.Exec(`DELETE o FROM device_exec_target_orders o JOIN devices d ON d.id=o.device_id WHERE d.kind='web'`).Error; err != nil {
				return err
			}
			return tx.Exec(`DELETE FROM devices WHERE kind='web'`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec("DROP TABLE IF EXISTS browser_exec_target_orders").Error
		},
	}
}
