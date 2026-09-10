package agent_session_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/database/db"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// UpsertSummary 必须是一条语句：命中 uk_agent_sessions_identity
// (user_id, conversation_id) 时覆盖除 createtime 外的全部可变列——
// 这条记录反映的是发起端上报的最新状态，不是「谁先谁赢」的版本竞态。绑定值一并
// 钉住：少绑一列时唯一索引的裁决对象或者覆盖到的字段就变了，只看 SQL 文本看不出来。
func TestUpsertSummary_SingleStatementOverwritesAllButCreatetime(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("ON DUPLICATE KEY UPDATE")).
		WithArgs(
			int64(7), "conv-1", "fp-daemon-1", // user_id, conversation_id, peer_fingerprint
			"Fix the bug", "agent-sync-1", "provider-sess-1", "/repo",
			"01KZN9FVVD69NY8M0VCEAABNMZ", // project_sync_id：对端自己说出来的项目归属
			"claude_code", "running",
			true, int64(42), int64(1700), // backend_type..waiting_for_input, latest_seq, last_message_at
			"prov-anthropic", "sonnet-4-6", // 这条对话自己钉的 ModelTarget，逐字镜像发起端
			int64(0),                 // last_read_at：发起端不知道这个账号读到哪了
			int64(1000), int64(2000), // createtime, updatetime
		).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	s := &agent_session_entity.SessionSummary{
		UserID: 7, ConversationID: "conv-1",
		PeerFingerprint: "fp-daemon-1",
		Title:           "Fix the bug", AgentSyncID: "agent-sync-1", ProviderSessionID: "provider-sess-1",
		Cwd: "/repo", ProjectSyncID: "01KZN9FVVD69NY8M0VCEAABNMZ",
		BackendType: "claude_code", LifecycleState: "running",
		WaitingForInput: true, LatestSeq: 42, LastMessageAt: 1700,
		ProviderKey: "prov-anthropic", ModelKey: "sonnet-4-6",
		Createtime: 1000, Updatetime: 2000,
	}
	require.NoError(t, r.UpsertSummary(ctx, s))
	require.NoError(t, mock.ExpectationsWereMet())
}

// last_read_at **不在** ON DUPLICATE KEY UPDATE 的赋值列里：发起端上报的是活动，
// 它并不知道这个账号读到哪了。混进去的话，对端每报一次状态就会把这条对话重新标成
// 已读——于是「未读」这一档永远是空的，而且不报任何错。
//
// 这里钉的是**整张赋值列表**而不是「不含某个词」：多出任何一列都该在这里变红。
func TestUpsertSummary_NeverResetsLastReadAt(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"ON DUPLICATE KEY UPDATE `peer_fingerprint`=VALUES(`peer_fingerprint`),`title`=VALUES(`title`),"+
			"`agent_sync_id`=VALUES(`agent_sync_id`),"+
			"`provider_session_id`=VALUES(`provider_session_id`),"+
			"`cwd`=VALUES(`cwd`),`project_sync_id`=VALUES(`project_sync_id`),"+
			"`backend_type`=VALUES(`backend_type`),"+
			"`lifecycle_state`=VALUES(`lifecycle_state`),"+
			"`waiting_for_input`=VALUES(`waiting_for_input`),"+
			"`latest_seq`=VALUES(`latest_seq`),`last_message_at`=VALUES(`last_message_at`),"+
			"`provider_key`=VALUES(`provider_key`),`model_key`=VALUES(`model_key`),"+
			"`updatetime`=VALUES(`updatetime`)",
	) + "$").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	s := &agent_session_entity.SessionSummary{
		UserID: 7, ConversationID: "conv-1", PeerFingerprint: "fp-1",
	}
	require.NoError(t, r.UpsertSummary(ctx, s))
	require.NoError(t, mock.ExpectationsWereMet())
}

// ListSummariesByUser 只按账号过滤：一条镜像行属于一个账号，读的时候忘记这一条
// 就是跨账号泄漏。
// savesJoinSQL 是 joinSaves 拼出的那条 LEFT JOIN。**只有问到承载机器的路径带它**
// （投影 machine_fingerprint、按机器过滤、按机器/位置分组）；纯计数那几条不带，
// 见 TestCountSummaries_AggregatesInSQL 与 TestCountAttention_BothNumbersInOneQuery
// 里刻意钉住的「FROM `agent_sessions` WHERE」——它们每进一次页面就跑一遍，白接一次
// 索引查找是实打实的成本。
const savesJoinSQL = "LEFT JOIN agent_session_saves" +
	" ON agent_session_saves.user_id=agent_sessions.user_id" +
	" AND agent_session_saves.conversation_id=agent_sessions.conversation_id"

func TestListSummariesByUser_AccountScoped(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	rows := sqlmock.NewRows([]string{
		"id", "user_id", "conversation_id", "peer_fingerprint", "title", "last_message_at",
		"machine_fingerprint",
	}).
		AddRow(1, 7, "conv-9", "fp-browser-1", "Fix the bug", 2000, "fp-daemon-1").
		AddRow(2, 7, "conv-8", "fp-daemon-1", "Refactor", 1000, "fp-daemon-1")
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `agent_sessions` " + savesJoinSQL +
			" WHERE agent_sessions.user_id=? ORDER BY last_message_at DESC, agent_sessions.id DESC",
	)).WithArgs(int64(7)).WillReturnRows(rows)

	out, err := r.ListSummariesByUser(ctx, 7)
	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, "conv-9", out[0].ConversationID)
	assert.Equal(t, int64(7), out[0].UserID)
	assert.Equal(t, "fp-browser-1", out[0].PeerFingerprint)
	assert.Equal(t, "fp-daemon-1", out[0].MachineFingerprint)
	require.NoError(t, mock.ExpectationsWereMet())
}

// DeleteSummary 撤掉一条对话的摘要：删除时账号里这一份连同它的转录一起消失，
// 索引里立刻看不到它（决策 6：界面上不留「已删除但还在」的中间态）。
// 身份键两列齐全，理由与 DeleteFrames 相同。
func TestDeleteSummary_ScopedToTheWholeIdentity(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"DELETE FROM `agent_sessions` WHERE user_id=? AND conversation_id=?",
	)).WithArgs(int64(7), "conv-42").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	require.NoError(t, r.DeleteSummary(ctx, 7, "conv-42"))
	require.NoError(t, mock.ExpectationsWereMet())
}

// ── 索引的分页读（2026-08-19-session-index-pagination.md 决策 1 / 7） ──────────

// 第一页：没有游标就不该出现游标判据，但排序与 LIMIT 必须在——少了 LIMIT 这条读
// 就还是「一次拿全份」，分页等于没做。
func TestListSummariesPage_FirstPage_AccountScopedOrderedAndLimited(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta(
		"WHERE agent_sessions.user_id=? ORDER BY last_message_at DESC, agent_sessions.id DESC LIMIT ?",
	)).WithArgs(int64(7), 50).WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}).AddRow(1, 7))

	out, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7}, Limit: 50,
	})
	require.NoError(t, err)
	require.Len(t, out, 1)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 带游标时取的是**严格排在它之后**的那些：(last_message_at, id) 是一个复合位置，
// 只比 last_message_at 会把同一毫秒里的行重复发一遍或整批跳过。
func TestListSummariesPage_WithCursor_TakesStrictlyAfterIt(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta(
		"(last_message_at < ? OR (last_message_at = ? AND agent_sessions.id < ?))",
	)).WithArgs(int64(7), int64(1700), int64(1700), int64(42), 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7},
		Cursor:       SummaryCursor{LastMessageAt: 1700, ID: 42},
		Limit:        50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 搜索只按标题（决策 8），筛选按生命周期与「在等输入」（决策 9）——两者与账号范围
// 复合，不是三选一。
func TestListSummariesPage_TitleSearchAndWaitingFilterCompose(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("title LIKE ?")).
		WithArgs(int64(7), "%bug%", true, 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, TitleLike: "bug", Attention: AttentionNeedsAttention},
		Limit:        50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 「运行中」是 running **且不在等输入**：等你处理优先，两个 chip 不能同时命中同一条
// （判据与前端 matchesSessionFilter 逐字一致）。
func TestListSummariesPage_RunningExcludesWaiting(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("waiting_for_input=? AND lifecycle_state=?")).
		WithArgs(int64(7), false, "running", 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, Attention: AttentionRunning},
		Limit:        50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 搜索词里的 LIKE 元字符必须转义：搜「50%」要搜的是这三个字符，不是「50 开头的任何
// 标题」。不转义时通配符由用户输入控制，命中集合会悄悄放大。
func TestListSummariesPage_EscapesLikeMetacharactersInSearch(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("title LIKE ?")).
		WithArgs(int64(7), `%50\%\_a\\b%`, 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, TitleLike: `50%_a\b`},
		Limit:        50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// Agent 轴的一组 = 该 Agent 名下的会话；「未命名 Agent」那一组是 agent_sync_id 为
// 空串的那些——它是一个**真实的值**，不是「不过滤」，所以判据用指针区分。
func TestListSummariesPage_AgentScope_EmptyStringIsTheUnnamedGroup(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	unnamed := ""
	mock.ExpectQuery(regexp.QuoteMeta("agent_sync_id=?")).
		WithArgs(int64(7), "", 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, AgentSyncID: &unnamed},
		Limit:        50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 项目轴的一组有两拨会话，判据因此是**或**：对端自己报了这个项目的（桌面端），
// 以及没报项目、但位置落在该项目任一位置上的（agentred，决策 12）。
//
// 位置是 (承载机器指纹, cwd) 这个**对**，不是 cwd 单独一列：同一个路径在两台机器上是
// 两个不同的地方。两半写成**与**的话这一组一条都取不到——没有哪条会话两边都占。
//
// 指纹那一半取自保存名单（承载这条对话的那台机器），不是 agent_sessions 的
// peer_fingerprint：浏览器派出去的对话，发起端是浏览器，配不上任何机器上的路径。
func TestListSummariesPage_ProjectScope_MatchesReportedOrLocated(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta(
		"(project_sync_id=? OR (project_sync_id='' AND ("+machineFingerprintExpr+
			", cwd) IN ((?,?),(?,?))))")).
		WithArgs(int64(7), "proj-1", "fp-a", "/repo/x", "fp-b", "/repo/y", 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, ProjectMode: ProjectIs, ProjectSyncID: "proj-1",
			Locations: []SummaryLocation{
				{MachineFingerprint: "fp-a", Cwd: "/repo/x"},
				{MachineFingerprint: "fp-b", Cwd: "/repo/y"},
			}},
		Limit: 50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 一台 agentred 都没配路径的项目（web 上建出来、还没挑工作目录的那种，2026-08-20
// 决策 7）照样有对话：桌面端点了名的那些。位置名单空着不等于这一组是空的。
func TestListSummariesPage_ProjectScopeWithNoLocations_StillMatchesReported(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("project_sync_id=?")).
		WithArgs(int64(7), "proj-1", 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, ProjectMode: ProjectIs, ProjectSyncID: "proj-1"},
		Limit:        50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 「未归项目」是**既没报项目、也不落在任何已知项目位置**上的那些，cwd 为空的自然
// 也在其中。报了项目的一条都不在这里，哪怕它报的那个项目已经被删了——那种行由服务层
// 在读回之后判掉（决策 13），因为「这个标识还活着吗」要拿账号项目名单才答得出。
func TestListSummariesPage_UnassignedProjectScope_ExcludesReportedAndKnownLocations(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("project_sync_id=''")+`.*`+
		regexp.QuoteMeta("("+machineFingerprintExpr+", cwd) NOT IN ((?,?))")).
		WithArgs(int64(7), "fp-a", "/repo/x", 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, ProjectMode: ProjectUnassigned,
			Locations: []SummaryLocation{{MachineFingerprint: "fp-a", Cwd: "/repo/x"}}},
		Limit: 50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 两半判据都空的项目里一条会话都没有。空判据如果被当成「不过滤」，这一组会把整个
// 账号的会话都列进去——那是最坏的一种错。
func TestListSummariesPage_ProjectScopeWithNoCriteria_MatchesNothing(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("1=0")).
		WithArgs(int64(7), 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	out, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, ProjectMode: ProjectIs},
		Limit:        50,
	})
	require.NoError(t, err)
	assert.Empty(t, out)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 详情页按对话标识精确查（决策 13）：它要的不是一页，而是「这条在不在」，
// 所以既不排序也不限条数。
func TestListSummariesPage_ConversationIDIsExactAndUnpaged(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("conversation_id=?")).
		WithArgs(int64(7), "conv-42").
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, ConversationID: "conv-42"},
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 顶栏那个数是 COUNT 出来的，不是把行拉回来再 len()——后者等于绕过分页又读一次全份。
func TestCountSummaries_AggregatesInSQL(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT count(*) FROM `agent_sessions` WHERE agent_sessions.user_id=?")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(int64(137)))

	got, err := r.CountSummaries(ctx, SummaryQuery{UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, int64(137), got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 「查看全部 N」的 N 是每组各自的真数，因此按组聚合一次拿全，而不是每组各查一遍。
func TestCountSummariesByAgent_GroupsInSQL(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("GROUP BY `agent_sync_id`")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"group_key", "total"}).
			AddRow("agent-1", int64(9)).AddRow("", int64(2)))

	got, err := r.CountSummariesByAgent(ctx, SummaryQuery{UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, map[string]int64{"agent-1": 9, "": 2}, got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 项目轴的每组计数**不能**在 SQL 里直接按项目分组：报上来的标识可能指着一个已经被
// 删掉的项目（决策 13），位置要拿去跟账号项目树比（决策 12），两件事都要账号的项目
// 名单才判得了。SQL 数得出的只是判据本身，折算成项目是服务层的事。
func TestCountSummariesByProjectKey_GroupsByReportedProjectAndLocation(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("GROUP BY `project_sync_id`,`machine_fingerprint`,`cwd`")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"project_sync_id", "machine_fingerprint", "cwd", "total"}).
			AddRow("", "fp-a", "/repo/x", int64(3)).
			AddRow("proj-1", "fp-desktop", "", int64(2)).
			AddRow("", "fp-a", "", int64(1)))

	got, err := r.CountSummariesByProjectKey(ctx, SummaryQuery{UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, []SummaryProjectKeyCount{
		{SummaryProjectKey: SummaryProjectKey{MachineFingerprint: "fp-a", Cwd: "/repo/x"}, Total: 3},
		{SummaryProjectKey: SummaryProjectKey{ProjectSyncID: "proj-1", MachineFingerprint: "fp-desktop"}, Total: 2},
		{SummaryProjectKey: SummaryProjectKey{MachineFingerprint: "fp-a"}, Total: 1},
	}, got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// ── 已读状态（2026-08-20 对话页 UI/UX 改版）─────────────────────────────────
//
// 「未读」此前不是一件真事：那一档筛选叫过「未读」，但判据一直是
// waiting_for_input，规格 2026-08-17 决策 3 因此把名字改成了「等你处理」。现在它
// 有了自己的列 last_read_at，判据与桌面端 attention-store 逐字一致：
// unread = lastMessageAt > lastReadAt。

// 标记已读只碰 last_read_at 一列，WHERE 与 upsert 的冲突判定同一组身份键，外加一条
// `last_read_at<?` —— 已读时刻**只往前走**：同一条对话在两个标签页里打开时，后到的
// 那次请求可能带着更早的时刻（网络乱序），允许它往回退等于把刚读过的那条重新标成未读。
//
// SET 里**没有** last_message_at 是这条用例真正钉住的东西：这个实体有一个叫 UpdatedAt 的
// 字段，GORM 会把它当成自己的自动时间戳列。走 Updates 的话它会被顺手改成
// time.Now()，而 last_message_at 记的是发起端上报的活动时刻（毫秒），换成 GORM 的秒级
// 当前时间就等于毁掉这条对话的排序位置与游标 —— 只因为你把它读了一遍。
func TestMarkSummaryRead_TouchesOnlyLastReadAtAndOnlyMovesForward(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `agent_sessions` SET `last_read_at`=?,`updatetime`=? "+
			"WHERE user_id=? AND conversation_id=? AND last_read_at<?",
	)).
		WithArgs(int64(1700), int64(1700), int64(7), "conv-9", int64(1700)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	require.NoError(t, r.MarkSummaryRead(ctx, 7, "conv-9", 1700))
	require.NoError(t, mock.ExpectationsWereMet())
}

// 「未读」的判据与共享包 `computeAttention` 的 `unread` 那一档**逐字对应**：它是最弱
// 的一档，在跑的、等你按的、跑挂的各有更强的理由，都不算未读。
//
// 此前这里只有 `last_message_at>last_read_at` 一句：chip 上那个数因此把在跑与等你按
// 的行一起数了进去，点进去列出来的行却各自写着「running」「等你处理」，一个带
// 「未读」记号的都没有——数字与看得见的东西对不上。
func TestScoped_UnreadFilter(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta(
		"waiting_for_input=? AND lifecycle_state NOT IN (?,?) AND last_message_at>last_read_at",
	)).
		WithArgs(int64(7), false, "running", "failed").
		WillReturnRows(sqlmock.NewRows([]string{"count(*)"}).AddRow(int64(3)))

	got, err := r.CountSummaries(ctx, SummaryQuery{UserID: 7, Attention: AttentionUnread})
	require.NoError(t, err)
	assert.Equal(t, int64(3), got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 「等你处理」与「未读」是**两个数**，一次问出来。
//
// 侧栏那颗角标要说的是「有多少条在等你」，它此前只数 waiting_for_input——与索引上
// 那个「未读」chip 是完全不同的判据，于是侧栏说 1 条、点进去筛选是 0 条。两个数
// 由同一条 SQL 的两个 SUM 交出来，用的还是 attentionExpr 那一处判据，因此不可能
// 与 chip 分家。
func TestCountAttention_BothNumbersInOneQuery(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	// 整条 SQL 加参数一起钉：SELECT 子句里也有占位符，而它排在 WHERE 前面。只钉
	// 「里面有个 SUM」的话，两组参数一旦串位（账号 id 被当成 waiting_for_input 去比）
	// 这条用例照样绿，线上却会数出一个谁也解释不了的数。
	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COALESCE(SUM(CASE WHEN waiting_for_input=? THEN 1 ELSE 0 END), 0) "+
			"AS needs_attention, "+
			"COALESCE(SUM(CASE WHEN waiting_for_input=? AND lifecycle_state NOT IN (?,?) "+
			"AND last_message_at>last_read_at THEN 1 ELSE 0 END), 0) AS unread "+
			"FROM `agent_sessions` WHERE agent_sessions.user_id=?",
	)).
		WithArgs(true, false, "running", "failed", int64(7)).
		WillReturnRows(
			sqlmock.NewRows([]string{"needs_attention", "unread"}).AddRow(int64(2), int64(5)),
		)

	got, err := r.CountAttention(ctx, SummaryQuery{UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, int64(2), got.NeedsAttention)
	assert.Equal(t, int64(5), got.Unread)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 一条对话都没有的账号：SUM 在**空集合上返回 NULL**，不是 0。
//
// 这是新账号的第一次进站，而 NULL 扫进 int64 会直接报错——角标于是不是显示 0，
// 而是整条取数失败。联调库上 `WHERE user_id=7` 正是这样一行 `NULL NULL`。
// COALESCE 把它按住在数据库那一侧：0 是答案，不是错误。
func TestCountAttention_EmptyAccountIsZeroNotAnError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("COALESCE(SUM(CASE WHEN")).
		WillReturnRows(
			sqlmock.NewRows([]string{"needs_attention", "unread"}).AddRow(nil, nil),
		)

	got, err := r.CountAttention(ctx, SummaryQuery{UserID: 7})
	require.NoError(t, err)
	assert.Zero(t, got.NeedsAttention)
	assert.Zero(t, got.Unread)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 五档 attention 的 SQL 判据与共享包 `computeAttention` 的 if 链**同一个顺序**：
// 每一档都带着比它强的那几档的否定，因此任意一行至多命中一档，几档相加不会重复计数。
//
// 这条守的是那个顺序本身。共享包那一侧改了优先级而这里没跟上时，它红。
func TestAttentionExpr_MirrorsTheSharedPackagePriority(t *testing.T) {
	tests := []struct {
		name    string
		filter  AttentionFilter
		wantSQL string
	}{
		{
			name:    "needs_attention 压过一切，因此不带任何否定",
			filter:  AttentionNeedsAttention,
			wantSQL: "waiting_for_input=?",
		},
		{
			name:    "running 让位给 needs_attention",
			filter:  AttentionRunning,
			wantSQL: "waiting_for_input=? AND lifecycle_state=?",
		},
		{
			name:    "error 要未读才算，且让位给上面两档",
			filter:  AttentionError,
			wantSQL: "waiting_for_input=? AND lifecycle_state=? AND last_message_at>last_read_at",
		},
		{
			name:    "unread 最弱：在跑的、等你按的、跑挂的都不算",
			filter:  AttentionUnread,
			wantSQL: "waiting_for_input=? AND lifecycle_state NOT IN (?,?) AND last_message_at>last_read_at",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			expr, _, ok := attentionExpr(tt.filter)
			require.True(t, ok)
			assert.Equal(t, tt.wantSQL, expr)
		})
	}

	// 「全部」不是一档理由，它是「不过滤」。
	_, _, ok := attentionExpr(AttentionAny)
	assert.False(t, ok)
}

// 这条钉的不是某个调用点，而是**实体本身**：GORM 的自动时间戳认的是 Go 的**字段名**
// UpdatedAt（不是列名）。这个实体的那个字段从前正叫 UpdatedAt，于是任何一条普通
// Updates 都会被顺手追加一列 =<当前 Unix 秒>；实体上因此不得不挂 autoUpdateTime:false
// 当防线。
//
// 那一列记的是发起端上报的活动时刻（毫秒），同时是索引 idx_..._recent 的排序键、
// 分页游标的一半、以及「未读」判据 last_message_at>last_read_at 的一边。被改成秒级当前
// 时间，这条对话的排序位置与游标当场作废，而且不报任何错。
//
// 决策 10 把字段改名 LastMessageAt，陷阱随之消失，那条标签也撤掉了——**这条用例就是
// 撤掉标签的依据**：它对着裸 Updates 断言 SET 子句里只有点名的那一列。谁把字段改回
// UpdatedAt（或新加一个同名字段），它立刻红。
func TestSessionSummaryEntity_PlainUpdatesNeverRewritesLastMessageAt(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `agent_sessions` SET `last_read_at`=? WHERE id=?",
	)).
		WithArgs(int64(5), 1).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	require.NoError(t, db.Ctx(ctx).Model(&agent_session_entity.SessionSummary{}).
		Where("id=?", 1).
		Updates(map[string]any{"last_read_at": int64(5)}).Error)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 机器分组使用承载机器指纹，而非发起端指纹。
func TestCountSummariesByMachine_GroupsByTheCarryingMachine(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta(machineFingerprintExpr + " AS machine_fingerprint")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"machine_fingerprint", "total"}).
			AddRow("fp-agentred", int64(36)).
			AddRow("fp-desktop", int64(2)))

	got, err := r.CountSummariesByMachine(ctx, SummaryQuery{UserID: 7})
	require.NoError(t, err)
	assert.Equal(t, map[string]int64{"fp-agentred": 36, "fp-desktop": 2}, got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 分组使用投影别名。
func TestCountSummariesByMachine_GroupsByTheProjectedAlias(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	mock.ExpectQuery(regexp.QuoteMeta("GROUP BY `machine_fingerprint`")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"machine_fingerprint", "total"}))

	_, err := r.CountSummariesByMachine(ctx, SummaryQuery{UserID: 7})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 机器组分页与计数使用同一承载机器判据。
func TestListSummariesPage_MachineScope_FiltersByTheCarryingMachine(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSummary()

	fp := "fp-agentred"
	mock.ExpectQuery(regexp.QuoteMeta("agent_session_saves.device_fingerprint=?")).
		WithArgs(int64(7), fp, 50).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id"}))

	_, err := r.ListSummariesPage(ctx, SummaryPageQuery{
		SummaryQuery: SummaryQuery{UserID: 7, MachineFingerprint: &fp},
		Limit:        50,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}
