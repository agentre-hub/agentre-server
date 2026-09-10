package portforward_svc

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/protorpc"
)

// ── 测试用的一对内存帧管道 ────────────────────────────────────────────────
//
// 生产上这一对是「协议引擎 ← relayFrameConn → 中继 → daemon」，本包只认引擎那一端
// （*protorpc.Conn）。所以测试造的是同一个接缝：一条真的 protorpc.Conn，底下换成
// 内存管道。上游 portforwardhost 自己那份 pipe_test.go 不导出，刻意不去复用它。

type memFrameConn struct {
	in   chan []byte
	out  chan []byte
	done chan struct{}
	once sync.Once
}

func newFramePipe() (client, device *memFrameConn) {
	toDevice := make(chan []byte, 64)
	toClient := make(chan []byte, 64)
	client = &memFrameConn{in: toClient, out: toDevice, done: make(chan struct{})}
	device = &memFrameConn{in: toDevice, out: toClient, done: make(chan struct{})}
	return client, device
}

func (c *memFrameConn) ReadFrame() ([]byte, error) {
	select {
	case frame := <-c.in:
		return frame, nil
	case <-c.done:
		return nil, io.EOF
	}
}

func (c *memFrameConn) WriteFrame(frame []byte) error {
	select {
	case c.out <- frame:
		return nil
	case <-c.done:
		return protorpc.ErrConnClosed
	}
}

func (c *memFrameConn) Close() error {
	c.once.Do(func() { close(c.done) })
	return nil
}

func (c *memFrameConn) Done() <-chan struct{} { return c.done }

// pending 是「还没被对面消化的帧数」。设备那一侧刻意不跑 Serve，于是收到的每一帧都
// 留在缓冲里可以数——「这次请求到底有没有发到设备上」因此是可断言的。
func (c *memFrameConn) pending() int { return len(c.in) }

// ── 测试用的拨号面 ──────────────────────────────────────────────────────

// stubDial 是一次拨号的产物：两端各一条 protorpc.Conn，以及本端那条连接被收掉没有。
type stubDial struct {
	userID      int64
	fingerprint string
	timeout     time.Duration
	ctx         context.Context

	conn      *protorpc.Conn
	transport *memFrameConn
	// device 只用来往本端推通知（撤销）；它不跑 Serve，于是发过去的帧留在缓冲里可数。
	device          *protorpc.Conn
	deviceTransport *memFrameConn

	mu     sync.Mutex
	closed bool
}

func (d *stubDial) isClosed() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.closed
}

type stubDialer struct {
	mu    sync.Mutex
	dials []*stubDial
	err   error
	// delay 让并发的取用真的重叠在同一次拨号上。
	delay time.Duration
	// gate 非 nil 时这次拨号一直卡在里面，直到它被关掉。「收工时还有一次拨号没落定」
	// 只有这样才造得出来——delay 是个定数，等出来的是同一件事的一个特例。
	gate chan struct{}
	// entered 在拨号真的进到里面时收到一下，于是用例不必靠 sleep 去猜它开始了没有。
	entered chan struct{}
	// callTimeout 压掉引擎的兜底预算，免得一次没人应答的调用把用例拖住。
	callTimeout time.Duration
}

func (d *stubDialer) DialPortForward(
	ctx context.Context, userID int64, fingerprint string, timeout time.Duration,
) (*protorpc.Conn, func(), error) {
	d.mu.Lock()
	failure, delay, callTimeout := d.err, d.delay, d.callTimeout
	gate, entered := d.gate, d.entered
	d.mu.Unlock()
	if entered != nil {
		select {
		case entered <- struct{}{}:
		default:
		}
	}
	if gate != nil {
		<-gate
	}
	if delay > 0 {
		time.Sleep(delay)
	}
	if failure != nil {
		return nil, nil, failure
	}
	if callTimeout <= 0 {
		callTimeout = 50 * time.Millisecond
	}
	clientTransport, deviceTransport := newFramePipe()
	conn := protorpc.NewConn(clientTransport, protorpc.NewRegistry(), protorpc.WithCallTimeout(callTimeout))
	go conn.Serve(context.Background())
	dial := &stubDial{
		userID: userID, fingerprint: fingerprint, timeout: timeout, ctx: ctx,
		conn: conn, transport: clientTransport,
		device:          protorpc.NewConn(deviceTransport, protorpc.NewRegistry()),
		deviceTransport: deviceTransport,
	}
	d.mu.Lock()
	d.dials = append(d.dials, dial)
	d.mu.Unlock()
	return conn, func() {
		dial.mu.Lock()
		dial.closed = true
		dial.mu.Unlock()
		_ = conn.Close()
	}, nil
}

func (d *stubDialer) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.dials)
}

func (d *stubDialer) at(i int) *stubDial {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.dials[i]
}

const (
	testUserID = int64(7)
	testFP     = "fp-machine"
)

func newTestPool(t *testing.T, dialer MachineDialer, idle time.Duration) *Pool {
	t.Helper()
	pool := New(Config{IdleTimeout: idle}, dialer)
	t.Cleanup(func() { pool.Stop(context.Background()) })
	return pool
}

// ── 目标一：同一账号对同一台设备的并发请求共用一条已握手的连接 ─────────────

func TestPool_ConcurrentAcquire_SharesOneConnection(t *testing.T) {
	dialer := &stubDialer{delay: 20 * time.Millisecond}
	pool := newTestPool(t, dialer, time.Minute)

	const callers = 8
	handlers := make([]http.Handler, callers)
	releases := make([]func(), callers)
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			handler, release, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
			require.NoError(t, err)
			handlers[i], releases[i] = handler, release
		}()
	}
	wg.Wait()

	require.Equal(t, 1, dialer.count(), "同一台设备上的并发取用只该拨一次")
	for i := 1; i < callers; i++ {
		require.Equal(t, handlers[0], handlers[i], "同一个端口上的并发取用共用同一个 Proxy")
	}
	for _, release := range releases {
		release()
	}
}

func TestPool_DifferentMachines_DoNotShareAConnection(t *testing.T) {
	dialer := &stubDialer{}
	pool := newTestPool(t, dialer, time.Minute)

	_, releaseA, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	defer releaseA()
	// 同一台机器、另一个账号：池的键是（账号, 设备），跨账号不共用连接。
	_, releaseB, err := pool.Acquire(context.Background(), testUserID+1, testFP, 3000)
	require.NoError(t, err)
	defer releaseB()

	require.Equal(t, 2, dialer.count())
}

// ── 目标二：引用计数归零并静置一段时间后连接被关掉 ─────────────────────────

func TestPool_IdleAfterLastRelease_ClosesTheConnection(t *testing.T) {
	dialer := &stubDialer{}
	pool := newTestPool(t, dialer, 40*time.Millisecond)

	_, releaseOne, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	_, releaseTwo, err := pool.Acquire(context.Background(), testUserID, testFP, 4000)
	require.NoError(t, err)
	require.Equal(t, 1, dialer.count())

	releaseOne()
	// 还有一位借着：静置期根本没开始，连接必须还在。
	time.Sleep(80 * time.Millisecond)
	require.False(t, dialer.at(0).isClosed(), "还有引用时不该回收")

	releaseTwo()
	require.Eventually(t, dialer.at(0).isClosed, time.Second, 5*time.Millisecond,
		"引用归零并静置之后连接该被关掉")

	// 关掉之后再来请求就重拨。
	_, release, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	defer release()
	require.Equal(t, 2, dialer.count())
}

func TestPool_ReacquireWithinIdleWindow_ReusesTheConnection(t *testing.T) {
	dialer := &stubDialer{}
	pool := newTestPool(t, dialer, time.Minute)

	handler, release, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	release()

	again, releaseAgain, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	defer releaseAgain()

	require.Equal(t, 1, dialer.count(), "静置期内又来请求就复用，不重拨")
	require.Equal(t, handler, again)
	require.False(t, dialer.at(0).isClosed())
}

// ── 目标三：连接断了之后下一次请求重新拨 ───────────────────────────────────

func TestPool_ConnectionDied_NextAcquireRedials(t *testing.T) {
	dialer := &stubDialer{}
	pool := newTestPool(t, dialer, time.Minute)

	first, releaseFirst, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	reused, releaseReused, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	require.Equal(t, 1, dialer.count())
	require.Equal(t, first, reused, "断线之前是同一条连接上的同一个 Proxy")
	releaseFirst()
	releaseReused()

	// 中继那一跳没了：底下的帧传输关掉，protorpc.Conn.Done 随之触发。
	require.NoError(t, dialer.at(0).transport.Close())

	require.Eventually(t, func() bool {
		handler, release, acquireErr := pool.Acquire(context.Background(), testUserID, testFP, 3000)
		if acquireErr != nil {
			return false
		}
		release()
		return dialer.count() == 2 && handler != first
	}, time.Second, 5*time.Millisecond, "连接断了之后下一次请求该重新拨")
}

// ── 目标四：onRevoked 只关掉该端口的 Proxy ────────────────────────────────

func TestPool_Revoked_ClosesOnlyThatPortsProxy(t *testing.T) {
	dialer := &stubDialer{}
	pool := newTestPool(t, dialer, time.Minute)

	revoked, releaseRevoked, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	defer releaseRevoked()
	kept, releaseKept, err := pool.Acquire(context.Background(), testUserID, testFP, 4000)
	require.NoError(t, err)
	defer releaseKept()
	require.Equal(t, 1, dialer.count())

	dial := dialer.at(0)
	require.NoError(t, dial.device.Notify(&agentrewire.RpcNotification{
		Payload: &agentrewire.RpcNotification_PortForwardRevoked{
			PortForwardRevoked: &agentrewire.PortForwardRevokedNotification{
				Port: 3000, Reason: "mapping_removed",
			},
		},
	}))

	// 被撤销的那个端口换了一个 Proxy……
	var fresh http.Handler
	require.Eventually(t, func() bool {
		handler, release, acquireErr := pool.Acquire(context.Background(), testUserID, testFP, 3000)
		if acquireErr != nil {
			return false
		}
		release()
		fresh = handler
		return handler != revoked
	}, time.Second, 5*time.Millisecond, "撤销之后这个端口该换一个新的 Proxy")
	require.NotNil(t, fresh)

	// ……而连接本身与别的端口一点都没动。
	require.Equal(t, 1, dialer.count(), "撤销一个端口不该重拨连接")
	require.False(t, dial.isClosed(), "撤销一个端口不该关掉连接")
	sameKept, releaseSameKept, err := pool.Acquire(context.Background(), testUserID, testFP, 4000)
	require.NoError(t, err)
	defer releaseSameKept()
	require.Equal(t, kept, sameKept, "同一条连接上别的端口的 Proxy 原样留着")

	// 被撤销的那个 Proxy 确实**关了**，不只是从表里摘掉：关掉的 Proxy 一个字节都不再
	// 往设备上发，而还活着的那个会真的发出一次 open。
	before := dial.deviceTransport.pending()
	revoked.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	require.Equal(t, before, dial.deviceTransport.pending(), "关掉的 Proxy 不该再往设备上发东西")
	kept.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	require.Greater(t, dial.deviceTransport.pending(), before, "还活着的 Proxy 照常发 open")
}

// ── 连接的寿命不跟着建它的那次请求走 ──────────────────────────────────────

func TestPool_RequestContextCanceled_PooledConnectionSurvives(t *testing.T) {
	dialer := &stubDialer{}
	pool := newTestPool(t, dialer, time.Minute)

	ctx, cancel := context.WithCancel(context.Background())
	handler, release, err := pool.Acquire(ctx, testUserID, testFP, 3000)
	require.NoError(t, err)
	release()
	cancel()

	dial := dialer.at(0)
	// 拨号 ctx 是连接的基座（protorpc.Serve 与中继那一跳的 WriteFrame 都挂在它上面）。
	// 直接把请求 ctx 递下去，第一个请求一结束整条池化连接就死了。
	require.NoError(t, dial.ctx.Err(), "拨号 ctx 不该跟着请求一起被取消")
	_, hasDeadline := dial.ctx.Deadline()
	require.False(t, hasDeadline, "拨号 ctx 不该带期限")

	again, releaseAgain, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	defer releaseAgain()
	require.Equal(t, 1, dialer.count())
	require.Equal(t, handler, again)
}

// ── 拨号失败原样上交 ────────────────────────────────────────────────────

func TestPool_DialFailure_IsReturnedAsIs(t *testing.T) {
	sentinel := errors.New("machine is offline")
	dialer := &stubDialer{err: sentinel}
	pool := newTestPool(t, dialer, time.Minute)

	_, _, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.ErrorIs(t, err, sentinel)

	// 失败不留痕：下一次请求重新拨，而不是一直拿着那个失败答案。
	dialer.mu.Lock()
	dialer.err = nil
	dialer.mu.Unlock()
	_, release, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	defer release()
}

// ── 收工 ───────────────────────────────────────────────────────────────

func TestPool_Stop_ClosesEveryConnection(t *testing.T) {
	dialer := &stubDialer{}
	pool := New(Config{IdleTimeout: time.Minute}, dialer)

	_, releaseA, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.NoError(t, err)
	_, releaseB, err := pool.Acquire(context.Background(), testUserID+1, testFP, 3000)
	require.NoError(t, err)

	pool.Stop(context.Background())

	require.True(t, dialer.at(0).isClosed())
	require.True(t, dialer.at(1).isClosed())
	// 归还在收工之后仍然安全（在飞的请求收尾时才归还）。
	releaseA()
	releaseB()

	_, _, err = pool.Acquire(context.Background(), testUserID, testFP, 3000)
	require.ErrorIs(t, err, ErrStopped)
	require.Equal(t, 2, dialer.count())
}

// Given 收工的时候还有一次拨号卡在半路（真链路上它可以卡到整个调用预算，缺省 60 秒）；
// When 调用方给了一份预算就来收工；Then 预算用完就放手，不把整个进程的退出拖在那一次
// 拨号上——而那条连接落地之后自己发现池已经收工，当场把自己收掉，不留一条悬着的中继订阅。
//
// 少了这一条，internal/task 那份 5 秒收工预算就是一句空话：Stop 拿到的 ctx 只用来记日志。
func TestPool_Stop_GivenAnUnsettledDial_ThenGivesUpWhenTheBudgetRunsOut(t *testing.T) {
	gate := make(chan struct{})
	dialer := &stubDialer{gate: gate, entered: make(chan struct{}, 1)}
	pool := New(Config{IdleTimeout: time.Minute}, dialer)

	acquired := make(chan struct{})
	go func() {
		defer close(acquired)
		_, release, err := pool.Acquire(context.Background(), testUserID, testFP, 3000)
		if err == nil {
			release()
		}
	}()
	select {
	case <-dialer.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("拨号没有开始，这条用例造不出「收工时还卡在拨号上」")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		pool.Stop(ctx)
	}()

	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("收工卡在一次还没落定的拨号上：那份预算根本没人看")
	}

	// 放开那次拨号：它落地时池已经收工，这条连接与它的中继订阅必须当场收掉，
	// 否则「不等」就变成了「泄漏」。
	close(gate)
	<-acquired
	require.Eventually(t, func() bool { return dialer.count() == 1 && dialer.at(0).isClosed() },
		2*time.Second, 5*time.Millisecond, "收工之后才落定的那条连接该自己收掉")
}
