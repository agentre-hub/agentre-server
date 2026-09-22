package portforward_ctr

import (
	"context"
	"errors"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/portforward_link_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/redirectpath"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

// 这个文件是端口转发子域的两端（规格 2026-09-21-port-forward-subdomain「地址与路由」
// 「转发登录」）：
//
//   - Dispatch 装在整棵路由树最前面：Host 是 <前缀>.<base_domain> 的请求整条归它，
//     不经过控制台的任何路由、SPA 兜底或 CSRF 中间件；
//   - Authorize 是控制台 Host 上的 GET /v1/port-forwards/authorize，签发一次性授权码。

const (
	// AuthorizePath 是控制台上签发授权码的那一条。
	AuthorizePath = "/v1/port-forwards/authorize"
	// reservedPrefix 是转发域上归本系统所有的路径（spec「保留路径」）：被转发应用自己
	// 的这个路径访问不到，这是已知代价。
	reservedPrefix = "/__agentre/"
	// callbackPath 是转发域上拿授权码换转发票的那一条。
	callbackPath = reservedPrefix + "callback"
	// prefixLength / prefixAlphabet 是前缀的形状（决策 1：12 位小写 base32）。
	prefixLength   = 12
	prefixAlphabet = "abcdefghijklmnopqrstuvwxyz234567"
)

// 本层自己出的两句纯文本（规格「失败的呈现」）。与 failpage.go 同一条 i18n 豁免：用户
// 在转发域上，四周没有控制台外壳。
const (
	unauthenticatedBody = "请先回控制台打开这条端口转发。"
	codeInvalidBody     = "这个登录链接已失效，请回控制台重新打开"
)

// PrefixResolver 是「按前缀反查链接、拼出转发地址」这件事（ISP），实现是
// portforward_svc.Links。
type PrefixResolver interface {
	FindByPrefix(ctx context.Context, prefix string) (*portforward_link_entity.PortForwardLink, error)
	ForwardURL(prefix string) string
}

// ForwardSessions 是转发登录（ISP），实现是 portforward_svc.ForwardAuth。
type ForwardSessions interface {
	IssueCode(ctx context.Context, userID int64, prefix, consoleSID string) (string, error)
	Redeem(ctx context.Context, code, prefix string) (string, error)
	Resolve(ctx context.Context, token, prefix string) (*portforward_svc.ForwardSession, error)
}

// HostConfig 是转发子域的部署事实。
type HostConfig struct {
	// BaseDomain 空串 = 这个部署不提供转发，Dispatch 什么都不拦。
	BaseDomain string
	// PublicURL 是控制台的地址，转发域把未登录的导航送回它的 authorize。
	PublicURL string
	// InsecureCookies 与控制台会话 cookie 同一个判据（PublicURL 的 scheme）：为真时
	// 转发票不带 __Host- 前缀、不带 Secure。
	InsecureCookies bool
}

// Host 是转发子域的控制器。
type Host struct {
	fwd      *PortForward
	links    PrefixResolver
	sessions ForwardSessions
	cfg      HostConfig
	// devicesURL 是失败页「回到设备」的去处：控制台设备页的绝对地址。
	devicesURL string
}

// NewHost 装配。links / sessions 为 nil 时 BaseDomain 也必须为空（部署不提供转发）；
// 否则 Dispatch 与 Authorize 答「此刻提供不了端口转发」。
func NewHost(fwd *PortForward, links PrefixResolver, sessions ForwardSessions, cfg HostConfig) *Host {
	cfg.BaseDomain = strings.ToLower(strings.TrimSuffix(cfg.BaseDomain, "."))
	return &Host{fwd: fwd, links: links, sessions: sessions, cfg: cfg, devicesURL: ConsoleDevicesURL(cfg.PublicURL)}
}

func (h *Host) forwardCookieName() string { return session.ForwardCookieName(!h.cfg.InsecureCookies) }

// answer 把本层自己的失败写出去，失败页的「回到设备」指向控制台。
func (h *Host) answer(c *gin.Context, kind failureKind) { answer(c, kind, h.devicesURL) }

// ── Host 分发 ───────────────────────────────────────────────────────────

// Dispatch 是全局中间件：转发域上的请求在这里处理完并 Abort，其余放行给控制台。
func (h *Host) Dispatch(c *gin.Context) {
	label, ok := h.forwardLabel(c.Request.Host)
	if !ok {
		c.Next()
		return
	}
	defer c.Abort()
	if h.links == nil || h.sessions == nil {
		h.answer(c, failureUnavailable)
		return
	}
	// 形状不对与「不是你的」答同一个 404（spec「按 Host 分发」）。
	if !validPrefix(label) {
		h.answer(c, failureNotFound)
		return
	}
	path := c.Request.URL.Path
	switch {
	case path == callbackPath && c.Request.Method == http.MethodGet:
		h.callback(c, label)
	case strings.HasPrefix(path, reservedPrefix):
		h.answer(c, failureNotFound)
	default:
		h.forward(c, label)
	}
}

// forwardLabel 判 Host 是不是落在转发域上，是的话交回 base_domain 之前的那一段。
// 端口忽略、大小写不敏感；base_domain 本身与多段标签也算落在转发域上（交回的标签
// 形状不对，由调用方答 404）——它们不该掉回控制台。
func (h *Host) forwardLabel(hostport string) (string, bool) {
	if h.cfg.BaseDomain == "" {
		return "", false
	}
	host := hostport
	if hh, _, err := net.SplitHostPort(hostport); err == nil {
		host = hh
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == h.cfg.BaseDomain {
		return "", true
	}
	label, ok := strings.CutSuffix(host, "."+h.cfg.BaseDomain)
	return label, ok
}

func validPrefix(label string) bool {
	if len(label) != prefixLength {
		return false
	}
	for _, r := range label {
		if !strings.ContainsRune(prefixAlphabet, r) {
			return false
		}
	}
	return true
}

// forward 是每次请求的判定（spec，有顺序）：转发会话有效 → 依附的控制台会话还活着
// → 账号闸门放行 → 前缀属于这个账号 → 设备归属仍然成立 → 设备在线 → 借连接、按映射 id 打开。
func (h *Host) forward(c *gin.Context, prefix string) {
	ctx := c.Request.Context()
	token, _ := c.Cookie(h.forwardCookieName())
	fs, err := h.sessions.Resolve(ctx, token, prefix)
	if err != nil {
		logger.Ctx(ctx).Warn("port forward session lookup failed", zap.Error(err))
		h.answer(c, failureUnavailable)
		return
	}
	// 账号闸门与控制台每一条鉴权路径同一道（会话在不等于账号还能用）：被拦下就等于
	// 没登录，导航回到 authorize，而那里对被拦的账号只会送去登录页。
	if fs == nil || accountBlocked(ctx, fs.UserID) {
		h.unauthenticated(c, prefix)
		return
	}
	link, kind, ok := h.ownedLink(ctx, fs.UserID, prefix)
	if !ok {
		h.answer(c, kind)
		return
	}
	device, kind, ok := h.fwd.deviceOwnerAndOnline(ctx, fs.UserID, link.DeviceID)
	if !ok {
		h.answer(c, kind)
		return
	}
	handler, release, err := h.fwd.acquire(ctx, fs.UserID, device.Fingerprint, link.MappingID)
	if err != nil {
		h.answer(c, acquireFailure(ctx, fs.UserID, device.Fingerprint, link.MappingID, err))
		return
	}
	defer release()
	stripForwardCredentials(c.Request)
	// 落到 NoRoute 上的路径，gin 在跑处理链之前就把状态预置成了 404；被转发应用没有显式
	// WriteHeader 就写 body 时，net/http 的约定是 200——这里把它恢复成那个约定，否则
	// 应用的一次普通响应会以 404 出去。
	c.Status(http.StatusOK)
	// ResponseWriter 原样交出去，不包任何一层（包注释）：101 升级要 Hijacker，流式要
	// Flusher。路径与查询串原样透传——子域下根路径就是应用的根，没有前缀可剥。
	handler.ServeHTTP(c.Writer, c.Request)
}

// ownedLink 按前缀查链接并判它属于这个账号。查不到与不是你的答同一个 404。
func (h *Host) ownedLink(
	ctx context.Context, userID int64, prefix string,
) (*portforward_link_entity.PortForwardLink, failureKind, bool) {
	link, err := h.links.FindByPrefix(ctx, prefix)
	if err != nil {
		logger.Ctx(ctx).Warn("port forward link lookup failed", zap.Error(err))
		return nil, failureUnavailable, false
	}
	if link == nil || link.UserID != userID {
		logger.Ctx(ctx).Info("port forward rejected: prefix is not this account's",
			zap.Int64("userId", userID), zap.Bool("known", link != nil))
		return nil, failureNotFound, false
	}
	return link, 0, true
}

// unauthenticated 是转发登录第 1 步：顶层导航 302 回控制台 authorize，其余（子资源、
// fetch、WebSocket 升级）答 401 纯文本、不跳转。
//
// 顶层导航的判据（spec「转发登录」步骤 1、决策 14）：请求带了任意一个 Sec-Fetch-*
// 头时，只认 GET + Sec-Fetch-Mode: navigate（这时 Accept 不看）；请求一个 Sec-Fetch-*
// 头都不带时——浏览器对 http 非 localhost 的源就是这样，2026-09-22 dev 运行期验证
// 过——退回到非升级的 GET + Accept 以 q>0 接受 text/html。这个兜底可以被脚本伪造，但伪造出的 302 只
// 指向控制台 authorize、且跨源，脚本读不到结果（spec「安全」残余风险 5）。
func (h *Host) unauthenticated(c *gin.Context, prefix string) {
	if !isTopLevelNavigation(c.Request) {
		writeFailureText(c.Writer, http.StatusUnauthorized, unauthenticatedBody)
		return
	}
	q := url.Values{"prefix": {prefix}, "return": {c.Request.URL.RequestURI()}}
	redirect(c, strings.TrimRight(h.cfg.PublicURL, "/")+AuthorizePath+"?"+q.Encode())
}

// secFetchHeaders 是 Fetch Metadata 那一组；只要请求带了其中任意一个，就认为浏览器
// 支持这组头，不再退回 Accept 兜底。
var secFetchHeaders = [...]string{"Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-Dest", "Sec-Fetch-User"}

func isTopLevelNavigation(r *http.Request) bool {
	// 升级请求（WebSocket 等）永远不是顶层导航，Accept 写了什么都不算。
	if r.Method != http.MethodGet || r.Header.Get("Upgrade") != "" {
		return false
	}
	for _, name := range secFetchHeaders {
		if len(r.Header.Values(name)) > 0 {
			return r.Header.Get("Sec-Fetch-Mode") == "navigate"
		}
	}
	// 同名头分多行发等同逗号拼接（RFC 9110 §5.3），只看第一行会漏。
	return acceptsHTML(strings.Join(r.Header.Values("Accept"), ","))
}

// acceptsHTML 判 Accept 头是不是接受 text/html：按 media-type 逐段比较，大小写不敏感，
// 不是子串匹配（"*/*" 不算）；q=0 是「不可接受」（RFC 9110 §12.4.2），q 写不成数也
// 不算，宁可答 401 也不把它当导航。
func acceptsHTML(accept string) bool {
	for _, part := range strings.Split(accept, ",") {
		mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(part))
		if err != nil || mediaType != "text/html" {
			continue
		}
		q, ok := params["q"]
		if !ok {
			return true
		}
		if weight, err := strconv.ParseFloat(q, 64); err == nil && weight > 0 {
			return true
		}
	}
	return false
}

// callback 是转发登录第 4 步：拿授权码换转发票，写 cookie，302 到 return。
func (h *Host) callback(c *gin.Context, prefix string) {
	ctx := c.Request.Context()
	token, err := h.sessions.Redeem(ctx, c.Query("code"), prefix)
	if err != nil {
		if !errors.Is(err, portforward_svc.ErrCodeInvalid) {
			logger.Ctx(ctx).Warn("port forward code redeem failed", zap.Error(err))
		}
		writeFailureText(c.Writer, http.StatusBadRequest, codeInvalidBody)
		return
	}
	// host-only（不带 Domain）、Path=/、HttpOnly、SameSite=Lax；https 下再加 Secure
	// 与 __Host- 前缀——与控制台会话 cookie 同一个写法（session.SetCookie）。
	session.SetCookie(c, h.forwardCookieName(), token, h.cfg.InsecureCookies)
	redirect(c, redirectpath.Local(c.Query("return")))
}

// ── 控制台上的 authorize ────────────────────────────────────────────────

// Authorize 是转发登录第 2、3 步：没登录送去登录页（登录后原路回来）；前缀属于当前
// 账号就签发一次性授权码、302 到转发域的 callback；不属于答 404，不签发。
//
// 不走 SessionAuth 中间件：那个答 401 JSON，而这里是浏览器顶层导航，没登录要的是跳转。
// 判定仍是同一套——会话 cookie + 账号闸门。GET、不改控制台任何状态，所以不过 CSRF。
func (h *Host) Authorize(c *gin.Context) {
	ctx := c.Request.Context()
	sid, _ := c.Cookie(auth_svc.Default().CookieName())
	sess, err := auth_svc.Default().GetSession(ctx, sid)
	if err != nil || sess == nil || accountBlocked(ctx, sess.UserID) {
		redirect(c, "/login?"+url.Values{"next": {c.Request.URL.RequestURI()}}.Encode())
		return
	}
	if h.links == nil || h.sessions == nil || h.cfg.BaseDomain == "" {
		h.answer(c, failureUnavailable)
		return
	}
	prefix := c.Query("prefix")
	if !validPrefix(prefix) {
		h.answer(c, failureNotFound)
		return
	}
	if _, kind, ok := h.ownedLink(ctx, sess.UserID, prefix); !ok {
		h.answer(c, kind)
		return
	}
	code, err := h.sessions.IssueCode(ctx, sess.UserID, prefix, sid)
	if err != nil {
		logger.Ctx(ctx).Warn("port forward code issue failed", zap.Error(err))
		h.answer(c, failureUnavailable)
		return
	}
	q := url.Values{"code": {code}, "return": {redirectpath.Local(c.Query("return"))}}
	redirect(c, strings.TrimSuffix(h.links.ForwardURL(prefix), "/")+callbackPath+"?"+q.Encode())
}

// accountBlocked 与鉴权中间件同一道账号闸门：会话在不等于账号还能用。闸门未装配
// （测试）时不判。
func accountBlocked(ctx context.Context, userID int64) bool {
	gate := user_svc.Gate()
	return gate != nil && gate.Check(ctx, userID) != nil
}

// ── 小工具 ──────────────────────────────────────────────────────────────

// redirect 302 且 no-store：带着一次性授权码的跳转不该进任何缓存。
func redirect(c *gin.Context, location string) {
	c.Header("Cache-Control", "no-store")
	c.Redirect(http.StatusFound, location)
}

// stripForwardCredentials 转交之前删掉本系统的转发票（两个名字都删：部署从 http 换到
// https 之后，浏览器里可能还留着旧名字那张）与 Authorization。被转发应用自己的 cookie
// 原样留下，包括与我们的票挤在同一行 Cookie 头里的那些。
func stripForwardCredentials(r *http.Request) {
	r.Header.Del("Authorization")
	ours := map[string]bool{session.ForwardCookieName(true): true, session.ForwardCookieName(false): true}
	var kept []string
	for _, line := range r.Header.Values("Cookie") {
		for _, part := range strings.Split(line, ";") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			name, _, _ := strings.Cut(part, "=")
			if ours[strings.TrimSpace(name)] {
				continue
			}
			kept = append(kept, part)
		}
	}
	r.Header.Del("Cookie")
	if len(kept) > 0 {
		r.Header.Set("Cookie", strings.Join(kept, "; "))
	}
}
