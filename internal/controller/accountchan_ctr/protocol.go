package accountchan_ctr

import (
	"fmt"

	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

func encodeNotification(signal accountchan_svc.Frame) ([]byte, error) {
	notification := &agentrewire.Notification{}
	switch signal.Type {
	case accountchan_svc.FrameTypeSyncVersion:
		if signal.Version < 0 {
			return nil, fmt.Errorf("account sync version must not be negative")
		}
		notification.Payload = &agentrewire.Notification_AccountSyncVersion{AccountSyncVersion: &agentrewire.AccountSyncVersion{Version: uint64(signal.Version)}}
	case accountchan_svc.FrameTypeMirrorChanged:
		notification.Payload = &agentrewire.Notification_AccountMirrorChanged{AccountMirrorChanged: &agentrewire.AccountMirrorChanged{}}
	case accountchan_svc.FrameTypeDevicePresence:
		notification.Payload = &agentrewire.Notification_AccountDevicePresence{AccountDevicePresence: &agentrewire.AccountDevicePresence{}}
	default:
		return nil, fmt.Errorf("unknown account channel signal %q", signal.Type)
	}
	return proto.Marshal(&agentrewire.WireFrame{Body: &agentrewire.WireFrame_Notification{
		Notification: notification,
	}})
}
