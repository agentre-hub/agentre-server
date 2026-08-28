package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608280005 创建 device_flow_codes 表（RFC 8628 的 device_code /
// user_code 状态机）。
//
// device_code 是机器之间传递的 bearer 凭据，用 utf8mb4_0900_bin 逐字节判等：大小写
// 不敏感等于凭空放宽一个凭据的匹配条件。
//
// user_code 相反，它是印给人看、由人敲进浏览器的，所以用 utf8mb4_0900_as_ci
// 大小写不敏感——用户小写敲验证码必须也能对上。usercode.Normalize 已经会先转大写，
// 排序规则是第二层保障：将来多一条忘了 Normalize 的查询路径时，症状是「查不到这个
// 验证码」这种很难联想到大小写的报错。
//
// 两者的长度按生成器实际产出来定，不留无意义的余量——
// device_code 是 randomBase32(32)（32 字节 base32、无填充，恒为 52 位小写），
// user_code 是 usercode.Generate() 的 "XXX-XXX"（7 位大写）。device_code 还是主键，
// InnoDB 会把主键塞进每一条二级索引，所以它的宽度是真实成本，不能随手写 varchar(255)。
//
// pending_flag 是 MySQL 表达「部分唯一索引」的写法，等价于 PG 的
// `... ON device_flow_codes(user_code) WHERE consumed_at = 0 AND denied_at = 0`：
// 唯一键里出现 NULL 的行不参与约束，因此只有未结算的行会互相排斥。
// 键写成 (user_code, pending_flag) 是为了让同一个索引也能被
// `WHERE user_code=? AND consumed_at=0 AND denied_at=0` 当最左前缀用上——这条路径
// 是设备每 5 秒一次的轮询和 approve/deny 两条 UPDATE，没有索引就是全表扫，
// 而全表扫的 UPDATE 在 InnoDB 下还会把 next-key 锁铺满整张表。
func migration202608280005() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608280005",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE device_flow_codes (
				  device_code         varchar(64) COLLATE utf8mb4_0900_bin PRIMARY KEY,
				  user_code           varchar(16) COLLATE utf8mb4_0900_as_ci NOT NULL,
				  device_kind         varchar(32) COLLATE utf8mb4_0900_bin NOT NULL,
				  client_fingerprint  varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  platform            varchar(64) NOT NULL DEFAULT '',
				  version             varchar(64) NOT NULL DEFAULT '',
				  client_name         varchar(128) NOT NULL DEFAULT '',
				  authorized_user_id  bigint NOT NULL DEFAULT 0,
				  approved_at         bigint NOT NULL DEFAULT 0,
				  consumed_at         bigint NOT NULL DEFAULT 0,
				  denied_at           bigint NOT NULL DEFAULT 0,
				  interval_seconds    smallint NOT NULL DEFAULT 5,
				  last_polled_at      bigint NOT NULL DEFAULT 0,
				  expires_at          bigint NOT NULL DEFAULT 0,
				  createtime          bigint NOT NULL DEFAULT 0,
				  pending_flag        tinyint GENERATED ALWAYS AS
				    (IF(consumed_at = 0 AND denied_at = 0, 1, NULL)) STORED,
				  UNIQUE KEY uk_dfc_user_code_pending (user_code, pending_flag),
				  KEY idx_dfc_expires (expires_at)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS device_flow_codes`).Error
		},
	}
}
