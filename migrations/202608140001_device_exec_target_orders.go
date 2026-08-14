package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608140001 建「每台设备自己的执行目标排列」表。
//
// 一行的含义是「某台设备，对某个 Agent，把执行目标排成这个次序」：持有者是排这份
// 顺序的客户端（本轮只有 kind=web 的浏览器会写），被排序的是 order_json 里的
// backend sync_id。账号级的执行目标**集合**仍只在同步组里（sync_objects 的
// kind=agent_exec_target），这张表只覆盖它的次序，不改变集合本身。
//
// 形状照抄 device_local_paths（202608090001）——同样是「某台设备对某个同步对象的
// 本地偏好」：(user_id, device_id, <sync_id>) 复合主键、无自增 id、无 createtime。
//
// 键用 device_id 而不是设备指纹：一是隔壁 followed_sessions.device_fingerprint 指的是
// **目标**设备，同名反义必被读错；二是 device_id 只能由指纹解析 devices 行得到，
// 于是「传入的指纹必须属于调用方账号」这条校验在结构上绕不过去——拿不到 device_id
// 就无法读写这张表。
//
// agent_sync_id 必须是 utf8mb4_0900_bin：它要和 sync_objects.sync_id 比较，而那一列
// 是该排序规则（202608090001）。表默认的 utf8mb4_0900_ai_ci 大小写不敏感，会把两个
// 不同的 Agent 认成同一个；老的 utf8mb4_bin 则是 PAD SPACE，会忽略尾随空格。
//
// order_json 存 backend sync_id 的有序 JSON 数组，整存整取（排列永远被整体读写，
// 没有按档查询的需求），与桌面端 agent_exec_target_overrides.order_json 同形。
// 用 text 而不是 json 列：这里不做任何数据库侧的 JSON 取值，text 与桌面端那侧
// 的存法也一致。
func migration202608140001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608140001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE device_exec_target_orders (
				  user_id       bigint NOT NULL,
				  device_id     bigint NOT NULL,
				  agent_sync_id varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  order_json    text NOT NULL,
				  updatetime    bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, device_id, agent_sync_id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec("DROP TABLE IF EXISTS device_exec_target_orders").Error
		},
	}
}
