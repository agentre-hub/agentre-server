package portforward_ctr

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
)

// 这个文件直接调本包的未导出部分（deviceOwnerAndOnline / acquire / acquireFailure /
// answer），不经过任何 gin 路由或 HTTP 客户端；它们在真实路由树上的组合由
// internal/api/portforward 的用例覆盖。

const (
	acqUserID      = int64(7)
	acqDeviceID    = int64(12)
	acqFingerprint = "sha256:fp-agentred-01"
)

// ── 替身 ────────────────────────────────────────────────────────────────

type stubDevices struct {
	device *device_entity.Device
	err    error
}

func (s stubDevices) OwnedDevice(_ context.Context, _, _ int64) (*device_entity.Device, error) {
	return s.device, s.err
}

type stubPresence struct {
	online bool
	err    error
}

func (s stubPresence) IsDaemonOnline(_ context.Context, _ int64, _ string) (bool, error) {
	return s.online, s.err
}

type handlerFunc func(http.ResponseWriter, *http.Request)

func (f handlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) { f(w, r) }

func device() *device_entity.Device {
	return &device_entity.Device{ID: acqDeviceID, UserID: acqUserID, Fingerprint: acqFingerprint}
}

// ── deviceOwnerAndOnline ────────────────────────────────────────────────

func TestDeviceOwnerAndOnline_GivenUnknownDevice_ThenFailureNotFound(t *testing.T) {
	p := New(stubDevices{err: errors.New("not found")}, stubPresence{}, nil)

	got, kind, ok := p.deviceOwnerAndOnline(context.Background(), acqUserID, acqDeviceID)

	assert.False(t, ok)
	assert.Nil(t, got)
	assert.Equal(t, failureNotFound, kind)
}

func TestDeviceOwnerAndOnline_GivenOfflineDevice_ThenFailureOfflineWithoutDialing(t *testing.T) {
	p := New(stubDevices{device: device()}, stubPresence{online: false}, nil)

	got, kind, ok := p.deviceOwnerAndOnline(context.Background(), acqUserID, acqDeviceID)

	assert.False(t, ok)
	assert.NotNil(t, got, "设备本身是真的，只是不在线——归还它，调用方要用它的指纹")
	assert.Equal(t, failureOffline, kind)
}

func TestDeviceOwnerAndOnline_GivenPresenceUnreadable_ThenFailureOffline(t *testing.T) {
	p := New(stubDevices{device: device()}, stubPresence{err: errors.New("redis is down")}, nil)

	_, kind, ok := p.deviceOwnerAndOnline(context.Background(), acqUserID, acqDeviceID)

	assert.False(t, ok)
	assert.Equal(t, failureOffline, kind, "问不到在线态就当它不在线")
}

func TestDeviceOwnerAndOnline_GivenOnlineOwnedDevice_ThenOK(t *testing.T) {
	p := New(stubDevices{device: device()}, stubPresence{online: true}, nil)

	got, _, ok := p.deviceOwnerAndOnline(context.Background(), acqUserID, acqDeviceID)

	assert.True(t, ok)
	require.NotNil(t, got)
	assert.Equal(t, acqFingerprint, got.Fingerprint)
}

// ── acquire：按映射 id、ErrConnectionGone 重试一次 ─────────────────────────

func TestAcquire_GivenNoForwarderConfigured_ThenErrForwarderUnavailable(t *testing.T) {
	p := New(stubDevices{}, stubPresence{}, nil)

	_, _, err := p.acquire(context.Background(), acqUserID, acqFingerprint, 3000)

	require.ErrorIs(t, err, errForwarderUnavailable)
}

func TestAcquire_GivenConnectionGoneOnce_ThenRetriesAndSucceeds(t *testing.T) {
	calls := 0
	app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	forwarder := &countingForwarder{
		onAcquire: func() (http.Handler, func(), error) {
			calls++
			if calls == 1 {
				return nil, nil, portforward_svc.ErrConnectionGone
			}
			return app, func() {}, nil
		},
	}
	p := New(stubDevices{}, stubPresence{}, forwarder)

	handler, release, err := p.acquire(context.Background(), acqUserID, acqFingerprint, 3000)

	require.NoError(t, err)
	require.NotNil(t, release)
	assert.Equal(t, 2, calls, "刚拿到的连接断了：只重试一次")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	assert.Equal(t, http.StatusOK, rec.Code)
}

type countingForwarder struct {
	onAcquire func() (http.Handler, func(), error)
}

func (f *countingForwarder) Acquire(
	_ context.Context, _ int64, _ string, _ int64,
) (http.Handler, func(), error) {
	return f.onAcquire()
}

// ── acquireFailure：借用失败归类 ───────────────────────────────────────────

func TestAcquireFailure_GivenForwarderUnavailable_ThenFailureUnavailable(t *testing.T) {
	got := acquireFailure(context.Background(), acqUserID, acqFingerprint, 3000, errForwarderUnavailable)

	assert.Equal(t, failureUnavailable, got)
}

func TestAcquireFailure_GivenMachineOffline_ThenFailureOffline(t *testing.T) {
	got := acquireFailure(context.Background(), acqUserID, acqFingerprint, 3000, mirror_svc.ErrMachineOffline)

	assert.Equal(t, failureOffline, got, "拨号面与在线判定不过答同一张")
}

func TestAcquireFailure_GivenPoolStopped_ThenFailureUnavailable(t *testing.T) {
	got := acquireFailure(context.Background(), acqUserID, acqFingerprint, 3000, portforward_svc.ErrStopped)

	assert.Equal(t, failureUnavailable, got, "进程正在退出，机器没事，别叫用户去等它")
}

func TestAcquireFailure_GivenSomethingElse_ThenFailureUpstream(t *testing.T) {
	got := acquireFailure(context.Background(), acqUserID, acqFingerprint, 3000, errors.New("protocol version mismatch"))

	assert.Equal(t, failureUpstream, got, "机器在，这一跳没搭起来")
}

// ── answer：页 vs 纯文本，且都是 no-store ──────────────────────────────────

func TestAnswer_GivenFailureOffline_ThenAFullPage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)

	answer(c, failureOffline, ConsoleDevicesURL("https://console.test"))

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/html")
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	assert.Contains(t, rec.Body.String(), "设备离线")
	assert.Contains(t, rec.Body.String(), `href="https://console.test/devices"`)
}

func TestAnswer_GivenFailureNotFound_ThenPlainNotStoreText(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)

	answer(c, failureNotFound, ConsoleDevicesURL("https://console.test"))

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain")
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}
