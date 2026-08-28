package workspace_svc

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// ── 浏览器直写看板（规格 2026-08-27-issues-board-project-scope「`agentre-server` 端」）──
//
// 走的是与组织面 / 项目面**完全同一条**写通道：账号级单调序列分配版本号
// （sync_repo.SyncState().NextVersion）、删除落墓碑、来源指纹记 ServerOriginFingerprint
// （空串，见 workspace.go），改只覆盖请求明确涉及的键（withOrgFields）。这里因此只写
// 看板自己那几条判据：
//
//   - 三个引用（项目 / Agent / 机器）与标签必须都是账号里存活的对象；
//   - stage 与 closed_at 联动——状态轴本轮消失，关闭时刻完全由阶段推导；
//   - 新卡落在目标列末尾、拖动落在相邻两卡之间；
//   - 删一张卡 / 一个标签时，它身上的关联行一并落墓碑。
//
// **这里没有、也不会有 agent_backend 的建与改**（与组织面同一条理由）：机器那颗 pill
// 只能从账号里已有的后端中挑一个，写通道里连一个能表达它的形状都没有。

// issueTones 是设计系统的 8 档**颜色名**（不是用途名），取值与桌面端
// issue_entity.Tones() 同源同序：颜色本身由两端共用的设计 token 管理，库里存的是名字。
// 库里落一个渲染不出来的色调，标签 chip 在两端都会掉回兜底底色。
var issueTones = []string{
	"gray", "red", "red_solid", "amber", "green", "steel", "blue", "violet",
}

// boardWriteKinds 是写路径那一次取数的类型集合：三个引用要核对、标签要核对、
// 同列的兄弟卡要算落点、关联行要按它级联。一次取回，不在写路径上散着查。
var boardWriteKinds = []string{
	sync_entity.KindProject, sync_entity.KindAgent, sync_entity.KindAgentBackend,
	sync_entity.KindLabel, sync_entity.KindIssue, sync_entity.KindIssueLabel,
}

// IssueWriteInput 是一次浏览器发起的任务写入。
//
// UserID 来自鉴权上下文而不是请求体（请求体里没有任何身份字段），写入范围因此只由
// 它圈定。Fields 只包含**这次请求明确涉及的键**；LabelSyncIDs 为 nil 即这次请求没提到
// 标签——省略与「清空标签」是两件事。
type IssueWriteInput struct {
	UserID       int64
	SyncID       string
	Fields       map[string]any
	LabelSyncIDs *[]string
}

// IssueMoveInput 是拖一张卡：落到哪一列、排在谁后面（AfterSyncID 为空即列首）。
type IssueMoveInput struct {
	UserID      int64
	SyncID      string
	Stage       string
	AfterSyncID string
}

// LabelWriteInput 是一次标签写入。Fields 只有 name 与 tone 两个键；status 由服务端
// 记（建出来的标签是存活的），浏览器不写它。
type LabelWriteInput struct {
	UserID int64
	SyncID string
	Fields map[string]any
}

func (s *workspaceSvc) CreateIssue(ctx context.Context, in IssueWriteInput) (*OrgWriteResult, error) {
	fields := copyOrgFields(in.Fields)
	if err := checkIssueFields(ctx, fields); err != nil {
		return nil, err
	}
	if strings.TrimSpace(stringField(fields, "title")) == "" {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	data, err := s.loadBoardWriteData(ctx, in.UserID)
	if err != nil {
		return nil, err
	}
	if err := checkIssueReferences(ctx, data, fields, in.LabelSyncIDs); err != nil {
		return nil, err
	}
	stage := normalizeStage(stringField(fields, "stage"))
	fields["stage"] = stage
	fields["closed_at"] = closedAtFor(stage, 0)
	// 落点由服务端算：写通道里根本没有 position 这个键（IssueFields 上没有它，
	// guard_test 也不让它长出来），新卡一律去目标列末尾。
	fields["position"] = tailPosition(data.issues, stage)

	res, err := s.createBoardRow(ctx, in.UserID, sync_entity.KindIssue, fields)
	if err != nil {
		return nil, err
	}
	if in.LabelSyncIDs != nil {
		if err := s.addIssueLabels(ctx, in.UserID, res.SyncID, *in.LabelSyncIDs); err != nil {
			return nil, err
		}
	}
	return res, nil
}

func (s *workspaceSvc) UpdateIssue(ctx context.Context, in IssueWriteInput) (*OrgWriteResult, error) {
	row, err := findBoardRow(ctx, in.UserID, sync_entity.KindIssue, in.SyncID)
	if err != nil {
		return nil, err
	}
	fields := copyOrgFields(in.Fields)
	if err := checkIssueFields(ctx, fields); err != nil {
		return nil, err
	}
	if _, ok := fields["title"]; ok && strings.TrimSpace(stringField(fields, "title")) == "" {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	data, err := s.loadBoardWriteData(ctx, in.UserID)
	if err != nil {
		return nil, err
	}
	if err := checkIssueReferences(ctx, data, fields, in.LabelSyncIDs); err != nil {
		return nil, err
	}
	if stage, ok := fields["stage"]; ok {
		normalized := normalizeStage(toString(stage))
		fields["stage"] = normalized
		fields["closed_at"] = closedAtFor(normalized, payloadClosedAt(row))
	}
	if err := s.saveIssuePayload(ctx, in.UserID, row, fields); err != nil {
		return nil, err
	}
	if in.LabelSyncIDs != nil {
		if err := s.applyIssueLabels(ctx, in.UserID, row.SyncID, data, *in.LabelSyncIDs); err != nil {
			return nil, err
		}
	}
	logger.Ctx(ctx).Info("workspace_svc.UpdateIssue: issue updated from web",
		zap.Int64("userId", in.UserID), zap.String("syncId", row.SyncID),
		zap.Int64("version", row.Version), zap.Strings("fields", keysOfOrgFields(fields)))
	return &OrgWriteResult{SyncID: row.SyncID, Version: row.Version}, nil
}

func (s *workspaceSvc) MoveIssue(ctx context.Context, in IssueMoveInput) (*OrgWriteResult, error) {
	stage := normalizeStage(in.Stage)
	if in.Stage != "" && stage != in.Stage {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	row, err := findBoardRow(ctx, in.UserID, sync_entity.KindIssue, in.SyncID)
	if err != nil {
		return nil, err
	}
	data, err := s.loadBoardWriteData(ctx, in.UserID)
	if err != nil {
		return nil, err
	}
	fields := map[string]any{
		"stage":     stage,
		"position":  positionAfter(data.issues, stage, in.SyncID, in.AfterSyncID),
		"closed_at": closedAtFor(stage, payloadClosedAt(row)),
	}
	if err := s.saveIssuePayload(ctx, in.UserID, row, fields); err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("workspace_svc.MoveIssue: issue repositioned from web",
		zap.Int64("userId", in.UserID), zap.String("syncId", row.SyncID),
		zap.String("stage", stage), zap.Int64("version", row.Version))
	return &OrgWriteResult{SyncID: row.SyncID, Version: row.Version}, nil
}

// DeleteIssue 落墓碑而不是物理删除：删除本身要能被下行游标带到每一台机器上，物理
// 删除只会让还没拉取的设备把它当成「从未存在」而重新推上来（R6）。
func (s *workspaceSvc) DeleteIssue(
	ctx context.Context, userID int64, syncID string,
) (*OrgWriteResult, error) {
	row, err := findBoardRow(ctx, userID, sync_entity.KindIssue, syncID)
	if err != nil {
		return nil, err
	}
	data, err := s.loadBoardWriteData(ctx, userID)
	if err != nil {
		return nil, err
	}
	if err := s.tombstoneLinks(ctx, userID, data, func(p issueLabelPayload) bool {
		return p.IssueSyncID == syncID
	}); err != nil {
		return nil, err
	}
	return s.tombstoneBoardRow(ctx, userID, row, "workspace_svc.DeleteIssue")
}

func (s *workspaceSvc) CreateLabel(ctx context.Context, in LabelWriteInput) (*OrgWriteResult, error) {
	fields := copyOrgFields(in.Fields)
	name := strings.TrimSpace(stringField(fields, "name"))
	if name == "" || !knownIssueTone(stringField(fields, "tone")) {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	fields["name"] = name
	if err := s.checkLabelNameFree(ctx, in.UserID, name, ""); err != nil {
		return nil, err
	}
	// status 由服务端记：server 没有本地行，读路径判「这个标签还在不在」只有这一个键。
	fields["status"] = consts.ACTIVE
	return s.createBoardRow(ctx, in.UserID, sync_entity.KindLabel, fields)
}

func (s *workspaceSvc) UpdateLabel(ctx context.Context, in LabelWriteInput) (*OrgWriteResult, error) {
	row, err := findBoardRow(ctx, in.UserID, sync_entity.KindLabel, in.SyncID)
	if err != nil {
		return nil, err
	}
	fields := copyOrgFields(in.Fields)
	if tone, ok := fields["tone"]; ok && !knownIssueTone(toString(tone)) {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	if raw, ok := fields["name"]; ok {
		name := strings.TrimSpace(toString(raw))
		if name == "" {
			return nil, i18n.NewError(ctx, code.InvalidParameter)
		}
		fields["name"] = name
		if err := s.checkLabelNameFree(ctx, in.UserID, name, row.SyncID); err != nil {
			return nil, err
		}
	}
	payload, err := withOrgFields(row.Payload, fields)
	if err != nil {
		return nil, err
	}
	row.Payload = payload
	if err := s.saveOrgRow(ctx, OrgWriteInput{UserID: in.UserID}, row); err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("workspace_svc.UpdateLabel: label updated from web",
		zap.Int64("userId", in.UserID), zap.String("syncId", row.SyncID),
		zap.Int64("version", row.Version), zap.Strings("fields", keysOfOrgFields(fields)))
	return &OrgWriteResult{SyncID: row.SyncID, Version: row.Version}, nil
}

// DeleteLabel 落墓碑，并把指向它的全部关联一并落——留着关联行就等于在每一台机器上
// 留下一串指向已消失标签的悬空引用（桌面端 labelAdapter.remove 也是这两步）。
func (s *workspaceSvc) DeleteLabel(
	ctx context.Context, userID int64, syncID string,
) (*OrgWriteResult, error) {
	row, err := findBoardRow(ctx, userID, sync_entity.KindLabel, syncID)
	if err != nil {
		return nil, err
	}
	data, err := s.loadBoardWriteData(ctx, userID)
	if err != nil {
		return nil, err
	}
	if err := s.tombstoneLinks(ctx, userID, data, func(p issueLabelPayload) bool {
		return p.LabelSyncID == syncID
	}); err != nil {
		return nil, err
	}
	return s.tombstoneBoardRow(ctx, userID, row, "workspace_svc.DeleteLabel")
}

// ── 共用的几段 ────────────────────────────────────────────────────────────────

func (s *workspaceSvc) loadBoardWriteData(ctx context.Context, userID int64) (*boardData, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, boardWriteKinds)
	if err != nil {
		return nil, err
	}
	return loadBoardData(rows), nil
}

// findBoardRow 把三条拒绝判在写入之前，与组织面的 findOrgRowForWrite 逐条同口径：
// 行在**当前账号**下不存在（跨账号的那一行正落在这里，Find 按（账号, 同步标识）取）、
// 类型与端点不符（与「不存在」共用一个码，分开就等于给出一个跨账号的存在性探测器）、
// 行已是墓碑（删除不复活，R6）。
func findBoardRow(
	ctx context.Context, userID int64, kind, syncID string,
) (*sync_entity.SyncObject, error) {
	if syncID == "" {
		return nil, i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
	}
	row, err := sync_repo.SyncObject().Find(ctx, userID, syncID)
	if err != nil {
		return nil, err
	}
	if row == nil || row.Kind != kind {
		return nil, i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
	}
	if row.IsDeleted() {
		return nil, i18n.NewError(ctx, code.OrgObjectDeleted)
	}
	return row, nil
}

// createBoardRow 落一行新的看板对象：server 分配同步标识与版本号，来源记空串。
// 与 CreateOrgObject 走的是同一套语义，只是闸门表与判据是看板自己的那一套。
func (s *workspaceSvc) createBoardRow(
	ctx context.Context, userID int64, kind string, fields map[string]any,
) (*OrgWriteResult, error) {
	payload, err := json.Marshal(orgFieldsOrEmpty(fields))
	if err != nil {
		return nil, err
	}
	version, err := sync_repo.SyncState().NextVersion(ctx, userID, 1)
	if err != nil {
		return nil, err
	}
	now := boardNow()
	obj := &sync_entity.SyncObject{
		UserID: userID, Kind: kind, SyncID: newOrgSyncID(now),
		Payload: string(payload), Version: version, SyncUpdatedAt: now,
		OriginFingerprint: ServerOriginFingerprint, Createtime: now, Updatetime: now,
	}
	if err := sync_repo.SyncObject().Save(ctx, obj); err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("workspace_svc.createBoardRow: board object created from web",
		zap.Int64("userId", userID), zap.String("kind", kind),
		zap.String("syncId", obj.SyncID), zap.Int64("version", obj.Version))
	accountchan_svc.BroadcastBestEffort(ctx, userID, obj.Version)
	return &OrgWriteResult{SyncID: obj.SyncID, Version: obj.Version}, nil
}

func (s *workspaceSvc) saveIssuePayload(
	ctx context.Context, userID int64, row *sync_entity.SyncObject, fields map[string]any,
) error {
	payload, err := withOrgFields(row.Payload, fields)
	if err != nil {
		return err
	}
	row.Payload = payload
	return s.saveOrgRow(ctx, OrgWriteInput{UserID: userID}, row)
}

func (s *workspaceSvc) tombstoneBoardRow(
	ctx context.Context, userID int64, row *sync_entity.SyncObject, from string,
) (*OrgWriteResult, error) {
	row.DeletedAt = boardNow()
	if err := s.saveOrgRow(ctx, OrgWriteInput{UserID: userID}, row); err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info(from+": board object tombstoned from web",
		zap.Int64("userId", userID), zap.String("kind", row.Kind),
		zap.String("syncId", row.SyncID), zap.Int64("version", row.Version))
	return &OrgWriteResult{SyncID: row.SyncID, Version: row.Version}, nil
}

// tombstoneLinks 把命中 pick 的关联行逐条落墓碑，与 cascadeProjectDelete 同形。
func (s *workspaceSvc) tombstoneLinks(
	ctx context.Context, userID int64, data *boardData, pick func(issueLabelPayload) bool,
) error {
	now := boardNow()
	cascaded := 0
	for _, row := range data.linkRows {
		var p issueLabelPayload
		if json.Unmarshal([]byte(row.Payload), &p) != nil || !pick(p) {
			continue
		}
		version, err := sync_repo.SyncState().NextVersion(ctx, userID, 1)
		if err != nil {
			return err
		}
		n, err := sync_repo.SyncObject().Tombstone(ctx, row.ID, version, now)
		if err != nil {
			return err
		}
		cascaded += int(n)
	}
	if cascaded > 0 {
		logger.Ctx(ctx).Info("workspace_svc.tombstoneLinks: issue labels tombstoned from web",
			zap.Int64("userId", userID), zap.Int("cascadedCount", cascaded))
	}
	return nil
}

// applyIssueLabels 是一次**差集**：新挂的建一行关联，摘掉的落墓碑，没动的一行都不碰
// ——重建全部关联会让每一次保存都在账号里刷掉一批版本号，而版本号是下行游标的刻度。
func (s *workspaceSvc) applyIssueLabels(
	ctx context.Context, userID int64, issueSyncID string, data *boardData, want []string,
) error {
	wanted := make(map[string]bool, len(want))
	for _, id := range uniqueStrings(want) {
		wanted[id] = true
	}
	have := map[string]bool{}
	if err := s.tombstoneLinks(ctx, userID, data, func(p issueLabelPayload) bool {
		if p.IssueSyncID != issueSyncID {
			return false
		}
		have[p.LabelSyncID] = true
		return !wanted[p.LabelSyncID]
	}); err != nil {
		return err
	}
	add := make([]string, 0, len(wanted))
	for id := range wanted {
		if !have[id] {
			add = append(add, id)
		}
	}
	sort.Strings(add)
	return s.addIssueLabels(ctx, userID, issueSyncID, add)
}

func (s *workspaceSvc) addIssueLabels(
	ctx context.Context, userID int64, issueSyncID string, labelSyncIDs []string,
) error {
	for _, labelSyncID := range uniqueStrings(labelSyncIDs) {
		if _, err := s.createBoardRow(ctx, userID, sync_entity.KindIssueLabel, map[string]any{
			"issue_sync_id": issueSyncID, "label_sync_id": labelSyncID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// checkIssueFields 判的是**写进去的值**：请求没提到阶段时不动原来的列，显式写一个
// 不认识的阶段则当场拒——落下去的卡在两端都会掉进一个不存在的列里。
func checkIssueFields(ctx context.Context, fields map[string]any) error {
	raw, ok := fields["stage"]
	if !ok {
		return nil
	}
	stage := toString(raw)
	if stage != "" && normalizeStage(stage) != stage {
		return i18n.NewError(ctx, code.InvalidParameter)
	}
	return nil
}

// checkIssueReferences 落实「三个引用与标签都得指到账号里存活的对象」。
//
// 指不到的一端在每一台机器上都解析不出引用，按 R2a 一直暂缓，用户只看到「这张卡
// 同步不过去」；而它在界面上与一张正常的卡长得一模一样。请求没提到某个引用时不核对。
func checkIssueReferences(
	ctx context.Context, data *boardData, fields map[string]any, labelSyncIDs *[]string,
) error {
	live := map[string]map[string]bool{
		sync_entity.KindProject:      {},
		sync_entity.KindAgent:        {},
		sync_entity.KindAgentBackend: {},
	}
	for _, row := range data.rows {
		if set, ok := live[row.Kind]; ok && !row.IsDeleted() {
			set[row.SyncID] = true
		}
	}
	for key, kind := range map[string]string{
		"project_sync_id":       sync_entity.KindProject,
		"agent_sync_id":         sync_entity.KindAgent,
		"agent_backend_sync_id": sync_entity.KindAgentBackend,
	} {
		raw, ok := fields[key]
		if !ok {
			continue
		}
		// 空串是一个**有意义**的值：取消归属 / 不指定执行归属，不参与核对。
		if value := toString(raw); value != "" && !live[kind][value] {
			return i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
		}
	}
	if labelSyncIDs == nil {
		return nil
	}
	for _, id := range *labelSyncIDs {
		if _, ok := data.labels[id]; !ok {
			return i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
		}
	}
	return nil
}

// checkLabelNameFree 落实「标签名在账号里唯一」。名字就是标签的自然键（桌面端的
// uniq_labels_name_active），两行同名的标签下行到本机会被合并到同一行上，用户看到的
// 是「删了一个另一个还在」。改成自己现在的名字不算重名。
func (s *workspaceSvc) checkLabelNameFree(
	ctx context.Context, userID int64, name, selfSyncID string,
) error {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindLabel})
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.SyncID == selfSyncID {
			continue
		}
		var p labelPayload
		if json.Unmarshal([]byte(row.Payload), &p) != nil || p.Status != consts.ACTIVE {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(p.Name), name) {
			return i18n.NewError(ctx, code.InvalidParameter)
		}
	}
	return nil
}

func knownIssueTone(tone string) bool {
	for _, known := range issueTones {
		if tone == known {
			return true
		}
	}
	return false
}

// closedAtFor 关闭时刻完全由阶段推导：进 done 记下时刻（已经记过的不重记，否则
// 每拖动一次都会把「什么时候完成的」刷成现在），离开 done 清掉它。
func closedAtFor(stage string, current int64) int64 {
	if stage != issueStageDone {
		return 0
	}
	if current > 0 {
		return current
	}
	return boardNow()
}

func payloadClosedAt(row *sync_entity.SyncObject) int64 {
	var p issuePayload
	if json.Unmarshal([]byte(row.Payload), &p) != nil {
		return 0
	}
	return p.ClosedAt
}

// tailPosition 新卡落在目标列的末尾。留 0 会让每一张新卡都和别人撞在同一个位置上，
// 列内次序随后完全由标识决定——用户排的序看上去自己乱了。
func tailPosition(issues []*sync_entity.SyncObject, stage string) float64 {
	max := 0.0
	found := false
	for _, card := range stageCards(issues, stage, "") {
		if !found || card.Position > max {
			max, found = card.Position, true
		}
	}
	if !found {
		return positionStep
	}
	return max + positionStep
}

// positionAfter 把卡片放到 afterSyncID 之后：落点相邻两卡取中点，顶 / 底外扩一格。
// afterSyncID 为空即列首；它不在目标列里（异常）则落底——范围仍是一个确定的位置。
func positionAfter(issues []*sync_entity.SyncObject, stage, movingSyncID, afterSyncID string) float64 {
	seq := stageCards(issues, stage, movingSyncID)
	if len(seq) == 0 {
		return positionStep
	}
	if afterSyncID == "" {
		return seq[0].Position - positionStep
	}
	for idx, card := range seq {
		if card.SyncID != afterSyncID {
			continue
		}
		if idx == len(seq)-1 {
			return card.Position + positionStep
		}
		return (card.Position + seq[idx+1].Position) / 2
	}
	return seq[len(seq)-1].Position + positionStep
}

// stageCards 取某一列里的卡，按位置升序，跳过 skipSyncID（被拖动的那一张自己）。
func stageCards(issues []*sync_entity.SyncObject, stage, skipSyncID string) []IssueCardView {
	out := make([]IssueCardView, 0, len(issues))
	for _, row := range issues {
		if row.SyncID == skipSyncID {
			continue
		}
		card := toIssueCardView(row, nil)
		if card.Stage != stage {
			continue
		}
		out = append(out, card)
	}
	sortIssueCards(out)
	return out
}

// copyOrgFields 不改调用方那张 map：这一族要往里补 stage / closed_at / position，
// 就地改会让控制器传进来的那份跟着变。
func copyOrgFields(fields map[string]any) map[string]any {
	out := make(map[string]any, len(fields)+3)
	for k, v := range fields {
		out[k] = v
	}
	return out
}

func stringField(fields map[string]any, key string) string {
	return toString(fields[key])
}

func toString(v any) string {
	s, _ := v.(string)
	return s
}
