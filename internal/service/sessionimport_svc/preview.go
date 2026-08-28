package sessionimport_svc

import (
	"context"
	"fmt"

	"github.com/cago-frame/cago/pkg/i18n"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/wireview"
)

// defaultPreviewTurns 预览默认解几轮。够看出「这条是不是我要的那条」，又不至于
// 让一次预览把整份转录搬过中继（那台机器按页解，预览只取第一页）。
const (
	defaultPreviewTurns = 3
	maxPreviewTurns     = 32
)

// Preview 打开一条候选：元信息 + 缺口 + 前几轮真实转录。
//
// **不写任何库**，也不在服务端持有句柄：那台机器取完这一页就把转录关掉。
func (s *sessionImportSvc) Preview(ctx context.Context, in PreviewInput) (*PreviewView, error) {
	if in.Backend == "" || in.Locator == "" {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	device, err := s.machine(ctx, in.UserID, in.DeviceID)
	if err != nil {
		return nil, err
	}
	limit := in.Turns
	if limit <= 0 {
		limit = defaultPreviewTurns
	}
	if limit > maxPreviewTurns {
		limit = maxPreviewTurns
	}

	var (
		opened *agentrewire.TranscriptImportOpenResponse
		turns  *agentrewire.TranscriptImportTurnsResponse
	)
	// 一条连接两个调用：open 拿元信息、turns 拿第一页。
	if callErr := s.machines.WithPeer(ctx, in.UserID, device.Fingerprint,
		func(ctx context.Context, peer TranscriptImportPeer) error {
			var err error
			if opened, err = peer.TranscriptImportOpen(ctx, &agentrewire.TranscriptImportOpenRequest{
				Backend: in.Backend, Locator: in.Locator,
			}); err != nil {
				return err
			}
			turns, err = peer.TranscriptImportTurns(ctx, &agentrewire.TranscriptImportTurnsRequest{
				Backend: in.Backend, Locator: in.Locator, MaxTurns: int32(limit),
			})
			return err
		}); callErr != nil {
		// 预览没有「部分成功」这一档：一份空转录会被当成「这条会话是空的」。
		return nil, failed(ctx, callErr, in.DeviceID)
	}

	view := &PreviewView{Meta: metaView(opened.GetMeta()), Frames: []FrameView{}}
	for _, turn := range turns.GetTurns() {
		frames, err := turnFrames(turn)
		if err != nil {
			return nil, failed(ctx, err, in.DeviceID)
		}
		view.Frames = append(view.Frames, frames...)
		view.PreviewedTurns++
	}
	for i := range view.Frames {
		// seq 是这一页里的位置，不是那台机器上的日志行号（预览根本没有日志行）。
		// 渲染链按它排序，因此必须严格递增。
		view.Frames[i].Seq = int64(i + 1)
	}
	// 元信息没给轮数时说不出还剩几轮 —— 报 -1 而不是 0，别让界面说「没有更多了」。
	view.RemainingTurns = -1
	if meta := opened.GetMeta(); meta.GetTurns() > 0 {
		view.RemainingTurns = max(int(meta.GetTurns())-view.PreviewedTurns, 0)
	}
	imported, err := s.importedByProviderSession(ctx, in.UserID, device.Fingerprint)
	if err != nil {
		return nil, err
	}
	if sessionID, ok := imported[view.Meta.ProviderSessionID]; ok && view.Meta.ProviderSessionID != "" {
		view.Meta.Imported, view.Meta.ImportedSessionID = true, sessionID
	}
	return view, nil
}

func metaView(meta *agentrewire.TranscriptImportMeta) MetaView {
	out := MetaView{
		Backend: meta.GetBackend(), ProviderSessionID: meta.GetProviderSessionId(),
		Title: meta.GetTitle(), Cwd: meta.GetCwd(), Model: meta.GetModel(),
		Turns: int(meta.GetTurns()), ToolCalls: int(meta.GetToolCalls()),
		Compactions: int(meta.GetCompactions()), StartedAt: meta.GetStartedAt(),
		EndedAt: meta.GetEndedAt(), Origin: meta.GetOrigin(), Gaps: []GapView{},
	}
	for _, gap := range meta.GetGaps() {
		out.Gaps = append(out.Gaps, GapView{
			Kind: gap.GetKind(), Count: int(gap.GetCount()), Detail: gap.GetDetail(),
		})
	}
	return out
}

// turnFrames 把一轮摊成「客户端**本该收到过**的那串通知」：
//
//	用户那一行 → 这一轮的事件 → 用量 / 错误 → done
//
// 形状照的是执行侧回放时落进通知日志的那一串（agentre 的
// daemon/transcriptimport.journalTurn），预览与导入后的真实转录因此长得一模一样，
// 也因此能喂进浏览器**同一个**归约器。
//
// 少了每轮末尾那条 done，没有用户那一行的下一轮会接着上一轮那条助手消息往下写：
// 归约器正是靠 done 收本条的。
//
// 收尾的 runResultDone 不发：它是补齐轮的终点，对一份已经定型的预览没有意义，
// 而它的载荷形状与事件帧不同，塞进来只会让渲染链多一条要忽略的分支。
func turnFrames(turn *agentrewire.TranscriptImportTurn) ([]FrameView, error) {
	events := make([]*agentrewire.RuntimeEventNotification, 0, len(turn.GetEvents())+3)
	if turn.GetUserText() != "" {
		// 用户那一行经 user_message 进转录 —— 它是「这一轮是谁开的」的唯一事实来源。
		// **不带 sourceDevice**：这一轮不是任何在线设备此刻发起的，填一个指纹会在
		// 转录里印出一句「来自 <设备>」。
		events = append(events, &agentrewire.RuntimeEventNotification{
			Event: &agentrewire.RuntimeEventNotification_UserMessage{
				UserMessage: &agentrewire.UserMessage{Text: turn.GetUserText()},
			},
		})
	}
	events = append(events, turn.GetEvents()...)
	if turn.GetUsage() != nil {
		events = append(events, &agentrewire.RuntimeEventNotification{
			Event: &agentrewire.RuntimeEventNotification_UsageUpdate{
				UsageUpdate: &agentrewire.UsageUpdate{Usage: turn.GetUsage()},
			},
		})
	}
	if turn.GetErrorText() != "" {
		events = append(events, &agentrewire.RuntimeEventNotification{
			Event: &agentrewire.RuntimeEventNotification_Error{
				Error: &agentrewire.ErrorEvent{Message: turn.GetErrorText()},
			},
		})
	}
	events = append(events, &agentrewire.RuntimeEventNotification{
		Event: &agentrewire.RuntimeEventNotification_Done{Done: &agentrewire.Done{}},
	})

	out := make([]FrameView, 0, len(events))
	for _, event := range events {
		method, params, err := wireview.Notification(&agentrewire.RpcNotification{
			Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: event},
		})
		if err != nil {
			return nil, fmt.Errorf("project imported turn %d: %w", turn.GetIndex(), err)
		}
		out = append(out, FrameView{Method: method, Params: params})
	}
	return out, nil
}
