// Package agent_session_repo is the data access layer for the account-scoped
// agent sessions (2026-08-18-server-session-mirror.md "存什么"): a summary per
// conversation, its raw journal frames, the delete todos left behind when a
// peer was offline at delete time, and the saves list that decides which
// conversations are carried here at all.
//
// The package is named for the rows, not for the mechanism that fills them
// (2026-08-27-schema-overhaul.md 决策 19); mirroring is a verb and lives on
// mirror_svc.
package agent_session_repo

import (
	"context"
	"strings"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
)

//go:generate mockgen -source summary.go -destination mock_agent_session_repo/mock_summary.go

// SummaryRepo is the data access seam for agent_sessions.
type SummaryRepo interface {
	// UpsertSummary writes the peer's latest reported state for one
	// conversation, keyed by (user_id, peer_fingerprint, peer_session_id) —
	// agent_sessions' one unique key (migrations/202608280008_agent_sessions.go). A
	// later summary for the same identity overwrites the earlier one in a
	// single statement; createtime is preserved.
	UpsertSummary(ctx context.Context, s *agent_session_entity.SessionSummary) error
	// ListSummariesByUser returns every summary mirrored for that account —
	// the full set the unified session index reads (镜像的范围是账号里已保存的
	// 对话). Account-scoped and nothing more: a read that drops user_id is a
	// cross-account leak.
	ListSummariesByUser(ctx context.Context, userID int64) ([]*agent_session_entity.SessionSummary, error)
	// ListSummariesPage 按游标读一页摘要，判据全在 SummaryPageQuery 里
	// （2026-08-19-session-index-pagination.md 决策 1 / 7）。Limit ≤ 0 时不限条数
	// ——那是「按会话号精确查」那条路径要的形状，它要的不是一页。
	ListSummariesPage(ctx context.Context, q SummaryPageQuery) ([]*agent_session_entity.SessionSummary, error)
	// CountSummaries 数出同一组判据下的条数——顶栏那个「这个账号有几条」（决策 10）。
	// 它必须是 COUNT：把行拉回来再 len() 等于绕过分页又读一次全份。
	CountSummaries(ctx context.Context, q SummaryQuery) (int64, error)
	// CountSummariesByAgent / CountSummariesByPeer 是「查看全部 N」那个 N 的来源
	// （决策 6）：一次按组聚合拿全，而不是每组各查一遍。键是 agent_sync_id /
	// peer_fingerprint 的原值，空串是「未命名 Agent」那一组的真实键。
	CountSummariesByAgent(ctx context.Context, q SummaryQuery) (map[string]int64, error)
	CountSummariesByPeer(ctx context.Context, q SummaryQuery) (map[string]int64, error)
	// CountSummariesByProjectKey 按「据以判定项目归属的那一组值」聚合：对端自己报的
	// project_sync_id，加上 (发起端指纹, cwd) 这个位置。
	//
	// 折算成项目仍然是**服务层**的事，SQL 一步都不做：报上来的标识可能指着一个已经
	// 被删掉的项目（决策 13：那样的对话落回未归项目），而位置要拿去跟账号项目树比
	// （决策 12）。两件事都要账号里的项目名单才判得了，仓储不认识项目。
	CountSummariesByProjectKey(ctx context.Context, q SummaryQuery) ([]SummaryProjectKeyCount, error)
	// MarkSummaryRead 记下「这个账号此刻读到这条对话为止」。身份键与 UpsertSummary
	// 的冲突判定同一组，碰的只有 last_read_at 一列 —— 发起端上报的是活动，它并不
	// 知道这个账号读到哪了，所以这一列不在 upsert 的赋值列里。
	//
	// 时刻**只往前走**：同一条对话在两个标签页里打开时，后到的那次请求可能带着
	// 更早的时刻（网络乱序），允许它往回退等于把刚读过的那条重新标成未读。
	// 一行都没命中仍然成功——没镜像过的对话没有「读到哪」这回事。
	MarkSummaryRead(
		ctx context.Context, userID int64, peerFingerprint, peerSessionID string, at int64,
	) error
	// DeleteSummary 撤掉一条对话的摘要，按同一个身份键
	// (user_id, peer_fingerprint, peer_session_id)。账号里删掉这条对话时它与转录一起
	// 消失，索引里当场就没了（决策 6：不留「已删除但还在」的中间态）。
	// 从来没镜像过的对话删不到行，仍然成功——删除幂等。
	DeleteSummary(ctx context.Context, userID int64, peerFingerprint, peerSessionID string) error
}

// SummaryCursor 是「上一页读到哪」：(last_message_at, id) 这个**复合**位置。只比
// last_message_at 会让同一毫秒里的行在两页之间重复出现或整批跳过——这张表的 last_message_at
// 是发起端自己记的活动时刻，同毫秒撞车是常态而不是边角。零值表示从头翻。
type SummaryCursor struct {
	LastMessageAt int64
	ID            int64
}

// IsZero 表示「从头翻」。last_message_at 为 0 的老会话（发起端从没记过活动时间）排在最后，
// 它们的游标 ID 不为 0，因此不会被误判成起点。
func (c SummaryCursor) IsZero() bool { return c.LastMessageAt == 0 && c.ID == 0 }

// SummaryLocation 是一条对话的落地位置：(发起端指纹, cwd)。项目归属就是拿它跟账号
// 项目树上的位置比出来的——**指纹是这个键的一半**：同一个路径在两台机器上是两个
// 不同的地方。
type SummaryLocation struct {
	PeerFingerprint string
	Cwd             string
}

// SummaryProjectKey 是一条对话据以判定项目归属的那一组值。它有两半，因为两种对端
// 交出来的事实不一样：
//
//   - ProjectSyncID：桌面端自己点的名。它没有「这条会话的 cwd」这种东西（工作目录
//     是每轮按项目本机路径现算的），项目同步标识才是它手里真实存在的那一维。
//   - PeerFingerprint + Cwd：agentred 的落地位置，拿去跟账号项目树上的路径比
//     （决策 12）。**指纹是这个键的一半**：同一个路径在两台机器上是两个不同的地方。
//
// 一条对话上只会有一半非空。非空的那一半就是它的判据，两者不相加也不互相覆盖。
type SummaryProjectKey struct {
	ProjectSyncID   string
	PeerFingerprint string
	Cwd             string
}

// SummaryProjectKeyCount 是同一组判据下有多少条对话。
type SummaryProjectKeyCount struct {
	SummaryProjectKey
	Total int64
}

// ProjectMode 说明项目轴这一组要的是什么。它把「报上来的标识」与「位置名单」这两半
// 合成一条判据，而不是两个各自独立的过滤器：同一个项目下两种对端的对话都在，用两个
// **与**关系的判据表达就一条都取不到。
type ProjectMode uint8

const (
	// ProjectAny 不按项目过滤。
	ProjectAny ProjectMode = iota
	// ProjectIs 是某个项目那一组：报了这个标识的，**或**没报标识、但位置落在
	// Locations 里的。ProjectSyncID 与 Locations 都空时一条都不要——一个位置都没配、
	// 也没有任何对端点过名的项目里本来就没有对话，当成「不过滤」会让这一组列出整个账号。
	ProjectIs
	// ProjectUnassigned 是未归项目那一组：既没报标识，位置也配不上任何已知位置。
	// cwd 为空、又没报标识的自然在其中。
	ProjectUnassigned
)

// LifecycleFilter 是索引上那三个筛选 chip 的服务端判据（决策 9）。
type LifecycleFilter uint8

const (
	// LifecycleAny = 「全部」。
	LifecycleAny LifecycleFilter = iota
	// LifecycleRunning = 「运行中」：running **且不在等输入**。等你处理优先，
	// 两个 chip 不能同时命中同一条。
	LifecycleRunning
	// LifecycleWaiting = 「等你处理」。
	LifecycleWaiting
	// LifecycleUnread = 「未读」：这条对话最后一次活动晚于我最后一次读它。
	// 与桌面端 attention-store 的 `lastMessageAt > lastReadAt` 同一条判据。
	//
	// 它与「等你处理」是**两件事**，不是同一件事的两个名字：一条你已经看过、
	// 只是停在那儿等输入的对话不是未读；一条跑出了新结果但不等输入的是。
	LifecycleUnread
)

// SummaryQuery 是一次索引读取的全部判据。它只谈这张表自己的列：project_sync_id 在
// 这里只是一个不透明的值，「这个标识还指着一个活着的项目吗」「这些位置属于哪个项目」
// 都要账号的项目名单才答得出，那是服务层的事（决策 12 / 13），仓储不认识项目。
type SummaryQuery struct {
	UserID int64
	// TitleLike 是搜索词的原文（决策 8：只按标题）。LIKE 的元字符在这里转义，
	// 调用方传的是用户敲的那几个字符，不是一段模式。
	TitleLike string
	Lifecycle LifecycleFilter
	// PeerSessionID 非空时按会话号精确匹配（决策 13，详情页认领发起端用）。
	PeerSessionID string
	// AgentSyncID / PeerFingerprint 用指针区分「不过滤」与「过滤成空串」——
	// 空串是「未命名 Agent」那一组的**真实键**，不是缺省值。
	AgentSyncID     *string
	PeerFingerprint *string
	// ProjectSyncID / Locations 一起构成项目轴那一组的判据，怎么用由 ProjectMode 说了算。
	ProjectSyncID string
	Locations     []SummaryLocation
	ProjectMode   ProjectMode
}

// SummaryPageQuery 在判据之上加位置与大小。
type SummaryPageQuery struct {
	SummaryQuery
	Cursor SummaryCursor
	// Limit ≤ 0 表示不限条数（精确查那条路径）。夹默认值与上限是服务层的事。
	Limit int
}

var defaultSummary SummaryRepo

func Summary() SummaryRepo          { return defaultSummary }
func RegisterSummary(i SummaryRepo) { defaultSummary = i }
func NewSummary() SummaryRepo       { return &summaryRepo{} }

type summaryRepo struct{}

// UpsertSummary 的赋值列里没有 user_id / peer_fingerprint / session_id
// （它们是冲突判定的身份键，改它们就等于改成另一条记录的身份）也没有 createtime
// （命中已有行时保留它首次落地的时间）。agent_sessions 上只有
// uk_agent_sessions_identity 这一个唯一键（migrations/202608280008_agent_sessions.go 的
// 注释），因此 ON DUPLICATE KEY UPDATE 命中的必然是它——docs/architecture.md
// 「只在表恰好一个唯一键时安全」。
func (r *summaryRepo) UpsertSummary(ctx context.Context, s *agent_session_entity.SessionSummary) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "user_id"}, {Name: "peer_fingerprint"}, {Name: "peer_session_id"},
		},
		DoUpdates: clause.AssignmentColumns([]string{
			"title", "agent_sync_id", "provider_session_id", "cwd", "project_sync_id",
			"backend_type", "lifecycle_state", "waiting_for_input", "latest_seq",
			"last_message_at", "provider_key", "model_key", "updatetime",
		}),
	}).Create(s).Error
}

func (r *summaryRepo) ListSummariesByUser(ctx context.Context, userID int64) ([]*agent_session_entity.SessionSummary, error) {
	var out []*agent_session_entity.SessionSummary
	if err := db.Ctx(ctx).Where("user_id=?", userID).
		Order("last_message_at DESC, id DESC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteSummary 的 WHERE 与 UpsertSummary 的冲突判定同一组列：删的必须正好是那条
// upsert 认作「同一条」的记录，少一列就删多了。
func (r *summaryRepo) DeleteSummary(
	ctx context.Context, userID int64, peerFingerprint, peerSessionID string,
) error {
	return db.Ctx(ctx).Where(
		"user_id=? AND peer_fingerprint=? AND peer_session_id=?", userID, peerFingerprint, peerSessionID,
	).Delete(&agent_session_entity.SessionSummary{}).Error
}

func (r *summaryRepo) MarkSummaryRead(
	ctx context.Context, userID int64, peerFingerprint, peerSessionID string, at int64,
) error {
	return db.Ctx(ctx).Model(&agent_session_entity.SessionSummary{}).
		Where(
			"user_id=? AND peer_fingerprint=? AND peer_session_id=? AND last_read_at<?",
			userID, peerFingerprint, peerSessionID, at,
		).
		// UpdateColumns 而不是 Updates：这里的 updatetime 是本行自己算好的值（就是
		// at），Updates 会在它之上再叠一次 GORM 的自动时间戳与钩子。
		//
		// 历史上还有一条更硬的理由：这个实体从前有一个字面叫 UpdatedAt 的字段，GORM
		// 把那个**字段名**认作自己的自动时间戳列，一条普通 Updates 就会顺手把发起端
		// 上报的毫秒活动时刻改成秒级当下。字段已随决策 10 改名 LastMessageAt，陷阱
		// 因此消失，实体上的 autoUpdateTime:false 也撤了——别照着旧注释以为还有一层
		// 标签兜底；真正的守卫是 summary_test.go 的
		// TestSessionSummaryEntity_PlainUpdatesNeverRewritesLastMessageAt。
		UpdateColumns(map[string]any{"last_read_at": at, "updatetime": at}).Error
}

// likeEscape 把用户敲的字符转成 LIKE 的字面量：`\` `%` `_` 都是 LIKE 的元字符，
// 不转义就等于让搜索词自带通配符——搜「50%」会变成「50 开头的任何标题」，命中集合
// 由用户输入悄悄放大。反斜杠必须先转，否则会把后面两步刚加上的转义符再转一遍。
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// locationPairs 把位置名单摊成 SQL 的行构造器实参：(peer_fingerprint, cwd) IN ((?,?),…)。
func locationPairs(locations []SummaryLocation) [][]any {
	pairs := make([][]any, 0, len(locations))
	for _, l := range locations {
		pairs = append(pairs, []any{l.PeerFingerprint, l.Cwd})
	}
	return pairs
}

// scoped 把 SummaryQuery 翻成 WHERE。全部读路径共用它——判据只有一处，分页与三种
// 计数因此不可能对不上（「这一组显示 N 条，翻出来却是别的集合」正是这么来的）。
func (r *summaryRepo) scoped(ctx context.Context, q SummaryQuery) *gorm.DB {
	tx := db.Ctx(ctx).Model(&agent_session_entity.SessionSummary{}).Where("user_id=?", q.UserID)
	if q.PeerSessionID != "" {
		tx = tx.Where("peer_session_id=?", q.PeerSessionID)
	}
	if q.TitleLike != "" {
		tx = tx.Where("title LIKE ?", "%"+likeEscape(q.TitleLike)+"%")
	}
	switch q.Lifecycle {
	case LifecycleRunning:
		tx = tx.Where("lifecycle_state=? AND waiting_for_input=?", "running", false)
	case LifecycleWaiting:
		tx = tx.Where("waiting_for_input=?", true)
	case LifecycleUnread:
		// 两列相比，没有索引帮得上（索引只排得了单列的值）。它跟在 user_id 那段
		// 扫描之后，与其余判据同一条路径。
		tx = tx.Where("last_message_at>last_read_at")
	case LifecycleAny:
	}
	if q.AgentSyncID != nil {
		tx = tx.Where("agent_sync_id=?", *q.AgentSyncID)
	}
	if q.PeerFingerprint != nil {
		tx = tx.Where("peer_fingerprint=?", *q.PeerFingerprint)
	}
	switch q.ProjectMode {
	case ProjectIs:
		// 报了这个项目的，**或**没报项目、但位置落在这个项目名下的。两半是或的关系：
		// 同一个项目下桌面端与 agentred 的对话都在这一组里。
		switch {
		case q.ProjectSyncID != "" && len(q.Locations) > 0:
			tx = tx.Where(
				"(project_sync_id=? OR (project_sync_id='' AND (peer_fingerprint, cwd) IN ?))",
				q.ProjectSyncID, locationPairs(q.Locations))
		case q.ProjectSyncID != "":
			tx = tx.Where("project_sync_id=?", q.ProjectSyncID)
		case len(q.Locations) > 0:
			tx = tx.Where("project_sync_id='' AND (peer_fingerprint, cwd) IN ?",
				locationPairs(q.Locations))
		default:
			// 一个位置都没配、也没有任何对端点过名的项目里一条对话都没有。这里必须
			// 显式落成「取不到」，空判据被当成「不过滤」会让这一组列出整个账号。
			tx = tx.Where("1=0")
		}
	case ProjectUnassigned:
		// 报了项目的一条都不在这一组里，哪怕它报的那个项目已经不存在了——那种行由
		// 服务层在读回之后判掉（决策 13），不在 SQL 这一层认，因为「这个标识还活着
		// 吗」要拿账号项目名单才答得出。
		tx = tx.Where("project_sync_id=''")
		// 名单为空时「不落在任何已知位置」对每一条都成立，因此不加位置条件。
		if len(q.Locations) > 0 {
			tx = tx.Where("(peer_fingerprint, cwd) NOT IN ?", locationPairs(q.Locations))
		}
	case ProjectAny:
	}
	return tx
}

func (r *summaryRepo) ListSummariesPage(
	ctx context.Context, q SummaryPageQuery,
) ([]*agent_session_entity.SessionSummary, error) {
	tx := r.scoped(ctx, q.SummaryQuery)
	if !q.Cursor.IsZero() {
		// 严格排在游标之后：先比活动时刻，同一刻内再比 id。两者缺一，同毫秒的那几条
		// 要么重复发一遍、要么整批被跳过。
		tx = tx.Where("(last_message_at < ? OR (last_message_at = ? AND id < ?))",
			q.Cursor.LastMessageAt, q.Cursor.LastMessageAt, q.Cursor.ID)
	}
	tx = tx.Order("last_message_at DESC, id DESC")
	if q.Limit > 0 {
		tx = tx.Limit(q.Limit)
	}
	var out []*agent_session_entity.SessionSummary
	if err := tx.Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

func (r *summaryRepo) CountSummaries(ctx context.Context, q SummaryQuery) (int64, error) {
	var total int64
	if err := r.scoped(ctx, q).Count(&total).Error; err != nil {
		return 0, err
	}
	return total, nil
}

// countByColumn 是两个单列分组计数的共同实现：同一份判据 + 一列 GROUP BY。
func (r *summaryRepo) countByColumn(
	ctx context.Context, q SummaryQuery, column string,
) (map[string]int64, error) {
	var rows []struct {
		GroupKey string
		Total    int64
	}
	if err := r.scoped(ctx, q).
		Select(column + " AS group_key, count(*) AS total").
		Group(column).Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, row := range rows {
		out[row.GroupKey] = row.Total
	}
	return out, nil
}

func (r *summaryRepo) CountSummariesByAgent(
	ctx context.Context, q SummaryQuery,
) (map[string]int64, error) {
	return r.countByColumn(ctx, q, "agent_sync_id")
}

func (r *summaryRepo) CountSummariesByPeer(
	ctx context.Context, q SummaryQuery,
) (map[string]int64, error) {
	return r.countByColumn(ctx, q, "peer_fingerprint")
}

func (r *summaryRepo) CountSummariesByProjectKey(
	ctx context.Context, q SummaryQuery,
) ([]SummaryProjectKeyCount, error) {
	var out []SummaryProjectKeyCount
	if err := r.scoped(ctx, q).
		Select("project_sync_id, peer_fingerprint, cwd, count(*) AS total").
		Group("project_sync_id").Group("peer_fingerprint").Group("cwd").
		Scan(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
