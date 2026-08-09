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
const MaxAvatarBytes = 512 * 1024

type SyncSvc interface {
	Push(ctx context.Context, in PushInput) (*PushOutput, error)
	Pull(ctx context.Context, in PullInput) (*PullOutput, error)
	ReportLocalPaths(ctx context.Context, in LocalPathsInput) error
	PutAvatar(ctx context.Context, in AvatarInput) error
	GetAvatar(ctx context.Context, userID int64, contentHash string) (*AvatarOutput, error)
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

	// 先把整批校验完再开事务：载荷带了不该过机的东西时一行都不该落库，
	// 也不该白白开一个注定回滚的事务。
	for _, item := range in.Items {
		if err := validateItem(ctx, item); err != nil {
			return nil, err
		}
	}

	out := &PushOutput{Results: make([]PushItemResult, 0, len(in.Items))}
	err = db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)
		out.Results = out.Results[:0]
		for _, item := range in.Items {
			res, err := s.applyItem(txCtx, in.UserID, in.DeviceID, now, item)
			if err != nil {
				return err
			}
			out.Results = append(out.Results, *res)
		}
		return sync_repo.SyncState().TouchDeviceState(txCtx, in.UserID, in.DeviceID, now)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// beyondTombstoneWindow 判 R6a：没有 last_sync_at 记录 = 首次登录的设备，不算
// 超窗口——把它拦下来只会让新设备第一次同步就卡住。
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

func validateItem(ctx context.Context, item PushItem) error {
	if !sync_entity.KindValid(item.Kind) {
		return i18n.NewError(ctx, code.SyncKindInvalid)
	}
	if item.SyncID == "" {
		return i18n.NewError(ctx, code.InvalidParameter)
	}
	// 路径记录的账号内自然键是（项目同步标识, 指纹）；没有项目同步标识就没有自然键，
	// R4b 的合并也就无从谈起。
	if item.Kind == sync_entity.KindProjectLocation && item.ProjectSyncID == "" {
		return i18n.NewError(ctx, code.SyncKindInvalid)
	}
	if err := sync_entity.ValidatePayload(item.Payload); err != nil {
		// 载荷内容一律不进日志：里面有项目路径、prompt 与 EnvJSON。
		logger.Ctx(ctx).Warn("sync payload rejected",
			zap.String("kind", item.Kind), zap.String("sync_id", item.SyncID), zap.Error(err))
		return i18n.NewError(ctx, code.SyncPayloadRejected)
	}
	return nil
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
			return nil, i18n.NewError(ctx, code.SyncKindInvalid)
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
	if err := sync_repo.SyncState().TouchDeviceState(ctx, in.UserID, in.DeviceID, s.now()); err != nil {
		return nil, err
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
