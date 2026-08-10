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

	"agentre-server/internal/model/entity/sync_entity"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/repository/sync_repo"
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
			zap.Int64("user_id", in.UserID), zap.Int64("device_id", in.DeviceID))
		return nil, i18n.NewError(ctx, code.SyncResyncRequired)
	}

	out := &PushOutput{Results: make([]PushItemResult, 0, len(in.Items))}
	err = db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)
		out.Results = out.Results[:0]
		for _, item := range in.Items {
			// 校验不通过只拒这一条：整批拒会把上行端的队列永久堵死，见
			// PushRejectReasonKind 一族常量的注释。
			if reason := rejectReason(txCtx, item); reason != "" {
				out.Results = append(out.Results, PushItemResult{
					SyncID: item.SyncID, Kind: item.Kind,
					Status: PushStatusRejected, Reason: reason,
				})
				continue
			}
			res, err := s.applyItem(txCtx, in.UserID, in.DeviceID, now, item)
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
	return out, nil
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
	if item.Kind == sync_entity.KindProjectLocation && item.ProjectSyncID == "" && !item.Deleted {
		return PushRejectReasonKind
	}
	if err := sync_entity.ValidatePayload(item.Payload); err != nil {
		// 载荷内容一律不进日志：里面有项目路径、prompt 与 EnvJSON。
		logger.Ctx(ctx).Warn("sync payload rejected",
			zap.String("kind", item.Kind), zap.String("sync_id", item.SyncID), zap.Error(err))
		return PushRejectReasonPayload
	}
	return ""
}

func (s *syncSvc) applyItem(
	ctx context.Context, userID, deviceID, now int64, item PushItem,
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
		if existing.IsDeleted() && !item.Deleted {
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
			res.OverwrittenDeviceID = existing.SourceDeviceID
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
		SourceDeviceID:      deviceID,
		Createtime:          now,
		Updatetime:          now,
	}
	if item.Deleted {
		obj.DeletedAt = now
	}

	version, err := sync_repo.SyncState().NextVersion(ctx, userID, 1)
	if err != nil {
		return nil, err
	}
	obj.Version = version

	if err := s.mergeLocationNaturalKey(ctx, userID, now, obj, res); err != nil {
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
// 墓碑必须先落：uk_sync_objects_location 这个部分唯一索引只允许自然键上有一行存活。
func (s *syncSvc) mergeLocationNaturalKey(
	ctx context.Context, userID, now int64, obj *sync_entity.SyncObject, res *PushItemResult,
) error {
	if obj.Kind != sync_entity.KindProjectLocation || obj.IsDeleted() {
		return nil
	}
	dup, err := sync_repo.SyncObject().FindLocationByNaturalKey(
		ctx, userID, obj.ProjectSyncID, obj.AgentredFingerprint)
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
		res.MergedSyncID, res.MergedVersion, res.MergedDeviceID = obj.SyncID, obj.Version, obj.SourceDeviceID
		logger.Ctx(ctx).Info("project location merged: incoming lost",
			zap.Int64("user_id", userID), zap.String("kept_sync_id", dup.SyncID),
			zap.String("merged_sync_id", obj.SyncID))
		return nil
	}

	// 墓碑要排在胜者前面：下行是按版本升序取的，接收端先看到墓碑、再看到胜者，
	// 自然键上就不会有一瞬间存在两行存活的行（它那边同样有唯一约束）。obj 此刻
	// 拿着的是本次上行先取到的那个较小版本，正好留给墓碑，胜者再取一个更大的。
	tombstoneVersion := obj.Version
	winnerVersion, err := sync_repo.SyncState().NextVersion(ctx, userID, 1)
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
	res.MergedSyncID, res.MergedVersion, res.MergedDeviceID = dup.SyncID, dup.Version, dup.SourceDeviceID
	logger.Ctx(ctx).Info("project location merged on natural key",
		zap.Int64("user_id", userID), zap.String("kept_sync_id", obj.SyncID),
		zap.String("merged_sync_id", dup.SyncID))
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
			SourceDeviceID:      row.SourceDeviceID,
			Deleted:             row.IsDeleted(),
		})
		if row.Version > out.NextCursor {
			out.NextCursor = row.Version
		}
	}
	out.HasMore = len(rows) == limit

	// R6a 的 30 天窗口只在设备**把增量消费干净**时刷新：这一页一行都没有，说明它
	// 送上来的游标已经站在账号序列的头上，此刻它不可能漏掉任何墓碑。
	//
	// 反过来，只要还有没消费的行就不刷新——这正是要拦的那一类：某一行在它那边落不
	// 了地，它每 30 秒来一次、每次拿回同一页，游标原地不动。用「最近联系过」量窗口
	// 时它永远是新的，那台机器可以拿着任意陈旧的基版本把一个已被回收的删除推回来。
	// 上行同理不刷新（见 Push）：只推不收的设备一样没有消费过任何东西。
	if len(rows) == 0 {
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

// ReclaimExpired 是决策 9「超期由服务端与本地各自回收」在服务端的那一半，同时
// 兑现 R16a 的「无人引用即可回收」。两件事共用同一个 30 天窗口，也共用同一个
// 时钟：server 是唯一时钟源，桌面端各自的墙钟不参与。
//
// 顺序不能反。墓碑先删，被删掉的 Agent 才不会再被算成头像的引用方；反过来先扫
// 头像，那些正等着超期的 Agent 墓碑还压着，回收的量会少一轮。
//
// 两条语句都不带 user_id：它们各自按行归属（墓碑）或按账号相关联（头像）决定去留，
// 一个账号的回收碰不到另一个账号的行——见两个仓储方法的注释。
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
			zap.Int64("tombstone_count", out.Tombstones), zap.Int64("avatar_count", out.Avatars))
	}
	return out, nil
}

// payloadOrEmptyObject 让墓碑也有一份合法的 jsonb 正文。
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
