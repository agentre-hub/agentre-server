// Package mirror_svc keeps the server's own copy of the conversations an
// account has saved correct: given one established relay connection to one
// machine, it speaks the catch-up family (session.list / session.attach /
// session.pull, see internal/pkg/relaywire) and writes what it learns through
// agent_session_repo.
//
// Mirror itself is the mirror's logic only: it is handed a RelaySession and
// the account's saved list, and never learns how either was obtained. The
// residency around it lives in resident.go — Supervisor owns the relay
// connection and its account handshake, holds the per-(account, machine)
// lease that keeps one machine followed by exactly one replica, and lets both
// go again. *Which* machines are worth following is still nobody's business
// here: the caller decides and calls Supervisor.Follow
// (2026-08-18-server-session-mirror.md 「镜像的范围与写入路径」).
//
// # What it guarantees
//
//   - Live notifications received while attached land keyed by seq, in order.
//   - After a disconnect the next Sync pulls from **this server's own stored
//     cursor** and replays the increment — no gap, no duplicate.
//   - A conversation whose lifecycle is `interrupted` is never attached, only
//     pulled: the daemon answers attach on such a session with ErrNoActiveTurn
//     (that turn's subprocess died with the previous daemon process) while its
//     history stays pullable.
//   - Nothing the account has not saved produces a single mirrored row
//     (decision 2's privacy boundary).
//
// # Where the cursor lives
//
// agent_sessions.latest_seq is this server's own cursor: the newest
// seq it has mirrored for that conversation, not the peer's high water mark.
// The two are equal the moment a catch-up finishes; while disconnected the
// stored value is what this server actually holds, which is also the most any
// reader can be shown. Keeping it in the same row as the summary means the
// identity key (account + originating peer + that peer's session id) that
// scopes the cursor is the same one that scopes the frames, and one account
// -scoped list read (ListSummariesByUser) recovers every cursor at once.
//
// # Identity
//
// Rows are keyed by the **originating** peer's fingerprint plus that peer's
// own session id (decision 17), never by the machine currently carrying the
// connection. On the wire the origin is echoed verbatim, empty included:
// wire's empty origin means "the caller's own peer" (agentre's
// handlers.ResolveSessionPeer), and naming a peer that the connection could
// have left implicit is rejected on pairing-authenticated connections.
package mirror_svc

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
)

// RelaySession is one established relay connection to one machine, narrowed
// to the typed catch-up methods the mirror needs. Who dials, reconnects and
// correlates request IDs is deliberately invisible here.
type RelaySession interface {
	SessionList(context.Context, *agentrewire.SessionListRequest) (*agentrewire.SessionListResponse, error)
	SessionAttach(context.Context, *agentrewire.SessionAttachRequest) (*agentrewire.SessionAttachResponse, error)
	SessionPull(context.Context, *agentrewire.SessionPullRequest) (*agentrewire.SessionPullResponse, error)
	SessionDelete(context.Context, *agentrewire.SessionDeleteRequest) (*agentrewire.SessionDeleteResponse, error)
}

// summaryStore / frameStore are the consumer-side halves of agent_session_repo:
// exactly the methods this service calls, so a change elsewhere in the
// repository interface cannot silently widen what the mirror may touch.
// agent_session_repo's own interfaces satisfy them, and its generated mocks with
// them (Go interfaces are structural), so tests inject mock_agent_session_repo.
type summaryStore interface {
	UpsertSummary(ctx context.Context, s *agent_session_entity.SessionSummary) error
	ListSummariesByUser(ctx context.Context, userID int64) ([]*agent_session_entity.SessionSummary, error)
}

type frameStore interface {
	WriteFrames(ctx context.Context, frames []*agent_session_entity.JournalFrame) error
	DeleteFrames(ctx context.Context, userID int64, peerFingerprint, sessionID string) error
}

// SavedSession identifies one conversation the account has saved: the
// originating peer's fingerprint and that peer's own session id, in the
// opaque string form the agent_session_* tables store.
//
// Both halves matter. Session ids are locally assigned by whoever created the
// conversation, so the same id turns up under several origins on one
// connection; matching on the id alone would mirror a conversation nobody
// saved.
type SavedSession struct {
	PeerFingerprint string
	SessionID       string
}

type identity struct {
	owner string
	key   string
}

// Mirror mirrors one account's saved conversations over one relay connection.
// It is safe for concurrent use, but the caller is expected to feed one
// conversation's live notifications in wire order (Apply may issue a pull, so
// it must not run inside the connection's read loop).
type Mirror struct {
	userID int64
	// fingerprint is the machine this connection reaches. It is the owner of
	// every session the peer lists without an origin.
	fingerprint string
	peer        RelaySession
	summaries   summaryStore
	frames      frameStore
	// signals 是「这个账号的镜像变了」的出口。它攒批（见 notify.go），所以这里
	// 每写一次就喊一次，不必自己判断喊得频不频。
	signals changeSignaller
	// now 是这个镜像的时钟。可注入，与下面的 schedule 同一理由：帧的 Createtime
	// 与摘要的落库时刻必须是同一个判据（未读判定两端各取一次钟就会互相错位），
	// 冻住钟才断言得了这件事（生产是 time.Now().UnixMilli）。
	now func() int64
	// summaryWindow / schedule 是摘要写入的攒批窗口与它的定时器，见 touchSummary。
	// schedule 可注入，让用例的窗口边界完全确定（生产是 time.AfterFunc）。
	summaryWindow time.Duration
	schedule      func(time.Duration, func())

	mu      sync.Mutex
	tracked map[identity]*trackedSession
	// live routes an incoming notification to a conversation by the bare
	// sessionId in its payload — the only routing key the wire carries. A
	// present-but-nil entry means two mirrored conversations share that id on
	// this connection: their live frames are indistinguishable, so none is
	// written and both stay correct through Sync's identity-keyed pulls.
	live map[int64]*trackedSession
}

// trackedSession is one mirrored conversation's state on this connection.
type trackedSession struct {
	sid int64
	// key / owner are the storage halves of the identity (decision 17).
	key   string
	owner string
	// origin is the wire value, echoed verbatim — empty means "this
	// connection's own peer", which is not the same statement as naming it.
	origin string

	mu      sync.Mutex
	cursor  int64
	summary *agentrewire.SessionSummary

	// 摘要攒批的窗口状态，形状与 notify.go 的「首发 + 尾补」一致，见 touchSummary。
	flushMu        sync.Mutex
	flushOpen      bool
	flushDirty     bool
	flushForgotten bool
}

// abandonSummaryFlush 让这条对话上还欠着的那次尾补作废。
//
// 少了它，攒批就会把 Forget 的注释里写明的那条窗口重新打开：账号删掉这条对话之后，
// 一次迟到的摘要写入把它原样写回去，「刚删掉的东西悄悄回来了」。删除路径先 Forget
// 再清行，那一步之后就不该再有任何人替这条对话写字。
func (ts *trackedSession) abandonSummaryFlush() {
	ts.flushMu.Lock()
	defer ts.flushMu.Unlock()
	ts.flushForgotten = true
	ts.flushDirty = false
}

func (ts *trackedSession) cursorNow() int64 {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return ts.cursor
}

func (ts *trackedSession) advanceTo(seq int64) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if seq > ts.cursor {
		ts.cursor = seq
	}
}

func (ts *trackedSession) reset() {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.cursor = 0
}

func (ts *trackedSession) peerSummary() *agentrewire.SessionSummary {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return ts.summary
}

func (ts *trackedSession) setSummary(s *agentrewire.SessionSummary) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.summary = proto.Clone(s).(*agentrewire.SessionSummary)
}

// New builds a mirror for one account over one machine's connection. The
// repositories are taken once, at construction: this object outlives a single
// request, and re-reading the accessor per call would let a mid-flight
// re-registration swap the store underneath a running catch-up.
func New(userID int64, machineFingerprint string, peer RelaySession) *Mirror {
	return &Mirror{
		userID:      userID,
		fingerprint: machineFingerprint,
		peer:        peer,
		summaries:   agent_session_repo.Summary(),
		frames:      agent_session_repo.JournalFrame(),
		tracked:     make(map[identity]*trackedSession),
		live:        make(map[int64]*trackedSession),
		signals:     mirrorChanges,

		now:           func() int64 { return time.Now().UnixMilli() },
		summaryWindow: summaryFlushWindow,
		// 定时器一次性用完即弃（每个窗口重新排一次），句柄没人需要。
		schedule: func(d time.Duration, f func()) { _ = time.AfterFunc(d, f) },
	}
}

// Sync brings every saved conversation this peer carries up to date, and
// starts tracking them so their live notifications can be applied. Call it
// once per connection and again on reconnect.
//
// One conversation failing does not abandon the others on the same machine:
// every failure is joined and returned, so the caller logs once and decides
// whether to back off (this layer never logs an error it also returns).
func (m *Mirror) Sync(ctx context.Context, saved []SavedSession) error {
	if len(saved) == 0 {
		return nil
	}
	list, err := m.peer.SessionList(ctx, &agentrewire.SessionListRequest{})
	if err != nil {
		return fmt.Errorf("session list: %w", err)
	}
	// 本 server 自己的游标一次读齐:身份键的账号维度就是这一次读的作用域。
	stored, err := m.summaries.ListSummariesByUser(ctx, m.userID)
	if err != nil {
		return fmt.Errorf("list mirrored summaries: %w", err)
	}
	wanted := make(map[SavedSession]bool, len(saved))
	for _, s := range saved {
		wanted[s] = true
	}
	// 名单是这一刻的权威：不在名单里的对话此刻就摘掉，不等到这轮补齐结束。
	m.pruneUnwanted(wanted)
	var errs []error
	for _, s := range list.GetSessions() {
		id := m.identityOf(s)
		if !wanted[SavedSession{PeerFingerprint: id.owner, SessionID: id.key}] {
			// 没保存过的对话一个字都不落库(决策 2)。会话标识跨发起端重号,
			// 所以判据是身份键整体,不是标识本身。
			continue
		}
		if err := m.catchUp(ctx, m.track(id, s, stored)); err != nil {
			errs = append(errs, fmt.Errorf("session %s@%s: %w", id.key, id.owner, err))
		}
	}
	return errors.Join(errs...)
}

// Apply stores one live notification received on this connection.
//
// It is the same three-rule seq gate the desktop runs on its own stream
// (agentre/internal/pkg/agentruntime/runtimes/remote/reconnect.go):
//
//   - seq == cursor + 1 → store it and advance;
//   - seq <= cursor     → already mirrored, drop;
//   - seq >  cursor + 1 → a hole; pull from the cursor instead, which brings
//     back both the hole and this frame (storing this one first would write
//     the same row twice for no gain — it is in the peer's journal already).
//
// Frames are written one row each, immediately — what a reader sees is never
// delayed. The cursor that rides along in the summary row is debounced instead
// (see touchSummary): on this path the summary's only changing field *is* the
// cursor, its only reader is storedCursor, and falling behind costs exactly
// what it always cost — one idempotent re-pull, nothing more.
func (m *Mirror) Apply(ctx context.Context, notification *agentrewire.RpcNotification) error {
	sessionID, seq, method := notificationHead(notification)
	if sessionID == 0 || method == "" {
		logger.Ctx(ctx).Warn("mirror typed notification unsupported")
		return nil
	}
	ts, known := m.liveSession(sessionID)
	if !known {
		// 没保存过的对话:一个字都不落库。
		return nil
	}
	if ts == nil {
		logger.Ctx(ctx).Warn("mirror notification session id is ambiguous on this connection",
			zap.Int64("userId", m.userID), zap.Int64("sessionId", sessionID),
			zap.String("method", method))
		return nil
	}
	if seq == 0 {
		logger.Ctx(ctx).Warn("mirror notification carries no seq, cannot be keyed",
			zap.Int64("userId", m.userID), zap.Int64("sessionId", sessionID),
			zap.String("method", method))
		return nil
	}
	cursor := ts.cursorNow()
	switch {
	case seq <= cursor:
		logger.Ctx(ctx).Debug("mirror duplicate notification dropped",
			zap.Int64("sessionId", sessionID), zap.Int64("seq", seq),
			zap.Int64("cursor", cursor), zap.String("method", method))
		return nil
	case seq > cursor+1:
		logger.Ctx(ctx).Warn("mirror notification seq gap, pulling",
			zap.Int64("sessionId", sessionID), zap.Int64("seq", seq),
			zap.Int64("cursor", cursor), zap.String("method", method))
		if err := m.pullUntilCaughtUp(ctx, ts); err != nil {
			return err
		}
		// 补洞是罕见路径，而且刚跨过一段：游标立刻钉住，不进攒批。
		return m.saveSummary(ctx, ts)
	default:
		if err := m.writeFrames(ctx, ts, []*agentrewire.JournaledNotification{
			{Seq: seq, Payload: notification},
		}); err != nil {
			return err
		}
		ts.advanceTo(seq)
		return m.touchSummary(ctx, ts)
	}
}

// touchSummary 记下「这条对话的游标又往前了」。可以随便调，限速在这里面。
//
// 形状与 notify.go 的信号攒批一样是**首发 + 尾补**：窗口外的第一次立刻写（攒批是
// 降噪，不是给每次变更加一个窗口的延迟），窗口内的压住，窗口结束时补一次把这一轮
// 最终的游标带出去。
//
// 为什么这里可以攒批 —— Apply 的注释原本说「没有一个诚实的攒批点」：
//
//   - 摘要那一行在 **Apply 这条路上唯一会变的字段就是游标**。元数据只由 Sync 经
//     setSummary 改，实时帧一个字段都动不了，所以窗口里被压住的那些次写的是同一行
//     的同一个值，只有 latest_seq 在动。
//   - latest_seq 只有一个读者：storedCursor，也就是重启后从哪儿接着拉。没有任何
//     用户可见的东西读它。它落后一点的代价 Apply 的注释自己写着 —— 「one idempotent
//     re-pull, nothing more」（帧表是 OnConflict DoNothing）。
//   - **帧不受影响**：writeFrames 照旧一帧一行立刻落库，页面看到的内容一点不打折。
//
// 攒批点因此是诚实的：让各端去读的是 signals 那条信号，而它本来就限速到一秒一条。
// 写得比信号还勤，多出来的那些次没有任何人看得见。
func (m *Mirror) touchSummary(ctx context.Context, ts *trackedSession) error {
	ts.flushMu.Lock()
	if ts.flushForgotten {
		ts.flushMu.Unlock()
		return nil
	}
	if ts.flushOpen {
		ts.flushDirty = true
		ts.flushMu.Unlock()
		return nil
	}
	ts.flushOpen = true
	ts.flushMu.Unlock()

	err := m.saveSummary(ctx, ts)
	// 尾补跑在定时器上，那时触发它的这次 Apply 早就返回了。带走一份不会被取消的
	// 副本：ctx 上的 trace / logger 字段还留着，而取消不再牵连这一条 —— 与 notify.go
	// 的同款理由。
	tail := context.WithoutCancel(ctx)
	m.schedule(m.summaryWindow, func() { m.summaryWindowElapsed(tail, ts) })
	return err
}

// summaryWindowElapsed 收尾一个窗口：压住过就补写一次并再开一个窗口（对话还在跑的话
// 下一帧照样先被压住），没压住过就把窗口关掉，下一帧重新走首发。
func (m *Mirror) summaryWindowElapsed(ctx context.Context, ts *trackedSession) {
	ts.flushMu.Lock()
	if ts.flushForgotten || !ts.flushDirty {
		ts.flushOpen = false
		ts.flushMu.Unlock()
		return
	}
	ts.flushDirty = false
	ts.flushMu.Unlock()

	if err := m.saveSummary(ctx, ts); err != nil {
		// 补写失败不重试：下一帧会重新走首发，把更新的游标一并带上。真正的代价
		// 只是重连时多拉一段，而那一段是幂等的。
		logger.Ctx(ctx).Warn("mirror trailing summary write failed",
			zap.Int64("userId", m.userID), zap.String("peerFingerprint", ts.owner),
			zap.String("sessionId", ts.key), zap.Error(err))
	}
	m.schedule(m.summaryWindow, func() { m.summaryWindowElapsed(ctx, ts) })
}

// catchUp is the three-step, and the order is hard:
//
//  0. pin the cursor — **before** attach. The peer starts pushing live frames
//     the moment it accepts the attach, and those advance the cursor
//     concurrently; the high-water guard below must compare the value as of
//     the attach, or it reads a perfectly normal live advance as a journal
//     that went backwards.
//  1. attach, unless the conversation is already interrupted (that turn's
//     subprocess died with the previous daemon process, so the daemon answers
//     attach with ErrNoActiveTurn) — its history is still pullable.
//  2. pull from the cursor and store, page by page.
func (m *Mirror) catchUp(ctx context.Context, ts *trackedSession) error {
	pinned := ts.cursorNow()
	summary := ts.peerSummary()
	highWater := summary.LatestSeq
	if summary.LifecycleState != relaywire.SessionLifecycleInterrupted {
		hw, err := m.attach(ctx, ts)
		if err != nil {
			// 清单与接入之间它刚被中断,或这条会话已经不在这台机器上:历史照拉,
			// 不因为接不上就整条丢掉。真正断掉的连接会让紧接着的 pull 一并失败。
			logger.Ctx(ctx).Warn("mirror attach failed, mirroring history only",
				zap.Int64("userId", m.userID), zap.String("peerFingerprint", ts.owner),
				zap.String("sessionId", ts.key), zap.Error(err))
		} else {
			highWater = hw
		}
	}
	if err := m.dropCursorAboveHighWater(ctx, ts, pinned, highWater); err != nil {
		return err
	}
	if err := m.pullUntilCaughtUp(ctx, ts); err != nil {
		return err
	}
	// 摘要每轮补齐落一次:对端报的元数据(标题 / 生命周期 / 等待标志)与本 server
	// 的游标一起更新,一条日志都没有的新对话也因此在索引里立得住。
	return m.saveSummary(ctx, ts)
}

// dropCursorAboveHighWater resets a cursor that has overtaken the peer's
// high-water mark, and is the single defence against a silent freeze.
//
// A cursor can only ever come from a seq the peer sent, so it never legally
// exceeds the peer's high water. When it does, that peer's notification log
// went backwards: a whole-session delete on the execution end wipes its seq
// high-water mark, and session ids are locally assigned and get reused, so
// the journal restarts at 1 under an id this server already has a cursor for.
//
// Not resetting does not lose a few frames — it loses all of them. Every
// later live notification satisfies seq <= cursor and is dropped as a
// duplicate by Apply's first rule: no gap, no error, the conversation simply
// stops producing text. That is the incident the desktop's identical rule
// (agentre .../runtimes/remote/reconnect.go dropCursorAboveHighWater) was
// written for.
//
// The stored copy is invalidated in the same breath. Leaving it would let the
// next process start read the out-of-range value straight back and replay the
// same freeze.
//
// The frames already stored under this identity go with it, and that deletion
// is not housekeeping — it is the whole point. Session ids are locally
// assigned on the execution end and get reused after a delete, so the new
// conversation's frames land on **the same** unique key (account, origin,
// session, seq) as the old one's, and the batch write is ON CONFLICT DO
// NOTHING: the old rows win. Re-pulling from 0 then changes nothing that a
// reader can see, and the page shows a different conversation's transcript.
func (m *Mirror) dropCursorAboveHighWater(ctx context.Context, ts *trackedSession, pinned, highWater int64) error {
	if pinned <= highWater {
		return nil
	}
	ts.reset()
	logger.Ctx(ctx).Warn("mirror cursor beyond peer high-water, restarting catch-up from scratch",
		zap.Int64("userId", m.userID), zap.String("peerFingerprint", ts.owner),
		zap.String("sessionId", ts.key), zap.Int64("cursor", pinned),
		zap.Int64("latestSeq", highWater))
	if err := m.frames.DeleteFrames(ctx, m.userID, ts.owner, ts.key); err != nil {
		return fmt.Errorf("purge frames of the reused session id: %w", err)
	}
	return m.saveSummary(ctx, ts)
}

// pullUntilCaughtUp pages the peer's journal from this server's cursor and
// stores every page as-is.
//
// A pulled page needs no seq gate: it is the peer's own answer to "what comes
// after this cursor", so its first row is the next thing to mirror whether or
// not it is cursor+1 (an older peer that reclaimed a prefix leaves a hole that
// no longer exists at the source, and rejecting the page for it would freeze
// the conversation instead of recovering it). Duplicates settle on the
// frames' unique key, so a page that overlaps what is already stored costs a
// no-op write, never a second row.
func (m *Mirror) pullUntilCaughtUp(ctx context.Context, ts *trackedSession) error {
	for {
		before := ts.cursorNow()
		res, err := m.peer.SessionPull(ctx, &agentrewire.SessionPullRequest{
			SessionId:       ts.sid,
			PeerFingerprint: ts.origin,
			Cursor:          before,
			Limit:           int32(relaywire.DefaultSessionPullLimit),
		})
		if err != nil {
			return fmt.Errorf("session pull: %w", err)
		}
		if len(res.GetNotifications()) == 0 {
			return nil
		}
		if err := m.writeFrames(ctx, ts, res.GetNotifications()); err != nil {
			return err
		}
		ts.advanceTo(res.GetNotifications()[len(res.GetNotifications())-1].GetSeq())
		// 停在对端说没有更多的时候;游标没被推前也停 —— 那是载荷坏了或对端一直
		// 交同一页,再转一圈只会是死循环。
		if !res.GetHasMore() || ts.cursorNow() <= before {
			return nil
		}
	}
}

func (m *Mirror) attach(ctx context.Context, ts *trackedSession) (int64, error) {
	res, err := m.peer.SessionAttach(ctx, &agentrewire.SessionAttachRequest{
		SessionId: ts.sid, PeerFingerprint: ts.origin,
	})
	if err != nil {
		return 0, err
	}
	return res.GetLatestSeq(), nil
}

// writeFrames stores canonical typed notifications, keyed by
// (account, originating peer, session, seq). The journal row's seq is the
// metadata source of truth, so it is stamped into the serialized notification
// for both live delivery and pull replay before persistence.
func (m *Mirror) writeFrames(ctx context.Context, ts *trackedSession, ns []*agentrewire.JournaledNotification) error {
	now := m.now()
	rows := make([]*agent_session_entity.JournalFrame, 0, len(ns))
	for _, n := range ns {
		if n.GetPayload() == nil {
			return fmt.Errorf("journal seq %d has no typed payload", n.GetSeq())
		}
		payload := proto.Clone(n.GetPayload()).(*agentrewire.RpcNotification)
		setNotificationSeq(payload, n.GetSeq())
		encoded, err := proto.Marshal(payload)
		if err != nil {
			return fmt.Errorf("encode journal seq %d: %w", n.GetSeq(), err)
		}
		rows = append(rows, &agent_session_entity.JournalFrame{
			UserID:          m.userID,
			PeerFingerprint: ts.owner,
			PeerSessionID:   ts.key,
			Seq:             n.GetSeq(),
			Payload:         encoded,
			Createtime:      now,
		})
	}
	if err := m.frames.WriteFrames(ctx, rows); err != nil {
		return fmt.Errorf("write mirror frames: %w", err)
	}
	return nil
}

// saveSummary writes the peer's reported metadata together with this server's
// own cursor (see the package doc on where the cursor lives). Fields an
// unupgraded peer never reported stay blank — as-is, never guessed.
func (m *Mirror) saveSummary(ctx context.Context, ts *trackedSession) error {
	s := ts.peerSummary()
	now := m.now()
	if err := m.summaries.UpsertSummary(ctx, &agent_session_entity.SessionSummary{
		UserID:            m.userID,
		PeerFingerprint:   ts.owner,
		PeerSessionID:     ts.key,
		Title:             s.Title,
		AgentSyncID:       s.AgentSyncId,
		ProviderSessionID: s.ProviderSessionId,
		Cwd:               s.Cwd,
		ProjectSyncID:     s.ProjectSyncId,
		BackendType:       s.BackendType,
		LifecycleState:    s.LifecycleState,
		WaitingForInput:   s.WaitingForInput,
		LatestSeq:         ts.cursorNow(),
		LastMessageAt:     s.LastMessageAt,
		// 会话级 ModelTarget 原样镜像。空是有含义的值（跟随 Agent 绑定），不补默认。
		ProviderKey: s.ProviderKey,
		ModelKey:    s.ModelKey,
		Createtime:  now,
		Updatetime:  now,
	}); err != nil {
		return fmt.Errorf("upsert mirror summary: %w", err)
	}
	// 落库之后才出声：信号说的是「库里变了，该拉了」，写失败时喊一声只会让所有在线
	// 连接拉回一模一样的一页。
	m.signals.changed(ctx, m.userID)
	return nil
}

// identityOf resolves the storage identity of one listed session: an omitted
// origin means the conversation started on the machine this connection
// reaches (agentre's handlers.ResolveSessionPeer), and that machine is then
// the owner the rows are keyed by.
func (m *Mirror) identityOf(s *agentrewire.SessionSummary) identity {
	owner := s.GetPeerFingerprint()
	if owner == "" {
		owner = m.fingerprint
	}
	return identity{owner: owner, key: strconv.FormatInt(s.GetSessionId(), 10)}
}

func (m *Mirror) track(id identity, s *agentrewire.SessionSummary, stored []*agent_session_entity.SessionSummary) *trackedSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	ts, ok := m.tracked[id]
	if !ok {
		ts = &trackedSession{sid: s.GetSessionId(), key: id.key, owner: id.owner, origin: s.GetPeerFingerprint()}
		m.tracked[id] = ts
		if _, taken := m.live[s.GetSessionId()]; taken {
			m.live[s.GetSessionId()] = nil // 重号:此后这个标识的实时帧谁都不认领。
		} else {
			m.live[s.GetSessionId()] = ts
		}
	}
	ts.setSummary(s)
	// 库里那份与内存里的取较大者:本进程已经消费到更远是常事,拿旧值去拉会把
	// 已经镜像过的那一段再走一遍(结果幂等,但白跑一趟)。
	if seq, found := storedCursor(stored, m.userID, id); found {
		ts.advanceTo(seq)
	}
	return ts
}

// Forget stops mirroring one conversation on this connection: neither its live
// notifications nor a later catch-up touch it again.
//
// The delete path calls this **before** clearing the stored rows. The other
// order leaves a window in which a live frame writes the conversation straight
// back in, and what the account just deleted quietly returns.
func (m *Mirror) Forget(ref SavedSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.forgetLocked(identity{owner: ref.PeerFingerprint, key: ref.SessionID})
}

// pruneUnwanted drops every tracked conversation the account no longer has
// saved. It is how a delete performed on **another replica** converges here:
// that replica cleared the rows, and this connection would otherwise keep
// writing the conversation back from its live stream. The saved list handed to
// Sync is the authority; anything outside it is out of scope (decision 2).
func (m *Mirror) pruneUnwanted(wanted map[SavedSession]bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id := range m.tracked {
		if wanted[SavedSession{PeerFingerprint: id.owner, SessionID: id.key}] {
			continue
		}
		m.forgetLocked(id)
	}
}

// forgetLocked drops one identity from both maps. The live map is only cleared
// when it still points at this very conversation: a shared session id parks a
// nil there deliberately, and that ambiguity marker must survive.
func (m *Mirror) forgetLocked(id identity) {
	ts, tracked := m.tracked[id]
	if !tracked {
		return
	}
	delete(m.tracked, id)
	ts.abandonSummaryFlush()
	if live, ok := m.live[ts.sid]; ok && live == ts {
		delete(m.live, ts.sid)
	}
}

func (m *Mirror) liveSession(sid int64) (*trackedSession, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ts, known := m.live[sid]
	return ts, known
}

func storedCursor(stored []*agent_session_entity.SessionSummary, userID int64, id identity) (int64, bool) {
	for _, row := range stored {
		if row.UserID == userID && row.PeerFingerprint == id.owner && row.PeerSessionID == id.key {
			return row.LatestSeq, true
		}
	}
	return 0, false
}
