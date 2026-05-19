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
	OAuthStateInvalid:   "oauth state invalid or expired",
	OAuthExchangeFailed: "github oauth exchange failed",
	OAuthProfileFailed:  "cannot fetch github user profile",
	GithubEmailMissing:  "github primary email not accessible; set verified primary email in github settings",
	SessionExpired:      "session expired, please login again",
	SessionInvalid:      "invalid session",

	DeviceFlowAuthorizationPending: "user has not approved the device yet",
	DeviceFlowSlowDown:             "polling too fast, slow down",
	DeviceFlowExpiredToken:         "device authorization expired, restart login",
	DeviceFlowAccessDenied:         "user denied the authorization",
	DeviceFlowInvalidGrant:         "invalid device_code",
	DeviceFlowUserCodeInvalid:      "user_code malformed or not found",
	DeviceFlowAlreadyConsumed:      "user_code already processed",

	DeviceNotFound:      "device not found",
	DeviceRevoked:       "device revoked",
	RefreshTokenReplay:  "refresh token reuse detected; all device tokens revoked",
	RefreshTokenExpired: "refresh token expired, please re-authorize",
	JWTSignatureInvalid: "invalid access token signature",
	JWTBlacklisted:      "access token revoked",
}
