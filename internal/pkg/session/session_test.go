package session

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
)

func TestCreate_ReturnsSidAndCsrf(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)

	sid, sess, err := store.Create(ctx, 42, Client{})
	assert.NoError(t, err)
	assert.NotEmpty(t, sid)
	assert.NotEmpty(t, sess.CSRFToken)
	assert.Equal(t, int64(42), sess.UserID)
}

func TestGet_RoundTrip(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)

	sid, created, err := store.Create(ctx, 7, Client{})
	assert.NoError(t, err)

	got, err := store.Get(ctx, sid)
	assert.NoError(t, err)
	assert.Equal(t, created.UserID, got.UserID)
	assert.Equal(t, created.CSRFToken, got.CSRFToken)
}

func TestGet_Missing(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)
	got, err := store.Get(ctx, "no-such-sid")
	assert.NoError(t, err)
	assert.Nil(t, got)
}

func TestDelete(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)

	sid, _, err := store.Create(ctx, 1, Client{})
	// 不吞这个错：吞掉的话 sid 是空串，Delete("") 返回 nil、Get("") 返回 nil，
	// 于是一个彻底坏掉的 store 也能让这条用例全绿。
	assert.NoError(t, err)
	assert.NotEmpty(t, sid)
	assert.NoError(t, store.Delete(ctx, sid))
	got, _ := store.Get(ctx, sid)
	assert.Nil(t, got)
}

// Exists 判存在但不续期：长连接反复轮询「这次登录还在吗」时，用 Get 的话一条空闲
// 的 websocket 就能把滑动 TTL 无限续下去，session 永远不过期。
func TestExists_DoesNotSlideTTL(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)

	sid, _, err := store.Create(ctx, 7, Client{})
	assert.NoError(t, err)
	// 人为压短剩余寿命，好看出判定有没有把它推回 14 天。
	assert.NoError(t, redis.Default().Expire(ctx, "session:"+sid, time.Minute).Err())

	alive, err := store.Exists(ctx, sid)
	assert.NoError(t, err)
	assert.True(t, alive)
	assert.LessOrEqual(t, redis.Default().TTL(ctx, "session:"+sid).Val(), time.Minute)

	// 对照：Get 是有意滑动的，这条语义不动。
	_, err = store.Get(ctx, sid)
	assert.NoError(t, err)
	assert.Greater(t, redis.Default().TTL(ctx, "session:"+sid).Val(), time.Minute)

	assert.NoError(t, store.Delete(ctx, sid))
	alive, err = store.Exists(ctx, sid)
	assert.NoError(t, err)
	assert.False(t, alive)
}

// ownRedis 换上一个本测试独享的 miniredis（用完还原），这样才能 FastForward 观察
// TTL 到期，而不污染同包其它用例共用的那一个。
func ownRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	testutils.Redis()
	prev := redis.Default()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	redis.SetDefault(client)
	t.Cleanup(func() {
		redis.SetDefault(prev)
		_ = client.Close()
	})
	return mini
}

// 清单要给出每次登录的 UA 原文、IP 与两个时刻——这是用户认出「哪一条是我现在用的
// 浏览器、哪一条不认识」的全部依据。UA 原样存：任何解析都是猜测，猜错会让用户撤销掉
// 自己正在用的那一条。
func TestListByUser_ReportsClientOfEachLoginSession(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)
	const uid = 4101
	const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0"

	sid, sess, err := store.Create(ctx, uid, Client{UserAgent: ua, IP: "203.0.113.9"})
	assert.NoError(t, err)
	assert.Equal(t, ua, sess.UserAgent)

	list, err := store.ListByUser(ctx, uid)
	assert.NoError(t, err)
	if assert.Len(t, list, 1) {
		assert.Equal(t, sid, list[0].SID)
		assert.Equal(t, ua, list[0].UserAgent)
		assert.Equal(t, "203.0.113.9", list[0].IP)
		assert.Positive(t, list[0].CreatedAt)
		assert.Positive(t, list[0].LastActiveAt)
	}

	// 清单是按账号归集的：别人的登录不该出现在这里。
	other, err := store.ListByUser(ctx, uid+1)
	assert.NoError(t, err)
	assert.Empty(t, other)
}

// IP 按 45 字符存，与 device_tokens.ip 同规格：客户端能塞进 X-Forwarded-For 的东西
// 长度不受我们控制，落库宽度必须是一个定数。
func TestCreate_TruncatesIPToStorageWidth(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)
	const uid = 4102

	long := strings.Repeat("f", 60)
	_, sess, err := store.Create(ctx, uid, Client{IP: long})
	assert.NoError(t, err)
	assert.Len(t, sess.IP, 45)
	assert.Equal(t, strings.Repeat("f", 45), sess.IP)
}

// UA 与 IP 一样是客户端完全可控的一段字节，而 net/http 默认允许的请求头总量是
// 1 MB：不收口就意味着一条会话可以在 Redis 上占掉那么多，滑动 TTL 每被读一次
// 还要把它重写一遍，而它最终会原样出现在 /account 的会话清单上。IP 早就按 45
// 字节收口了，UA 不收就是同一个函数里的两套标准。
func TestCreate_TruncatesAnOversizedUserAgent(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)

	long := strings.Repeat("A", 4096)
	_, sess, err := store.Create(ctx, 4109, Client{UserAgent: long})
	assert.NoError(t, err)
	assert.Len(t, sess.UserAgent, uaMaxLen)
	assert.Equal(t, strings.Repeat("A", uaMaxLen), sess.UserAgent)
}

// 截断按**字符**边界落刀，不许把一个多字节字符劈成两半：切出半个 rune 的结果是
// 一段非法 UTF-8，json.Marshal 会把它换成 U+FFFD，于是清单上出现一个乱码尾巴。
func TestCreate_TruncatedUserAgentStaysValidUTF8(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)

	// 「中」是 3 字节，uaMaxLen 不是 3 的倍数时，按字节切必然切在半个字符上。
	long := strings.Repeat("中", uaMaxLen)
	_, sess, err := store.Create(ctx, 4110, Client{UserAgent: long})
	assert.NoError(t, err)
	assert.True(t, utf8.ValidString(sess.UserAgent), "截断后必须仍是合法 UTF-8")
	assert.LessOrEqual(t, len(sess.UserAgent), uaMaxLen)
}

// 滑动 TTL 让「预设的过期时刻」不可信，集合里的死成员只能在读清单时回收：
// 逐个问 session:<sid> 还在不在，不在的当场 SREM 掉。判活刻意不滑动 TTL，
// 否则打开一次清单就把名下所有会话都续了 14 天。
func TestListByUser_DropsDeadMembersWithoutSlidingTTL(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)
	const uid = 4103

	live, _, err := store.Create(ctx, uid, Client{UserAgent: "live", IP: "203.0.113.1"})
	assert.NoError(t, err)
	dead, _, err := store.Create(ctx, uid, Client{UserAgent: "dead", IP: "203.0.113.2"})
	assert.NoError(t, err)
	// 直接删 key，模拟这条会话自然过期（不走 Delete，否则它自己就把成员摘了）。
	assert.NoError(t, redis.Default().Del(ctx, "session:"+dead).Err())
	// 人为压短剩余寿命，好看出读清单有没有把它推回 14 天。
	assert.NoError(t, redis.Default().Expire(ctx, "session:"+live, time.Minute).Err())

	list, err := store.ListByUser(ctx, uid)
	assert.NoError(t, err)
	if assert.Len(t, list, 1) {
		assert.Equal(t, live, list[0].SID)
	}
	assert.LessOrEqual(t, redis.Default().TTL(ctx, "session:"+live).Val(), time.Minute,
		"判活不能滑动 TTL，否则打开一次清单等于给所有会话续命")
	members, err := redis.Default().SMembers(ctx, "user_sessions:"+strconv.FormatInt(uid, 10)).Result()
	assert.NoError(t, err)
	assert.Equal(t, []string{live}, members, "死成员必须当场 SREM，这是它唯一的回收路径")
}

// 集合自身的 TTL 要随会话活动刷新：否则一条一直在用、TTL 一直被滑动的会话，
// 会在集合到点时从索引里掉出去，清单和「登出其它全部」从此看不见它。
func TestGet_RefreshesIndexTTLSoALongLivedSessionStaysListed(t *testing.T) {
	mini := ownRedis(t)
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 3600)
	const uid = 4104

	sid, _, err := store.Create(ctx, uid, Client{UserAgent: "chrome", IP: "203.0.113.3"})
	assert.NoError(t, err)

	mini.FastForward(50 * time.Minute)
	sess, err := store.Get(ctx, sid) // 一次正常请求：滑动 TTL 的那一刻
	assert.NoError(t, err)
	assert.NotNil(t, sess)
	mini.FastForward(50 * time.Minute)

	sess, err = store.Get(ctx, sid)
	assert.NoError(t, err)
	assert.NotNil(t, sess, "会话本身还活着（前提没变）")
	list, err := store.ListByUser(ctx, uid)
	assert.NoError(t, err)
	assert.Len(t, list, 1, "索引不能比它收录的会话先过期")
}

// 每次会话被读到都记一次最后活动时间：清单上「最后活动」这一列的全部来源。
func TestGet_RecordsLastActivity(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)
	const uid = 4105

	sid, created, err := store.Create(ctx, uid, Client{UserAgent: "chrome", IP: "203.0.113.4"})
	assert.NoError(t, err)
	time.Sleep(2 * time.Millisecond) // 毫秒精度：不等一下两个时刻会相等

	got, err := store.Get(ctx, sid)
	assert.NoError(t, err)
	assert.Greater(t, got.LastActiveAt, created.CreatedAt)
	assert.Equal(t, created.CreatedAt, got.CreatedAt, "创建时间不动")

	list, err := store.ListByUser(ctx, uid)
	assert.NoError(t, err)
	if assert.Len(t, list, 1) {
		assert.Equal(t, got.LastActiveAt, list[0].LastActiveAt, "最后活动时间要真的落到存储里")
	}
}

// 删除会话时顺手 SREM：登出后那一条不该继续挂在索引上。
func TestDelete_RemovesSessionFromUserIndex(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)
	const uid = 4106

	sid, _, err := store.Create(ctx, uid, Client{UserAgent: "chrome", IP: "203.0.113.5"})
	assert.NoError(t, err)
	assert.NoError(t, store.Delete(ctx, sid))

	list, err := store.ListByUser(ctx, uid)
	assert.NoError(t, err)
	assert.Empty(t, list)
	members, err := redis.Default().SMembers(ctx, "user_sessions:"+strconv.FormatInt(uid, 10)).Result()
	assert.NoError(t, err)
	assert.Empty(t, members)
}

// 升级前建立的会话不在索引里（那时还没有这个集合）：它们每被用到一次就自愈补进去。
// 否则滚动发布之后，老用户在清单上看不见自己当前这一条，「登出其它全部」也撤不掉
// 那些老会话——而丢了笔记本的人按的正是那个按钮。
func TestGet_BackfillsIndexForSessionsCreatedBeforeTheIndexExisted(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "server_session", 14*24*3600)
	const uid = 4107

	sid, _, err := store.Create(ctx, uid, Client{UserAgent: "chrome", IP: "203.0.113.6"})
	assert.NoError(t, err)
	// 抹掉索引，模拟升级前留下的会话：session key 在，集合里没有它。
	assert.NoError(t, redis.Default().Del(ctx, "user_sessions:"+strconv.FormatInt(uid, 10)).Err())
	list, err := store.ListByUser(ctx, uid)
	assert.NoError(t, err)
	assert.Empty(t, list, "前提：这条会话此刻确实不在索引里")

	_, err = store.Get(ctx, sid) // 这个浏览器发来的下一个请求
	assert.NoError(t, err)

	list, err = store.ListByUser(ctx, uid)
	assert.NoError(t, err)
	if assert.Len(t, list, 1, "会话每被用到一次就该把自己补回索引") {
		assert.Equal(t, sid, list[0].SID)
	}
}

// deleteAfterGet 在每条 GET 完成之后、调用方拿着载荷写回之前删掉指定的 key，
// 用来把「另一个副本正好在这一刻登出了这条会话」那段窗口钉死成确定性的。
type deleteAfterGet struct {
	killer *goredis.Client
	key    string
}

func (h deleteAfterGet) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (h deleteAfterGet) ProcessPipelineHook(
	next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return next
}

func (h deleteAfterGet) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		err := next(ctx, cmd)
		if cmd.Name() == "get" {
			_ = h.killer.Del(ctx, h.key).Err()
		}
		return err
	}
}

// 「登出其它全部」必须删得掉：被登出的浏览器有一个在途请求时，它的滑动 TTL 写回
// 不能把刚删掉的会话原地复活——否则丢了笔记本的人按下按钮也撤不干净。
func TestGet_DoesNotResurrectASessionDeletedMidRequest(t *testing.T) {
	mini := ownRedis(t)
	ctx := context.Background()
	const uid = 4108
	killer := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = killer.Close() })
	hooked := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = hooked.Close() })
	store := New(hooked, "server_session", 14*24*3600)

	sid, _, err := store.Create(ctx, uid, Client{UserAgent: "chrome", IP: "203.0.113.7"})
	assert.NoError(t, err)
	hooked.AddHook(deleteAfterGet{killer: killer, key: "session:" + sid})

	_, err = store.Get(ctx, sid) // 在途请求：读到了载荷，随后写回
	assert.NoError(t, err)

	alive, err := store.Exists(ctx, sid)
	assert.NoError(t, err)
	assert.False(t, alive, "被登出的会话不能被自己的在途请求复活")
	list, err := store.ListByUser(ctx, uid)
	assert.NoError(t, err)
	assert.Empty(t, list, "它也不该再出现在清单里")
}
