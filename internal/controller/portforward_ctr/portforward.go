// Package portforward_ctr 把浏览器打到 /fw/<device_id>/<port>/… 的请求送进那台设备
// 本机 127.0.0.1 的那个端口上（规格 2026-09-09-console-port-forward-host）。
//
// 它是本仓唯一一条**裸字节**的路由：没有请求结构体、没有响应结构体、不进
// internal/api 的任何响应面。控制器在这里只做三件事——按序校验、把地址里的
// device_id 翻成中继寻址用的指纹、剥掉前缀，然后把 ResponseWriter 原样交给共享包的
// 转发代理。
//
// 交出去之前只包一层 failureRewriter（rewrite.go）：共享包把七种失败答成写死中文的
// 纯文本，而用户此刻在浏览器标签里，那一层在 502 的那一刻把它换成一张完整的失败页。
// **它不得攒响应体**——代理要 Hijacker（101 升级）与 Flusher（流式），缓冲起来就当场
// 失效，纪律写在 rewrite.go。
//
// 本包的用例住在 internal/api/portforward/：这里的判定只有跑在真实路由树 + 真实
// SessionAuth + 真实 SPA 兜底上才说明问题——「形状不对的 /fw/… 不回落 SPA 外壳」
// 这一条，脱开那个兜底就测不到。
package portforward_ctr

import (
	"context"
	"errors"
	"net/http"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/api/portforward"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
)

// DeviceLookup 是「这台设备归不归这个账号、还能不能用」这一件事（ISP）。
// 实现是 device_svc.DeviceSvc.OwnedDevice：查不到、不归他、已撤销三种情形它回同一个
// 错误，正是这条路径要的不可区分口径——所以本层**不再**自己拼一套判定。
type DeviceLookup interface {
	OwnedDevice(ctx context.Context, userID, deviceID int64) (*device_entity.Device, error)
}

// Presence 是「这台机器此刻在不在线」这一件事（ISP）。实现是 relay_svc.RelaySvc，
// 判据是中继的 Redis 路由键。
//
// 不用 device_svc 那条列表口径（ListUserDevices）：它对账号名下每一台设备都要打一次
// 在线与协议探测，而这里只问一台。
type Presence interface {
	IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error)
}

// Forwarder 是端口转发连接池借出入口的那一件事（ISP），实现是
// portforward_svc.Pool。第二个返回值是归还函数，幂等，必须在请求收尾时调到。
type Forwarder interface {
	Acquire(
		ctx context.Context, userID int64, fingerprint string, port uint32,
	) (http.Handler, func(), error)
}

// failureKind 是这一层能给出的失败类别。
type failureKind int

const (
	// failureNotFound 是「这条地址没有指向一台你能用的设备的一个端口」：地址形状不对、
	// 设备查不到、不是你的、已经撤销——**四种答得一模一样**。
	//
	// 后三种必须不可区分：只要能分开，这条地址就是一台跨账号的设备存在性探测器
	// （规格「访问与鉴权」）。形状不对的并进来是因为它同样没有指向任何东西，而且它
	// 绝不能落到 SPA 兜底上（决策 10）——那里会答 200 + index.html，浏览器里是一张
	// 白屏而状态码正常，没有任何东西会红。
	failureNotFound failureKind = iota
	// failureOffline 是「设备离线」。两条来路：open 之前的在线判定不过，以及拨号面
	// 原样上交的 ErrMachineOffline。
	failureOffline
	// failureUpstream 是「机器在，这一跳没搭起来」：协议版本不合、连接反复断掉。
	// 与 failureOffline 同一个状态码（502），因为共享包本来就把「端口上没有服务」
	// 「上游把请求断了」「转发没完成」全答成 502，按状态码分不开它们（决策 13）；
	// 分开成两类是为了不在这里说一句「设备离线」这样的假话。
	failureUpstream
	// failureUnavailable 是「此刻这个部署给不了转发」：池没装配，或者进程正在退出。
	// 与设备无关，所以不能说成「设备离线」——那会叫用户去等一台其实好好的机器。
	failureUnavailable
)

type failureAnswer struct {
	status int
	// page 非空表示这一类答一张完整的 HTML 失败页；空的答 body 那句纯文本。
	//
	// **只有「设备离线」这一类有页**（规格「失败的呈现」只点名两张页，另一张由改写层
	// 在 502 那一刻渲染）。其余三类刻意留纯文本：
	//
	//   - failureNotFound：规格明写 404 不改写。而且这一张两个出口都说不通——「刷新」
	//     对一条形状不对的地址永远是同一个 404，剩下的只有「回到设备」，那正是用户已经
	//     知道的那一页。
	//   - failureUpstream：机器在，这一跳没搭起来（协议版本不合之类）。它是 502，但
	//     此刻我们**知道**它不是「端口上没有服务」，套那张页就等于叫用户去起一个其实
	//     起着的服务。决策 13 明知的代价只覆盖分不开的那几种，不该往这里扩。
	//   - failureUnavailable：与设备无关（池未装配 / 进程正在退出），两张页说的两件事
	//     哪一件都不是它。
	page *failurePage
	body string
}

var failureAnswers = map[failureKind]failureAnswer{
	failureNotFound:    {status: http.StatusNotFound, body: "没有这台设备的这个端口。"},
	failureOffline:     {status: http.StatusBadGateway, page: &offlinePage},
	failureUpstream:    {status: http.StatusBadGateway, body: "转发没有建立起来。"},
	failureUnavailable: {status: http.StatusServiceUnavailable, body: "这个部署此刻提供不了端口转发。"},
}

// failureContentType 是纯文本失败答复的类型。带页的那一类走 failurePageContentType。
const failureContentType = "text/plain; charset=utf-8"

type PortForward struct {
	devices   DeviceLookup
	presence  Presence
	forwarder Forwarder
}

// New 装配控制器。forwarder 为 nil 表示这个部署没有端口转发池——那不是错误，是一种
// 部署形态，请求会被答成 failureUnavailable 而不是去拨一个不存在的中继。
func New(devices DeviceLookup, presence Presence, forwarder Forwarder) *PortForward {
	return &PortForward{devices: devices, presence: presence, forwarder: forwarder}
}

// Forward 是 /fw/*forward 上的处理器。它是裸 gin 处理器而不是 mux.Bind 的那种形态：
// mux.Meta 是 struct tag，只写得下字面量，装不下通配尾段。
func (p *PortForward) Forward(c *gin.Context) {
	ctx := c.Request.Context()
	addr, ok := portforward.Parse(c.Param(portforward.ParamName))
	if !ok {
		// 地址都没解析出来，页面里那句「127.0.0.1:<端口>」无从谈起——这一类本来也
		// 不出页。
		p.answer(c, failureNotFound, 0)
		return
	}
	// 登录态由 middleware.SessionAuth 判掉，走到这里必然有账号。
	userID := ginctx.UserID(c)
	device, err := p.devices.OwnedDevice(ctx, userID, addr.DeviceID)
	if err != nil {
		// 答复对四种情形一模一样，所以「到底是哪一种」只能从日志里看。查库出错也走
		// 这条：它同样没法在不劈开答复的前提下多说一句。
		logger.Ctx(ctx).Info("port forward rejected: no such usable device for this account",
			zap.Int64("userId", userID), zap.Int64("deviceId", addr.DeviceID), zap.Error(err))
		p.answer(c, failureNotFound, addr.Port)
		return
	}
	online, err := p.presence.IsDaemonOnline(ctx, userID, device.Fingerprint)
	if err != nil {
		// 问不到在线态就当它不在线：这条路上唯一说得出口的话就是「机器没回来」，
		// 而拿一个读不出结果的判定去拨号只会把同一件事拖到超时才发现。
		logger.Ctx(ctx).Warn("port forward presence lookup failed, answering offline",
			zap.Int64("userId", userID), zap.String("machineFingerprint", device.Fingerprint),
			zap.Error(err))
		p.answer(c, failureOffline, addr.Port)
		return
	}
	if !online {
		p.answer(c, failureOffline, addr.Port)
		return
	}
	if p.forwarder == nil {
		p.answer(c, failureUnavailable, addr.Port)
		return
	}
	handler, release, err := p.acquire(ctx, userID, device.Fingerprint, addr.Port)
	if err != nil {
		p.answer(c, acquireFailure(ctx, userID, device.Fingerprint, addr.Port, err), addr.Port)
		return
	}
	defer release()
	// 前缀在这里剥、且**只剥一次**（决策 6）：共享包取的是 r.URL.RequestURI()，
	// 跟着 StripPrefix 改过的路径走。/fw/12/3000 因此变成 /（空 Path 的
	// RequestURI() 就是 "/"），/fw/12/3000/assets/x.js 变成 /assets/x.js。
	//
	// c.Writer 外面只包 failureRewriter：它在 502 的那一刻把共享包那句纯文本换成一张
	// 完整的失败页，其余一律原样放过，且把 Flusher / Hijacker / Unwrap 全部转下去
	// ——代理要拿它们做 Hijack 与 Flush。
	writer := &failureRewriter{
		inner: c.Writer,
		port:  addr.Port,
		classify: func() failurePage {
			return p.badGateway(ctx, userID, device.Fingerprint)
		},
	}
	http.StripPrefix(addr.Prefix, handler).ServeHTTP(writer, c.Request)
}

// badGateway 分开共享包那四种共用 502 的失败（规格决策 13，用户拍板）。
//
// 判据是**再读一次在线状态**，不匹配上游文案：还在线 → 端口上没有服务，已离线 →
// 设备离线。上游那几句中文常量在上游仓且未导出，认它们的话上游改一个字这里就静默
// 失灵，而本仓不会有任何用例会红。
//
// 明知的代价：「上游把请求断了」「转发没完成」这两种也会落到「端口上没有服务」那一
// 张。规格没有为它们定页，而按状态码分不开它们。
func (p *PortForward) badGateway(
	ctx context.Context, userID int64, fingerprint string,
) failurePage {
	online, err := p.presence.IsDaemonOnline(ctx, userID, fingerprint)
	if err != nil {
		// 与 open 之前那次同一条口径：问不到就当它不在线。这条路上唯一说得出口的话
		// 是「等机器回来」，而不是叫用户去起一个其实起着的服务。
		logger.Ctx(ctx).Warn("port forward presence re-read failed, answering offline",
			zap.Int64("userId", userID), zap.String("machineFingerprint", fingerprint),
			zap.Error(err))
		return offlinePage
	}
	if online {
		return noListenerPage
	}
	return offlinePage
}

// acquire 借一次转发入口，ErrConnectionGone 重试一次。
//
// 那个错误的语义就是「刚拿到手的连接在借出之前就断了」——池已经把它摘掉了，再要一次
// 就会重新拨。只重一次：真的拨不出去时连着重试只是把同一个失败拖长。
func (p *PortForward) acquire(
	ctx context.Context, userID int64, fingerprint string, port uint32,
) (http.Handler, func(), error) {
	handler, release, err := p.forwarder.Acquire(ctx, userID, fingerprint, port)
	if !errors.Is(err, portforward_svc.ErrConnectionGone) {
		return handler, release, err
	}
	return p.forwarder.Acquire(ctx, userID, fingerprint, port)
}

// acquireFailure 把借用失败归到该给用户的那一类上。
func acquireFailure(
	ctx context.Context, userID int64, fingerprint string, port uint32, err error,
) failureKind {
	logger.Ctx(ctx).Warn("port forward acquire failed",
		zap.Int64("userId", userID), zap.String("machineFingerprint", fingerprint),
		zap.Uint32("port", port), zap.Error(err))
	switch {
	case errors.Is(err, mirror_svc.ErrMachineOffline):
		// 在线判定与拨号之间机器走掉了：与判定不过答同一张。
		return failureOffline
	case errors.Is(err, portforward_svc.ErrStopped):
		// 这个副本正在退出。机器没事，别叫用户去等它。
		return failureUnavailable
	default:
		// 余下的（协议版本不合、连接反复断掉）：机器在，这一跳没搭起来。
		return failureUpstream
	}
}

func (p *PortForward) answer(c *gin.Context, kind failureKind, port uint32) {
	answer := failureAnswers[kind]
	if answer.page != nil {
		writeFailurePage(c.Writer, answer.status, *answer.page, port)
		c.Abort()
		return
	}
	c.Data(answer.status, failureContentType, []byte(answer.body))
	c.Abort()
}
