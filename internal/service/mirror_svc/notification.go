package mirror_svc

import (
	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/turnstate"
)

const (
	notifyRuntimeEvent          = "runtime.event"
	notifyRunResultDone         = "runtime.runResultDone"
	notifyAutonomousTurnStarted = "runtime.autonomousTurn.started"
	notifyAutonomousTurnEvent   = "runtime.autonomousTurn.event"
	notifyAutonomousTurnDone    = "runtime.autonomousTurn.done"
	notifyTurnStarted           = "runtime.turnStarted"
)

func notificationHead(notification *agentrewire.RpcNotification) (string, int64, string) {
	if notification == nil {
		return "", 0, ""
	}
	switch payload := notification.GetPayload().(type) {
	case *agentrewire.RpcNotification_RuntimeEvent:
		return payload.RuntimeEvent.GetConversationId(), payload.RuntimeEvent.GetSeq(), notifyRuntimeEvent
	case *agentrewire.RpcNotification_RunResultDone:
		return payload.RunResultDone.GetConversationId(), payload.RunResultDone.GetSeq(), notifyRunResultDone
	case *agentrewire.RpcNotification_AutonomousTurnStarted:
		return payload.AutonomousTurnStarted.GetConversationId(), payload.AutonomousTurnStarted.GetSeq(), notifyAutonomousTurnStarted
	case *agentrewire.RpcNotification_AutonomousTurnEvent:
		return payload.AutonomousTurnEvent.GetConversationId(), payload.AutonomousTurnEvent.GetSeq(), notifyAutonomousTurnEvent
	case *agentrewire.RpcNotification_AutonomousTurnDone:
		return payload.AutonomousTurnDone.GetConversationId(), payload.AutonomousTurnDone.GetSeq(), notifyAutonomousTurnDone
	case *agentrewire.RpcNotification_TurnStarted:
		return payload.TurnStarted.GetConversationId(), payload.TurnStarted.GetSeq(), notifyTurnStarted
	default:
		return "", 0, ""
	}
}

func setNotificationSeq(notification *agentrewire.RpcNotification, seq int64) bool {
	if notification == nil {
		return false
	}
	switch payload := notification.GetPayload().(type) {
	case *agentrewire.RpcNotification_RuntimeEvent:
		payload.RuntimeEvent.Seq = seq
	case *agentrewire.RpcNotification_RunResultDone:
		payload.RunResultDone.Seq = seq
	case *agentrewire.RpcNotification_AutonomousTurnStarted:
		payload.AutonomousTurnStarted.Seq = seq
	case *agentrewire.RpcNotification_AutonomousTurnEvent:
		payload.AutonomousTurnEvent.Seq = seq
	case *agentrewire.RpcNotification_AutonomousTurnDone:
		payload.AutonomousTurnDone.Seq = seq
	case *agentrewire.RpcNotification_TurnStarted:
		payload.TurnStarted.Seq = seq
	default:
		return false
	}
	return true
}

// waiterKind 是一帧对「这条会话在不在等你处理」说了什么。
//
// 只认工具审批与提问这两族：daemon 那边 `waitingForInput` 的判据逐字就是
// 「待决审批数 + 待决提问数 > 0」（agentre 的 SessionCatchupHandlers.waitingForInput），
// 镜像这一侧跟着同一条，两端对「等你处理」的说法因此是同一个。
//
// 执行审批（ExecApprovalRequested / Resolved）**不在**其中：那是另一套机制，
// daemon 的 waiter 表里没有它，把它算进来会让镜像比对端多说一档。
type waiterKind int

const (
	waiterNone waiterKind = iota
	// waiterOpened:一次待决产生了(审批请求 / 提问)。
	waiterOpened
	// waiterClosed:那次待决落定了(批了 / 拒了 / 答了 / 跳过了)。
	waiterClosed
)

// waiterSignal 读出一帧的待决边界与它的请求标识。请求标识是必需的:同一条会话上
// 可以先后有多次待决,只按「来过一次请求」置真、「来过一次落定」置假的话,两次交错
// 就会把还在等的那一次抹掉。
func waiterSignal(notification *agentrewire.RpcNotification) (waiterKind, string) {
	event, ok := notification.GetPayload().(*agentrewire.RpcNotification_RuntimeEvent)
	if !ok {
		return waiterNone, ""
	}
	switch e := event.RuntimeEvent.GetEvent().(type) {
	case *agentrewire.RuntimeEventNotification_ToolPermissionRequest:
		return waiterOpened, e.ToolPermissionRequest.GetRequestId()
	case *agentrewire.RuntimeEventNotification_ToolPermissionResolved:
		return waiterClosed, e.ToolPermissionResolved.GetRequestId()
	case *agentrewire.RuntimeEventNotification_UserAskRequest:
		return waiterOpened, e.UserAskRequest.GetRequestId()
	case *agentrewire.RuntimeEventNotification_UserAskResolved:
		return waiterClosed, e.UserAskResolved.GetRequestId()
	default:
		return waiterNone, ""
	}
}

// turnFailed 回答「这一帧代表的那一轮是不是**故障**收场」。
//
// 判据本身在共享 module 的 pkg/wire/turnstate 里 —— agentred 落自己那一行时用的是
// 同一句话（handlers.settleSession），浏览器决定画不画错误卡时也是。三处分头写的话，
// 同一轮在列表里和在转录里会给出两种说法，而最容易误伤的正是「用户自己按了停止」
// 那一档：它在线上同样带停止文案，只有 sentinel 分得开。
//
// 只有两种终态帧带停止原因（runResultDone / autonomousTurn.done）；其余一律不是终态，
// 回 false。
func turnFailed(notification *agentrewire.RpcNotification) bool {
	switch payload := notification.GetPayload().(type) {
	case *agentrewire.RpcNotification_RunResultDone:
		return turnstate.IsFailure(
			payload.RunResultDone.GetStopErrorMessage(),
			int(payload.RunResultDone.GetStopErrorCode()),
		)
	case *agentrewire.RpcNotification_AutonomousTurnDone:
		return turnstate.IsFailure(
			payload.AutonomousTurnDone.GetStopErrorMessage(),
			int(payload.AutonomousTurnDone.GetStopErrorCode()),
		)
	default:
		return false
	}
}
