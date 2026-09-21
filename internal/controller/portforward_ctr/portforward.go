// Package portforward_ctr 把一条端口转发映射借出来的连接池入口，与「借不到时该说
// 什么」这两件事收在一起（规格 2026-09-09-console-port-forward-host、
// 2026-09-21-port-forward-subdomain）。
//
// # 分工
//
// host.go 是转发子域的两端：按 Host 分发（Dispatch，<前缀>.<base_domain> 上的请求
// 整条归它）与控制台上签发授权码的 Authorize。本文件是它们共用的两件更小的事——
// 「按（账号, 设备指纹, 映射 id）借一次转发入口」（deviceOwnerAndOnline / acquire）与
// 「借不到 / 映射本身不可用时怎么答」（answer）。/fw/<device_id>/<port>/… 那条旧路由
// 已按规格 2026-09-21-port-forward-subdomain 决策 13 删除。
//
// ResponseWriter 的处理原则不变：调用方拿到 Acquire 借出的 http.Handler 之后要
// **原样**交出去，不包任何一层——失败的措辞由本包的渲染钩子（failpage.go 的
// NewFailureRenderer）负责，它装在代理的构造处（internal/bootstrap），只在代理自己的
// 失败上被调用，被转发应用自己的响应因此一个字节都不经过我们
// （规格 2026-09-09-console-forward-failure-pages 决策 3）。
package portforward_ctr

import (
	"context"
	"errors"
	"net/http"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
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
//
// **按映射 id 定位，不再按端口**（规格 2026-09-21-port-forward-subdomain 决策 10）。
type Forwarder interface {
	Acquire(
		ctx context.Context, userID int64, fingerprint string, mappingID int64,
	) (http.Handler, func(), error)
}

// failureKind 是这一层能给出的失败类别——都发生在**借到共享代理之前**，与共享包判出
// 的那一套（portforwardhost.FailureKind，见 failpage.go）分开。
type failureKind int

const (
	// failureNotFound 是「没有指向一台你能用的设备的一条映射」：设备查不到、不是你
	// 的、已经撤销——**三种答得一模一样**，且必须不可区分：只要能分开，调用方拼出来
	// 的地址就是一台跨账号的设备存在性探测器（规格「访问与鉴权」）。
	failureNotFound failureKind = iota
	// failureOffline 是「设备离线」。两条来路：open 之前的在线判定不过，以及拨号面
	// 原样上交的 ErrMachineOffline。
	failureOffline
	// failureUpstream 是「机器在，这一跳没搭起来」：借连接时协议版本不合、连接反复
	// 断掉。它与 failureOffline 同为 502，但分成两类，为的是不在这里说一句「设备
	// 离线」这样的假话。
	//
	// 它发生在**借到代理之前**，所以共享包那套失败归因够不着它：本层自己答。
	failureUpstream
	// failureUnavailable 是「此刻这个部署给不了转发」：池没装配，或者进程正在退出。
	// 与设备无关，所以不能说成「设备离线」——那会叫用户去等一台其实好好的机器。
	failureUnavailable
)

type failureAnswer struct {
	status int
	// page 非空表示这一类答一张完整的 HTML 失败页；空的答 body 那句纯文本。
	//
	// 这三类是**本层自己**产生的失败：它们不经过共享代理，渲染钩子够不着，所以答复
	// 在这里定。规格 2026-09-09-console-forward-failure-pages 决策 7 明写它们维持
	// 原样，因此只有「设备离线」这一类有页，其余两类刻意留纯文本：
	//
	//   - failureNotFound：这一张两个出口都说不通——「刷新」对一条查不到的映射永远是
	//     同一个 404，剩下的只有「回到设备」，那正是用户已经知道的那一页。
	//   - failureUpstream：机器在，这一跳没搭起来（协议版本不合之类）。它是 502，但
	//     此刻我们**知道**它不是「目标连不上」，套那张页就等于叫用户去检查一个其实没
	//     问题的目标。
	//   - failureUnavailable：与设备无关（池未装配 / 进程正在退出），三张页说的三件事
	//     哪一件都不是它。
	page *failurePage
	body string
}

var failureAnswers = map[failureKind]failureAnswer{
	failureNotFound:    {status: http.StatusNotFound, body: "没有这条你能用的端口转发映射。"},
	failureOffline:     {status: http.StatusBadGateway, page: &offlinePage},
	failureUpstream:    {status: http.StatusBadGateway, body: "转发没有建立起来。"},
	failureUnavailable: {status: http.StatusServiceUnavailable, body: "这个部署此刻提供不了端口转发。"},
}

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

// deviceOwnerAndOnline 查一遍「这台设备归不归这个账号」与「它此刻在不在线」，答复
// 「查不到 / 不是你的 / 已撤销」不可区分（failureNotFound）与「设备离线」
// （failureOffline）两类维持 Forward() 原来的口径。
//
// 调用方是 host.go 的 forward：它从前缀表解出 (userID, deviceID) 之后先走这一步，
// 接着才是 acquire。
func (p *PortForward) deviceOwnerAndOnline(
	ctx context.Context, userID, deviceID int64,
) (*device_entity.Device, failureKind, bool) {
	device, err := p.devices.OwnedDevice(ctx, userID, deviceID)
	if err != nil {
		// 答复对「查不到」「不是你的」「已经撤销」三种情形一模一样，所以「到底是哪一
		// 种」只能从日志里看。查库出错也走这条：它同样没法在不劈开答复的前提下多说
		// 一句。
		logger.Ctx(ctx).Info("port forward rejected: no such usable device for this account",
			zap.Int64("userId", userID), zap.Int64("deviceId", deviceID), zap.Error(err))
		return nil, failureNotFound, false
	}
	online, err := p.presence.IsDaemonOnline(ctx, userID, device.Fingerprint)
	if err != nil {
		// 问不到在线态就当它不在线：这条路上唯一说得出口的话就是「机器没回来」，
		// 而拿一个读不出结果的判定去拨号只会把同一件事拖到超时才发现。
		logger.Ctx(ctx).Warn("port forward presence lookup failed, answering offline",
			zap.Int64("userId", userID), zap.String("machineFingerprint", device.Fingerprint),
			zap.Error(err))
		return device, failureOffline, false
	}
	if !online {
		return device, failureOffline, false
	}
	return device, 0, true
}

// acquire 借一次转发入口，ErrConnectionGone 重试一次。
//
// 那个错误的语义就是「刚拿到手的连接在借出之前就断了」——池已经把它摘掉了，再要一次
// 就会重新拨。只重一次：真的拨不出去时连着重试只是把同一个失败拖长。
func (p *PortForward) acquire(
	ctx context.Context, userID int64, fingerprint string, mappingID int64,
) (http.Handler, func(), error) {
	if p.forwarder == nil {
		return nil, nil, errForwarderUnavailable
	}
	handler, release, err := p.forwarder.Acquire(ctx, userID, fingerprint, mappingID)
	if !errors.Is(err, portforward_svc.ErrConnectionGone) {
		return handler, release, err
	}
	return p.forwarder.Acquire(ctx, userID, fingerprint, mappingID)
}

// errForwarderUnavailable 是「这个部署没有装配端口转发池」——那不是拨号失败，是一种
// 部署形态，acquireFailure 把它答成 failureUnavailable 而不是随手套上「机器在，
// 这一跳没搭起来」。
var errForwarderUnavailable = errors.New("port forward: forwarder not configured")

// acquireFailure 把借用失败归到该给用户的那一类上。
func acquireFailure(
	ctx context.Context, userID int64, fingerprint string, mappingID int64, err error,
) failureKind {
	if errors.Is(err, errForwarderUnavailable) {
		return failureUnavailable
	}
	logger.Ctx(ctx).Warn("port forward acquire failed",
		zap.Int64("userId", userID), zap.String("machineFingerprint", fingerprint),
		zap.Int64("mappingId", mappingID), zap.Error(err))
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

// answer 按失败类别把答复写进 c.Writer：要么一整张页，要么一句 no-store 的纯文本。
// devicesURL 是页上「回到设备」的去处（ConsoleDevicesURL）。
func answer(c *gin.Context, kind failureKind, devicesURL string) {
	answer := failureAnswers[kind]
	if answer.page != nil {
		writeFailurePage(c.Writer, answer.status, *answer.page, devicesURL)
		c.Abort()
		return
	}
	// 与出页的那一条同一个出口：纯文本也要 no-store。少了它，404 那一句按 RFC 9111
	// 是可被浏览器**启发式缓存**的（带 Date、没有任何 Cache-Control / Expires），
	// 于是设备重新配对、映射重新建好之后，同一条转发地址在那个标签页里刷新仍可能
	// 是旧的 404，而服务端这一侧完全看不出问题。
	writeFailureBody(c.Writer, answer.status, failureTextContentType, answer.body)
	c.Abort()
}
