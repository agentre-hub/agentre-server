package code

import "github.com/cago-frame/cago/pkg/i18n"

func init() {
	i18n.Register("en", en)
}

var en = map[int]string{
	OperationFailed:  "operation failed",
	InvalidParameter: "invalid parameter",
	NotFound:         "not found",
	ServerError:      "internal server error",
	Unauthorized:     "unauthorized",
	Forbidden:        "forbidden",

	UserNotFound:        "user not found",
	UserBanned:          "user banned",
	OAuthExchangeFailed: "github oauth exchange failed",

	DeviceFlowAuthorizationPending: "user has not approved the device yet",
	DeviceFlowSlowDown:             "polling too fast, slow down",
	DeviceFlowExpiredToken:         "device authorization expired, restart login",
	DeviceFlowAccessDenied:         "user denied the authorization",
	DeviceFlowInvalidGrant:         "invalid device_code",
	DeviceFlowUserCodeInvalid:      "user_code malformed or not found",

	DeviceNotFound:      "device not found",
	DeviceRevoked:       "device revoked",
	RefreshTokenReplay:  "refresh token reuse detected; all device tokens revoked",
	RefreshTokenExpired: "refresh token expired, please re-authorize",
	RefreshTokenInvalid: "invalid refresh token, please re-authorize",
	DeviceListFailed:    "failed to list devices",

	RelayDaemonNotFound: "daemon is not registered to this account",
	RelayDaemonOffline:  "daemon is currently offline",
	RelayForwardFailed:  "daemon is online but relay forwarding failed",

	SyncResyncRequired:     "device offline too long, pull a full snapshot before syncing",
	SyncAvatarHashMismatch: "avatar content does not match the declared hash",
	SyncAvatarNotFound:     "avatar not found",
	SyncCursorUnknown:      "unknown sync cursor, pull a full snapshot before syncing",

	PasskeyLimitReached:       "passkey limit reached, delete one before adding another",
	PasskeyChallengeInvalid:   "this passkey ceremony expired, start again",
	PasskeyVerificationFailed: "passkey verification failed",
	PasskeyAlreadyRegistered:  "this passkey is already registered",
	PasskeyNotFound:           "passkey not found",
	PasskeyOriginNotAllowed:   "this site is not an allowed origin for passkey sign-in",
	PasskeyCredentialUnknown:  "this passkey does not belong to any usable account",
	PasskeyCounterRollback:    "passkey signature counter went backwards, sign-in refused",

	AccountChannelUnavailable: "the realtime channel is unavailable, falling back to periodic sync",

	OrgKindNotWritable:            "this kind cannot be created or edited from the web",
	OrgObjectNotFound:             "object not found",
	OrgObjectDeleted:              "this object has been deleted",
	OrgBackendNotFound:            "the referenced agent backend does not exist",
	OrgSystemAgentImmutable:       "the built-in agent cannot be deleted or moved",
	OrgProjectParentCycle:         "the parent project cannot be the project itself or one of its descendants",
	OrgProjectMemberExists:        "this agent is already a member of the project",
	OrgProjectPathDesktopReadOnly: "a desktop's project path is not set through this endpoint",

	SessionImportMachineOffline: "this machine is offline, its local sessions cannot be read",
	SessionImportFailed:         "importing the local session failed",

	CredentialInvalid: "invalid token",

	EngineProviderNotFound:      "provider not found",
	EngineBackendNotFound:       "agent backend not found",
	EngineBuiltinForbidden:      "builtin backends cannot be created from the browser",
	EngineBackendDeviceNotFound: "the selected device is not an active device on this account",
}
