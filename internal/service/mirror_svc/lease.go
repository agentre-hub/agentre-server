package mirror_svc

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// ErrLeaseLost 表示这份租约已经不在自己名下：过期了，或者已经被别的副本接手。
// 拿到它的唯一正确反应是收工——继续镜像等于和接手方一起写同一条对话。
var ErrLeaseLost = errors.New("mirror machine lease lost")

// machineLease 是「(账号, 机器) 此刻归哪个副本跟」这一件事在 Redis 上的表示。
//
// 形状照 relay_svc.RegisterDaemon / RenewDaemon 复刻：一个存着 InstanceID 的 key +
// TTL，续期前先确认持有者还是自己。差别只有认领这一步用 SET NX——daemon 连上来时
// 它自己就是权威，可以无条件覆盖；而副本之间是竞争关系，谁先写进去谁跟。
//
// 不用 internal/task 的 withPeriodLock：那把锁只 TryLock、不 Unlock、没有持有者标识
// 也不续期，靠 TTL 自然过期。周期任务要的正是那个语义，常驻连接要的恰恰相反——一条
// 连接活得比任何合理的 TTL 都久，不续期就会在跑着的时候被第二个副本认领，同一条对话
// 从此被镜像两次。
type machineLease struct {
	redis      *goredis.Client
	key        string
	instanceID string
	ttl        time.Duration
}

// renewIfHeldScript 与 releaseIfHeldScript 都是「先确认是我、再动手」的原子版本。
//
// 分成 GET + EXPIRE / GET + DEL 两步下发是不对的：两步之间租约可能刚好过期并被别的
// 副本认领，于是 EXPIRE 延的、DEL 删的都是**别人**那份。无条件 DEL 会删掉别人刚抢到
// 的租约，正是 2026-08-07-multi-instance-safety.md 决策 6 点名的那个缺陷。
// （Lua 里 GET 一个不存在的 key 返回 false，与任何 ARGV 都不相等，因此天然落到 0。）
var renewIfHeldScript = goredis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`)

var releaseIfHeldScript = goredis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("DEL", KEYS[1])
end
return 0
`)

func newMachineLease(rdb *goredis.Client, instanceID string, m machineKey, ttl time.Duration) *machineLease {
	return &machineLease{redis: rdb, key: machineLeaseKey(m), instanceID: instanceID, ttl: ttl}
}

// machineLeaseKey 的粒度是 (user_id, fingerprint)：同一个指纹值在两个账号下是两台
// 互不相干的机器。指纹按 base64 编码进 key，与 relay_svc.routeKey 同一写法——指纹是
// 设备自报的任意字符串，原样拼进 key 会让含冒号的值撞进别人的命名空间。
func machineLeaseKey(m machineKey) string {
	return fmt.Sprintf("mirror:machine:%d:%s", m.userID,
		base64.RawURLEncoding.EncodeToString([]byte(m.fingerprint)))
}

// acquire 认领这台机器。返回 false 表示别的副本正跟着它——那是正常路径，不是故障。
func (l *machineLease) acquire(ctx context.Context) (bool, error) {
	claimed, err := l.redis.SetNX(ctx, l.key, l.instanceID, l.ttl).Result()
	if err != nil {
		return false, fmt.Errorf("claim mirror machine: %w", err)
	}
	return claimed, nil
}

// renew 续租。持有者已经不是自己时返回 ErrLeaseLost。
func (l *machineLease) renew(ctx context.Context) error {
	renewed, err := renewIfHeldScript.Run(ctx, l.redis,
		[]string{l.key}, l.instanceID, l.ttl.Milliseconds()).Int64()
	if err != nil {
		return fmt.Errorf("renew mirror machine lease: %w", err)
	}
	if renewed == 0 {
		return ErrLeaseLost
	}
	return nil
}

// release 交还租约，让下一个副本立刻接得上，不必等一整个 TTL。租约已经易主时什么都
// 不做——那一份不是自己的。
func (l *machineLease) release(ctx context.Context) error {
	if err := releaseIfHeldScript.Run(ctx, l.redis, []string{l.key}, l.instanceID).Err(); err != nil {
		return fmt.Errorf("release mirror machine lease: %w", err)
	}
	return nil
}
