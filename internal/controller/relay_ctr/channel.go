package relay_ctr

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// clientChannels 是一条中继客户端连接上的虚拟通道注册表。
//
// 目标从连接级降到通道级之后（决策 10），一条连接上的通道可以分别落在不同的机器
// 上，所以「这条连接接的是谁」这个问题不再有答案——只有「这条**通道**接的是谁」。
// 注册表是连接级的连接状态，因此归控制器，不归服务层。
//
// 通道号有两套：客户端在自己这条连接里自选的号（客户端侧命名空间，键就是它），
// 与服务端分配给 daemon 那条链路的号（AttachClient 交回，账号+机器范围内唯一）。
// 两者在这里翻译，客户端因此撞不到、也猜不到别人那条通道的服务端号。
// maxOpenChannelsPerConnection 是一条中继客户端连接上同时开着的虚拟通道数上限。
//
// 目标降到通道级之后,开一条通道要一次库 + 一次 Redis,并在服务端留下一份附着与
// 一份在线登记(带自己的续期 goroutine);而这些只在客户端主动关、或整条连接断掉时
// 回收。没有上限,一个已鉴权的账号在**一条** socket 上就能把它们无限开下去。
// 取值远高于任何真实用法(浏览器一条对话一条通道,桌面端一台机器一条)。
const maxOpenChannelsPerConnection = 256

// maxChannelIDLength 与对端 relaytransport.maxRelayChannelIDLength 同值。信封头
// 允许 65535 字节的通道号,但通道号是客户端自选的、要被服务端存进注册表并原样回写
// 到每一帧上 —— 不设限就等于让对面用通道号本身放大内存占用。
const maxChannelIDLength = 128

type clientChannels struct {
	svc    relay_svc.RelaySvc
	conn   FrameConn
	client int64

	mu   sync.Mutex
	open map[string]*clientChannel
}

// FrameConn 是通道注册表用得到的那一小块连接能力（ISP）：写一帧。
type FrameConn interface {
	WriteMessage(messageType int, data []byte) error
}

type clientChannel struct {
	route    relay_svc.Route
	daemonID string
	detach   func()
}

func newClientChannels(svc relay_svc.RelaySvc, conn FrameConn, accountID int64) *clientChannels {
	return &clientChannels{svc: svc, conn: conn, client: accountID, open: map[string]*clientChannel{}}
}

// handle 处理客户端发来的一帧。它由这条连接的读循环**顺序**调用，因此注册表的读写
// 之间没有交错；锁留着是因为服务端主动开的保留通道（决策 13）会从别的 goroutine 来。
//
// 三条路，按「这条通道服务端认不认得」分：不认得且载荷非空 = 开通道，载荷就是目标
// 声明；认得 = 数据，转发给这条通道自己的机器；载荷为空 = 关这条通道。
//
// 它**不返回错误**：通道级的失败只答复给那一条通道，绝不牵连同一连接上的其它通道。
// 唯一能关掉整条连接的是鉴权失效（连接守卫，见 Client）。
func (c *clientChannels) handle(ctx context.Context, channelID string, payload []byte) {
	// 保留通道只出不进（决策 13/14）：号归服务端，客户端往它写任何东西——包括普通
	// 通道上表示「关掉这条」的空载荷——都是协议违例。判在最前面而不是开通道那一步：
	// 服务端已经开着的那条保留通道在注册表里没有条目，落到 lookup 之后会被当成
	// 「客户端要开一条新通道」，那时再拒就把两种违例混成一种。
	if len(channelID) > maxChannelIDLength {
		c.writeError(ctx, channelID, relay_svc.ChannelCodeTargetInvalid, code.InvalidParameter)
		return
	}
	if strings.HasPrefix(channelID, relay_svc.ReservedChannelPrefix) {
		// 不带关闭帧：保留通道是服务端开的，客户端的一次违例不该把它自己的信号路
		// 判死——它还在收信号。
		c.writeError(ctx, channelID, relay_svc.ChannelCodeReserved, code.InvalidParameter)
		return
	}
	if len(payload) == 0 {
		c.close(channelID)
		return
	}
	if channel, ok := c.lookup(channelID); ok {
		if err := c.svc.ForwardClient(
			ctx, channel.route, channel.daemonID, websocket.BinaryMessage, payload,
		); err != nil {
			// 转发失败是这条通道的目标出了问题：这一条报错关掉，别的通道照常收发。
			c.fail(ctx, channelID, err)
		}
		return
	}
	c.openChannel(ctx, channelID, string(payload))
}

// openChannel 按通道声明的目标接上一台机器。
//
// 解析是同步的：它跑在读循环上，一次目标解析要问一次库、一次 Redis。这只发生在
// 每条通道开通那一刻（之后的帧走 lookup 直接转发），但一次很慢的解析确实会推迟
// 同连接其它通道的帧——那是延迟，不是隔离：解析失败仍然只判死这一条通道。
func (c *clientChannels) openChannel(ctx context.Context, channelID, target string) {
	// 保留号在 handle 那一步就被挡掉了，因此这里的通道一定有一台对端机器可以附着
	// ——AttachClient 结束时要往通道上发一帧空载荷通知对端 daemon，而保留通道压根
	// 没有对端 daemon。
	c.mu.Lock()
	overCap := len(c.open) >= maxOpenChannelsPerConnection
	c.mu.Unlock()
	if overCap {
		// 通道级失败:已经开着的那些照常收发,只是不再接受新的。
		c.writeError(ctx, channelID, relay_svc.ChannelCodeTargetInvalid, code.InvalidParameter)
		_ = (&channelWriter{conn: c.conn, channelID: channelID}).
			WriteMessage(websocket.BinaryMessage, nil)
		logger.Ctx(ctx).Warn("relay_ctr.openChannel: connection is at its channel cap",
			zap.Int64("accountId", c.client), zap.Int("openChannels", maxOpenChannelsPerConnection))
		return
	}
	route, err := c.svc.ResolveTarget(ctx, c.client, target)
	if err != nil {
		c.fail(ctx, channelID, err)
		return
	}
	daemonID, detach, err := c.svc.AttachClient(ctx, route, &channelWriter{conn: c.conn, channelID: channelID})
	if err != nil {
		c.fail(ctx, channelID, err)
		return
	}
	c.mu.Lock()
	c.open[channelID] = &clientChannel{route: route, daemonID: daemonID, detach: detach}
	c.mu.Unlock()
}

func (c *clientChannels) lookup(channelID string) (*clientChannel, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	channel, ok := c.open[channelID]
	return channel, ok
}

func (c *clientChannels) take(channelID string) *clientChannel {
	c.mu.Lock()
	defer c.mu.Unlock()
	channel := c.open[channelID]
	delete(c.open, channelID)
	return channel
}

// close 关掉一条通道：摘掉本地附着，并让 daemon 那侧也知道这条虚拟通道没了。
func (c *clientChannels) close(channelID string) {
	if channel := c.take(channelID); channel != nil {
		channel.detach()
	}
}

// pumpSignals 把账号信号写进一条共享中继连接的保留通道（决策 13）。两种对端
// 落点不同、机制相同（浏览器/桌面端的 Client，agentred 的 Daemon），因此这里不
// 认识调用方是哪一种连接，只认一个能写帧的 FrameConn。
//
// 帧流关掉意味着这份订阅没了（Redis 订阅彻底失败，或连接正在收尾）：关掉的是这
// **一条**通道而不是整条连接——上面还跑着 RPC。对端据此把信号那一路标为不可用
// 并退回轮询，重连或下一次主动读取补齐断流期间的变更。
func pumpSignals(conn FrameConn, frames <-chan []byte) {
	writer := &channelWriter{conn: conn, channelID: relay_svc.SignalChannelID}
	for frame := range frames {
		if err := writer.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			return
		}
	}
	// 空载荷 = 这条通道关了，与普通通道同一个约定。
	_ = writer.WriteMessage(websocket.BinaryMessage, nil)
}

// signalUnavailable 告诉对端信号那一路建不起来。它是**通道级**的：整条连接照常
// 服务 RPC，只有保留通道当场关掉，对端退回轮询。
func signalUnavailable(ctx context.Context, conn FrameConn) {
	writeChannelError(ctx, conn, relay_svc.SignalChannelID,
		relay_svc.ChannelCodeSignalUnavailable, code.AccountChannelUnavailable)
	writer := &channelWriter{conn: conn, channelID: relay_svc.SignalChannelID}
	_ = writer.WriteMessage(websocket.BinaryMessage, nil)
}

// fail 把一条通道判死：告诉客户端为什么，再关掉它。整条连接不受影响。
func (c *clientChannels) fail(ctx context.Context, channelID string, err error) {
	channelCode, businessCode := channelFailure(err)
	// 记一行。客户端只拿得到一个码 + 一句语言包文案,而 default 分支恰恰是「谁也没
	// 认出这个失败」—— 库挂了 / Redis 挂了都长这样。不记的话,一次依赖故障在服务端
	// 一点痕迹都不留,只在每条通道上变成一个泛泛的 -32603。
	if channelCode == relay_svc.ChannelCodeInternal {
		logger.Ctx(ctx).Error("relay_ctr.channel: unmapped channel failure",
			zap.String("channelId", channelID), zap.Int64("accountId", c.client), zap.Error(err))
	} else {
		logger.Ctx(ctx).Warn("relay_ctr.channel: channel failed",
			zap.String("channelId", channelID), zap.Int64("accountId", c.client),
			zap.Int32("channelCode", channelCode), zap.Error(err))
	}
	c.writeError(ctx, channelID, channelCode, businessCode)
	// 空载荷 = 这条通道关了，与 daemon 那条链路上同一个约定。
	_ = (&channelWriter{conn: c.conn, channelID: channelID}).
		WriteMessage(websocket.BinaryMessage, nil)
	c.close(channelID)
}

func (c *clientChannels) writeError(ctx context.Context, channelID string, channelCode int32, businessCode int) {
	writeChannelError(ctx, c.conn, channelID, channelCode, businessCode)
}

// writeChannelError 把一个通道级失败编成 RpcFrame_Error 帧写给对端。两条链路
// （client 的普通/保留通道失败、daemon 的保留通道失败）共用这一个编码。
func writeChannelError(ctx context.Context, conn FrameConn, channelID string, channelCode int32, businessCode int) {
	frame, err := relaywire.EncodeFrame(&agentrewire.RpcFrame{
		Body: &agentrewire.RpcFrame_Error{Error: &agentrewire.RpcError{
			Code: channelCode, Message: i18n.T(ctx, businessCode),
		}},
	})
	if err != nil {
		logger.Ctx(ctx).Error("encode relay channel error", zap.Error(err))
		return
	}
	writer := &channelWriter{conn: conn, channelID: channelID}
	_ = writer.WriteMessage(websocket.BinaryMessage, frame)
}

// closeAll 在连接走人时把每条通道都摘掉，让每台机器都收到自己那条通道的关闭信号。
//
// 并发摘而不是顺序摘:每个 detach 底下是一次 ForwardClient,跨副本时要等一次投递
// 回执(relay_svc 的 channelCloseTimeout)。顺序摘的话 N 条通道最坏要等 N 倍,而这
// 段跑在连接处理器的 defer 上 —— 它同时挡着这条连接的信号订阅收尾与 mux.Shutdown。
func (c *clientChannels) closeAll() {
	c.mu.Lock()
	channels := c.open
	c.open = map[string]*clientChannel{}
	c.mu.Unlock()
	var wg sync.WaitGroup
	for _, channel := range channels {
		wg.Add(1)
		go func(detach func()) {
			defer wg.Done()
			detach()
		}(channel.detach)
	}
	wg.Wait()
}

// channelWriter 把一条通道的出帧套上**客户端自己那个号**的信封再写进共享连接。
// 客户端因此始终按自己开通道时用的号收发，看不到服务端分配的那一套号。
type channelWriter struct {
	conn      FrameConn
	channelID string
}

func (w *channelWriter) WriteMessage(messageType int, frame []byte) error {
	envelope, err := relay_svc.WrapEnvelope(w.channelID, frame)
	if err != nil {
		return err
	}
	return w.conn.WriteMessage(messageType, envelope)
}

// channelFailure 把服务层的失败翻成一个通道级错误码 + 一个业务码。
//
// 业务码沿用 upgrade 前那一版（internal/pkg/code 的 Relay 段与 Forbidden）：换的
// 只是投递方式，不是这些失败的含义。文案因此照旧由中英语言包给出，通道级与
// HTTP 级不会各说一套。
func channelFailure(err error) (int32, int) {
	switch {
	case errors.Is(err, relay_svc.ErrTargetInvalid):
		return relay_svc.ChannelCodeTargetInvalid, code.InvalidParameter
	case errors.Is(err, relay_svc.ErrDaemonNotFound):
		return relay_svc.ChannelCodeTargetNotFound, code.RelayDaemonNotFound
	case errors.Is(err, relay_svc.ErrDaemonOffline):
		return relay_svc.ChannelCodeTargetOffline, code.RelayDaemonOffline
	case errors.Is(err, relay_svc.ErrForwardFailed):
		return relay_svc.ChannelCodeForwardFailed, code.RelayForwardFailed
	case errors.Is(err, relay_svc.ErrDaemonForbidden):
		return relay_svc.ChannelCodeTargetForbidden, code.Forbidden
	default:
		return relay_svc.ChannelCodeInternal, code.ServerError
	}
}
