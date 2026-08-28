package workspace_svc

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/i18n"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
)

// ── 看板的读路径（规格 2026-08-27-issues-board-project-scope「`agentre-server` 端」）──
//
// **不新增任何表。** 任务、标签与两者的关联全部住在既有的 sync_objects 里，靠 kind
// 区分；一次 ListByKinds 取回账号下的 project / label / issue / issue_label，六个
// 筛选条件、列头的「命中 / 全部」与项目选择器的子树计数**全部在 Go 里算**（决策 15）。
// 没有投影表、没有第二个查询层——账号级的这几百到几千行在内存里过一遍就够了，而一张
// 投影表要多一条与同步下行竞争的写路径。
//
// 与桌面端的**唯一**语义差别在关键词那一条：桌面端还能按 `#编号` 命中，而编号是那台
// 机器上的本地自增主键，同步载荷里根本没有它（adapter_issue.go 的 issuePayload）。
// 这一侧因此把 `#179` 当成文本 `179` 去匹配标题与描述，而不是编造一个账号级编号——
// 编造出来的号在两台机器上会指向不同的卡。
//
// 创建时间同理：载荷里没有「桌面端那一行是什么时候建的」，这一侧用的是
// sync_objects.createtime，也就是**这个账号第一次见到这张卡**的时刻。

// 项目范围的三档（规格「项目范围」）。空串等同 IssueScopeAll。
const (
	IssueScopeAll        = "all"        // 全部项目：不加任何项目条件
	IssueScopeUnassigned = "unassigned" // 未归属：project_sync_id 为空的那一档
	IssueScopeProject    = "project"    // 某个项目**及其整棵子树**
)

// 看板的四列。零命中的列照常出现在计数里——界面据此把空列留在原位而不是让它塌缩。
var issueStages = []string{"todo", "doing", "review", "done"}

const (
	issueStageTodo = "todo"
	issueStageDone = "done"
	millisPerDay   = int64(24 * 60 * 60 * 1000)
	// positionStep 与桌面端 issue_svc 同值：两端算出来的落点要落在同一个量级上，
	// 否则一台机器排的序在另一台机器上会被挤成同一个数。
	positionStep = 65536.0
)

// boardNow 是这一族取「现在」的唯一入口：保留窗口与关闭时刻都相对它算。
// 时刻由服务端就地取，**不收客户端的**——客户端的钟不可信，而这些数要和服务端
// 自己记的时刻相比。
var boardNow = func() int64 { return time.Now().UnixMilli() }

// boardReadKinds 是读路径那一次取数的类型集合。项目在里面：范围要靠它展开成子树，
// 选择器右侧的计数也要靠它汇总。
var boardReadKinds = []string{
	sync_entity.KindProject, sync_entity.KindLabel,
	sync_entity.KindIssue, sync_entity.KindIssueLabel,
}

// labelPayload / issuePayload / issueLabelPayload 是三种载荷的键名形状，由桌面端
// sync_svc/adapter_issue.go 定死，这一侧**逐字消费**。与 projectAgentPayload 同一种
// 「跨仓重新声明」的做法：两个仓库不能互相 import，键名改了两边都要改，因此这里写明出处。
//
// labelPayload.Status 在载荷里而不像别的对象那样只靠墓碑表达：server 没有本地行，
// 判「这个标签还在不在」只有这一个键。
type labelPayload struct {
	Name   string `json:"name"`
	Tone   string `json:"tone"`
	Status int    `json:"status"`
}

// issuePayload 里**没有** state：状态轴本轮消失，它完全由 stage 推导
// （stage=done 即已完成），两端各自算，不进载荷。
type issuePayload struct {
	Title              string  `json:"title"`
	Description        string  `json:"description"`
	Stage              string  `json:"stage"`
	Position           float64 `json:"position"`
	ProjectSyncID      string  `json:"project_sync_id,omitempty"`
	AgentSyncID        string  `json:"agent_sync_id,omitempty"`
	AgentBackendSyncID string  `json:"agent_backend_sync_id,omitempty"`
	LLMProviderKey     string  `json:"llm_provider_key"`
	LLMModelKey        string  `json:"llm_model_key"`
	ClosedAt           int64   `json:"closed_at"`
}

type issueLabelPayload struct {
	IssueSyncID string `json:"issue_sync_id"`
	LabelSyncID string `json:"label_sync_id"`
}

// IssueBoardQuery 是一次看板取数：项目范围加其余五个条件。
//
// UserID 来自鉴权上下文而不是请求体，看板范围因此只由它圈定，别的账号的任务一行都读不到。
type IssueBoardQuery struct {
	UserID int64
	// Scope / ProjectSyncID 是「项目」那一条，两个字段合起来才是一档范围。
	Scope         string
	ProjectSyncID string
	Keyword       string
	// LabelSyncIDs 非空 = 按标签筛选；LabelMatchAll 决定「任意一个」还是「全部满足」。
	LabelSyncIDs  []string
	LabelMatchAll bool
	NoLabel       bool
	// 两段闭区间（毫秒 epoch，0 = 该端不限）。
	UpdatedFrom int64
	UpdatedTo   int64
	CreatedFrom int64
	CreatedTo   int64
	// DoneWithinDays 「已完成保留多久」（0 = 全部）：只裁剪已完成的卡片。
	DoneWithinDays int
}

// IssueLabelView 是标签目录的一项。UsageCount 是「被 N 个任务使用」，删之前要说得出
// 的爆炸半径；它是**账号口径**，不随当前筛选缩水。
type IssueLabelView struct {
	SyncID     string
	Name       string
	Tone       string
	UsageCount int64
}

// IssueCardView 是板上的一张卡。执行归属三个字段本轮没有任何路径读，但必须往返得了
// ——表单打开时那三颗 pill 要停在原来的位置上。
type IssueCardView struct {
	SyncID             string
	Title              string
	Description        string
	Stage              string
	Position           float64
	ProjectSyncID      string
	AgentSyncID        string
	AgentBackendSyncID string
	LLMProviderKey     string
	LLMModelKey        string
	ClosedAt           int64
	CreatedAt          int64
	UpdatedAt          int64
	Labels             []IssueLabelView
}

// ProjectIssueCountView 是项目选择器每一项右侧的计数：该项目**及其子树**里未完成的
// 任务数（ProjectSyncID 为空是「未归属」那一档）。
type ProjectIssueCountView struct {
	ProjectSyncID string
	Count         int64
}

type IssueBoardView struct {
	Issues []IssueCardView
	// Labels 是账号的标签目录，随看板一起下发：筛选面板与标签管理画的是同一份。
	Labels []IssueLabelView
	// StageCounts / StageTotals 是列头的「命中 / 全部」：前者吃全部筛选条件，
	// 后者只吃项目范围——范围是「在看哪块板」，不是一个能被摘掉的条件。
	StageCounts map[string]int64
	StageTotals map[string]int64
	// ProjectCounts 不随筛选变化：打开选择器就是为了判断该切到哪，这个数跟着当前
	// 筛选缩水就失去了用途。
	ProjectCounts []ProjectIssueCountView
}

// IssueBoardSvc 是看板这一族的服务面。它与 WorkspaceSvc 分开声明、各有自己的默认值
// （同 SessionReadSvc 的做法）：调用方各自换掉自己那一片，不必给对方那一片也造替身。
type IssueBoardSvc interface {
	// Board 一次取回看板要画的全部材料：卡、标签目录、两套列头计数、项目子树计数。
	Board(ctx context.Context, q IssueBoardQuery) (*IssueBoardView, error)
	// CreateIssue / UpdateIssue / MoveIssue / DeleteIssue 是浏览器直写任务：
	// server 分配版本号、删除落墓碑，与设备上行完全一样的账号级语义。
	CreateIssue(ctx context.Context, in IssueWriteInput) (*OrgWriteResult, error)
	// UpdateIssue 只覆盖 in.Fields 里明确涉及的键；in.LabelSyncIDs 为 nil 即这次
	// 请求没提到标签，一行关联都不动。
	UpdateIssue(ctx context.Context, in IssueWriteInput) (*OrgWriteResult, error)
	// MoveIssue 拖一张卡：改 stage 与 position，关闭时刻随 stage 推导。
	MoveIssue(ctx context.Context, in IssueMoveInput) (*OrgWriteResult, error)
	// DeleteIssue 落墓碑，并把这张卡身上的标签关联一并落。
	DeleteIssue(ctx context.Context, userID int64, syncID string) (*OrgWriteResult, error)
	CreateLabel(ctx context.Context, in LabelWriteInput) (*OrgWriteResult, error)
	UpdateLabel(ctx context.Context, in LabelWriteInput) (*OrgWriteResult, error)
	// DeleteLabel 落墓碑，并把指向它的全部关联一并落。
	DeleteLabel(ctx context.Context, userID int64, syncID string) (*OrgWriteResult, error)
}

var defaultIssueBoard IssueBoardSvc = New()

func IssueBoard() IssueBoardSvc     { return defaultIssueBoard }
func SetIssueBoard(s IssueBoardSvc) { defaultIssueBoard = s }

// boardData 是那一次取数解出来的全部材料，读路径与写路径共用同一套解析。
type boardData struct {
	rows   []*sync_entity.SyncObject
	issues []*sync_entity.SyncObject
	// labels 只含存活的标签（载荷里 status 不是 ACTIVE 的已在本机软删）。
	labels map[string]IssueLabelView
	// labelsOf 是每张卡挂着的标签，指向已消失标签的关联行不计入。
	labelsOf map[string][]IssueLabelView
	// linkRows 是全部关联行，删除的级联要按它定位。
	linkRows []*sync_entity.SyncObject
}

func loadBoardData(rows []*sync_entity.SyncObject) *boardData {
	data := &boardData{
		rows:     rows,
		labels:   map[string]IssueLabelView{},
		labelsOf: map[string][]IssueLabelView{},
	}
	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindIssue:
			data.issues = append(data.issues, row)
		case sync_entity.KindLabel:
			var p labelPayload
			if json.Unmarshal([]byte(row.Payload), &p) != nil || p.Status != consts.ACTIVE {
				continue
			}
			data.labels[row.SyncID] = IssueLabelView{SyncID: row.SyncID, Name: p.Name, Tone: p.Tone}
		case sync_entity.KindIssueLabel:
			data.linkRows = append(data.linkRows, row)
		}
	}
	live := map[string]bool{}
	for _, row := range data.issues {
		live[row.SyncID] = true
	}
	// 同一对 (任务, 标签) 只算一次：两台机器各自给同一件事挂过同一个标签时，账号里
	// 会有两条同步标识不同、指向同一对的关联行（桌面端 UpsertFromSync 按自然键收敛，
	// 落败那条的墓碑不一定已经到）。不去重的话，卡上会出现两枚一模一样的 chip，
	// 「被 N 个任务使用」也会把一张卡数成两张。
	seenPair := map[string]bool{}
	for _, row := range data.linkRows {
		var p issueLabelPayload
		if json.Unmarshal([]byte(row.Payload), &p) != nil {
			continue
		}
		label, ok := data.labels[p.LabelSyncID]
		if !ok {
			continue
		}
		// 只数指向**还在的**任务的关联：另一台机器删掉的那张卡墓碑还没到，把它算进
		// 爆炸半径会让用户以为删这个标签会动到一张看不见的卡。
		if !live[p.IssueSyncID] {
			continue
		}
		pair := p.IssueSyncID + "\x00" + p.LabelSyncID
		if seenPair[pair] {
			continue
		}
		seenPair[pair] = true
		data.labelsOf[p.IssueSyncID] = append(data.labelsOf[p.IssueSyncID], label)
		label.UsageCount++
		data.labels[p.LabelSyncID] = label
	}
	for syncID := range data.labelsOf {
		sortLabelViews(data.labelsOf[syncID])
	}
	return data
}

func sortLabelViews(items []IssueLabelView) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Name != items[j].Name {
			return items[i].Name < items[j].Name
		}
		return items[i].SyncID < items[j].SyncID
	})
}

func (s *workspaceSvc) Board(ctx context.Context, q IssueBoardQuery) (*IssueBoardView, error) {
	// 「某个项目」这一档必须真的带着一个项目。空串会被 projectSubtree 当成「没挂
	// 项目」那一档的键，于是 scope=project 静默变成一块未归属的板——那是另一个档
	// （IssueScopeUnassigned），不能让它从一个漏填的参数里冒出来。
	if q.Scope == IssueScopeProject && q.ProjectSyncID == "" {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, q.UserID, boardReadKinds)
	if err != nil {
		return nil, err
	}
	data := loadBoardData(rows)
	scope := resolveIssueScope(rows, q)

	inScope := make([]*sync_entity.SyncObject, 0, len(data.issues))
	for _, row := range data.issues {
		if scope(row) {
			inScope = append(inScope, row)
		}
	}
	matched := make([]IssueCardView, 0, len(inScope))
	stageCounts := emptyStageCounts()
	stageTotals := emptyStageCounts()
	cond := newIssueConditions(q)
	for _, row := range inScope {
		card := toIssueCardView(row, data.labelsOf[row.SyncID])
		stageTotals[card.Stage]++
		if !cond.keep(card) {
			continue
		}
		stageCounts[card.Stage]++
		matched = append(matched, card)
	}
	sortIssueCards(matched)

	labels := make([]IssueLabelView, 0, len(data.labels))
	for _, l := range data.labels {
		labels = append(labels, l)
	}
	sortLabelViews(labels)

	return &IssueBoardView{
		Issues:        matched,
		Labels:        labels,
		StageCounts:   stageCounts,
		StageTotals:   stageTotals,
		ProjectCounts: rollUpProjectIssueCounts(rows, data),
	}, nil
}

func emptyStageCounts() map[string]int64 {
	out := make(map[string]int64, len(issueStages))
	for _, stage := range issueStages {
		out[stage] = 0
	}
	return out
}

// toIssueCardView 把一行同步对象翻成一张卡。载荷解不开的行按空卡处理而不是让整次
// 取数失败：一张画不出来的卡不该把整块板拖黑。
func toIssueCardView(row *sync_entity.SyncObject, labels []IssueLabelView) IssueCardView {
	var p issuePayload
	_ = json.Unmarshal([]byte(row.Payload), &p)
	if labels == nil {
		labels = []IssueLabelView{}
	}
	return IssueCardView{
		SyncID: row.SyncID, Title: p.Title, Description: p.Description,
		Stage: normalizeStage(p.Stage), Position: p.Position,
		ProjectSyncID: p.ProjectSyncID, AgentSyncID: p.AgentSyncID,
		AgentBackendSyncID: p.AgentBackendSyncID,
		LLMProviderKey:     p.LLMProviderKey, LLMModelKey: p.LLMModelKey,
		ClosedAt: p.ClosedAt, CreatedAt: row.Createtime, UpdatedAt: row.SyncUpdatedAt,
		Labels: labels,
	}
}

// normalizeStage 空串与不认识的阶段一律归到第一列：迁移默认与旧行都可能是空串，
// 把它们丢在一个不存在的列里等于让用户再也看不见那张卡。
func normalizeStage(stage string) string {
	for _, known := range issueStages {
		if stage == known {
			return stage
		}
	}
	return issueStageTodo
}

// resolveIssueScope 把「项目范围」这一档展开成一个判据。
// 全部项目 → 不加条件；未归属 → 只有没挂项目的卡；某个项目 → 它自己加整棵子树。
func resolveIssueScope(
	rows []*sync_entity.SyncObject, q IssueBoardQuery,
) func(*sync_entity.SyncObject) bool {
	switch q.Scope {
	case IssueScopeUnassigned:
		return func(row *sync_entity.SyncObject) bool {
			return issueProjectSyncID(row) == ""
		}
	case IssueScopeProject:
		subtree := projectSubtree(rows, q.ProjectSyncID)
		return func(row *sync_entity.SyncObject) bool {
			return subtree[issueProjectSyncID(row)]
		}
	default:
		return func(*sync_entity.SyncObject) bool { return true }
	}
}

func issueProjectSyncID(row *sync_entity.SyncObject) string {
	var p issuePayload
	if json.Unmarshal([]byte(row.Payload), &p) != nil {
		return ""
	}
	return p.ProjectSyncID
}

// issueConditions 是除「项目」之外的五个条件。它们**同时**决定板上留哪些卡与列头的
// 「命中」数——两处各写一遍迟早对不上。
type issueConditions struct {
	keyword       string
	labelSyncIDs  []string
	labelMatchAll bool
	noLabel       bool
	updatedFrom   int64
	updatedTo     int64
	createdFrom   int64
	createdTo     int64
	doneAfter     int64
}

func newIssueConditions(q IssueBoardQuery) issueConditions {
	cond := issueConditions{
		// `#179` 与 `179` 在这一侧是同一个关键词：编号本身不过机（见文件头）。
		keyword:       strings.ToLower(strings.TrimPrefix(strings.TrimSpace(q.Keyword), "#")),
		labelSyncIDs:  uniqueStrings(q.LabelSyncIDs),
		labelMatchAll: q.LabelMatchAll,
		noLabel:       q.NoLabel,
		updatedFrom:   q.UpdatedFrom,
		updatedTo:     q.UpdatedTo,
		createdFrom:   q.CreatedFrom,
		createdTo:     q.CreatedTo,
	}
	if q.DoneWithinDays > 0 {
		cond.doneAfter = boardNow() - int64(q.DoneWithinDays)*millisPerDay
	}
	return cond
}

func (c issueConditions) keep(card IssueCardView) bool {
	if c.keyword != "" &&
		!strings.Contains(strings.ToLower(card.Title), c.keyword) &&
		!strings.Contains(strings.ToLower(card.Description), c.keyword) {
		return false
	}
	if !c.keepByLabels(card) {
		return false
	}
	if c.updatedFrom > 0 && card.UpdatedAt < c.updatedFrom {
		return false
	}
	if c.updatedTo > 0 && card.UpdatedAt > c.updatedTo {
		return false
	}
	if c.createdFrom > 0 && card.CreatedAt < c.createdFrom {
		return false
	}
	if c.createdTo > 0 && card.CreatedAt > c.createdTo {
		return false
	}
	if c.doneAfter > 0 && card.Stage == issueStageDone {
		// 历史卡可能没记下关闭时刻，退回最后修改时间——否则保留窗口会静默吞掉它们。
		closed := card.ClosedAt
		if closed == 0 {
			closed = card.UpdatedAt
		}
		if closed < c.doneAfter {
			return false
		}
	}
	return true
}

func (c issueConditions) keepByLabels(card IssueCardView) bool {
	// 「只看没有标签的」是一句完整的话，说了它就不再看选中的是哪些标签——两个条件
	// 一起判必然一张卡都留不下，那是一块解释不了的空板，不是用户表达的意思。
	if c.noLabel {
		return len(card.Labels) == 0
	}
	if len(c.labelSyncIDs) == 0 {
		return true
	}
	on := make(map[string]bool, len(card.Labels))
	for _, l := range card.Labels {
		on[l.SyncID] = true
	}
	hit := 0
	for _, want := range c.labelSyncIDs {
		if on[want] {
			hit++
		}
	}
	if c.labelMatchAll {
		return hit == len(c.labelSyncIDs)
	}
	return hit > 0
}

func uniqueStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// sortIssueCards 只有一种次序：按列、列内按位置。
//
// 看板的顺序是人拖出来的 `position`（决策 10「不给看板加排序」），所以这里没有第二
// 个次序可挑，也就没有一个「按什么排」的参数——列表视图在决策 3 里已经删掉了。以
// 同步标识收尾，同一份数据每次取回的顺序因此是稳定的。
func sortIssueCards(cards []IssueCardView) {
	sort.SliceStable(cards, func(i, j int) bool {
		a, b := cards[i], cards[j]
		if a.Stage != b.Stage {
			return a.Stage < b.Stage
		}
		if a.Position != b.Position {
			return a.Position < b.Position
		}
		return a.SyncID < b.SyncID
	})
}

// rollUpProjectIssueCounts 汇总「该项目及其子树里未完成的任务数」。
//
// 它**刻意不吃任何筛选条件**：这个数的用途就是判断该切到哪，跟着当前筛选缩水就
// 失去了用途。没有未归属任务时不给「未归属」那一档编一个 0——界面据此不摆一个
// 点进去必定是空板的入口。
func rollUpProjectIssueCounts(rows []*sync_entity.SyncObject, data *boardData) []ProjectIssueCountView {
	own := map[string]int64{}
	for _, row := range data.issues {
		var p issuePayload
		if json.Unmarshal([]byte(row.Payload), &p) != nil {
			continue
		}
		if normalizeStage(p.Stage) == issueStageDone {
			continue
		}
		own[p.ProjectSyncID]++
	}
	childrenOf := map[string][]string{}
	projectIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.Kind != sync_entity.KindProject {
			continue
		}
		projectIDs = append(projectIDs, row.SyncID)
		var pp projectPayload
		if json.Unmarshal([]byte(row.Payload), &pp) != nil || pp.ParentSyncID == "" {
			continue
		}
		childrenOf[pp.ParentSyncID] = append(childrenOf[pp.ParentSyncID], row.SyncID)
	}

	total := map[string]int64{}
	visiting := map[string]bool{}
	var walk func(id string) int64
	walk = func(id string) int64 {
		if v, ok := total[id]; ok {
			return v
		}
		if visiting[id] {
			return 0 // 数据异常成环时不至于转不出来
		}
		visiting[id] = true
		sum := own[id]
		for _, child := range childrenOf[id] {
			sum += walk(child)
		}
		delete(visiting, id)
		total[id] = sum
		return sum
	}

	out := make([]ProjectIssueCountView, 0, len(projectIDs)+1)
	if unassigned, ok := own[""]; ok {
		out = append(out, ProjectIssueCountView{ProjectSyncID: "", Count: unassigned})
	}
	sort.Strings(projectIDs)
	for _, id := range projectIDs {
		out = append(out, ProjectIssueCountView{ProjectSyncID: id, Count: walk(id)})
	}
	return out
}
