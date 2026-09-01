package mirror_svc

import (
	"testing"

	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

func TestNotificationHeadUsesCanonicalMethodNames(t *testing.T) {
	tests := []struct {
		name         string
		notification *agentrewire.RpcNotification
		want         string
	}{
		{
			name: "runtime event",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
				RuntimeEvent: &agentrewire.RuntimeEventNotification{ConversationId: conv42, Seq: 7},
			}},
			want: "runtime.event",
		},
		{
			name: "run result done",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RunResultDone{
				RunResultDone: &agentrewire.RunResultDoneNotification{ConversationId: conv42, Seq: 7},
			}},
			want: "runtime.runResultDone",
		},
		{
			name: "autonomous turn started",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_AutonomousTurnStarted{
				AutonomousTurnStarted: &agentrewire.AutonomousTurnStartedNotification{ConversationId: conv42, Seq: 7},
			}},
			want: "runtime.autonomousTurn.started",
		},
		{
			name: "autonomous turn event",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_AutonomousTurnEvent{
				AutonomousTurnEvent: &agentrewire.RuntimeEventNotification{ConversationId: conv42, Seq: 7},
			}},
			want: "runtime.autonomousTurn.event",
		},
		{
			name: "autonomous turn done",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_AutonomousTurnDone{
				AutonomousTurnDone: &agentrewire.RunResultDoneNotification{ConversationId: conv42, Seq: 7},
			}},
			want: "runtime.autonomousTurn.done",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			conversationID, seq, method := notificationHead(tt.notification)
			require.Equal(t, conv42, conversationID)
			require.Equal(t, int64(7), seq)
			require.Equal(t, tt.want, method)
		})
	}
}
