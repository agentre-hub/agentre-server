package device_ctr

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/device"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
)

// MachineUpgrader 是本包对「让那台机器把自己升上去」的全部需要（ISP）：一台机器、
// 一个显式的 force 位、一个受理判定。接口声明在消费侧，实现是 mirror_svc.Supervisor
// ——它才知道怎么借那条已鉴权的镜像连接把调用送过去。
type MachineUpgrader interface {
	UpgradeMachine(
		ctx context.Context, userID int64, fingerprint string, force bool,
	) (mirror_svc.UpgradeResult, error)
}

type Device struct {
	// upgrader 由装配处注入（router.go）。为空时落到本进程那份常驻镜像——它同样
	// 可能没装配，UpgradeMachine 的 nil 接收者会如实说「这个部署够不着那台机器」。
	upgrader MachineUpgrader
}

func NewDevice() *Device { return &Device{} }

// SetMachineUpgrader 注入「够到那台机器」的实现（组合根 / 测试各注一份）。
func (d *Device) SetMachineUpgrader(u MachineUpgrader) { d.upgrader = u }

func (d *Device) machineUpgrader() MachineUpgrader {
	if d.upgrader != nil {
		return d.upgrader
	}
	return mirror_svc.Default()
}

// ---- Device Flow ----

func (d *Device) Authorize(ctx context.Context, req *api.DeviceAuthorizeRequest) (*api.DeviceAuthorizeResponse, error) {
	out, err := device_svc.Default().Authorize(ctx, device_svc.AuthorizeInput{
		DeviceKind: req.DeviceKind, Fingerprint: req.Fingerprint,
		Platform: req.Platform, Version: req.Version, Name: req.Name,
	})
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return &api.DeviceAuthorizeResponse{
		DeviceCode: out.DeviceCode, UserCode: out.UserCode,
		VerificationURI: out.VerificationURI, VerificationURIComplete: out.VerificationURIComplete,
		Interval: out.Interval, ExpiresIn: out.ExpiresIn,
	}, nil
}

func (d *Device) Token(c *gin.Context, req *api.DeviceTokenRequest) (*api.DeviceTokenResponse, error) {
	ctx := device_svc.WithClientInfo(c.Request.Context(), c.ClientIP(), c.GetHeader("User-Agent"))
	out, err := device_svc.Default().ExchangeToken(ctx, req.DeviceCode)
	if err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.DeviceTokenResponse{
		AccessToken: out.AccessToken, TokenType: "Bearer",
		ExpiresIn: out.ExpiresIn, RefreshToken: out.RefreshToken,
		RefreshExpiresIn: out.RefreshExpiresIn, DeviceID: out.DeviceID,
	}, nil
}

func (d *Device) Pending(c *gin.Context, req *api.DevicePendingRequest) (*api.DevicePendingResponse, error) {
	info, err := device_svc.Default().Pending(c.Request.Context(), req.UserCode)
	if err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.DevicePendingResponse{
		DeviceKind: info.DeviceKind, Platform: info.Platform, Version: info.Version,
		ExpiresIn: info.ExpiresIn,
	}, nil
}

func (d *Device) Approve(c *gin.Context, req *api.DeviceApproveRequest) (*api.DeviceApproveResponse, error) {
	userID := ginctx.UserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(c.Request.Context(), http.StatusUnauthorized, code.Unauthorized)
	}
	kind, err := device_svc.Default().Approve(c.Request.Context(), req.UserCode, userID)
	if err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.DeviceApproveResponse{DeviceKind: kind}, nil
}

func (d *Device) Deny(c *gin.Context, req *api.DeviceDenyRequest) (*api.DeviceDenyResponse, error) {
	if err := device_svc.Default().Deny(c.Request.Context(), req.UserCode); err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.DeviceDenyResponse{}, nil
}

func (d *Device) Refresh(c *gin.Context, req *api.TokenRefreshRequest) (*api.TokenRefreshResponse, error) {
	ctx := device_svc.WithClientInfo(c.Request.Context(), c.ClientIP(), c.GetHeader("User-Agent"))
	out, err := device_svc.Default().Refresh(ctx, req.RefreshToken)
	if err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.TokenRefreshResponse{
		AccessToken: out.AccessToken, ExpiresIn: out.ExpiresIn,
		RefreshToken: out.RefreshToken, RefreshExpiresIn: out.RefreshExpiresIn,
	}, nil
}

// RelayTicket 用浏览器登录 session 换取只可连接 relay client 的短效凭据。
//
// 票据是 server 记下账号、类型与对端身份的随机串（auth_svc.IssueRelayTicket），挂在这次
// 会话名下：登出之后新连接认不下它，已建连接在下一次心跳复查时断开。对端身份由账号派生
// （决策 8/9）：agentred 的 auth.account 从凭据的记录取身份，浏览器在请求体里报不了自己是谁。
func (d *Device) RelayTicket(c *gin.Context, _ *api.RelayTicketRequest) (*api.RelayTicketResponse, error) {
	ctx := c.Request.Context()
	userID := ginctx.UserID(c)
	auth := auth_svc.Default()
	if userID == 0 || auth == nil {
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusUnauthorized, code.Unauthorized)
	}
	// 本路由挂在 SessionAuth 之后，Redis 不可用时请求根本走不到这儿；记不下来就不发
	// （fail-closed），代价只是同一次抖动里换票失败——比留下一张撤不掉的票便宜。
	sid, _ := c.Cookie(auth.CookieName())
	ticket, err := auth.IssueRelayTicket(ctx, sid, userID)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return &api.RelayTicketResponse{
		AccessToken: ticket.Token, ExpiresIn: int(ticket.ExpiresIn / time.Second),
		PeerFingerprint: ticket.PeerFingerprint,
	}, nil
}

// Revoke 撤销一台设备的凭据。
//
// 设备 JWT 调用方（device_id 非 0）只能撤销自己；浏览器 session 调用方
// （device_id 为 0）只能撤销属于自己账号、且仍在用的设备——凭据所属关系以
// device_svc.OwnedDevice 为准，防止跨账号撤销。
func (d *Device) Revoke(c *gin.Context, req *api.TokenRevokeRequest) (*api.TokenRevokeResponse, error) {
	userID := ginctx.UserID(c)
	callerID := ginctx.DeviceID(c)
	target := req.DeviceID
	if target == 0 {
		target = callerID
	}
	if target == 0 {
		return nil, i18n.NewForbiddenError(c.Request.Context(), code.Forbidden)
	}
	if callerID != 0 {
		if target != callerID {
			return nil, i18n.NewForbiddenError(c.Request.Context(), code.Forbidden)
		}
	} else if _, err := ownedDevice(c.Request.Context(), userID, target); err != nil {
		return nil, err
	}
	if err := device_svc.Default().Revoke(c.Request.Context(), target); err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.TokenRevokeResponse{}, nil
}

// ownedDevice 取调用方账号下一台在用的设备，供撤销与升级判归属：按 id 取那一行，
// 不读整份设备列表（列表要为每台机器读一遍在线态，判归属用不上）。
//
// 答复沿用改用它之前的两个出口，API 形状不变（db-perf-fixes 决策 10）：不归他 /
// 已撤销 / 查不到（服务层同一个 DeviceNotFound）回 403 Forbidden；查库失败回 500
// DeviceListFailed。
func ownedDevice(ctx context.Context, userID, deviceID int64) (*device_entity.Device, error) {
	device, err := device_svc.Default().OwnedDevice(ctx, userID, deviceID)
	if err == nil {
		return device, nil
	}
	var he *httputils.Error
	if errors.As(err, &he) && he.Code == code.DeviceNotFound {
		return nil, i18n.NewForbiddenError(ctx, code.Forbidden)
	}
	return nil, i18n.NewInternalError(ctx, code.DeviceListFailed)
}

func (d *Device) List(c *gin.Context, _ *api.ListDevicesRequest) (*api.ListDevicesResponse, error) {
	userID := ginctx.UserID(c)
	deviceID := ginctx.DeviceID(c)

	views, err := device_svc.Default().ListUserDevices(c.Request.Context(), userID, deviceID)
	if err != nil {
		return nil, err
	}
	items := make([]api.ListDevicesItem, 0, len(views))
	for _, view := range views {
		items = append(items, toListDevicesItem(view))
	}
	return &api.ListDevicesResponse{Devices: items}, nil
}

// toListDevicesItem 把服务层的 view 映射成 wire 上的形状。
//
// 这一层映射就是分层的落点：服务层给的是领域事实（哪台机器、在不在线、握着哪个
// commit），json 字段名与「空串表示什么」由 api 层的那份 DTO 解释。
func toListDevicesItem(view device_svc.DeviceView) api.ListDevicesItem {
	return api.ListDevicesItem{
		ID:               view.ID,
		Name:             view.Name,
		DisplayName:      view.DisplayName,
		Kind:             view.Kind,
		Platform:         view.Platform,
		Version:          view.Version,
		Fingerprint:      view.Fingerprint,
		LastSeenAt:       view.LastSeenAt,
		Status:           view.Status,
		Online:           view.Online,
		IsThisDevice:     view.IsThisDevice,
		ProtocolMismatch: view.ProtocolMismatch,
		DaemonCommit:     view.DaemonCommit,
		DaemonBuildKnown: view.DaemonBuildKnown,
	}
}

// Rename 给一台设备设/改/清账号级备注名。
//
// 这个端点存在的理由：设备名是 claim 时那台机器自报的主机名，同一台 Mac 上的三个
// checkout 在账号里就是三行一模一样的名字，要撤销其中一台时用户分不出该点哪一个。
// 桌面端此前那个「重命名」只写它自己的本地表，控制台和别的桌面端都看不见——所以这件
// 事只能在服务端解决，写在账号上。
//
// 归属与长度判定都在服务层（Rename → OwnedDevice + NormalizeDisplayName）：这里既不
// 提前查一遍设备，也不重写它的出口。改别人账号下的设备、改一台已撤销的设备，与「根本
// 没有这台设备」同一个答复 404 DeviceNotFound —— 区分它们等于告诉调用方这台设备存在、
// 只是不归他。它与撤销 / 升级的 403 形状不同：那两个端点的 403 是改用 OwnedDevice 之前
// 就有的出口，沿用是为了不动既有 API；这是条新路由，没有要沿用的历史。
//
// 鉴权面与设备列表同一组（会话 + CSRF，或设备 access token）：能读到这份清单的调用方
// 就能给清单里的行起名字。这与撤销不同——撤销动的是凭据，设备 JWT 只许撤自己；备注名
// 只是一个标签。
func (d *Device) Rename(c *gin.Context, req *api.RenameDeviceRequest) (*api.RenameDeviceResponse, error) {
	ctx := c.Request.Context()
	userID := ginctx.UserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusUnauthorized, code.Unauthorized)
	}
	name, err := device_svc.Default().Rename(ctx, userID, req.DeviceID, *req.DisplayName)
	if err != nil {
		return nil, err
	}
	return &api.RenameDeviceResponse{DisplayName: name}, nil
}

// Upgrade 让控制台点名的那台 agentred 把自己升上去（规格 2026-09-03
// 「控制台呈现与 latest 来源」）。
//
// 鉴权沿用既有的两条：浏览器会话 + CSRF 圈定账号，归属判定圈定机器——升级借的是那台
// 机器上**已经鉴权的**镜像连接，本身不引入新的授权面（决策 15）。
//
// 受理判定完全归 daemon：这里既不判「有没有对话在跑」，也不重写它给出的那句人话
// （决策 22）——两端与命令行对同一件事只说一句话，前提是中间这几层谁都不改口。
func (d *Device) Upgrade(c *gin.Context, req *api.DeviceUpgradeRequest) (*api.DeviceUpgradeResponse, error) {
	ctx := c.Request.Context()
	userID := ginctx.UserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusUnauthorized, code.Unauthorized)
	}
	// 不是本账号在用的设备、或者根本不是一台 agentred：一次调用都不发。自更新方法只有
	// agentred 认，对着桌面端发等于拿一个必然的协议错误当业务答复。
	target, err := ownedDevice(ctx, userID, req.DeviceID)
	if err != nil {
		return nil, err
	}
	if target.Kind != device_entity.KindAgentred {
		return nil, i18n.NewForbiddenError(ctx, code.Forbidden)
	}
	result, err := d.machineUpgrader().UpgradeMachine(ctx, userID, target.Fingerprint, req.Force)
	switch {
	case errors.Is(err, mirror_svc.ErrMachineOffline):
		// 离线不是「升级被拒绝」：用户该做的事不一样（等它回来，而不是换个说法再点
		// 一次）。与 relay_ctr 对 daemon 离线的答复同一形状。
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusConflict, code.RelayDaemonOffline)
	case err != nil:
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return &api.DeviceUpgradeResponse{
		Accepted:      result.Accepted,
		RejectReason:  string(result.RejectReason),
		Message:       result.Message,
		ActiveTurns:   result.ActiveTurns,
		TargetVersion: result.TargetVersion,
	}, nil
}

// oauthErrToHTTP 把 device_svc.OAuthError 映射成 HTTP 状态 + 业务 code，并在 body 里附 RFC 8628 字段。
func oauthErrToHTTP(c *gin.Context, err error) error {
	var oe *device_svc.OAuthError
	if !errors.As(err, &oe) {
		return i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	var status, biz int
	switch oe.Code {
	case device_svc.ErrAuthorizationPending:
		status, biz = http.StatusBadRequest, code.DeviceFlowAuthorizationPending
	case device_svc.ErrSlowDown:
		status, biz = http.StatusTooManyRequests, code.DeviceFlowSlowDown
	case device_svc.ErrExpiredToken:
		status, biz = http.StatusGone, code.DeviceFlowExpiredToken
	case device_svc.ErrAccessDenied:
		status, biz = http.StatusForbidden, code.DeviceFlowAccessDenied
	case device_svc.ErrInvalidGrant:
		status, biz = http.StatusBadRequest, code.DeviceFlowInvalidGrant
	case device_svc.ErrUserCodeInvalid:
		status, biz = http.StatusBadRequest, code.DeviceFlowUserCodeInvalid
	default:
		status, biz = http.StatusBadRequest, code.OperationFailed
	}
	// 服务层钉死的业务码优先：线上字面量要按 RFC 留在词表里（agentred 只认它），
	// 但 invalid_grant 底下压着六种失败，说明该由服务层给。
	if oe.Biz != 0 {
		biz = oe.Biz
	}
	c.Set("oauth_error", oe.Code)
	c.Set("oauth_error_description", oe.Description)
	return i18n.NewErrorWithStatus(c.Request.Context(), status, biz)
}
