package crontab

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	"github.com/agentre-hub/agentre-server/internal/service/activity_svc"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
)

// ── 假的三个依赖：拨号、在线判定、拉取本体 ──────────────────────────────────

// fakeMachines 记下每一次拨号，并按机器决定这次拨得通拨不通。
type fakeMachines struct {
	mu sync.Mutex
	// dialed 是被拨过的机器指纹，按发生顺序。
	dialed []string
	// dialErr 按指纹给出这次拨号的结果（离线、拨不通）。
	dialErr map[string]error
}

func newFakeMachines() *fakeMachines {
	return &fakeMachines{dialErr: map[string]error{}}
}

func (f *fakeMachines) WithMachine(
	_ context.Context, _ int64, fingerprint string, fn func(mirror_svc.ActivityRollupClient) error,
) error {
	f.mu.Lock()
	f.dialed = append(f.dialed, fingerprint)
	err := f.dialErr[fingerprint]
	f.mu.Unlock()
	if err != nil {
		return err
	}
	return fn(stubRollupClient{fingerprint: fingerprint})
}

func (f *fakeMachines) dialedMachines() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.dialed...)
}

// stubRollupClient 是交给 fn 的那个对端。这一层不发请求，只关心**哪台机器**那条连接
// 被原样带到了 activity_svc.Pull 手里。
type stubRollupClient struct{ fingerprint string }

func (stubRollupClient) ActivityRollup(
	context.Context, *agentrewire.ActivityRollupRequest,
) (*agentrewire.ActivityRollupResponse, error) {
	return &agentrewire.ActivityRollupResponse{}, nil
}

// fakePresence 按指纹回答「这台机器现在在不在线」。
type fakePresence struct {
	offline map[string]bool
	err     map[string]error
}

func newFakePresence() *fakePresence {
	return &fakePresence{offline: map[string]bool{}, err: map[string]error{}}
}

func (f *fakePresence) IsDaemonOnline(_ context.Context, _ int64, fingerprint string) (bool, error) {
	if err := f.err[fingerprint]; err != nil {
		return false, err
	}
	return !f.offline[fingerprint], nil
}

// fakePuller 记下每一次拉取（账号 + 机器），并按机器决定这次拉成没拉成。
type fakePuller struct {
	mu      sync.Mutex
	pulls   []pulledFrom
	pullErr map[string]error
	// peers 是每次拉取拿到的对端，用来确认它真是拨出来那条连接上的。
	peers []activity_svc.ActivityPeer
}

type pulledFrom struct {
	userID      int64
	fingerprint string
}

func newFakePuller() *fakePuller {
	return &fakePuller{pullErr: map[string]error{}}
}

func (f *fakePuller) Pull(
	_ context.Context, userID int64, peer activity_svc.ActivityPeer, peerFingerprint string,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pulls = append(f.pulls, pulledFrom{userID: userID, fingerprint: peerFingerprint})
	f.peers = append(f.peers, peer)
	return f.pullErr[peerFingerprint]
}

func (f *fakePuller) pulled() []pulledFrom {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]pulledFrom(nil), f.pulls...)
}

// ── rig ────────────────────────────────────────────────────────────────────

type activityRig struct {
	settings *mock_user_repo.MockSettingsRepo
	devices  *mock_device_repo.MockDeviceRepo
	machines *fakeMachines
	presence *fakePresence
	puller   *fakePuller
}

func newActivityRig(t *testing.T) *activityRig {
	t.Helper()
	ctrl := gomock.NewController(t)
	settings := mock_user_repo.NewMockSettingsRepo(ctrl)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	user_repo.RegisterSettings(settings)
	device_repo.RegisterDevice(devices)
	t.Cleanup(func() {
		user_repo.RegisterSettings(nil)
		device_repo.RegisterDevice(nil)
	})
	return &activityRig{
		settings: settings, devices: devices,
		machines: newFakeMachines(), presence: newFakePresence(), puller: newFakePuller(),
	}
}

func (r *activityRig) run(ctx context.Context) error {
	return activityRound{
		machines: r.machines, presence: r.presence, puller: r.puller,
	}.run(ctx)
}

func machine(userID int64, fingerprint string) *device_entity.Device {
	return &device_entity.Device{
		UserID: userID, Fingerprint: fingerprint,
		Kind: device_entity.KindAgentred, Status: consts.ACTIVE,
	}
}

// ── 一轮的语义 ─────────────────────────────────────────────────────────────

// Given 一个账号都没开这个开关；When 这一轮到点；Then 一台机器都不拨——
// 关着开关的账号连「你今天干了什么」这个问题都不该被问到：问出去的那一刻，
// 机器就已经把计数交出来了，服务端有没有落库是另一回事。
func TestPullActivityRollups_NobodyOptedIn_DialsNothing(t *testing.T) {
	rig := newActivityRig(t)
	rig.settings.EXPECT().ListEnabledUserIDs(gomock.Any()).Return(nil, nil)

	require.NoError(t, rig.run(context.Background()))
	assert.Empty(t, rig.machines.dialedMachines())
	assert.Empty(t, rig.puller.pulled())
}

// Given 账号名下一台在线、一台离线；When 这一轮到点；
// Then 只拨在线那台，离线那台安静跳过——它回来时下一轮自然被拉到，而它的历史
// 一直躺在它自己机器上，不会因为这一轮没问到就丢。
func TestPullActivityRollups_OfflineMachineIsSkipped(t *testing.T) {
	rig := newActivityRig(t)
	rig.settings.EXPECT().ListEnabledUserIDs(gomock.Any()).Return([]int64{7}, nil)
	rig.devices.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{
		machine(7, "fp-online"), machine(7, "fp-offline"),
	}, nil)
	rig.presence.offline["fp-offline"] = true

	require.NoError(t, rig.run(context.Background()))

	assert.Equal(t, []string{"fp-online"}, rig.machines.dialedMachines())
	assert.Equal(t, []pulledFrom{{userID: 7, fingerprint: "fp-online"}}, rig.puller.pulled())
	assert.Equal(t, []activity_svc.ActivityPeer{stubRollupClient{fingerprint: "fp-online"}},
		rig.puller.peers, "拉取拿到的必须是拨给这台机器的那条连接")
}

// Given 一台已经被撤销的设备；When 这一轮到点；Then 它一次都不被拨——
// 撤销的意思正是「这台机器不再代表这个账号」。
func TestPullActivityRollups_RevokedMachineIsNotDialed(t *testing.T) {
	rig := newActivityRig(t)
	revoked := machine(7, "fp-revoked")
	revoked.Status = consts.DELETE
	rig.settings.EXPECT().ListEnabledUserIDs(gomock.Any()).Return([]int64{7}, nil)
	rig.devices.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{revoked}, nil)

	require.NoError(t, rig.run(context.Background()))
	assert.Empty(t, rig.machines.dialedMachines())
}

// Given 同一个账号下两台在线机器，第一台拉取失败；When 这一轮到点；
// Then 第二台照样被拉到，而那次失败一并上交给调用方记账——一台机器的故障不该
// 让整个账号（乃至整轮）的统计停在昨天。
func TestPullActivityRollups_OneMachineFails_TheOthersStillRun(t *testing.T) {
	rig := newActivityRig(t)
	rig.settings.EXPECT().ListEnabledUserIDs(gomock.Any()).Return([]int64{7}, nil)
	rig.devices.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{
		machine(7, "fp-bad"), machine(7, "fp-good"),
	}, nil)
	broken := errors.New("这台机器答不上来")
	rig.puller.pullErr["fp-bad"] = broken

	err := rig.run(context.Background())

	require.ErrorIs(t, err, broken, "失败要上交，不能被吞成一轮成功")
	assert.Equal(t, []pulledFrom{
		{userID: 7, fingerprint: "fp-bad"}, {userID: 7, fingerprint: "fp-good"},
	}, rig.puller.pulled())
}

// Given 一个账号的机器名单读不出来；When 这一轮到点；
// Then 另一个账号照样跑完，那次失败一并上交。
func TestPullActivityRollups_OneAccountFails_TheOthersStillRun(t *testing.T) {
	rig := newActivityRig(t)
	rig.settings.EXPECT().ListEnabledUserIDs(gomock.Any()).Return([]int64{7, 8}, nil)
	broken := errors.New("库读不出来")
	rig.devices.EXPECT().ListByUser(gomock.Any(), int64(7)).Return(nil, broken)
	rig.devices.EXPECT().ListByUser(gomock.Any(), int64(8)).Return([]*device_entity.Device{
		machine(8, "fp-8"),
	}, nil)

	err := rig.run(context.Background())

	require.ErrorIs(t, err, broken)
	assert.Equal(t, []pulledFrom{{userID: 8, fingerprint: "fp-8"}}, rig.puller.pulled())
}

// Given 一台机器在「问过在线」与「真拨过去」之间下线了；When 这一轮到点；
// Then 它算跳过而不是失败：这个窗口一直存在，把它记成故障只会让日志里每一轮都
// 挂着几条其实什么都没坏的错误。
func TestPullActivityRollups_MachineGoesOfflineWhileDialing_IsSkipped(t *testing.T) {
	rig := newActivityRig(t)
	rig.settings.EXPECT().ListEnabledUserIDs(gomock.Any()).Return([]int64{7}, nil)
	rig.devices.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{
		machine(7, "fp-vanished"),
	}, nil)
	rig.machines.dialErr["fp-vanished"] = mirror_svc.ErrMachineOffline

	require.NoError(t, rig.run(context.Background()))
	assert.Empty(t, rig.puller.pulled())
}

// Given 这个部署没有装配常驻镜像；When 这一轮到点；Then 安静跳过——
// 不 panic，也不每个周期在日志里留一条假故障（照 ReconcileSessionMirrors）。
func TestPullActivityRollups_NotConfigured_IsQuiet(t *testing.T) {
	mirror_svc.SetDefault(nil)

	require.NoError(t, PullActivityRollups(context.Background()))
}
