package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608280002 建活跃统计的两张表：日滚存与账号设置。
//
// agent_activity_daily 是活跃统计的唯一数据源。它存的是**计数**，一行是「某账号、某天、
// 某台机器、某个维度组合下有几条对话」——没有标题、没有路径、没有对话内容。这条边界
// 就是那个开关向用户承诺的东西，落在 schema 上就是这张表里根本没有那些列。
//
// 一条对话只落进一个维度组合，所以按任意维度子集 SUM 都是对的：热力图只按 day 求和，
// 三张分布卡各按自己那一维求和，同一张表两用。
//
// day 存的是 char(10) 而不是 date，这一条看着像退步，是刻意的：这个日界**已经在别处
// 定过了**——发起端按服务端时区把它切成 "2006-01-02" 报上来，前端拿它当热力图格子的
// 键，下一次增量拉取又把它原样当 since_day 送回去。它的一生都是这个字符串。
//
// 存成 date 会在每一次读上多一次转换，而 DSN 带 parseTime=True，date 回来是
// time.Time；一旦有人整行扫回实体，那个 string 字段拿到的是 "2026-08-28T00:00:00+08:00"，
// 而它会被原样当成下一次的 since_day。char(10) 没有时区语义可供重新解释，逐字节的排序
// 恰好就是日期序，范围查询照样吃索引。真要做日期运算时 STR_TO_DATE 一句话的事。
//
// dims_hash 是六个维度的 STORED 生成列，参与主键。这不是为了省空间，而是必须：六个
// varchar(255) 直接拼进主键有 5000+ 字节，超过 InnoDB 3072 字节的索引上限，建表当场就
// 失败。让数据库自己算这个摘要（而不是应用算了再写）去掉了一整类 bug——应用与数据库对
// 「什么算同一行」产生分歧时，upsert 会静默地变成插入，计数从此翻倍。
//
// 维度列一律 utf8mb4_0900_bin：同步标识是不透明标识，大小写不敏感的比较会把两个不同的
// 标识认成同一个，两个 Agent 的计数并进一个桶——而这是一张只读作统计的表，并错了没人
// 会发现。
//
// user_settings 是账号级设置。眼下只有活跃上报这一个开关，但它不该塞进 users：那是身份
// 表，隐私状态与登录凭据放在一起，每一次读账号都会顺带把它带出来。
// activity_stats_enabled 默认 0——默认开等于替用户做了决定，而这个开关的全部意义就是
// 「用户显式同意之后才上报」。
//
// activity_last_pull_at 是最近一次**成功拉取**的时刻，由 Pull 每轮写下，不管那一轮有没有
// 拉到桶。它回答的是「这条管子还通着吗」，所以既不能拿 activity_stats_enabled_at（最近
// 一次开启）顶替，也不能拿 agent_activity_daily 的 MAX(updatetime) 顶替——后者在一台一周
// 没干活的机器上会停在一周前，而它其实一直在正常上报空结果。
//
// activity_backfill_from 是拉取的**下界日**，在开启那一刻写死：勾了「一并回填历史」就写
// 空串（没有下界），没勾就写当天。它必须落在库里而不是当场跑一次回填——since_day 取自
// 「这台机器已经收到的最后一天」，一台从没上报过的机器那个值是空串，而空串的意思正是
// 「把你有的全给我」。少了这一列，取消回填与勾上回填跑出来的结果一模一样，用户的选择
// 静默失效；而写在库里，一台当时离线的机器几个月后回来，那个下界依然在。
func migration202608280002() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608280002",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.Exec(`
				CREATE TABLE agent_activity_daily (
				  user_id          bigint NOT NULL,
				  day              char(10) COLLATE utf8mb4_0900_bin NOT NULL,
				  peer_fingerprint varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  agent_sync_id    varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  backend_type     varchar(64) NOT NULL DEFAULT '',
				  provider_key     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  model_key        varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  project_sync_id  varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  session_count    int NOT NULL DEFAULT 0,
				  createtime       bigint NOT NULL DEFAULT 0,
				  updatetime       bigint NOT NULL DEFAULT 0,
				  dims_hash        binary(32) AS (UNHEX(SHA2(CONCAT_WS(0x1F,
				                     peer_fingerprint, agent_sync_id, backend_type,
				                     provider_key, model_key, project_sync_id), 256))) STORED NOT NULL,
				  PRIMARY KEY (user_id, day, dims_hash),
				  KEY idx_agent_activity_daily_machine (user_id, peer_fingerprint, day)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error; err != nil {
				return err
			}
			return tx.Exec(`
				CREATE TABLE user_settings (
				  user_id                   bigint NOT NULL PRIMARY KEY,
				  activity_stats_enabled    tinyint(1) NOT NULL DEFAULT 0,
				  activity_stats_enabled_at bigint NOT NULL DEFAULT 0,
				  activity_last_pull_at     bigint NOT NULL DEFAULT 0,
				  activity_backfill_from    char(10) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  createtime                bigint NOT NULL DEFAULT 0,
				  updatetime                bigint NOT NULL DEFAULT 0
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			if err := tx.Exec(`DROP TABLE IF EXISTS agent_activity_daily;`).Error; err != nil {
				return err
			}
			return tx.Exec(`DROP TABLE IF EXISTS user_settings;`).Error
		},
	}
}
