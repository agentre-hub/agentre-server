package migrations

import (
	"fmt"

	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"

	"github.com/agentre-hub/agentre-server/internal/pkg/conversationid"
)

// conversationIDTables 是四张要回填的镜像表。列名在四张表上同名同义
// （user_id / peer_fingerprint / peer_session_id），所以回填只有一份实现。
var conversationIDTables = []string{
	"agent_sessions",
	"agent_session_notification_journal",
	"agent_session_delete_todos",
	"agent_session_saves",
}

// backfillBatchSize 是一批取多少个**身份**（不是多少行）。
// agent_session_notification_journal 一个身份下可以有成千上万帧，按身份成批因此比按行成批
// 稳得多：批的大小以对话数计，而不是以帧数计。
const backfillBatchSize = 500

// conversationIdentity 是一条对话在换键之前的身份：账号 + 发起端 + 那一端的会话标识。
type conversationIdentity struct {
	UserID          int64  `gorm:"column:user_id"`
	PeerFingerprint string `gorm:"column:peer_fingerprint"`
	PeerSessionID   string `gorm:"column:peer_session_id"`
}

// migration202609010002 按决策 2 给四张镜像表回填 conversation_id。
//
// 派生规则是 UUIDv5(NS_AGENTRE_CONVERSATION, peer_fingerprint + "\0" + peer_session_id)
// （internal/pkg/conversationid）。桌面端对**同一批对话**用同样的输入算出同样的值，
// 两边因此在互不通信的情况下换到同一个身份上；算不一致的那天，镜像里的存量对话
// 全体成孤儿。那件事的机械保证是 conversationid_test.go 里那组与上游逐字相同的向量，
// 不在这里。
//
// 只回填、不换键：换键是 202609010003。分开的理由见 202609010001 的注释。
func migration202609010002() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609010002",
		Migrate: func(tx *gorm.DB) error {
			for _, table := range conversationIDTables {
				if err := backfillConversationIDs(tx, table); err != nil {
					return fmt.Errorf("backfill conversation_id on %s: %w", table, err)
				}
			}
			return nil
		},
		// 回填不可回滚成「原来的样子」：原来的样子就是空串，而把它清回空串会连同
		// 换键之后新写进来的行一起清掉。降级要撤的是 202609010001 那一列本身。
		Rollback: func(*gorm.DB) error { return nil },
	}
}

// backfillConversationIDs 把一张表里还没有身份的行按批补上，直到一行不剩。
//
// **可分批、可重入**，而不是「一个大事务，失败整体回滚」：
// agent_session_notification_journal 的体量没有上界（帧只在对话被删时才消失），把整张表
// 的回填压进一个事务，等于用一个无上界的 undo log 去换一个这里本来就不需要的保证。
// 不需要，是因为每一条 UPDATE 自己就是原子的，而 `conversation_id = ”` 这个判据让
// 中途失败的下一次运行**从断点接着跑**：已经补上的行选不出来，没补上的行照旧被选中，
// 而同一个身份两次算出的 uuid 逐位相同。重跑一遍不改任何一行。
//
// 每一轮都重新查（而不是一次查全再遍历）也是这个道理：本轮的 UPDATE 会把这一批从
// 下一轮的结果集里挪走，循环因此在补完的那一刻自然停下。
func backfillConversationIDs(tx *gorm.DB, table string) error {
	for {
		var batch []conversationIdentity
		if err := tx.Raw(
			"SELECT DISTINCT user_id, peer_fingerprint, peer_session_id FROM "+table+
				" WHERE conversation_id = '' LIMIT ?", backfillBatchSize,
		).Scan(&batch).Error; err != nil {
			return err
		}
		if len(batch) == 0 {
			return nil
		}
		for _, identity := range batch {
			derived := conversationid.Derive(
				conversationid.Namespace, identity.PeerFingerprint, identity.PeerSessionID)
			// WHERE 里再带一次 conversation_id = ''：这一条 UPDATE 因此只碰本轮
			// 选中的那些行，不会把换键之后新写进来的同身份行改写掉。
			if err := tx.Exec(
				"UPDATE "+table+" SET conversation_id = ? WHERE user_id = ? AND "+
					"peer_fingerprint = ? AND peer_session_id = ? AND conversation_id = ''",
				derived, identity.UserID, identity.PeerFingerprint, identity.PeerSessionID,
			).Error; err != nil {
				return err
			}
		}
	}
}
