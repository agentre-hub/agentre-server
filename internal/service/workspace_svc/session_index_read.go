// session_index_read.go 是「对话」页那个索引的读侧
// （2026-08-19-session-index-pagination.md「索引读到什么」）：一次读取由**要哪一套组**
// （轴）、**要不要只看其中一组**（scope）、**位置与大小**（游标 / 每页 / 每组）与
// **范围**（搜索词 / 状态筛选）四组正交的入参决定。
//
// 这一层是唯一认识「组」这个词的地方：仓储只谈自己的列（决策 1 把项目那一维留在这里，
// 因为项目归属是拿 (指纹, cwd) 与账号项目树比出来的，决策 12），控制器只搬数据。
// cwd 在这里参与比较后就地出局，一个字段都不往上传（R19）。
package workspace_svc

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
)

const (
	// defaultIndexLimit / maxIndexLimit 是**翻一组**时的一页大小。
	defaultIndexLimit = 50
	maxIndexLimit     = 200
	// defaultPerGroup / defaultTimePerGroup 是**不带 scope**时每组先给几条：分组轴
	// 上组头吃掉纵向空间，时间轴没有组头因此可以多给（与桌面端同值，决策 4）。
	defaultPerGroup     = 5
	defaultTimePerGroup = 30
	maxPerGroup         = 50
)

// SessionIndexAxis 是索引的四个轴。它决定「有哪些组」，不决定行怎么排——行一律按
// 最后活动时间倒序。
type SessionIndexAxis string

const (
	AxisTime    SessionIndexAxis = "time"
	AxisProject SessionIndexAxis = "project"
	AxisAgent   SessionIndexAxis = "agent"
	AxisMachine SessionIndexAxis = "machine"
)

// SessionFilter 是索引上那几个筛选 chip。判据与前端 matchesSessionFilter 逐字一致：
// 「等你处理」优先于「运行中」，两者不会同时命中同一条。
type SessionFilter string

const (
	SessionFilterAll     SessionFilter = ""
	SessionFilterRunning SessionFilter = "running"
	SessionFilterWaiting SessionFilter = "waiting"
	// SessionFilterUnread = 「未读」：最后一次活动晚于这个账号最后一次读它。
	// 与桌面端 attention-store 的 lastMessageAt > lastReadAt 同一条判据。
	//
	// 它与「等你处理」是两件事：一条你已经看过、只是停在那儿等输入的对话不是未读；
	// 一条跑出了新结果但不等输入的是。索引摆的是「未读」，总览那条操作条摆的仍是
	// 「等你处理」——两个页面问的本来就不是同一个问题。
	SessionFilterUnread SessionFilter = "unread"
)

// scope 的词汇。它是「一个组」的身份，客户端把组头上那一个值原样回传即可，不必自己
// 拼判据。两个兜底组没有 ref——它们不指向任何项目或 Agent，它们**就是**「配不上」。
const (
	ScopeTime              = "time"
	ScopeUnassignedProject = "unassigned-project"
	ScopeUnnamedAgent      = "unnamed-agent"
	scopePrefixProject     = "project:"
	scopePrefixAgent       = "agent:"
	scopePrefixMachine     = "machine:"
)

// SessionIndexQuery 是一次索引读取。UserID 取自鉴权上下文，不由调用方填。
type SessionIndexQuery struct {
	UserID int64
	// Axis 决定不带 scope 时摆哪一套组；带 scope 时它仍要与 scope 相符——对不上说明
	// 调用方拼错了地址，如实报错而不是给出另一个轴的答案。
	Axis SessionIndexAxis
	// Scope 为空表示「要这个轴的全部组」。
	Scope string
	// Search 只按标题匹配（决策 8）。它是用户敲的字符，不是一段模式。
	Search string
	Filter SessionFilter
	// SessionID 非空时走精确认领：不分组、不分页，同号多条如实全给。
	SessionID string
	// Cursor 是上一页给的位置，空表示从头。
	Cursor string
	// Limit 是带 scope 时的一页大小；PerGroup 是不带 scope 时每组先给几条。
	// 两者都不填走默认档，超上限就地夹住。
	Limit    int
	PerGroup int
}

// SessionIndexGroup 是一个组：它的身份、它在**当前范围下**的真数，以及先给的那几条。
type SessionIndexGroup struct {
	Scope string
	Total int64
	Items []SavedSessionSummaryView
	// Cursor / HasMore 让调用方能从这几条之后继续翻这一组（「查看全部 N」那条路）。
	Cursor  string
	HasMore bool
}

// SessionIndexPage 是一次读取的结果。Groups 与 Items 互斥：不带 scope 时给组骨架，
// 带 scope（或按会话号精确查）时给行。
type SessionIndexPage struct {
	Groups  []SessionIndexGroup
	Items   []SavedSessionSummaryView
	Cursor  string
	HasMore bool
	// Total 是**当前搜索与筛选下**账号里的条数，与已加载多少无关（决策 10）。
	Total int64
}

// formatIndexCursor / parseIndexCursor 是游标的两端。它对调用方不透明：里面是
// (updated_at, id) 这个复合位置，只比 updated_at 会让同一毫秒里的行重复或跳过。
func formatIndexCursor(c agent_session_repo.SummaryCursor) string {
	if c.IsZero() {
		return ""
	}
	return strconv.FormatInt(c.LastMessageAt, 10) + "." + strconv.FormatInt(c.ID, 10)
}

func parseIndexCursor(raw string) (agent_session_repo.SummaryCursor, error) {
	if raw == "" {
		return agent_session_repo.SummaryCursor{}, nil
	}
	updatedAt, id, ok := strings.Cut(raw, ".")
	if !ok {
		return agent_session_repo.SummaryCursor{}, fmt.Errorf("session index: malformed cursor %q", raw)
	}
	u, err := strconv.ParseInt(updatedAt, 10, 64)
	if err != nil {
		return agent_session_repo.SummaryCursor{}, fmt.Errorf("session index: malformed cursor %q: %w", raw, err)
	}
	i, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return agent_session_repo.SummaryCursor{}, fmt.Errorf("session index: malformed cursor %q: %w", raw, err)
	}
	return agent_session_repo.SummaryCursor{LastMessageAt: u, ID: i}, nil
}

func clamp(v, fallback, max int) int {
	if v <= 0 {
		return fallback
	}
	if v > max {
		return max
	}
	return v
}

// baseQuery 是「范围」那一半：账号 + 搜索 + 筛选。四个轴、每一组、每一次计数都从它
// 出发，判据因此只有一处——组头说「9 条」翻出来却是另一批，就是这里分了两处才会有。
func baseQuery(in SessionIndexQuery) agent_session_repo.SummaryQuery {
	q := agent_session_repo.SummaryQuery{
		UserID:        in.UserID,
		TitleLike:     strings.TrimSpace(in.Search),
		PeerSessionID: in.SessionID,
	}
	switch in.Filter {
	case SessionFilterRunning:
		q.Lifecycle = agent_session_repo.LifecycleRunning
	case SessionFilterWaiting:
		q.Lifecycle = agent_session_repo.LifecycleWaiting
	case SessionFilterUnread:
		q.Lifecycle = agent_session_repo.LifecycleUnread
	case SessionFilterAll:
	}
	return q
}

// projectAffinityKinds 是判一次项目归属要读的两类对象：位置（agentred 那条路，
// 决策 12）与项目行本身（判对端报上来的标识还指不指得着一个活着的项目，决策 13）。
// 两类一次读齐——它们服务于同一个判定，分两次读只会多一次往返，还可能读到两个时刻。
var projectAffinityKinds = []string{sync_entity.KindProject, sync_entity.KindProjectLocation}

// projectAffinity 是判一次项目归属要的两份名单。
type projectAffinity struct {
	// byLocation 是账号项目树上的全部位置：(承载机器指纹, cwd) → 项目同步标识。
	byLocation map[string]string
	// liveProjects 是账号里还活着的项目同步标识。对端报上来的标识要先过这一关：
	// 项目删了以后指着它的对话落回「随手对话」（决策 13），而不是变成一个只有标识、
	// 没有名字的幽灵组。
	liveProjects map[string]bool
}

// projectOf 判一条对话归哪个项目，空串 = 未归项目。
//
// 两种对端交出来的事实不一样，因此有两条判法，**报上来的那个优先**：
//
//   - 桌面端自己点名（reported）。它没有「这条会话的 cwd」这种东西——工作目录是每轮
//     按项目本机路径现算的——而且它的本机路径存在另一张表（device_local_paths、按
//     上报设备分命名空间）里，压根不在 byLocation 这份名单中。不认它的话，桌面端的
//     每一条对话都只能落进「随手对话」。
//   - agentred 不报项目，拿它的落地位置去跟账号项目树上的路径比（决策 12）。位置的
//     指纹那一半是**承载**这条对话的机器，不是发起端：目录长在承载机器上，账号项目
//     树上的位置也是按 agentred 指纹配的。控制台派活时发起端是浏览器的中继标识，拿
//     它去比的话，用户明明选了项目的对话一条都配不上位置。
//
// 点了名但那个项目已经不在了，就当没点：**不**再回头去比位置。位置那条路答的是
// 「这台机器的这个目录属于哪个项目」，而报了项目的对话通常连 cwd 都没有；真要撞上
// 一个同名位置，那也是另一个项目，把它塞进去比落进「随手对话」更难解释。
func (a projectAffinity) projectOf(reported, machineFingerprint, cwd string) string {
	if reported != "" {
		if a.liveProjects[reported] {
			return reported
		}
		return ""
	}
	if cwd == "" {
		return ""
	}
	return a.byLocation[machineFingerprint+"\x00"+cwd]
}

// projectLocations 读出判一次项目归属要的那两份名单。它同时供三件事用：把分组计数
// 折算成项目、把「某个项目」翻成一组位置、以及给行判项目归属。
func (s *workspaceSvc) projectLocations(ctx context.Context, userID int64) (projectAffinity, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, projectAffinityKinds)
	if err != nil {
		return projectAffinity{}, err
	}
	live := map[string]bool{}
	for _, row := range rows {
		if row.Kind == sync_entity.KindProject && row.SyncID != "" {
			live[row.SyncID] = true
		}
	}
	return projectAffinity{byLocation: projectSyncIDByLocation(rows), liveProjects: live}, nil
}

// projectLocationCache 让**一次索引读取**只查一遍项目位置表：取一次用到底。
//
// 轴骨架把一次请求摊成「每组各取几条」，而每组的每一行都要判项目归属；这份名单在
// 一次请求里不会变，逐组各查一遍就是把同一份数据查上几十遍（账号里有几十台机器 /
// 几十个项目时就是几十次往返）。
//
// 它是**每次请求新建的局部值**，不是服务上的字段：服务是单例、多副本各跑各的，把
// 这份账号数据挂上去等于让一个账号的项目位置漏给下一个请求，而且谁也说不清它是
// 什么时候的。惰性也保留着——没有一行带 cwd 时根本不查（那次查询的结果只可能被拿
// 去比 cwd）。
type projectLocationCache struct {
	svc    *workspaceSvc
	userID int64
	loaded bool
	rows   projectAffinity
}

func (c *projectLocationCache) get(ctx context.Context) (projectAffinity, error) {
	if c.loaded {
		return c.rows, nil
	}
	rows, err := c.svc.projectLocations(ctx, c.userID)
	if err != nil {
		return projectAffinity{}, err
	}
	c.rows, c.loaded = rows, true
	return c.rows, nil
}

// splitLocationKey 把 projectSyncIDByLocation 的键拆回 (指纹, cwd)。
func splitLocationKey(key string) agent_session_repo.SummaryLocation {
	fp, cwd, _ := strings.Cut(key, "\x00")
	return agent_session_repo.SummaryLocation{MachineFingerprint: fp, Cwd: cwd}
}

// locationsOfProject 是某个项目名下的全部位置；allLocations 是账号已知的全部位置
// （「未归项目」要否定的正是这一整份，而不是这批摘要里出现过的那些——后者会把
// 「有位置但这次没会话」的项目漏掉，让本该未归的行混进来）。
func locationsOfProject(byLocation map[string]string, projectSyncID string) []agent_session_repo.SummaryLocation {
	out := make([]agent_session_repo.SummaryLocation, 0, len(byLocation))
	for key, proj := range byLocation {
		if proj == projectSyncID {
			out = append(out, splitLocationKey(key))
		}
	}
	sortLocations(out)
	return out
}

func allLocations(byLocation map[string]string) []agent_session_repo.SummaryLocation {
	out := make([]agent_session_repo.SummaryLocation, 0, len(byLocation))
	for key := range byLocation {
		out = append(out, splitLocationKey(key))
	}
	sortLocations(out)
	return out
}

// sortLocations 让位置名单有确定的顺序：map 的遍历序每次都不同，直接拼进 SQL 会让
// 同一次查询的语句文本随机变化（查询缓存、日志与测试断言都会跟着抖）。
func sortLocations(locations []agent_session_repo.SummaryLocation) {
	sort.Slice(locations, func(i, j int) bool {
		if locations[i].MachineFingerprint != locations[j].MachineFingerprint {
			return locations[i].MachineFingerprint < locations[j].MachineFingerprint
		}
		return locations[i].Cwd < locations[j].Cwd
	})
}

// applyScope 把一个组的身份翻成仓储判据。认不出来的 scope 是错，不是「当成没传」：
// 静默忽略会把用户要的那一组悄悄换成整个账号。
func (s *workspaceSvc) applyScope(
	ctx context.Context, in SessionIndexQuery, q agent_session_repo.SummaryQuery,
	locations *projectLocationCache,
) (agent_session_repo.SummaryQuery, error) {
	scope := in.Scope
	wantAxis := func(axis SessionIndexAxis) error {
		if in.Axis != axis {
			return fmt.Errorf("session index: scope %q does not belong to axis %q", scope, in.Axis)
		}
		return nil
	}

	switch {
	case scope == ScopeTime:
		return q, wantAxis(AxisTime)
	case scope == ScopeUnnamedAgent:
		if err := wantAxis(AxisAgent); err != nil {
			return q, err
		}
		unnamed := ""
		q.AgentSyncID = &unnamed
		return q, nil
	case strings.HasPrefix(scope, scopePrefixAgent):
		if err := wantAxis(AxisAgent); err != nil {
			return q, err
		}
		agentSyncID := strings.TrimPrefix(scope, scopePrefixAgent)
		q.AgentSyncID = &agentSyncID
		return q, nil
	case strings.HasPrefix(scope, scopePrefixMachine):
		if err := wantAxis(AxisMachine); err != nil {
			return q, err
		}
		fingerprint := strings.TrimPrefix(scope, scopePrefixMachine)
		q.PeerFingerprint = &fingerprint
		return q, nil
	case scope == ScopeUnassignedProject:
		if err := wantAxis(AxisProject); err != nil {
			return q, err
		}
		affinity, err := locations.get(ctx)
		if err != nil {
			return q, err
		}
		q.ProjectMode = agent_session_repo.ProjectUnassigned
		q.Locations = allLocations(affinity.byLocation)
		return q, nil
	case strings.HasPrefix(scope, scopePrefixProject):
		if err := wantAxis(AxisProject); err != nil {
			return q, err
		}
		affinity, err := locations.get(ctx)
		if err != nil {
			return q, err
		}
		projectSyncID := strings.TrimPrefix(scope, scopePrefixProject)
		q.ProjectMode = agent_session_repo.ProjectIs
		// 两半都给：报了这个项目的（桌面端），与没报项目、位置落在它名下的（agentred）。
		q.ProjectSyncID = projectSyncID
		q.Locations = locationsOfProject(affinity.byLocation, projectSyncID)
		return q, nil
	default:
		return q, fmt.Errorf("session index: unknown scope %q", scope)
	}
}

// SessionIndex 见 WorkspaceSvc 上的接口注释。
func (s *workspaceSvc) SessionIndex(ctx context.Context, in SessionIndexQuery) (SessionIndexPage, error) {
	base := baseQuery(in)
	// 这一次读取里的每一处项目归属都从这一份名单来，它最多被查一遍。
	locations := &projectLocationCache{svc: s, userID: in.UserID}

	// 按会话号精确认领（决策 13）：要的不是一页，因此不分组、不排序也不限条数。
	if in.SessionID != "" {
		rows, err := agent_session_repo.Summary().ListSummariesPage(
			ctx, agent_session_repo.SummaryPageQuery{SummaryQuery: base})
		if err != nil {
			return SessionIndexPage{}, err
		}
		items, err := s.viewsOf(ctx, locations, rows)
		if err != nil {
			return SessionIndexPage{}, err
		}
		return SessionIndexPage{Items: items, Total: int64(len(items))}, nil
	}

	if in.Scope != "" {
		return s.scopedPage(ctx, in, base, locations)
	}
	return s.axisSkeleton(ctx, in, base, locations)
}

// scopedPage 翻一个组。多取一条判 HasMore，而不是靠「这页刚好装满」去猜——半满的
// 最后一页与真的到头了否则分不清（与 Transcript 同一条做法）。
func (s *workspaceSvc) scopedPage(
	ctx context.Context, in SessionIndexQuery, base agent_session_repo.SummaryQuery,
	locations *projectLocationCache,
) (SessionIndexPage, error) {
	q, err := s.applyScope(ctx, in, base, locations)
	if err != nil {
		return SessionIndexPage{}, err
	}
	cursor, err := parseIndexCursor(in.Cursor)
	if err != nil {
		return SessionIndexPage{}, err
	}
	total, err := agent_session_repo.Summary().CountSummaries(ctx, q)
	if err != nil {
		return SessionIndexPage{}, err
	}
	items, nextCursor, hasMore, err := s.pageOf(
		ctx, locations, q, cursor, clamp(in.Limit, defaultIndexLimit, maxIndexLimit))
	if err != nil {
		return SessionIndexPage{}, err
	}
	return SessionIndexPage{Items: items, Cursor: nextCursor, HasMore: hasMore, Total: total}, nil
}

// pageOf 取一页并把游标算好。空页上游标原样退回调用方送来的位置，不回退到起点——
// 回退会让调用方把这一组从头再翻一遍。
func (s *workspaceSvc) pageOf(
	ctx context.Context, locations *projectLocationCache, q agent_session_repo.SummaryQuery,
	cursor agent_session_repo.SummaryCursor, limit int,
) ([]SavedSessionSummaryView, string, bool, error) {
	rows, err := agent_session_repo.Summary().ListSummariesPage(ctx, agent_session_repo.SummaryPageQuery{
		SummaryQuery: q, Cursor: cursor, Limit: limit + 1,
	})
	if err != nil {
		return nil, "", false, err
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	next := cursor
	if n := len(rows); n > 0 {
		next = agent_session_repo.SummaryCursor{LastMessageAt: rows[n-1].LastMessageAt, ID: rows[n-1].ID}
	}
	items, err := s.viewsOf(ctx, locations, rows)
	if err != nil {
		return nil, "", false, err
	}
	return items, formatIndexCursor(next), hasMore, nil
}

// axisSkeleton 摆出这个轴的全部组：每组的身份、它在当前范围下的真数、以及先给的那
// 几条。只摆有对话的组——空组不在本轮范围内。
//
// 每组的头几条各是一次查询。组数由账号里的项目 / Agent / 机器数决定（个位到几十），
// 这条代价换来的是每组各自的真数与「查看全部 N」能真的翻完那一组。
func (s *workspaceSvc) axisSkeleton(
	ctx context.Context, in SessionIndexQuery, base agent_session_repo.SummaryQuery,
	locations *projectLocationCache,
) (SessionIndexPage, error) {
	total, err := agent_session_repo.Summary().CountSummaries(ctx, base)
	if err != nil {
		return SessionIndexPage{}, err
	}

	perGroup := clamp(in.PerGroup, defaultPerGroup, maxPerGroup)
	if in.Axis == AxisTime {
		perGroup = clamp(in.PerGroup, defaultTimePerGroup, maxPerGroup)
	}

	specs, err := s.groupSpecsFor(ctx, in, base, total, locations)
	if err != nil {
		return SessionIndexPage{}, err
	}

	// 组的顺序在这里定死（按 scope 字典序）：map 遍历序每次都不同，同一份数据两次
	// 请求给出两种顺序会让调用方看到列表自己跳。展示顺序（项目树、Agent 置顶）由
	// 调用方自己排，它手里才有那些名单。
	sort.Slice(specs, func(i, j int) bool { return specs[i].scope < specs[j].scope })

	page := SessionIndexPage{Total: total, Groups: make([]SessionIndexGroup, 0, len(specs))}
	for _, spec := range specs {
		items, cursor, hasMore, err := s.pageOf(ctx, locations, spec.query, agent_session_repo.SummaryCursor{}, perGroup)
		if err != nil {
			return SessionIndexPage{}, err
		}
		page.Groups = append(page.Groups, SessionIndexGroup{
			Scope: spec.scope, Total: spec.total, Items: items, Cursor: cursor, HasMore: hasMore,
		})
	}
	return page, nil
}

// groupSpec 是一组在被取内容之前的样子：它的身份（scope）、它在当前范围下的真数，
// 以及把这一组捞出来要用的那条查询。
type groupSpec struct {
	scope string
	total int64
	query agent_session_repo.SummaryQuery
}

// groupSpecsFor 按轴摆出这一轮有哪些组。只在这里认识「哪个轴分出哪些组」，取内容
// 与排序都不掺进来。
func (s *workspaceSvc) groupSpecsFor(
	ctx context.Context, in SessionIndexQuery, base agent_session_repo.SummaryQuery,
	total int64, locations *projectLocationCache,
) ([]groupSpec, error) {
	var specs []groupSpec
	switch in.Axis {
	case AxisTime:
		specs = append(specs, groupSpec{scope: ScopeTime, total: total, query: base})
	case AxisAgent:
		counts, err := agent_session_repo.Summary().CountSummariesByAgent(ctx, base)
		if err != nil {
			return nil, err
		}
		for agentSyncID, n := range counts {
			q := base
			key := agentSyncID
			q.AgentSyncID = &key
			scope := scopePrefixAgent + agentSyncID
			if agentSyncID == "" {
				scope = ScopeUnnamedAgent
			}
			specs = append(specs, groupSpec{scope: scope, total: n, query: q})
		}
	case AxisMachine:
		counts, err := agent_session_repo.Summary().CountSummariesByPeer(ctx, base)
		if err != nil {
			return nil, err
		}
		for fingerprint, n := range counts {
			q := base
			key := fingerprint
			q.PeerFingerprint = &key
			specs = append(specs, groupSpec{
				scope: scopePrefixMachine + fingerprint, total: n, query: q,
			})
		}
	case AxisProject:
		return s.projectGroupSpecs(ctx, base, locations)
	default:
		return nil, fmt.Errorf("session index: unknown axis %q", in.Axis)
	}
	return specs, nil
}

// projectGroupSpecs 摆出项目轴的组。它比别的轴多一步：仓储数出来的是判据，不是项目。
func (s *workspaceSvc) projectGroupSpecs(
	ctx context.Context, base agent_session_repo.SummaryQuery, locations *projectLocationCache,
) ([]groupSpec, error) {
	affinity, err := locations.get(ctx)
	if err != nil {
		return nil, err
	}
	counts, err := agent_session_repo.Summary().CountSummariesByProjectKey(ctx, base)
	if err != nil {
		return nil, err
	}
	// SQL 只数得出判据，折算成项目在这里：报了项目的按它报的算，没报的拿位置去比，
	// 同一个项目的两拨合到一起，哪一头都对不上的进「未归项目」（决策 12 / 13）。
	byProject := map[string]int64{}
	var unassigned int64
	for _, c := range counts {
		if proj := affinity.projectOf(c.ProjectSyncID, c.MachineFingerprint, c.Cwd); proj != "" {
			byProject[proj] += c.Total
			continue
		}
		unassigned += c.Total
	}
	var specs []groupSpec
	for projectSyncID, n := range byProject {
		q := base
		q.ProjectMode = agent_session_repo.ProjectIs
		q.ProjectSyncID = projectSyncID
		q.Locations = locationsOfProject(affinity.byLocation, projectSyncID)
		specs = append(specs, groupSpec{
			scope: scopePrefixProject + projectSyncID, total: n, query: q,
		})
	}
	if unassigned > 0 {
		q := base
		q.ProjectMode = agent_session_repo.ProjectUnassigned
		q.Locations = allLocations(affinity.byLocation)
		specs = append(specs, groupSpec{scope: ScopeUnassignedProject, total: unassigned, query: q})
	}
	return specs, nil
}

// viewsOf 把镜像行变成索引一行的材料，顺带就地判项目归属（决策 12）。
//
// 一行都没有、或没有任何一行带得出项目归属的判据（cwd 与对端报的项目标识都空）时
// 不去查那两份名单：那次查询的结果只可能被用来判归属，没有判据就没有可判的东西。
// 查得到的那一次由 locations 记着，同一次读取里的其余组直接复用。
func (s *workspaceSvc) viewsOf(
	ctx context.Context, locations *projectLocationCache, rows []*agent_session_entity.SessionSummary,
) ([]SavedSessionSummaryView, error) {
	needsProject := false
	for _, r := range rows {
		if r.Cwd != "" || r.ProjectSyncID != "" {
			needsProject = true
			break
		}
	}
	var affinity projectAffinity
	if needsProject {
		var err error
		affinity, err = locations.get(ctx)
		if err != nil {
			return nil, err
		}
	}

	out := make([]SavedSessionSummaryView, 0, len(rows))
	for _, r := range rows {
		view := SavedSessionSummaryView{
			PeerFingerprint:    r.PeerFingerprint,
			MachineFingerprint: r.MachineFingerprint,
			SessionID:          r.PeerSessionID,
			Title:              r.Title,
			AgentSyncID:        r.AgentSyncID,
			BackendType:        r.BackendType,
			LifecycleState:     r.LifecycleState,
			WaitingForInput:    r.WaitingForInput,
			LastMessageAt:      r.LastMessageAt,
			LastReadAt:         r.LastReadAt,
			ProviderKey:        r.ProviderKey,
			ModelKey:           r.ModelKey,
		}
		// Cwd 只在这里参与一次比较，判完立刻出局——它本身永不进入 View（R19）。
		view.ProjectSyncID = affinity.projectOf(r.ProjectSyncID, r.MachineFingerprint, r.Cwd)
		out = append(out, view)
	}
	return out, nil
}

// WaitingCount 把「等你处理」这一档的判据原样交给仓储去数。
//
// 判据不在这里重写：LifecycleWaiting 的含义（等输入，且与「运行中」互斥）住在
// agent_session_repo 那一侧，索引的 chip 与这颗角标因此必然是同一个数。在这里另写一遍
// `WaitingForInput == true` 会让两者在下一次判据演化时悄悄分家。
func (s *workspaceSvc) WaitingCount(ctx context.Context, userID int64) (int64, error) {
	return agent_session_repo.Summary().CountSummaries(ctx, agent_session_repo.SummaryQuery{
		UserID:    userID,
		Lifecycle: agent_session_repo.LifecycleWaiting,
	})
}
