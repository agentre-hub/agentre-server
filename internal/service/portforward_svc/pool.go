// Package portforward_svc 是控制台端口转发在服务端这一侧的连接池：按（账号, 设备）
// 复用一条已握手的设备连接，并在那条连接上按端口挂共享包的转发代理
// （github.com/agentre-hub/agentre/pkg/wire/portforwardhost.Proxy）。
//
// # 为什么它不住在 mirror_svc 里
//
// 拨号那件事在 mirror_svc（它才知道怎么签凭据、怎么走中继），但**这条池刻意不要
// Redis 租约**：端口转发没有「同一台机器同一时刻只该被一个副本跟」这条排他性
// （规格 2026-09-09-console-port-forward-host 决策 3），浏览器打到哪个副本、哪个
// 副本自己拨即可。而 mirror_svc 里那份常驻的全部形状都围着租约转
// （resident.go 的 machineLease）。两者混住会让下一个读者以为这条池也受租约管辖。
//
// 所以依赖方向是：本包声明一个只有「拨一条专用连接」的窄接口（MachineDialer），
// mirror_svc 那一侧导出一个结构上满足它的方法，装配在 internal/bootstrap。
package portforward_svc

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre/pkg/wire/portforwardhost"
	"github.com/agentre-hub/agentre/pkg/wire/protorpc"
)

// ErrStopped 是在已经收工的池上再要一条连接。进程正在退出，新拨一条只会留下一条
// 没人收的中继订阅。
var ErrStopped = errors.New("port forward pool is stopped")

// ErrConnectionGone 是「刚拿到手的那条连接在借出去之前就没了」。它与拨号失败分开：
// 拨号失败说的是够不着那台机器（ErrMachineOffline 之类，由拨号面原样上交），这一个
// 说的是连接刚建好就断了，调用方重试一次即可。
var ErrConnectionGone = errors.New("port forward connection is gone")

const (
	// defaultIdleTimeout 是「引用归零之后再静置多久就把连接收掉」。
	//
	// 借用是**按请求**的（取用 → ServeHTTP → 归还），所以一个开着却没有请求在飞的
	// 标签页引用数就是零：这个数实际决定的是「读完一页再点一下链接，还算不算同一条
	// 连接」。重拨一次要读一次 Redis 退避记号、签一张 JWT、查一次中继路由、attach、
	// 再跑一次 auth.account 往返（mirror_svc/resident.go 的 dialWithTimeout）——把它
	// 押在人从「页面渲染完」到「点下一个链接」之间是没有道理的。
	//
	// 取 60 秒：比人读一屏再点一下长得多，又短到没人用的转发不会白占着一条中继通道。
	// 更短（比如 5 秒）会让一次普通的「读完再点」重新握一次手；更长则一次误开的转发
	// 要占着通道好几分钟。HMR 那种长连接不受它影响——那条请求一直在飞，引用就不为零。
	defaultIdleTimeout = 60 * time.Second

	// defaultCallTimeout 是这条连接上一次调用等应答的预算，与会话 RPC 的
	// Config.CallTimeout（缺省 15 秒）分开（规格决策 9），照一键升级另给预算的做法
	// （mirror_svc 的 upgradeCallTimeout）。
	//
	// 预算落在**连接**上而不是某一次调用的 ctx 上，因为它同时是中继那一跳的期限
	// （mirror_svc/relayframeconn.go 的 WriteFrame 没有 ctx 可用）。
	//
	// 这条连接上跑的调用只有四个：portForward.open / write / ack / close。它们都是
	// 「问一句答一句」——响应头与响应体是**通知**，不是应答，所以一次几分钟的大下载
	// 从来不坐在某一次调用里。真正会拖长的是 write：设备把这一块写进它本机那个服务
	// 的 socket，服务读得慢它就卡着，而同一时刻一次大下载还在占着中继那一跳。
	//
	// 取 60 秒，与协议引擎自己的 DefaultCallTimeout 同值（「远比任何正常往返都长，
	// 又远短于用户的耐心」）。15 秒是给会话 RPC 选的，对上面那条慢上传偏紧；5 分钟
	// （升级那个数）则会让一个已经走掉的标签页的上传在设备那侧悬好几分钟。
	defaultCallTimeout = 60 * time.Second
)

// Config 是连接池的运行期参数。两个都可注入：用例要把时间尺度压到毫秒。
type Config struct {
	// IdleTimeout 见 defaultIdleTimeout。
	IdleTimeout time.Duration
	// CallTimeout 见 defaultCallTimeout。
	CallTimeout time.Duration
}

func (c Config) withDefaults() Config {
	if c.IdleTimeout <= 0 {
		c.IdleTimeout = defaultIdleTimeout
	}
	if c.CallTimeout <= 0 {
		c.CallTimeout = defaultCallTimeout
	}
	return c
}

// MachineDialer 是「为端口转发拨一条通往这台机器的专用连接」这一件事，只有这一个
// 方法（ISP）。实现在 mirror_svc.Supervisor —— 它才知道怎么签凭据、怎么走中继。
//
// 接口在**消费侧**声明，于是 mirror_svc 不必知道这个包存在；两者只在装配处
// （internal/bootstrap）见面。返回的 close 收掉这条连接，幂等。
//
// timeout 同时是这条连接上的调用预算与中继那一跳的期限，见 defaultCallTimeout。
type MachineDialer interface {
	DialPortForward(
		ctx context.Context, userID int64, fingerprint string, timeout time.Duration,
	) (*protorpc.Conn, func(), error)
}

// machineKey 是一台机器：账号 + 它的设备指纹。连接按这个粒度复用。
//
// 账号进键是硬要求：连接是拿账号凭据握的手，两个账号共用一条就是拿 A 的身份替 B
// 转发。
type machineKey struct {
	userID      int64
	fingerprint string
}

// Pool 是本副本手里那些端口转发连接。多副本各持各的，不互相协调（决策 3）。
type Pool struct {
	cfg    Config
	dialer MachineDialer

	// mu 守着 conns 以及每条 pooledConn 的可变部分（引用数、端口表、空闲表、dead）。
	// 一把锁足够：拨号、Proxy.Close 与收连接都在锁外跑。
	mu      sync.Mutex
	conns   map[machineKey]*pooledConn
	stopped bool
}

// pooledConn 是一台机器上那条共用连接。
//
// conn / release / dialErr 只由拨号那一位在 close(ready) 之前写一次，之后只读；
// 其余可变字段由 Pool.mu 守着。
type pooledConn struct {
	key machineKey

	// ready 在拨号落定（成功或失败）时关掉，并发的取用都等它——于是同一台机器上的
	// 一批并发请求只拨一次。
	ready   chan struct{}
	conn    *protorpc.Conn
	release func()
	dialErr error

	// watch 关掉即让守望 goroutine 退出（连接是被回收掉的，不是自己断的）。
	watch chan struct{}

	refs    int
	proxies map[uint32]*proxySlot
	idle    *time.Timer
	dead    bool
}

// proxySlot 让撤销回调认得出「是我这一位」。回调在 NewProxy 内部就订上了通知，
// 可能早于 NewProxy 返回，所以 proxy 字段的写与读都压在 Pool.mu 下。
type proxySlot struct {
	proxy *portforwardhost.Proxy
}

func New(cfg Config, dialer MachineDialer) *Pool {
	return &Pool{cfg: cfg.withDefaults(), dialer: dialer, conns: map[machineKey]*pooledConn{}}
}

// Acquire 借一条通往（账号, 设备）的连接上、这个端口的转发入口。
//
// 同一台设备上的并发请求共用一条已握手的连接，同一个端口上的并发请求共用同一个
// Proxy（它本就按 streamId 多路复用）。归还函数幂等，**必须**在请求收尾时调到，
// 否则这条连接的引用永远不归零、也就永远不会被回收。
//
// 拨号失败原样上交（mirror_svc.ErrMachineOffline 因此透得到调用方手里，控制台据此
// 答「设备离线」那一张失败页）。
func (p *Pool) Acquire(
	ctx context.Context, userID int64, fingerprint string, port uint32,
) (http.Handler, func(), error) {
	entry, mine, err := p.take(machineKey{userID: userID, fingerprint: fingerprint})
	if err != nil {
		return nil, nil, err
	}
	if mine {
		p.dial(ctx, entry)
	}
	select {
	case <-entry.ready:
	case <-ctx.Done():
		// 请求走了。拨号仍会跑完并留在池里给下一位用——半路把它掐掉，一批并发请求里
		// 先超时的那个就会连累其余的。
		p.releaseRef(entry)
		return nil, nil, ctx.Err()
	}
	if entry.dialErr != nil {
		p.releaseRef(entry)
		return nil, nil, entry.dialErr
	}
	handler := p.proxyFor(entry, port)
	if handler == nil {
		p.releaseRef(entry)
		return nil, nil, ErrConnectionGone
	}
	var once sync.Once
	return handler, func() { once.Do(func() { p.releaseRef(entry) }) }, nil
}

// take 找出或建起这台机器的那条连接，并当场记上一次引用。第二个返回值是「这一位
// 要负责去拨」。
func (p *Pool) take(key machineKey) (*pooledConn, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopped {
		return nil, false, ErrStopped
	}
	if entry, ok := p.conns[key]; ok && !entry.dead {
		entry.refs++
		p.disarmIdleLocked(entry)
		return entry, false, nil
	}
	entry := &pooledConn{
		key:     key,
		ready:   make(chan struct{}),
		watch:   make(chan struct{}),
		refs:    1,
		proxies: map[uint32]*proxySlot{},
	}
	// 先占位再干慢活：并发的取用因此都落到这一位身上等 ready，只拨一次。
	p.conns[key] = entry
	return entry, true, nil
}

// dial 拨这条连接。它跑在锁外。
func (p *Pool) dial(ctx context.Context, entry *pooledConn) {
	// **拨号 ctx 必须脱开这次请求。** 它是这条连接的基座：协议引擎的读循环挂在它
	// 上面，中继那一跳的 WriteFrame 也拿它当父 ctx（mirror_svc/relayframeconn.go）。
	// 直接把请求 ctx 递下去，第一个请求一结束整条池化连接就跟着死了——而池的全部
	// 意义就是它活得比单次请求久。WithoutCancel 留下日志上下文、去掉取消与期限；
	// 这条拨号不会因此无限期挂着，它的预算是 CallTimeout（落在连接上，见那个常量）。
	conn, release, err := p.dialer.DialPortForward(
		context.WithoutCancel(ctx), entry.key.userID, entry.key.fingerprint, p.cfg.CallTimeout)
	if err != nil {
		// 失败不留痕：先从池里摘掉再放行等待者，晚到的取用因此重新拨，而不是一直
		// 拿着这个失败答案。
		p.mu.Lock()
		if current, ok := p.conns[entry.key]; ok && current == entry {
			delete(p.conns, entry.key)
		}
		entry.dead = true
		p.mu.Unlock()
		entry.dialErr = err
		close(entry.ready)
		return
	}
	entry.conn, entry.release = conn, release
	close(entry.ready)
	// 连接断了就从池里摘掉，下一次请求重新拨（规格「连接与生命周期」）。在飞的请求
	// 由 Proxy 自己收场——它盯着同一个 Done。
	go func() {
		select {
		case <-conn.Done():
			p.teardown(ctx, entry, "connection closed")
		case <-entry.watch:
		}
	}()
	// 收工可能在这次拨号落定之前就走过去了：Stop 只按调用方给的那份预算等，等不到就
	// 放手（见 Stop）。那时这条连接已经不在池里，谁都不会再来收它——所以它落地之后
	// 自己判一次，当场把自己收掉，否则它与中继上那条订阅要一直悬到进程被 SIGKILL。
	p.mu.Lock()
	stopped := p.stopped
	p.mu.Unlock()
	if stopped {
		p.teardown(ctx, entry, "stopped")
	}
}

// proxyFor 交出这条连接上这个端口的转发入口，没有就现开一个。连接已经没了时交出 nil。
func (p *Pool) proxyFor(entry *pooledConn, port uint32) http.Handler {
	p.mu.Lock()
	defer p.mu.Unlock()
	if entry.dead {
		return nil
	}
	if slot, ok := entry.proxies[port]; ok {
		return slot.proxy
	}
	slot := &proxySlot{}
	// NewProxy 构造时就订上通知，撤销回调因此可能早于它返回——但回调是在自己的
	// goroutine 里跑的（共享包的 Proxy.revoked），而这里正握着 Pool.mu，所以它必然
	// 排在下面那次赋值之后。slot.proxy 的写与读都在这把锁下，没有竞态。
	slot.proxy = portforwardhost.NewProxy(entry.conn, port, func(reason string) {
		p.revokePort(entry, port, slot, reason)
	})
	entry.proxies[port] = slot
	return slot.proxy
}

// releaseRef 归还一次引用。归零之后不立刻收连接，先静置一段时间（见 defaultIdleTimeout）。
func (p *Pool) releaseRef(entry *pooledConn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if entry.refs > 0 {
		entry.refs--
	}
	if entry.refs > 0 || entry.dead {
		return
	}
	p.disarmIdleLocked(entry)
	entry.idle = time.AfterFunc(p.cfg.IdleTimeout, func() { p.reapIfIdle(entry) })
}

func (p *Pool) disarmIdleLocked(entry *pooledConn) {
	if entry.idle != nil {
		entry.idle.Stop()
		entry.idle = nil
	}
}

// reapIfIdle 是静置到点：还没人回来借就把这条连接收掉。
//
// 「还没人借」与「摘掉」必须在同一把锁下判完并做完：分成两步的话，正好在这中间
// take 记上的那一次引用就会拿到一条已经在收的连接，而它此前已经检查过是活的。
func (p *Pool) reapIfIdle(entry *pooledConn) {
	p.mu.Lock()
	if entry.refs > 0 || entry.dead {
		// 静置期内又被借走了，或者已经收过了。
		p.mu.Unlock()
		return
	}
	slots := p.detachLocked(entry)
	p.mu.Unlock()
	p.finishTeardown(context.Background(), entry, "idle", slots)
}

// revokePort 是「设备说这个端口不再允许转发」的出口：**只**关掉这个端口的 Proxy 并
// 从端口表里摘掉，连接本身与同一条连接上别的端口一点都不动（规格「连接与生命周期」）。
// 在飞的流由 Proxy.Close 以 host_gone 收场，下一次请求重新开一个。
//
// 桌面端那一侧的等价物是关掉本机监听；控制台没有监听可关，摘掉这个 Proxy 就是全部。
func (p *Pool) revokePort(entry *pooledConn, port uint32, slot *proxySlot, reason string) {
	p.mu.Lock()
	current, ok := entry.proxies[port]
	if ok && current == slot {
		delete(entry.proxies, port)
	} else {
		slot = nil
	}
	p.mu.Unlock()
	if slot == nil {
		return
	}
	logger.Ctx(context.Background()).Info("port forward mapping revoked by device",
		zap.Int64("userId", entry.key.userID), zap.String("machineFingerprint", entry.key.fingerprint),
		zap.Uint32("port", port), zap.String("reason", reason))
	slot.proxy.Close()
}

// teardown 收掉这条连接：从池里摘掉、关掉它上面每一个 Proxy、放掉连接本身。可重复调用。
func (p *Pool) teardown(ctx context.Context, entry *pooledConn, reason string) {
	p.mu.Lock()
	if entry.dead {
		p.mu.Unlock()
		return
	}
	slots := p.detachLocked(entry)
	p.mu.Unlock()
	p.finishTeardown(ctx, entry, reason, slots)
}

// detachLocked 把这条连接从池里摘干净并交出它上面那些 Proxy。调用方必须握着 p.mu，
// 且必须已经确认 entry 还没死。
func (p *Pool) detachLocked(entry *pooledConn) []*proxySlot {
	entry.dead = true
	p.disarmIdleLocked(entry)
	if current, ok := p.conns[entry.key]; ok && current == entry {
		delete(p.conns, entry.key)
	}
	slots := make([]*proxySlot, 0, len(entry.proxies))
	for _, slot := range entry.proxies {
		slots = append(slots, slot)
	}
	entry.proxies = map[uint32]*proxySlot{}
	return slots
}

// finishTeardown 是收尾里跑在锁外的那一半：退订通知（拿协议引擎的注册面锁）与摘掉
// 中继订阅，都不该压在池这把锁下。
func (p *Pool) finishTeardown(
	ctx context.Context, entry *pooledConn, reason string, slots []*proxySlot,
) {
	close(entry.watch)
	logger.Ctx(ctx).Debug("port forward connection closed",
		zap.Int64("userId", entry.key.userID), zap.String("machineFingerprint", entry.key.fingerprint),
		zap.String("reason", reason))
	for _, slot := range slots {
		slot.proxy.Close()
	}
	if entry.release != nil {
		entry.release()
	}
}

// Stop 收工：关掉手里每一条连接。进程退出前调用，中继上那些订阅当场摘掉。
// 此后 Acquire 一律拒绝。
//
// ctx 是这次收工的**预算**，不只是日志上下文：一条还卡在拨号上的连接可以卡满整个
// 调用预算（缺省 60 秒），无条件等下去就是把整个进程的退出押在它身上。预算用完就
// 不再等——那条连接落地时会自己发现池已经收工并当场收掉自己（见 dial）。
func (p *Pool) Stop(ctx context.Context) {
	p.mu.Lock()
	p.stopped = true
	entries := make([]*pooledConn, 0, len(p.conns))
	for _, entry := range p.conns {
		entries = append(entries, entry)
	}
	p.conns = map[machineKey]*pooledConn{}
	p.mu.Unlock()
	for _, entry := range entries {
		if !waitSettled(ctx, entry) {
			logger.Ctx(ctx).Warn("port forward connection still dialing at shutdown, not waiting",
				zap.Int64("userId", entry.key.userID),
				zap.String("machineFingerprint", entry.key.fingerprint))
			continue
		}
		p.teardown(ctx, entry, "stopped")
	}
}

// waitSettled 等这条连接的拨号落定，最多等到预算用完。
//
// 先做一次不阻塞的判定：预算已经用完时，select 在两个都就绪的分支里是随机挑的，
// 而**已经落定的那些无论如何都该当场收掉**——收它们不需要等任何东西。
func waitSettled(ctx context.Context, entry *pooledConn) bool {
	select {
	case <-entry.ready:
		return true
	default:
	}
	select {
	case <-entry.ready:
		return true
	case <-ctx.Done():
		return false
	}
}
