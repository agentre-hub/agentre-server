package mirror_svc

import agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

const (
	notifyRuntimeEvent          = "runtime.event"
	notifyRunResultDone         = "runtime.runResultDone"
	notifyAutonomousTurnStarted = "runtime.autonomousTurn.started"
	notifyAutonomousTurnEvent   = "runtime.autonomousTurn.event"
	notifyAutonomousTurnDone    = "runtime.autonomousTurn.done"
)

func notificationHead(notification *agentrewire.RpcNotification) (int64, int64, string) {
	if notification == nil {
		return 0, 0, ""
	}
	switch payload := notification.GetPayload().(type) {
	case *agentrewire.RpcNotification_RuntimeEvent:
		return payload.RuntimeEvent.GetSessionId(), payload.RuntimeEvent.GetSeq(), notifyRuntimeEvent
	case *agentrewire.RpcNotification_RunResultDone:
		return payload.RunResultDone.GetSessionId(), payload.RunResultDone.GetSeq(), notifyRunResultDone
	case *agentrewire.RpcNotification_AutonomousTurnStarted:
		return payload.AutonomousTurnStarted.GetSessionId(), payload.AutonomousTurnStarted.GetSeq(), notifyAutonomousTurnStarted
	case *agentrewire.RpcNotification_AutonomousTurnEvent:
		return payload.AutonomousTurnEvent.GetSessionId(), payload.AutonomousTurnEvent.GetSeq(), notifyAutonomousTurnEvent
	case *agentrewire.RpcNotification_AutonomousTurnDone:
		return payload.AutonomousTurnDone.GetSessionId(), payload.AutonomousTurnDone.GetSeq(), notifyAutonomousTurnDone
	default:
		return 0, 0, ""
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
	default:
		return false
	}
	return true
}
