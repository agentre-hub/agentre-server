// Package sync_svc 编排工作区多端同步的上行、下行、本机路径上报与头像存取。
package sync_svc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// TombstoneWindow 是墓碑保留窗口，同时也是 R6a 的超窗口判据：距今超过它的设备
// 必须先拉一份全量快照再上行。
const TombstoneWindow = 30 * 24 * time.Hour

// DefaultPullLimit / MaxPullLimit 约束一次下行取多少行。
const (
	DefaultPullLimit = 200
	MaxPullLimit     = 1000
)

// MaxAvatarBytes 限制单份头像正文的大小。
//
// 这里量的是 base64 data URL **整串**的长度，而桌面端的上限（agent_svc 的
// avatarMaxBytes = 2 MiB）量的是解码后的字节数——过机的是整串，两个数字不可
// 直接相比：base64 按 4/3 膨胀，再加上 "data:image/png;base64," 这段前缀，
// 桌面端放行的最大一张头像到这里约 2.67 MiB。上限取 4 MiB，覆盖桌面端接受的
// 任何一张图（R16a 的「换头像照常触发同步」因此在大图上也成立），同时仍然是
// 一个上限——它挡的是明显不是头像的正文。
const MaxAvatarBytes = 4 * 1024 * 1024

type SyncSvc interface {
	Push(ctx context.Context, in PushInput) (*PushOutput, error)
	Pull(ctx context.Context, in PullInput) (*PullOutput, error)
	ReportLocalPaths(ctx context.Context, in LocalPathsInput) error
	PutAvatar(ctx context.Context, in AvatarInput) error
	GetAvatar(ctx context.Context, userID int64, contentHash string) (*AvatarOutput, error)
	// PurgeDeviceLocalPaths 删掉某台设备名下全部上报的本机路径记录（R18）。
	PurgeDeviceLocalPaths(ctx context.Context, deviceID int64) error
	// PurgeDeviceSyncObjects 把只属于某台机器的账号级同步对象落墓碑（R14/R18），
	// 并按 R6 的级联把引用其中 backend 的执行目标列表项一并落墓碑。
	PurgeDeviceSyncObjects(ctx context.Context, userID int64, fingerprint string) error
	// ReclaimExpired 回收超期墓碑与无人引用的头像正文（决策 9、R16a），
	// 由定时任务周期性调用。
	ReclaimExpired(ctx context.Context) (*ReclaimOutput, error)
}

type syncSvc struct {
	now func() int64
}

var defaultSvc SyncSvc = newSyncSvc()

func Default() SyncSvc { return defaultSvc }

// SetDefault 换掉默认实现；controller 测试用它注入桩。
func SetDefault(s SyncSvc) { defaultSvc = s }

func newSyncSvc() *syncSvc {
	return &syncSvc{now: func() int64 { return time.Now().UnixMilli() }}
}

// Push 收下一批上行。
//
// 三件事在这里一次性解决，且只在这里解决：R6a 的超窗口判定、R4a 的冲突判定、
// R4b 的路径记录自然键合并。放在 server 是因为它是唯一时钟源——一次判定的结果
// 对所有端一致，每台桌面端各判一次则不然。
func (s *syncSvc) Push(ctx context.Context, in PushInput) (*PushOutput, error) {
	now := s.now()

	overWindow, err := s.beyondTombstoneWindow(ctx, in.UserID, in.DeviceID, now)
	if err != nil {
		return nil, err
	}
	if overWindow {
		logger.Ctx(ctx).Warn("sync push rejected: device beyond tombstone window",
			zap.Int64("userId", in.UserID), zap.Int64("deviceId", in.DeviceID))
		return nil, i18n.NewError(ctx, code.SyncResyncRequired)
	}

	// 先跑一遍纯校验。rejectReason 不碰库(只做类型/自然键/载荷校验加一条日志),
	// 所以它可以、也应该在事务外跑完:一来能据此算出这一批真正需要几个版本号,
	// 拒掉的条目因此仍然一个号都不烧;二来日志不再压在事务里。
	reasons := make([]string, len(in.Items))
	var needs int64
	for i, item := range in.Items {
		// 校验不通过只拒这一条：整批拒会把上行端的队列永久堵死，见
		// PushRejectReasonKind 一族常量的注释。
		reasons[i] = rejectReason(ctx, item)
		if reasons[i] == "" {
			needs++
		}
	}

	// 整批的版本号一次取完,而且取在外层事务**之前**。
	//
	// 从前是每条 item 各取一次,而 NextVersion 自己是一个嵌套事务(SAVEPOINT)加两条
	// 语句;api/sync 允许一批 500 条,于是一次 Push 在同一个外层事务里要发上千次往返。
	// 更要命的是锁:那条 INSERT … ON DUPLICATE KEY UPDATE 跑在外层事务内,
	// sync_account_seqs 里该账号那一行的排他锁从第一条 item 一直持有到整批提交,
	// 同账号两台设备并发上行完全串行。取在事务之前,行锁只被持有一次往返的时间。
	//
	// 块里剩下没发完的号(某条 item 在 applyItem 里才被判出类型不符或撞墓碑)只是
	// 序列上的空号。版本号是单调游标,下行按「version > cursor」取,空号对任何一端
	// 都不可观察。
	versions, err := newVersionBlock(ctx, in.UserID, needs)
	if err != nil {
		return nil, err
	}

	// 「最后修改来自哪台机器」落库的是**指纹**（决策 14）：数值设备主键是这个 server
	// 的本地键，桌面端离线创建的行没有它，而工作区里其余跨机引用一律用指纹。凭据里
	// 只有设备号，所以这里按号解一次指纹——整批一次，不是每条一次。
	originFingerprint, err := s.originFingerprintOf(ctx, in.DeviceID)
	if err != nil {
		return nil, err
	}

	out := &PushOutput{Results: make([]PushItemResult, 0, len(in.Items))}
	err = db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)
		out.Results = out.Results[:0]
		for i, item := range in.Items {
			if reasons[i] != "" {
				out.Results = append(out.Results, PushItemResult{
					SyncID: item.SyncID, Kind: item.Kind,
					Status: PushStatusRejected, Reason: reasons[i],
				})
				continue
			}
			res, err := s.applyItem(txCtx, in.UserID, originFingerprint, now, item, versions)
			if err != nil {
				return err
			}
			out.Results = append(out.Results, *res)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	accountchan_svc.BroadcastBestEffort(ctx, in.UserID, highestWrittenVersion(out.Results))
	return out, nil
}

// versionBlock 是一次 Push 预先从账号序列取走的一段版本号,在内存里按序发放。
//
// NextVersion(ctx, userID, n) 原子取走 n 个并返回其中**最大**的那个,所以这一段是
// [last-n+1, last]。发放顺序即 item 顺序,与逐条取号时的编号完全一致。
type versionBlock struct {
	next, last int64
}

func newVersionBlock(ctx context.Context, userID, n int64) (*versionBlock, error) {
	if n <= 0 {
		return &versionBlock{next: 1, last: 0}, nil
	}
	last, err := sync_repo.SyncState().NextVersion(ctx, userID, n)
	if err != nil {
		return nil, err
	}
	return &versionBlock{next: last - n + 1, last: last}, nil
}

// take 领一个版本号。块用完时再向序列要一个,而不是让整批 Push 失败——块按 item
// 条数预取,而自然键合并会在一条 item 上额外烧掉一个号(墓碑一个、胜者一个),
// 那种情况下走这条补领路径。
func (b *versionBlock) take(ctx context.Context, userID int64) (int64, error) {
	if b.next <= b.last {
		version := b.next
		b.next++
		return version, nil
	}
	return sync_repo.SyncState().NextVersion(ctx, userID, 1)
}

// highestWrittenVersion 从一批 Push 结果里挑出这一次操作实际烧到的最高版本号。
// PushStatusRejected 要么在拿到新版本号之前就返回（校验不通过、类型不符、撞墓碑），
// 要么只是回声 server 上早已存在的版本——两种情况都没有新写入，因此被排除；
// Accepted 与 Conflict 都在 applyItem 里走过 NextVersion + Save，Version 是新的。
func highestWrittenVersion(results []PushItemResult) int64 {
	var version int64
	for _, res := range results {
		if res.Status == PushStatusRejected {
			continue
		}
		if res.Version > version {
			version = res.Version
		}
	}
	return version
}

// beyondTombstoneWindow 判 R6a：没有 last_sync_at 记录 = 首次登录的设备，不算
// 超窗口——把它拦下来只会让新设备第一次同步就卡住。
//
// last_sync_at 记的是「这台设备最近一次把增量**消费干净**的时刻」（见 Pull），
// 不是「最近一次联系过」。两者的差别正是这条守卫的全部意义：卡在某一行落不了地
// 的设备照样每 30 秒来一次，用「最近联系过」量，30 天窗口永远不会触发。
func (s *syncSvc) beyondTombstoneWindow(ctx context.Context, userID, deviceID, now int64) (bool, error) {
	st, err := sync_repo.SyncState().FindDeviceState(ctx, userID, deviceID)
	if err != nil {
		return false, err
	}
	if st == nil || st.LastSyncAt <= 0 {
		return false, nil
	}
	return now-st.LastSyncAt > TombstoneWindow.Milliseconds(), nil
}

// rejectReason 报告这一条该不该被单独拒掉，空串 = 放行。
func rejectReason(ctx context.Context, item PushItem) string {
	if !sync_entity.KindValid(item.Kind) || item.SyncID == "" {
		return PushRejectReasonKind
	}
	// 路径记录的账号内自然键是（项目同步标识, 指纹）；没有项目同步标识就没有自然键，
	// R4b 的合并也就无从谈起。
	//
	// 墓碑不在此列：mergeLocationNaturalKey 对已删除的对象直接返回，删除本来就不参与
	// 自然键合并；而桌面端的 buildPushItem 删除分支刻意不读本地行（行可能已经软删），
	// 因此路径记录的墓碑上行本来就不带 project_sync_id。
	if (item.Kind == sync_entity.KindProjectLocation || item.Kind == sync_entity.KindAgentBackendCLI) &&
		(item.ProjectSyncID == "" || item.AgentredFingerprint == "") && item.DeletedAt == 0 {
		return PushRejectReasonKind
	}
	if err := sync_entity.ValidatePayload(item.Kind, item.Payload); err != nil {
		// 载荷内容一律不进日志：里面有项目路径、prompt 与 EnvJSON。
		logger.Ctx(ctx).Warn("sync payload rejected",
			zap.String("kind", item.Kind), zap.String("syncId", item.SyncID), zap.Error(err))
		return PushRejectReasonPayload
	}
	return ""
}

// originFingerprintOf 把凭据里的设备号解成这台机器的指纹。设备行查不到时交回空串
// ——那与「服务端直写」同义（workspace_svc.ServerOriginFingerprint），而这一列没有
// 任何判定读它（决策 14），不值得让一整批上行失败。
func (s *syncSvc) originFingerprintOf(ctx context.Context, deviceID int64) (string, error) {
	if deviceID == 0 {
		return "", nil
	}
	row, err := device_repo.Device().Find(ctx, deviceID)
	if err != nil {
		return "", err
	}
	if row == nil {
		logger.Ctx(ctx).Warn("sync_svc.originFingerprintOf: device row missing",
			zap.Int64("deviceId", deviceID))
		return "", nil
	}
	return row.Fingerprint, nil
}

func (s *syncSvc) applyItem(
	ctx context.Context, userID int64, originFingerprint string, now int64,
	item PushItem, versions *versionBlock,
) (*PushItemResult, error) {
	existing, err := sync_repo.SyncObject().Find(ctx, userID, item.SyncID)
	if err != nil {
		return nil, err
	}
	res := &PushItemResult{SyncID: item.SyncID, Kind: item.Kind, Status: PushStatusAccepted}
	if existing != nil {
		if existing.Kind != item.Kind {
			// 同一个同步标识换了类型：只拒这一条，同批其余的照常落库。
			res.Status, res.Reason, res.Version = PushStatusRejected, PushRejectReasonKind, existing.Version
			return res, nil
		}
		// R6：删除不会被复活。server 上已是墓碑时，任何非删除的上行都被拒——
		// 一台持有旧副本的桌面端把它推上来就把删除撤销了。R5a 的「恢复一个已被
		// 删除的对象时明确拒绝」正是这一条；界面据此提供「按这份内容新建」。
		// 重复投递的删除照常受理：离线队列恢复后同一条可能被投两次（R7）。
		if existing.IsDeleted() && item.DeletedAt == 0 {
			res.Status = PushStatusRejected
			res.Reason = PushRejectReasonDeleted
			res.Version = existing.Version
			return res, nil
		}
		// R4a：基版本不符判为冲突；基版本为空但同步标识已存在也算——否则两端会
		// 各自「新建」出同一个标识，而「我的改动被覆盖了」与「他端后来又正常改了
		// 一次」在数据上完全同形，R5 的追回承诺就无从兑现。
		if item.BaseVersion == 0 || item.BaseVersion != existing.Version {
			res.Status = PushStatusConflict
			res.OverwrittenVersion = existing.Version
			res.OverwrittenOriginFingerprint = existing.OriginFingerprint
			// 被覆盖掉的正文只在 server 手上，随应答带回去，R5 才追得回来。
			res.OverwrittenPayload = existing.Payload
		}
	}

	obj := &sync_entity.SyncObject{
		UserID:              userID,
		Kind:                item.Kind,
		SyncID:              item.SyncID,
		ProjectSyncID:       item.ProjectSyncID,
		AgentredFingerprint: item.AgentredFingerprint,
		Payload:             payloadOrEmptyObject(item.Payload),
		SyncUpdatedAt:       item.UpdatedAt,
		OriginFingerprint:   originFingerprint,
		Createtime:          now,
		Updatetime:          now,
		// 墓碑带的是**发起端记下的删除时刻**，不是 server 的当下（决策 20）：那一刻
		// 在桌面端库、线格式与本库三处都存在，server 没有理由再编一个。
		// 但它要夹回本机时钟的窗口内，见 clampTombstoneInstant。
		DeletedAt: clampTombstoneInstant(item.DeletedAt, now),
	}

	version, err := versions.take(ctx, userID)
	if err != nil {
		return nil, err
	}
	obj.Version = version

	if err := s.mergeLocationNaturalKey(ctx, userID, now, obj, res, versions); err != nil {
		return nil, err
	}
	if err := sync_repo.SyncObject().Save(ctx, obj); err != nil {
		return nil, err
	}
	res.Version = obj.Version
	return res, nil
}

// mergeLocationNaturalKey 落实 R4b：两端在互不知情的情况下为同一（项目, agentred
// 指纹）各建了一行，带着不同的同步标识落在同一个自然键上，由 server 合并成一行
// ——按 R4 判出胜者并沿用胜者的同步标识，落败的那份落墓碑（上行端据此按 R5 落一条
// 记录）。合并在这里做而不是让每台桌面端各自做，是因为 server 已经是唯一时钟源。
//
// 墓碑必须先落：uk_sync_objects_natural 这个部分唯一索引只允许自然键上有一行存活。
func (s *syncSvc) mergeLocationNaturalKey(
	ctx context.Context, userID, now int64, obj *sync_entity.SyncObject, res *PushItemResult,
	versions *versionBlock,
) error {
	if (obj.Kind != sync_entity.KindProjectLocation && obj.Kind != sync_entity.KindAgentBackendCLI) || obj.IsDeleted() {
		return nil
	}
	var dup *sync_entity.SyncObject
	var err error
	if obj.Kind == sync_entity.KindProjectLocation {
		dup, err = sync_repo.SyncObject().FindLocationByNaturalKey(
			ctx, userID, obj.ProjectSyncID, obj.AgentredFingerprint)
	} else {
		dup, err = sync_repo.SyncObject().FindCLIOverlayByNaturalKey(
			ctx, userID, obj.ProjectSyncID, obj.AgentredFingerprint)
	}
	if err != nil {
		return err
	}
	if dup == nil || dup.SyncID == obj.SyncID {
		return nil
	}

	if !obj.Wins(dup) {
		// 兜底分支：本次上行的版本刚从单调序列取出，正常情况下必然更大，走不到这里。
		// 留着它是为了让胜负只由 R4（版本号，平局看来源设备）决定，而不是靠「后到的
		// 那个一定赢」这个隐含假设——版本分配方式一变，这里仍然是对的。
		obj.DeletedAt = now
		res.MergedSyncID, res.MergedVersion, res.MergedOriginFingerprint = obj.SyncID, obj.Version, obj.OriginFingerprint
		logger.Ctx(ctx).Info("project location merged: incoming lost",
			zap.Int64("userId", userID), zap.String("keptSyncId", dup.SyncID),
			zap.String("mergedSyncId", obj.SyncID))
		return nil
	}

	// 墓碑要排在胜者前面：下行是按版本升序取的，接收端先看到墓碑、再看到胜者，
	// 自然键上就不会有一瞬间存在两行存活的行（它那边同样有唯一约束）。obj 此刻
	// 拿着的是本次上行先取到的那个较小版本，正好留给墓碑，胜者再取一个更大的。
	tombstoneVersion := obj.Version
	winnerVersion, err := versions.take(ctx, userID)
	if err != nil {
		return err
	}
	obj.Version = winnerVersion
	n, err := sync_repo.SyncObject().Tombstone(ctx, dup.ID, tombstoneVersion, now)
	if err != nil {
		return err
	}
	if n != 1 {
		// 并发的另一次上行已经把它合并掉了：自然键上没有第二行要处理。
		return nil
	}
	res.MergedSyncID, res.MergedVersion, res.MergedOriginFingerprint = dup.SyncID, dup.Version, dup.OriginFingerprint
	logger.Ctx(ctx).Info("project location merged on natural key",
		zap.Int64("userId", userID), zap.String("keptSyncId", obj.SyncID),
		zap.String("mergedSyncId", dup.SyncID))
	return nil
}

// Pull 按版本游标增量下行。墓碑也在其中——R6 的删除靠它到达各端。
//
// 超窗口的设备照样能下行：R6a 要求它先拉一份全量快照（游标从 0 开始），拉取本身
// 不能被拦。
func (s *syncSvc) Pull(ctx context.Context, in PullInput) (*PullOutput, error) {
	limit := in.Limit
	if limit <= 0 {
		limit = DefaultPullLimit
	}
	if limit > MaxPullLimit {
		limit = MaxPullLimit
	}
	rows, err := sync_repo.SyncObject().ListSince(ctx, in.UserID, in.Cursor, limit)
	if err != nil {
		return nil, err
	}
	out := &PullOutput{Items: make([]PullItem, 0, len(rows)), NextCursor: in.Cursor}
	for _, row := range rows {
		out.Items = append(out.Items, PullItem{
			Kind:                row.Kind,
			SyncID:              row.SyncID,
			ProjectSyncID:       row.ProjectSyncID,
			AgentredFingerprint: row.AgentredFingerprint,
			Payload:             []byte(row.Payload),
			Version:             row.Version,
			UpdatedAt:           row.SyncUpdatedAt,
			OriginFingerprint:   row.OriginFingerprint,
			DeletedAt:           row.DeletedAt,
		})
		if row.Version > out.NextCursor {
			out.NextCursor = row.Version
		}
	}
	out.HasMore = len(rows) == limit

	// 这一页一行都没有，有**两种**成因，处置相反，必须先分开。
	if len(rows) == 0 {
		head, err := sync_repo.SyncState().CurrentVersion(ctx, in.UserID)
		if err != nil {
			return nil, err
		}
		// ① 游标超出账号序列的头：这段历史不是本账号发出的（库被重建，或用户换了
		// 一套自建服务端，序列从头开始）。空页在这里是个假象——它不表示「消费干净」，
		// 而表示「我不认识你说的那段历史」。照旧刷新窗口的后果是死锁：设备的游标
		// 永远追不上一个更小的序列，每一轮都拿回空页、每一轮都把 last_sync_at 刷新，
		// R6a 因此永不触发，设备也就永远等不到重同步的指令，而界面上一切正常。
		if in.Cursor > head {
			logger.Ctx(ctx).Warn("sync pull rejected: cursor beyond account sequence",
				zap.Int64("userId", in.UserID), zap.Int64("deviceId", in.DeviceID),
				zap.Int64("cursor", in.Cursor), zap.Int64("head", head))
			return nil, i18n.NewError(ctx, code.SyncCursorUnknown)
		}
		// ② 游标站在序列的头上：这台设备确实把增量消费干净了，此刻它不可能漏掉任何
		// 墓碑，R6a 的 30 天窗口据此刷新。
		//
		// 反过来，只要还有没消费的行就不刷新——这正是要拦的那一类：某一行在它那边落不
		// 了地，它每 30 秒来一次、每次拿回同一页，游标原地不动。用「最近联系过」量窗口
		// 时它永远是新的，那台机器可以拿着任意陈旧的基版本把一个已被回收的删除推回来。
		// 上行同理不刷新（见 Push）：只推不收的设备一样没有消费过任何东西。
		if err := sync_repo.SyncState().TouchDeviceState(ctx, in.UserID, in.DeviceID, s.now()); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ReportLocalPaths 收下上报组的整份快照。它按设备分命名空间，与同步组无关：
// 本机路径不在桌面端之间流动，删除靠「这次快照里没有它」生效。
func (s *syncSvc) ReportLocalPaths(ctx context.Context, in LocalPathsInput) error {
	now := s.now()
	items := make([]*sync_entity.DeviceLocalPath, 0, len(in.Items))
	for _, it := range in.Items {
		if it.ProjectSyncID == "" {
			return i18n.NewError(ctx, code.InvalidParameter)
		}
		items = append(items, &sync_entity.DeviceLocalPath{
			UserID:        in.UserID,
			DeviceID:      in.DeviceID,
			ProjectSyncID: it.ProjectSyncID,
			Path:          it.Path,
			Updatetime:    now,
		})
	}
	return sync_repo.SyncLocalPath().ReplaceSnapshot(ctx, in.UserID, in.DeviceID, items)
}

// PutAvatar 按内容哈希存一份头像正文，与设备无关：同一张图在多少台设备上出现，
// server 上都只有一行。
func (s *syncSvc) PutAvatar(ctx context.Context, in AvatarInput) error {
	if in.Content == "" || int64(len(in.Content)) > MaxAvatarBytes {
		return i18n.NewError(ctx, code.InvalidParameter)
	}
	hash := strings.ToLower(strings.TrimSpace(in.ContentHash))
	if hash != sha256Hex(in.Content) {
		return i18n.NewError(ctx, code.SyncAvatarHashMismatch)
	}
	return sync_repo.SyncAvatar().Save(ctx, &sync_entity.SyncAvatar{
		UserID:      in.UserID,
		ContentHash: hash,
		ContentType: in.ContentType,
		Content:     in.Content,
		ByteSize:    int64(len(in.Content)),
		Createtime:  s.now(),
	})
}

func (s *syncSvc) GetAvatar(ctx context.Context, userID int64, contentHash string) (*AvatarOutput, error) {
	a, err := sync_repo.SyncAvatar().Find(ctx, userID, strings.ToLower(strings.TrimSpace(contentHash)))
	if err != nil {
		return nil, err
	}
	if a == nil {
		return nil, i18n.NewNotFoundError(ctx, code.SyncAvatarNotFound)
	}
	return &AvatarOutput{ContentHash: a.ContentHash, ContentType: a.ContentType, Content: a.Content}, nil
}

// PurgeDeviceLocalPaths 删掉某台设备名下全部上报的本机路径记录（R18）：用户在
// web 端删除（撤销）一台设备的记录时，该设备的这份清单跟着消失，账号级对象
// （sync_objects）不受影响——它们不属于那台桌面端。
func (s *syncSvc) PurgeDeviceLocalPaths(ctx context.Context, deviceID int64) error {
	return sync_repo.SyncLocalPath().DeleteByDevice(ctx, deviceID)
}

// deviceScopedKinds 是「这台机器不在了就没有意义」的两类账号级对象：它的 CLI
// 覆盖，以及它上面的项目路径。两者的 agentred_fingerprint 都是那台 daemon 的指纹，
// 因此一条 WHERE 就能圈出来。
//
// 其余对象一律不在此列：项目 / 部门 / Agent / llm_provider / 成员关系描述的是账号
// 本身，一台机器离开账号不该让它们消失。**backend 身份与执行目标同样不在此列**，
// 尽管一个 backend 现在明确带着它的运行设备（agentred_fingerprint）：后端是一份可以
// 改指到另一台机器的配置，机器撤销之后它在控制台里如实标成「设备已撤销」等着用户
// 改指（规格 2026-08-21「同步与身份」决策 8），替用户删掉才是丢东西。
var deviceScopedKinds = []string{sync_entity.KindProjectLocation, sync_entity.KindAgentBackendCLI}

// PurgeDeviceSyncObjects 把只属于某台机器的账号级同步对象落墓碑：控制台「解除授权」
// 与机器上 `agentred logout` 共用这一条路径（两者都经 device_svc.Revoke 到这里）。
//
// **必须是墓碑，不能是硬删。** 这些对象的删除要随同步游标传给其它设备；硬删会让
// 旧副本永远不知道该撤掉自己的路径或 CLI 覆盖，后续一次编辑还会把它重新推回来，
// 直接违反 R6。落墓碑并分配新版本号之后，删除随正常下行传播到每一端。
//
// 空指纹直接返回：它不指代任何一台具体机器（规格 2026-08-21 推翻了「当前这台桌面端
// 的相对引用」那条读法——空指纹只是「没写运行设备」）。拿它当过滤条件会把账号下每
// 一条没写设备的 CLI 覆盖一次全部落墓碑。
func (s *syncSvc) PurgeDeviceSyncObjects(ctx context.Context, userID int64, fingerprint string) error {
	if fingerprint == "" {
		return nil
	}
	rows, err := sync_repo.SyncObject().ListLiveByFingerprint(ctx, userID, fingerprint, deviceScopedKinds)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	now := s.now()
	tombstoned := 0
	var lastVersion int64
	for _, row := range rows {
		// 逐行取版本：墓碑要像一次普通的写入那样各占一个版本号，下行才按序到达。
		version, err := sync_repo.SyncState().NextVersion(ctx, userID, 1)
		if err != nil {
			return err
		}
		lastVersion = version
		n, err := sync_repo.SyncObject().Tombstone(ctx, row.ID, version, now)
		if err != nil {
			return err
		}
		// n == 0：并发的一次上行已经把它删掉了，这一行没什么可做的。
		tombstoned += int(n)
	}

	logger.Ctx(ctx).Info("sync_svc.PurgeDeviceSyncObjects: tombstoned rows scoped to a departing device",
		zap.Int64("userId", userID), zap.Int("candidateCount", len(rows)),
		zap.Int("tombstoneCount", tombstoned))
	accountchan_svc.BroadcastBestEffort(ctx, userID, lastVersion)
	return nil
}

// ReclaimExpired 是决策 9「超期由服务端与本地各自回收」在服务端的那一半，同时
// 兑现 R16a 的「无人引用即可回收」。两件事共用同一个 30 天窗口，也共用同一个
// 时钟：server 是唯一时钟源，桌面端各自的墙钟不参与。
//
// 顺序不能反。墓碑先删，被删掉的 Agent 才不会再被算成头像的引用方；反过来先扫
// 头像，那些正等着超期的 Agent 墓碑还压着，回收的量会少一轮。
//
// 两条语句都不带 user_id：它们各自按行归属（墓碑）或按账号相关联（头像）决定去留，
// 一个账号的回收碰不到另一个账号的行——见两个仓储方法的注释。
// clampTombstoneInstant 把上行带来的删除时刻夹回 [now-TombstoneWindow, now]。
//
// 决策 20 让墓碑携带发起端记下的时刻，信息量确实比 server 现编一个大；但**同一列**
// 同时是 ReclaimExpired 的唯一回收判据（deleted_at < now - 30d，见 ReclaimExpired
// 与 sync_repo.DeleteTombstonesBefore）。原样落库等于把保留期的裁量权交给桌面端的
// 墙钟，而 ReclaimExpired 的契约写明「server 是唯一时钟源，桌面端各自的墙钟不参与」：
//   - 时刻偏早（墙钟落后 30 天，或客户端干脆写 deleted_at: 1）：这条墓碑在下一轮
//     回收里立刻被删。还没拉到它的离线端把活行推回来时，Push 的 R6 复活守卫
//     （existing.IsDeleted()）已经无行可查，整个账号的删除被撤销。
//   - 时刻偏晚（墙钟在未来）：墓碑永不过期，30 天窗口对它失效。
//
// 夹取而不是拒收：越界只说明对端的钟不准，不说明这次删除不该发生。夹完仍是一个
// 真实存在过的时刻，展示与 30 天窗口两边都成立。零值照旧表示「这不是墓碑」。
func clampTombstoneInstant(deletedAt, now int64) int64 {
	if deletedAt <= 0 {
		return 0
	}
	return min(max(deletedAt, now-TombstoneWindow.Milliseconds()), now)
}

func (s *syncSvc) ReclaimExpired(ctx context.Context) (*ReclaimOutput, error) {
	cutoff := s.now() - TombstoneWindow.Milliseconds()

	tombstones, err := sync_repo.SyncObject().DeleteTombstonesBefore(ctx, cutoff)
	if err != nil {
		return nil, err
	}
	avatars, err := sync_repo.SyncAvatar().DeleteUnreferencedBefore(ctx, cutoff)
	if err != nil {
		return nil, err
	}

	out := &ReclaimOutput{Tombstones: tombstones, Avatars: avatars}
	if out.Tombstones > 0 || out.Avatars > 0 {
		logger.Ctx(ctx).Info("sync reclaim swept expired rows",
			zap.Int64("tombstoneCount", out.Tombstones), zap.Int64("avatarCount", out.Avatars))
	}
	return out, nil
}

// payloadOrEmptyObject 让墓碑也有一份合法的 JSON 正文。
func payloadOrEmptyObject(payload []byte) string {
	if len(strings.TrimSpace(string(payload))) == 0 {
		return "{}"
	}
	return string(payload)
}

// sha256Hex 是头像的内容哈希算法：正文的 sha256，小写十六进制。
func sha256Hex(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}
