// session_mirror_read.go 是账号镜像里**详情页**那一半的读侧：一条对话按游标翻的
// 转录（2026-08-18-server-session-mirror.md 「索引与详情读到什么」）。索引那一半在
// session_index_read.go——它按组分页，两者的游标是两回事（一个数 seq，一个数
// (updated_at, id)）。本文件只读 agent_session_repo，写路径在 mirror_svc。
package agent_session_svc

import (
	"context"
	"encoding/json"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/wireview"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
)

const (
	// defaultTranscriptLimit 是调用方没给 Limit 时的一页大小。
	defaultTranscriptLimit = 200
	// maxTranscriptLimit 是服务端夹的上限，防止一次翻页请求整段日志。
	maxTranscriptLimit = 500

	// ── 反向读的预算（规格 2026-08-21-transcript-tail-loading 决策 7）──────
	//
	// 一页的量**不按帧数**定。payload 是 json 列而不是 text，理由写在
	// migrations/202609040108_agent_sessions.go：「text 的 64KB 上限会悄悄截断
	// 一个大帧」。所以一帧可以 >64KB（带文件内容的 tool_result），也可以只有几十
	// 字节（一个 text_delta 的 token 片）——固定帧数既框不住流量，也框不住「几段
	// 对话」，200 个 delta 常常还不够一条助手回复。
	//
	// 三个条件谁先到停谁，各自框的是不同的东西：

	// tailTurns 是用户感知的那个刻度：「最后几段对话」。
	tailTurns = 3
	// tailBytes 框的是流量。它**只在轮次边界上判**，因此不会把一轮劈成两半；
	// 代价是最新那一轮自己就超预算时照样整轮给——截断帧会把它弄坏。
	tailBytes = 256 << 10
	// tailRowCap 是病态情形的兜底：一条没有任何轮次边界的对话（或十万个碎 delta）
	// 不能一路读到开头。
	tailRowCap = 2000
	// tailBatchRows 是**一次 SQL 取多少行**，与预算无关。分批读是因为单帧可以很大，
	// 一次把 tailRowCap 行全捞回来可能是几百 MB；而预算通常在第一批里就满了。
	tailBatchRows = 200

	// eventKindUserMessage 是轮次的**起**帧。用它而不是 runResultDone 划边界：
	// 被中断的、还等着输入的轮次没有终帧，但一定有起帧。
	eventKindUserMessage = "user_message"

	// methodUndecodableFrame 是一条**这一侧读不懂**的帧的方法名。
	//
	// 它刻意不是 runtime.* 里的任何一个：那个前缀下的方法都有确定的 params 形状，
	// 而这一条恰恰是形状未知的那种。归约器据此原样放行，不会把它当正文。
	//
	// 帧的原件不在这里交出去 —— 它留在库里那一行。这个视图只回答「第几帧读不懂」，
	// 好让页面显示得出一个缺口而不是整页塌掉。
	methodUndecodableFrame = "durable.undecodable"
)

// Transcript 翻一页镜像里的原始帧。多请求 1 条（limit+1）用来判定 HasMore，而不是
// 靠「这一页刚好装满」去猜——半满的最后一页与真的到头了否则会分不清。
func (s *sessionReadSvc) Transcript(ctx context.Context, in TranscriptQuery) (TranscriptPage, error) {
	if in.Backward {
		return s.transcriptTail(ctx, in)
	}
	limit := in.Limit
	if limit <= 0 {
		limit = defaultTranscriptLimit
	}
	if limit > maxTranscriptLimit {
		limit = maxTranscriptLimit
	}
	rows, err := agent_session_repo.DurableFrame().ListFramesBySeq(
		ctx, in.UserID, in.ConversationID, in.AfterSeq, limit+1)
	if err != nil {
		return TranscriptPage{}, err
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	// Cursor 起点是调用方自己送来的位置：空页（没有新帧）上原样退回，不回退到 0，
	// 否则调用方会把整段日志当成需要重放。
	page := TranscriptPage{
		Frames:  make([]TranscriptFrameView, 0, len(rows)),
		Cursor:  in.AfterSeq,
		HasMore: hasMore,
	}
	for _, r := range rows {
		page.Frames = append(page.Frames, durableFrameView(ctx, r))
		page.Cursor = r.Seq
	}
	return page, nil
}

// transcriptTail 从最新往回按预算取一页（规格 2026-08-21-transcript-tail-loading）。
//
// 走法是「一轮一轮地收」：从最新那条往回读，遇到 user_message 就说明**刚收完一轮**
// （它是那一轮的起帧），这时候才判预算。判在轮次边界上，因此不会把一轮劈成两半。
//
// 三个数（Cursor / OldestSeq / HasBefore）按**原始行**记，与投影削掉了多少无关。
func (s *sessionReadSvc) transcriptTail(ctx context.Context, in TranscriptQuery) (TranscriptPage, error) {
	var (
		// turns 是已经收完的那些轮次，投影过、每一轮内部升序，**最新的一轮在前**。
		turns [][]TranscriptFrameView
		// pending 是正在收的那一轮，**已投影**的视图，最新在前。存视图而不是原始行,
		// 是因为轮次边界与最终下行要的是同一份投影 —— 一页里同一行只解一次
		// （规格 2026-09-07-journal-payload-json.md 问题 3）。
		pending   []TranscriptFrameView
		newestSeq int64
		oldestSeq int64
		bytes     int
		rows      int
		hasBefore bool
		before    = in.BeforeSeq
	)

	// take 收完一轮：翻正、削（丢弃/合并）、记账。两步都不会失败，所以它也不会。
	take := func() {
		if len(pending) == 0 {
			return
		}
		asc := make([]TranscriptFrameView, 0, len(pending))
		for i := len(pending) - 1; i >= 0; i-- {
			asc = append(asc, pending[i])
		}
		projected := projectTranscriptFrames(asc)
		for _, f := range projected {
			bytes += len(f.Params)
		}
		// 预算数的是**投影后**的字节：那才是真正下行的量。
		oldestSeq = pending[len(pending)-1].Seq
		turns = append(turns, projected)
		pending = nil
	}

	full := false
	for !full {
		batch, err := agent_session_repo.DurableFrame().ListFramesBefore(
			ctx, in.UserID, in.ConversationID, before, tailBatchRows)
		if err != nil {
			return TranscriptPage{}, err
		}
		if len(batch) == 0 {
			break
		}
		for i, row := range batch {
			if newestSeq == 0 {
				newestSeq = row.Seq
			}
			view := durableFrameView(ctx, row)
			pending = append(pending, view)
			rows++
			if isTurnStart(view) {
				take()
				if len(turns) >= tailTurns || bytes >= tailBytes || rows >= tailRowCap {
					// 还有没有更早的：这一批里没吃完的那些，或者这一批本来就是满的
					// （满批说明库里可能还有）。宁可多说一句「还有」——下一页如实
					// 交回空页，也不能少说，那会让更早的内容变成够不着。
					hasBefore = i < len(batch)-1 || len(batch) == tailBatchRows
					full = true
					break
				}
				continue
			}
			if rows >= tailRowCap {
				// 一条轮次边界都没遇上：按行硬顶收住，正在收的那一段照样交出去。
				take()
				hasBefore = i < len(batch)-1 || len(batch) == tailBatchRows
				full = true
				break
			}
		}
		if full {
			break
		}
		if len(batch) < tailBatchRows {
			// 库里到头了。正在收的那一段是这条对话真正的开头，一并交出去。
			take()
			break
		}
		before = batch[len(batch)-1].Seq
	}

	// turns 是最新的一轮在前，翻过来拼成整页的升序。
	page := TranscriptPage{Cursor: newestSeq, OldestSeq: oldestSeq, HasBefore: hasBefore}
	page.Frames = make([]TranscriptFrameView, 0, rows)
	for i := len(turns) - 1; i >= 0; i-- {
		page.Frames = append(page.Frames, turns[i]...)
	}
	return page, nil
}

// isTurnStart 判一帧**已投影的**视图是不是某一轮的起帧。解不动的载荷一律**不是**
// 边界：猜错边界会把两轮并成一轮，而收不到边界最多是多读一批。
//
// 它收视图而不是原始行：调用方投影一次就把这一份一路带到下行,同一行不会为了读一个
// event.kind 再解一遍（规格 2026-09-07-journal-payload-json.md 问题 3）。
func isTurnStart(view TranscriptFrameView) bool {
	kind, _, ok := decodeEventKind(view)
	return ok && kind == eventKindUserMessage
}

// durableFrameView 把库里的一行投影成下行视图。**它不会失败**：读不懂的那一行交出
// 一个 methodUndecodableFrame 的缺口帧。
//
// 从前它把错误一路交回给调用方，而三个调用方都是 `return TranscriptPage{}, err` ——
// 一条坏帧于是把整条对话的详情页变成一次请求错误。坏的是一帧，让整页跟着塌掉既救不
// 回那一帧，又把它前后那些好帧一起藏了。
//
// 解不开的原件仍在库里那一行，没有任何东西被丢弃；能不能读懂它是**这一侧**的事，
// 换个版本的服务端再读同一行仍可能读得懂。
func durableFrameView(ctx context.Context, row *agent_session_entity.DurableFrame) TranscriptFrameView {
	method, params, err := wireview.DecodeStoredFrame(row.Payload)
	if err != nil {
		return undecodableFrameView(ctx, row, err)
	}
	return TranscriptFrameView{Seq: row.Seq, Method: method, Params: params, Createtime: row.Createtime}
}

// undecodableFrameView 是读不懂那一行时交出的缺口帧。
//
// 记一条 Warn 而不是静默吞掉：一帧读不懂是数据问题，**整段**读不懂是这一侧的解码
// 坏了，后者只有在日志里连成一片时才看得出来。
func undecodableFrameView(
	ctx context.Context, row *agent_session_entity.DurableFrame, cause error,
) TranscriptFrameView {
	logger.Ctx(ctx).Warn("mirror durable frame is undecodable",
		zap.Int64("seq", row.Seq), zap.Error(cause))
	params, err := json.Marshal(map[string]int64{"seq": row.Seq})
	if err != nil {
		params = []byte("{}")
	}
	return TranscriptFrameView{
		Seq: row.Seq, Method: methodUndecodableFrame,
		Params: params, Createtime: row.Createtime,
	}
}
