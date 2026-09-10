package agent_session_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// WriteFrames 必须批量落在一条语句里，且用 DO NOTHING 收主键
// (user_id, conversation_id, seq)：attach 期间的实时通知与断连重连后的
// pull 补齐窗口会有重叠，同一条帧落两次不能变成两行,也不能报错。
func TestWriteFrames_BatchSingleStatement(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewJournalFrame()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `agent_session_notification_journal`",
	)).WithArgs(
		int64(7), "conv-9", int64(101), "fp-daemon-1", []byte{0x0a, 0x01, 0xff}, int64(1000),
		int64(7), "conv-9", int64(102), "fp-daemon-1", []byte{0x12, 0x01, 0x00}, int64(1001),
	).WillReturnResult(sqlmock.NewResult(1, 2))
	mock.ExpectCommit()

	frames := []*agent_session_entity.JournalFrame{
		{UserID: 7, ConversationID: "conv-9", PeerFingerprint: "fp-daemon-1", Seq: 101, Payload: []byte{0x0a, 0x01, 0xff}, Createtime: 1000},
		{UserID: 7, ConversationID: "conv-9", PeerFingerprint: "fp-daemon-1", Seq: 102, Payload: []byte{0x12, 0x01, 0x00}, Createtime: 1001},
	}
	require.NoError(t, r.WriteFrames(ctx, frames))
	require.NoError(t, mock.ExpectationsWereMet())
}

// 一条已经落库的帧被原样重放（同一 seq 再来一次）：DO NOTHING 落到 0 行变化，
// 调用方仍然成功——这是「replayed frame must not duplicate or error」的核心断言。
func TestWriteFrames_GivenReplayedFrame_ThenNoDuplicateNoError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewJournalFrame()

	mock.ExpectBegin()
	// 钉住**自赋值**这个形状，而不是只看见 "ON DUPLICATE KEY UPDATE" 就算数：
	// 赋值右边一旦不是被赋的那一列，重放就从「什么都不改」变成「用后到的值覆盖」，
	// 而两条断言的措辞完全一样。
	mock.ExpectExec(regexp.QuoteMeta("ON DUPLICATE KEY UPDATE `user_id`=`user_id`")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	frames := []*agent_session_entity.JournalFrame{
		{UserID: 7, ConversationID: "conv-9", PeerFingerprint: "fp-daemon-1", Seq: 101, Payload: []byte{0x0a, 0x01, 0xff}, Createtime: 1000},
	}
	require.NoError(t, r.WriteFrames(ctx, frames))
	require.NoError(t, mock.ExpectationsWereMet())
}

// 空批次是 no-op：不发任何语句。attach 刚建立、还没有任何帧要落库时的正常路径,
// 不应该拿一个空切片去撞 gorm 的「empty slice found」。
func TestWriteFrames_GivenEmptySlice_ThenNoStatement(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewJournalFrame()

	require.NoError(t, r.WriteFrames(ctx, nil))
	require.NoError(t, mock.ExpectationsWereMet()) // 没有设任何期望：一发语句这里就会报错
}

// ListFramesBySeq 按 (user_id, conversation_id) 圈定单条会话,
// seq 严格大于游标（独占,与 wire.SessionPullParams.Cursor 同一口径),按 seq 升序、
// 用 limit 分页——断连重连时按自己存的游标补齐缺口靠的就是这个形状。
func TestListFramesBySeq_ScopedAndOrderedBySeqAscending(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewJournalFrame()

	rows := sqlmock.NewRows([]string{
		"user_id", "conversation_id", "peer_fingerprint", "seq", "payload", "createtime",
	}).
		AddRow(7, "conv-9", "fp-daemon-1", 101, []byte{0x0a, 0x01, 0xff}, 1000).
		AddRow(7, "conv-9", "fp-daemon-1", 102, []byte{0x12, 0x01, 0x00}, 1001)
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `agent_session_notification_journal` WHERE user_id=? AND conversation_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
	)).WithArgs(int64(7), "conv-9", int64(100), 50).WillReturnRows(rows)

	out, err := r.ListFramesBySeq(ctx, 7, "conv-9", 100, 50)
	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, int64(101), out[0].Seq)
	assert.Equal(t, int64(102), out[1].Seq)
	// 列名换过顺序,只断言 Seq 的话「扫错列」会静默通过:身份那两列必须各归各位。
	assert.Equal(t, "conv-9", out[0].ConversationID)
	assert.Equal(t, "fp-daemon-1", out[0].PeerFingerprint)
	require.NoError(t, mock.ExpectationsWereMet())
}

// DeleteFrames 清掉一条对话在这个身份键下的全部帧：删除时清账号里那一份，以及
// 会话标识被执行端复用时把旧对话的整段先清干净——批量写是 ON CONFLICT DO NOTHING，
// 不清就会让旧帧原地胜出，页面上显示的是另一条对话的转录。
// 两列缺一不可：少了 user_id 是跨账号删，少了 conversation_id 会连累别的
// 那条同号会话。
func TestDeleteFrames_ScopedToTheWholeIdentity(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewJournalFrame()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"DELETE FROM `agent_session_notification_journal` WHERE user_id=? AND conversation_id=?",
	)).WithArgs(int64(7), "conv-42").WillReturnResult(sqlmock.NewResult(0, 5))
	mock.ExpectCommit()

	require.NoError(t, r.DeleteFrames(ctx, 7, "conv-42"))
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListFramesBefore 是**反向**读：详情页打开一条对话时要的是它最后那一段，而不是
// 从头翻（规格 2026-08-21-transcript-tail-loading）。
//
// 三条形状缺一不可：
//   - seq 严格小于上界（排他，与正向那条的 seq> 对称），0 表示从最新往回；
//   - 按 seq **降序** 取，limit 才落在「最新的 n 条」上——升序加 limit 取到的是
//     整条对话最老的 n 条，正好相反；
//   - 身份键仍是三列，少一列就是跨账号 / 跨发起端读。
//
// 交回的顺序保持降序（最新在前）：调用方是按预算从最新往回累计的，倒过来给它
// 还得再翻一次。
func TestListFramesBefore_NewestFirstAndExclusiveUpperBound(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewJournalFrame()

	rows := sqlmock.NewRows([]string{
		"user_id", "conversation_id", "peer_fingerprint", "seq", "payload", "createtime",
	}).
		AddRow(7, "conv-9", "fp-daemon-1", 102, []byte{0x12, 0x01, 0x00}, 1001).
		AddRow(7, "conv-9", "fp-daemon-1", 101, []byte{0x0a, 0x01, 0xff}, 1000)
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `agent_session_notification_journal` WHERE user_id=? AND conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
	)).WithArgs(int64(7), "conv-9", int64(103), 50).WillReturnRows(rows)

	out, err := r.ListFramesBefore(ctx, 7, "conv-9", 103, 50)
	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, int64(102), out[0].Seq)
	assert.Equal(t, int64(101), out[1].Seq)
	assert.Equal(t, "conv-9", out[0].ConversationID)
	assert.Equal(t, "fp-daemon-1", out[0].PeerFingerprint)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 上界 0 = 从最新往回。它不能被当成「seq<0」发出去——那会一行都取不到，详情页
// 于是把一条有内容的对话显示成空的。
func TestListFramesBefore_ZeroUpperBoundReadsFromNewest(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewJournalFrame()

	rows := sqlmock.NewRows([]string{
		"user_id", "conversation_id", "peer_fingerprint", "seq", "payload", "createtime",
	}).AddRow(7, "conv-9", "fp-daemon-1", 300, []byte{0x0a, 0x01, 0xff}, 1009)
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `agent_session_notification_journal` WHERE user_id=? AND conversation_id=? ORDER BY seq DESC LIMIT ?",
	)).WithArgs(int64(7), "conv-9", 50).WillReturnRows(rows)

	out, err := r.ListFramesBefore(ctx, 7, "conv-9", 0, 50)
	require.NoError(t, err)
	require.Len(t, out, 1)
	assert.Equal(t, int64(300), out[0].Seq)
	require.NoError(t, mock.ExpectationsWereMet())
}
