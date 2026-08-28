package mirror_svc

import (
	"context"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 租约照 relay_svc.RegisterDaemon / RenewDaemon 的形状复刻:Redis key 存 InstanceID
// + TTL,续期前先确认持有者还是自己。它**不是** internal/task 的 withPeriodLock ——
// 那把锁只 TryLock 不 Unlock、没有持有者标识、也不续期,跑得久的常驻连接会被第二个
// 副本重复认领,正是本轮要避免的事。

const (
	replicaA = "replica-a"
	replicaB = "replica-b"
)

// leaseRedis 起 miniredis(prior art: internal/task/lock_test.go:20)并清干净 ——
// testutils.Redis() 是进程级单例,同包的用例共用同一个实例。
func leaseRedis(t *testing.T) *goredis.Client {
	t.Helper()
	testutils.Redis()
	rdb := redis.Default()
	require.NoError(t, rdb.FlushAll(context.Background()).Err())
	return rdb
}

func testLease(rdb *goredis.Client, instanceID string, userID int64, fingerprint string) *machineLease {
	return newMachineLease(rdb, instanceID, machineKey{userID: userID, fingerprint: fingerprint}, time.Minute)
}

// Given 副本 A 已经认领了这台机器;When 副本 B 也想认领同一台;
// Then 认不到 —— 同一台机器在任何时刻只被一个副本跟。
func TestMachineLease_SecondReplicaCannotClaimHeldMachine(t *testing.T) {
	rdb := leaseRedis(t)
	ctx := context.Background()

	claimedByA, err := testLease(rdb, replicaA, 7, "fp-daemon-1").acquire(ctx)
	require.NoError(t, err)
	require.True(t, claimedByA)

	claimedByB, err := testLease(rdb, replicaB, 7, "fp-daemon-1").acquire(ctx)

	require.NoError(t, err, "被别人占着不是故障,是正常路径")
	assert.False(t, claimedByB, "两个副本同时跟同一台机器 = 同一条对话被镜像两次")
}

// Given A 持有租约;When A 续期、B 也试着续期;
// Then A 续得上,B 一律失败 —— 续期只认持有者,冒充不了。
func TestMachineLease_RenewOnlyForCurrentHolder(t *testing.T) {
	rdb := leaseRedis(t)
	ctx := context.Background()
	a := testLease(rdb, replicaA, 7, "fp-daemon-1")
	b := testLease(rdb, replicaB, 7, "fp-daemon-1")
	claimed, err := a.acquire(ctx)
	require.NoError(t, err)
	require.True(t, claimed)

	require.NoError(t, a.renew(ctx))
	err = b.renew(ctx)

	require.ErrorIs(t, err, ErrLeaseLost)
	holder, err := rdb.Get(ctx, a.key).Result()
	require.NoError(t, err)
	assert.Equal(t, replicaA, holder, "续期失败的一方不得把租约改到自己名下")
}

// Given 持有租约的副本没了(租约按 TTL 过期);When 另一个副本认领;
// Then 认得到 —— 副本崩了,机器由别人接手。
//
// miniredis 的 TTL 走虚拟时钟、不随真实时间流逝(lock_test.go:38 记的同一条),
// 因此直接删 key 表示「TTL 到期」,与生产里过期后的状态等价。
func TestMachineLease_ExpiredClaimIsTakenOverByAnotherReplica(t *testing.T) {
	rdb := leaseRedis(t)
	ctx := context.Background()
	a := testLease(rdb, replicaA, 7, "fp-daemon-1")
	claimed, err := a.acquire(ctx)
	require.NoError(t, err)
	require.True(t, claimed)
	require.NoError(t, rdb.Del(ctx, a.key).Err())

	claimedByB, err := testLease(rdb, replicaB, 7, "fp-daemon-1").acquire(ctx)

	require.NoError(t, err)
	assert.True(t, claimedByB, "租约过期之后必须有人接得了手,否则这台机器再也没人跟")
}

// Given A 主动收工(进程重启前的正常退出);When A 释放租约;
// Then B 立刻认得到,不用等一整个 TTL。
func TestMachineLease_ReleaseHandsOverImmediately(t *testing.T) {
	rdb := leaseRedis(t)
	ctx := context.Background()
	a := testLease(rdb, replicaA, 7, "fp-daemon-1")
	claimed, err := a.acquire(ctx)
	require.NoError(t, err)
	require.True(t, claimed)

	require.NoError(t, a.release(ctx))

	claimedByB, err := testLease(rdb, replicaB, 7, "fp-daemon-1").acquire(ctx)
	require.NoError(t, err)
	assert.True(t, claimedByB)
}

// Given 租约已经易主给 B(A 那份过期了、B 刚认领);When A 走它的收尾路径释放;
// Then B 的租约纹丝不动 —— 无条件 DEL 会把别人刚抢到的租约删掉,那正是
// 2026-08-07-multi-instance-safety.md 决策 6 点名的缺陷。
func TestMachineLease_ReleaseNeverDropsAnotherHoldersClaim(t *testing.T) {
	rdb := leaseRedis(t)
	ctx := context.Background()
	a := testLease(rdb, replicaA, 7, "fp-daemon-1")
	claimed, err := a.acquire(ctx)
	require.NoError(t, err)
	require.True(t, claimed)
	require.NoError(t, rdb.Del(ctx, a.key).Err()) // A 那份过期
	b := testLease(rdb, replicaB, 7, "fp-daemon-1")
	claimedByB, err := b.acquire(ctx)
	require.NoError(t, err)
	require.True(t, claimedByB)

	require.NoError(t, a.release(ctx))

	holder, err := rdb.Get(ctx, b.key).Result()
	require.NoError(t, err, "B 的租约被别人的收尾删掉了")
	assert.Equal(t, replicaB, holder)
}

// Given 两个账号在各自的机器上用了同一个指纹值;When 一个账号认领;
// Then 另一个账号照样认领得到 —— 租约的粒度是 (user_id, fingerprint)。
func TestMachineLease_ScopedByAccountAndFingerprint(t *testing.T) {
	rdb := leaseRedis(t)
	ctx := context.Background()
	claimed, err := testLease(rdb, replicaA, 7, "fp-daemon-1").acquire(ctx)
	require.NoError(t, err)
	require.True(t, claimed)

	otherAccount, err := testLease(rdb, replicaA, 8, "fp-daemon-1").acquire(ctx)
	require.NoError(t, err)
	assert.True(t, otherAccount, "别的账号那台同名指纹机器与本账号无关")

	otherMachine, err := testLease(rdb, replicaA, 7, "fp-daemon-2").acquire(ctx)
	require.NoError(t, err)
	assert.True(t, otherMachine, "同账号的另一台机器要能各自认领")
}
