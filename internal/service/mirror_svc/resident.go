package mirror_svc

import (
	"context"
	"crypto/rand"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// ErrStopped 是在已经收工的 Supervisor 上再要求跟机器。进程正在退出，认领一台机器
// 只会留下一份没人续期的租约。
var ErrStopped = errors.New("mirror supervisor is stopped")

// ErrMachineOffline 是「这台机器现在联系不上」。常驻循环拿它当收工的一个原因；
// 一次性的请求（把删除传到执行端）拿它当答案——调用方据此留一条待办、等机器回来
// 补做，而不是当成一次失败去重试。
var ErrMachineOffline = errors.New("mirror machine is offline")

const (
	defaultLeaseTTL    = 30 * time.Second
	defaultRenewEvery  = 10 * time.Second
	defaultCallTimeout = 15 * time.Second
	// defaultReviveEvery 是「接不上的会话再试一次」的间隔（见 Mirror.Revive）。
	//
	// 它比续期慢得多是**故意**的：这一路问的是「对端那边它复活了吗」，而复活由人
	// 触发（在别处对那条对话发了一条消息），一分钟的延迟对着这件事看不出来。稳态
	// 下它一个请求都不发（全都接上时 Revive 直接返回），所以这个数只决定「卡住的
	// 那些最多晚多久回来」，不决定常态开销。
	defaultReviveEvery = time.Minute
	// liveNoteBuffer 是实时通知在被镜像消化前的缓冲。它满了不会卡住帧总线：溢出的
	// 帧丢掉并排一次重同步，缺口由 pull 按游标补回来（Mirror.Sync 的语义）。
	liveNoteBuffer = 256
	// releaseTimeout 限制收尾里那次 Redis 释放：它跑在连接的收工路径上。
	releaseTimeout = 3 * time.Second
	// clientFingerprintPrefix 只为可读性存在，安全性由长度承担，见 newClientFingerprint。
	clientFingerprintPrefix = "server-mirror:"
)

// Config 是常驻镜像的运行期参数。
type Config struct {
	// InstanceID 必须在每个 server 进程里唯一（bootstrap 已经按 hostname-pid-nanos
	// 造了一个给 relay_svc）。它是租约里的持有者标识，两个副本共用一个值会让彼此
	// 的续期都成功，同一台机器因此被跟两遍。
	InstanceID  string
	LeaseTTL    time.Duration
	RenewEvery  time.Duration
	CallTimeout time.Duration
	// ReviveEvery 是接不上的会话多久再试一次，见 defaultReviveEvery。
	ReviveEvery time.Duration
}

func (c Config) withDefaults() Config {
	if c.LeaseTTL <= 0 {
		c.LeaseTTL = defaultLeaseTTL
	}
	if c.RenewEvery <= 0 {
		c.RenewEvery = defaultRenewEvery
	}
	if c.RenewEvery >= c.LeaseTTL {
		// 续期慢于租约 = 每个周期都在丢租约。
		c.RenewEvery = c.LeaseTTL / 3
	}
	if c.CallTimeout <= 0 {
		c.CallTimeout = defaultCallTimeout
	}
	if c.ReviveEvery <= 0 {
		c.ReviveEvery = defaultReviveEvery
	}
	return c
}

// Supervisor 是一个 server 副本手里那些常驻镜像连接。
//
// 它只回答「已经决定要跟这台机器了，怎么跟住、怎么放手」：认领（多副本部署里同一台
// 机器同一时刻只被一个副本跟）、连上并握手、把实时通知喂进 Mirror、按时续租，以及
// 在租约易主 / 机器下线 / 进程退出时干净地让位。**决定跟哪些机器不在这里**——扫出
// 没人跟的机器是周期任务的事。
type Supervisor struct {
	cfg    Config
	relay  RelayDialer
	signer CredentialSigner
	redis  *goredis.Client
	// fingerprint 是本副本作为中继客户端的对端身份，一个进程一个，见 newClientFingerprint。
	fingerprint string

	mu        sync.Mutex
	followers map[machineKey]*follower
	stopped   bool
}

// machineKey 是一台机器：账号 + 它的设备指纹。租约与连接都按这个粒度。
type machineKey struct {
	userID      int64
	fingerprint string
}

// NewSupervisor 造一个副本的常驻镜像。三个依赖都由装配处注入（DIP）：中继取
// relay_svc.Default()、签名器取 bootstrap 里那把 jwt.Signer（它已经在给 device_svc
// 与 device_ctr 用）、Redis 取 redis.Default()。
func NewSupervisor(cfg Config, relay RelayDialer, signer CredentialSigner, rdb *goredis.Client) *Supervisor {
	return &Supervisor{
		cfg: cfg.withDefaults(), relay: relay, signer: signer, redis: rdb,
		fingerprint: newClientFingerprint(cfg.InstanceID),
		followers:   map[machineKey]*follower{},
	}
}

// newClientFingerprint 造本副本出示给 daemon 的对端指纹。
//
// 它**必须撞不上账号里任何一台真设备的指纹**：撞上了，daemon 就会把镜像这条连接
// 当成那台机器的对端（ResolveSessionPeer 省略 origin 时解出的正是调用方自己），
// 等于替一台真机器签收它的会话。前缀只是给人看的，真正的依据是长度：设备指纹进库
// 的唯一入口 /v1/oauth/device/authorize 把它机械地限制在 128 字符以内
// （internal/api/device/device.go 的 binding），而这里恒长 142，真设备在结构上做不到。
// 浏览器那种不建 devices 行的对端（一个 UUID 客户端 id）同样短得多。
//
// 随机数让「没配 InstanceID」这种装配失误也不至于让两个副本共用一个身份；InstanceID
// 只进哈希、不原样出现，免得把 server 的主机名与 pid 送到每一台 daemon 上。
func newClientFingerprint(instanceID string) string {
	nonce := make([]byte, 32)
	// crypto/rand.Read 从不返回错误（它在取不到熵时直接 panic）。
	_, _ = rand.Read(nonce)
	sum := sha512.Sum512(append([]byte(instanceID+"\x00"), nonce...))
	return clientFingerprintPrefix + hex.EncodeToString(sum[:])
}

// clientFingerprint 是本副本出示给 daemon 的对端指纹。
func (s *Supervisor) clientFingerprint() string { return s.fingerprint }

// Follow 跟住一台机器上那些已保存的对话，幂等。
//
// 返回 false 表示这台机器没被本副本认领——它要么已经被别的副本跟着（正常路径，
// 不是错误），要么根本没有已保存的对话。
//
// saved 是账号此刻在这台机器上保存的全部对话；已经跟着时，名单变了会在**同一条
// 连接**上补一次同步，不重连。
func (s *Supervisor) Follow(ctx context.Context, userID int64, fingerprint string, saved []SavedSession) (bool, error) {
	if len(saved) == 0 {
		// 没有已保存对话的机器不占连接也不占租约：镜像的范围就是账号保存过的那些对话。
		return false, nil
	}
	key := machineKey{userID: userID, fingerprint: fingerprint}
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return false, ErrStopped
	}
	if existing, ok := s.followers[key]; ok {
		s.mu.Unlock()
		existing.want(saved)
		return true, nil
	}
	f := newFollower(s, key, saved)
	// 先占位再干慢活：同一进程里第二次 Follow 因此不会另起一条连接，而认领、握手与
	// 首次补齐都在锁外跑，一台慢机器不会拖住整轮认领。
	s.followers[key] = f
	s.mu.Unlock()

	claimed, err := f.start(ctx)
	if err != nil || !claimed {
		s.forget(key, f)
		return false, err
	}
	return true, nil
}

// dial 建一条通往这台机器的中继客户端连接并完成账号握手：签一张短效凭据、出示本副本
// 的合成指纹。onNotify 收这条连接上的实时通知；只发一次请求的短连接传 nil。
//
// 机器不在线时交出 ErrMachineOffline：调用方（常驻的认领、一次性的删除传播）对这件事
// 的反应各不相同，但都需要把它与「连上了、这一次没成」分开。
func (s *Supervisor) dial(
	ctx context.Context, key machineKey, onNotify func(*agentrewire.RpcNotification),
) (*machineConn, error) {
	// pfp 是这枚凭据说了算的**对端身份**（决策 8）：对端从已验签凭据里取它，
	// AuthAccountRequest 已经没有可以自报身份的字段了。不签它，新版 agentred 会以
	// ErrUnauthorized 拒掉这条常驻镜像连接——整条镜像链路当场断掉。
	credential, _, err := s.signer.Sign(
		jwt.Claims{UID: key.userID, Kind: relayClientKind, PFP: s.clientFingerprint()},
		credentialTTL)
	if err != nil {
		return nil, fmt.Errorf("sign mirror relay credential: %w", err)
	}
	if onNotify == nil {
		onNotify = func(*agentrewire.RpcNotification) {}
	}
	conn, err := dialMachine(ctx, s.relay, credential,
		key, s.cfg.CallTimeout, onNotify)
	if err != nil {
		if errors.Is(err, relay_svc.ErrDaemonOffline) {
			return nil, ErrMachineOffline
		}
		return nil, err
	}
	return conn, nil
}

// forgetSession 让本副本这条连接不再镜像某一条对话。删除路径在清库之前调它——
// 只清库不摘，下一帧就把刚删掉的内容写回来了。本副本没跟着这台机器时什么都不做：
// 跟着它的那个副本会在自己下一轮同步时按保存名单收敛。
func (s *Supervisor) forgetSession(userID int64, fingerprint, conversationID string) {
	s.mu.Lock()
	f := s.followers[machineKey{userID: userID, fingerprint: fingerprint}]
	s.mu.Unlock()
	if f != nil {
		f.drop(SavedSession{ConversationID: conversationID})
	}
}

// Unfollow 放开一台机器：摘掉连接并交还租约，让别的副本立刻接得上。巡检在这台机器
// 已经不承载任何已保存对话时调它（Reconciler.releaseEmptyMachines）。
func (s *Supervisor) Unfollow(ctx context.Context, userID int64, fingerprint string) {
	key := machineKey{userID: userID, fingerprint: fingerprint}
	s.mu.Lock()
	f := s.followers[key]
	delete(s.followers, key)
	s.mu.Unlock()
	if f != nil {
		f.shutdown(ctx)
	}
}

// Stop 收工：放开手里每一台机器。进程退出前调用，租约当场让出，接手的副本不必等
// 一整个 TTL。此后 Follow 一律拒绝。
func (s *Supervisor) Stop(ctx context.Context) {
	s.mu.Lock()
	s.stopped = true
	followers := make([]*follower, 0, len(s.followers))
	for _, f := range s.followers {
		followers = append(followers, f)
	}
	s.followers = map[machineKey]*follower{}
	s.mu.Unlock()
	// 锁已经放开：收尾要等各自的循环退出，而那些循环的收尾会回头调 forget。
	for _, f := range followers {
		f.shutdown(ctx)
	}
}

// followedMachines 交出本副本此刻跟着的每一台机器。巡检据此认出那些「已经不承载
// 任何已保存对话」的机器并放开它们（Reconciler.releaseEmptyMachines）。
func (s *Supervisor) followedMachines() []machineKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]machineKey, 0, len(s.followers))
	for key := range s.followers {
		out = append(out, key)
	}
	return out
}

// follows 报告这台机器此刻是不是由本副本跟着。
func (s *Supervisor) follows(userID int64, fingerprint string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.followers[machineKey{userID: userID, fingerprint: fingerprint}]
	return ok
}

// forget 只在登记的还是这一位时才摘掉：同一台机器可能已经被重新跟起来了。
func (s *Supervisor) forget(key machineKey, f *follower) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.followers[key]; ok && current == f {
		delete(s.followers, key)
	}
}

// follower 是本副本对一台机器的那份常驻：一条连接、一份租约、一个 Mirror。
type follower struct {
	ctx    context.Context
	sup    *Supervisor
	key    machineKey
	lease  *machineLease
	conn   *machineConn
	mirror *Mirror

	notes  chan liveNote
	resync chan struct{}
	stop   chan struct{}
	done   chan struct{}

	mu      sync.Mutex
	saved   []SavedSession
	running bool
	closed  bool
}

type liveNote struct {
	payload *agentrewire.RpcNotification
}

func newFollower(sup *Supervisor, key machineKey, saved []SavedSession) *follower {
	return &follower{
		ctx:   context.Background(),
		sup:   sup,
		key:   key,
		lease: newMachineLease(sup.redis, sup.cfg.InstanceID, key, sup.cfg.LeaseTTL),
		saved: append([]SavedSession(nil), saved...),
		notes: make(chan liveNote, liveNoteBuffer),
		// resync 只有一个槽位：排队期间再来的重同步请求自然合并成一次。
		resync: make(chan struct{}, 1),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
}

// start 认领、连上、补齐，然后把常驻循环跑起来。任何一步没成，这台机器上不留下
// 任何痕迹——租约交还、通道摘掉。
func (f *follower) start(ctx context.Context) (bool, error) {
	f.ctx = ctx
	claimed, err := f.lease.acquire(ctx)
	if err != nil {
		return false, err
	}
	if !claimed {
		// 别的副本正跟着它。正常路径，不打日志、不报错。
		return false, nil
	}
	conn, err := f.sup.dial(ctx, f.key, f.enqueue)
	if err != nil {
		f.releaseLease(ctx)
		return false, err
	}
	f.conn = conn
	// Mirror 的第三个身份参数是「这条连接通到哪台机器」，只在对端省略 origin 时用得上。
	// 真 daemon 在账号鉴权的连接上会给每一行都标上发起端指纹（它只对调用方自己那台
	// 省略，而这条连接的合成指纹撞不上任何真设备），所以那条回落实际上不会触发——
	// 镜像的身份因此总是对端明说的发起端，正是决策 17 要的。
	mirror := New(f.key.userID, f.key.fingerprint, conn)
	// 挂在锁下：删除路径要在这条连接上摘掉一条对话（drop），它跑在别的 goroutine 上。
	f.mu.Lock()
	f.mirror = mirror
	f.mu.Unlock()
	if err := mirror.Sync(ctx, f.savedNow()); err != nil {
		conn.Close()
		f.releaseLease(ctx)
		return false, err
	}

	f.mu.Lock()
	if f.closed {
		// 起来之前就被叫停了（进程正在退出）。
		f.mu.Unlock()
		conn.Close()
		f.releaseLease(ctx)
		return false, nil
	}
	f.running = true
	f.mu.Unlock()
	logger.Ctx(ctx).Info("mirror machine followed",
		zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
		zap.String("instanceId", f.sup.cfg.InstanceID))
	// 循环活得比这次调用久：ctx 的取消不该把常驻连接一起带走，但它携带的日志上下文
	// 要留着。
	go f.run(context.WithoutCancel(ctx))
	return true, nil
}

// run 是这台机器的常驻循环：消化实时通知、按需重同步、按时续租。
//
// 一条 goroutine 干完全部三件事，因此 Apply 与 Sync 天然不并发，实时帧也保持到达
// 顺序（Mirror 要求同一条对话的实时通知按 wire 顺序喂进来）。
func (f *follower) run(ctx context.Context) {
	defer func() {
		f.conn.Close()
		f.releaseLease(ctx)
		f.sup.forget(f.key, f)
		close(f.done)
	}()
	ticker := time.NewTicker(f.sup.cfg.RenewEvery)
	defer ticker.Stop()
	// 「接不上的会话再试一次」自成一档，不搭在续期那只表上：两件事的合适节奏差一个
	// 数量级，共用一只表就得按快的那个跑（见 defaultReviveEvery）。
	revive := time.NewTicker(f.sup.cfg.ReviveEvery)
	defer revive.Stop()
	for {
		select {
		case <-f.stop:
			return
		case note := <-f.notes:
			if err := f.mirrorNow().Apply(ctx, note.payload); err != nil {
				_, _, method := notificationHead(note.payload)
				logger.Ctx(ctx).Warn("mirror live notification not stored, resyncing",
					zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
					zap.String("method", method), zap.Error(err))
				f.requestResync()
			}
		case <-f.resync:
			if err := f.mirrorNow().Sync(ctx, f.savedNow()); err != nil {
				logger.Ctx(ctx).Warn("mirror resync failed",
					zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
					zap.Error(err))
			}
		case <-revive.C:
			// 接不上的那些在这里拿到第二次机会。它跑在同一条 goroutine 上，因此
			// 与 Apply / Sync 天然不并发（这只循环的既定前提）。
			if err := f.mirrorNow().Revive(ctx); err != nil {
				logger.Ctx(ctx).Warn("mirror revive failed",
					zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
					zap.Error(err))
			}
		case <-ticker.C:
			if err := f.keepalive(ctx); err != nil {
				logger.Ctx(ctx).Info("mirror machine released",
					zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
					zap.String("instanceId", f.sup.cfg.InstanceID), zap.Error(err))
				return
			}
		}
	}
}

// keepalive 每轮回答同一个问题：这台机器现在还该由我跟吗。
//
// 答不上来也算否：Redis 出故障时本副本证明不了租约还在自己手里，继续镜像就可能与
// 接手方一起写同一条对话。放手是可逆的（下一轮扫描会有人重新认领），重复镜像不是。
func (f *follower) keepalive(ctx context.Context) error {
	if err := f.lease.renew(ctx); err != nil {
		return err
	}
	online, err := f.sup.relay.IsDaemonOnline(ctx, f.key.userID, f.key.fingerprint)
	if err != nil {
		return fmt.Errorf("check machine presence: %w", err)
	}
	if !online {
		return ErrMachineOffline
	}
	return nil
}

// enqueue 收下一条实时通知。它跑在帧总线的投递路径上，必须立刻返回。
func (f *follower) enqueue(notification *agentrewire.RpcNotification) {
	select {
	case f.notes <- liveNote{payload: notification}:
	default:
		// 积压到缓冲都满了：丢掉这一帧并排一次重同步，缺口按游标 pull 补回来。
		_, _, method := notificationHead(notification)
		logger.Ctx(f.ctx).Warn("mirror live notification dropped, resyncing",
			zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
			zap.String("method", method))
		f.requestResync()
	}
}

func (f *follower) requestResync() {
	select {
	case f.resync <- struct{}{}:
	default: // 已经排着一次了，合并。
	}
}

// want 更新这台机器上的保存名单；变了就排一次重同步，让新保存的对话在同一条连接上
// 跟起来。
func (f *follower) want(saved []SavedSession) {
	f.mu.Lock()
	changed := !sameSavedSet(f.saved, saved)
	if changed {
		f.saved = append([]SavedSession(nil), saved...)
	}
	f.mu.Unlock()
	if changed {
		f.requestResync()
	}
}

// mirrorNow 交出这条连接上的镜像。它只在常驻循环起来之后被调,而那时候 start 已经
// 把它挂好了。
func (f *follower) mirrorNow() *Mirror {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mirror
}

// drop 把一条对话从这台机器的保存名单里摘掉,并让连接上的镜像不再认它 —— 删除
// 之后它的实时帧一个字都不该再落库。
func (f *follower) drop(ref SavedSession) {
	f.mu.Lock()
	kept := make([]SavedSession, 0, len(f.saved))
	for _, s := range f.saved {
		if s == ref {
			continue
		}
		kept = append(kept, s)
	}
	f.saved = kept
	mirror := f.mirror
	f.mu.Unlock()
	if mirror != nil {
		mirror.Forget(ref)
	}
}

func (f *follower) savedNow() []SavedSession {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SavedSession(nil), f.saved...)
}

// shutdown 从外面叫停这一位，并等它的收尾跑完（摘通道、还租约）。可重复调用。
//
// 等待受 ctx 约束：循环正卡在一次慢补齐里时，进程的退出预算不该被它无限期占住。
// 等不及就先走——循环自己仍会跑完收尾，最坏情况是那份租约多留一个 TTL 才让出。
func (f *follower) shutdown(ctx context.Context) {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.closed = true
	running := f.running
	f.mu.Unlock()
	close(f.stop)
	if !running {
		// 循环还没起来：start 会看见 closed，自己把连接与租约收掉。
		return
	}
	select {
	case <-f.done:
	case <-ctx.Done():
	}
}

// releaseLease 交还租约。收尾常常发生在 ctx 已经取消之后（进程退出、请求结束），
// 因此这里自带一个不受它牵连的期限——释放不掉就只能等 TTL，接手要多等一轮。
func (f *follower) releaseLease(ctx context.Context) {
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), releaseTimeout)
	defer cancel()
	if err := f.lease.release(releaseCtx); err != nil {
		logger.Ctx(releaseCtx).Warn("mirror machine lease not released",
			zap.Int64("userId", f.key.userID), zap.String("machineFingerprint", f.key.fingerprint),
			zap.Error(err))
	}
}

// sameSavedSet 按集合比较：名单来自一次数据库读，顺序不构成差异。
func sameSavedSet(a, b []SavedSession) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[SavedSession]int, len(a))
	for _, s := range a {
		seen[s]++
	}
	for _, s := range b {
		seen[s]--
		if seen[s] < 0 {
			return false
		}
	}
	return true
}
