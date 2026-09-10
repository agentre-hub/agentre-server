// Package session 提供 Redis-backed 浏览器 session 存储 + cookie 编码。
//
// 数据结构：
//
//	session:<sid>       -> JSON{user_id, csrf_token, created_at, user_agent, ip, last_active_at}
//	user_sessions:<uid> -> SET{sid}，一个账号当前有哪些登录会话
//
// TTL：14 天滑动；每次 Get 重写 session key（顺带记下最后活动时间），并把归集集合的
// TTL 一起推到同样的时刻——集合不能比它收录的会话先过期。
package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/cago-frame/cago/pkg/logger"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// CookieName 是浏览器 session cookie 的名字。
//
// 它不是配置项：这枚 cookie 只由本服务写、也只由本服务读（写在 auth_ctr /
// passkey_ctr，读在 middleware 与各控制器），名字唯一的作用是和自己对上。改它的
// 效果只有一个——所有在线用户当场掉线。
const CookieName = "server_session"

// ipMaxLen 是 IP 的存储宽度，与 device_tokens.ip 的 varchar(45) 同规格：
// 客户端能塞进代理头的东西长度不由我们决定，落存储的宽度必须是个定数。
const ipMaxLen = 45

// uaMaxLen 是 User-Agent 的存储宽度。
//
// 与 IP 同一个理由，只是它更值钱一点：UA 完全由客户端决定，而 net/http 默认允许
// 的请求头总量是 1 MB。不收口的话，一条会话就能在 Redis 上占掉那么多、被滑动 TTL
// 每读一次重写一遍、并且原样出现在 /account 的会话清单上。真实 UA 都在 256 字节
// 以内，512 留了一倍余量，超出的部分对「认出这是哪个浏览器」没有任何贡献。
const uaMaxLen = 512

// Session 是 Redis 中的 session payload。
type Session struct {
	UserID    int64  `json:"userId"`
	CSRFToken string `json:"csrf_token"`
	CreatedAt int64  `json:"created_at"`
	// UserAgent 是建立这次会话时的 User-Agent **原文**：不解析、不归一。
	// 任何 UA 解析都是猜测，猜错会让用户在清单上认错浏览器、撤销掉正在用的那一条。
	UserAgent string `json:"user_agent,omitempty"`
	IP        string `json:"ip,omitempty"`
	// LastActiveAt 是这次会话最后一次被读到的时刻（毫秒），也就是滑动 TTL 的那一刻。
	LastActiveAt int64 `json:"last_active_at,omitempty"`
}

// Client 是建立会话时的客户端信息，由 HTTP 层从请求头取。
type Client struct {
	UserAgent string
	IP        string
}

// Info 是清单里的一条登录会话。
//
// 刻意不复用 Session：那里带着 CSRF token，而清单是要发给浏览器的东西，
// 结构上不给它任何漏出去的机会。
type Info struct {
	SID          string
	UserAgent    string
	IP           string
	CreatedAt    int64
	LastActiveAt int64
}

// Store 封装 Redis session 读写。
type Store struct {
	rc         *goredis.Client
	cookieName string
	ttl        time.Duration
}

// New 构造 store。ttlSeconds 是 session 滑动 TTL 秒数。
func New(rc *goredis.Client, cookieName string, ttlSeconds int) *Store {
	return &Store{rc: rc, cookieName: cookieName, ttl: time.Duration(ttlSeconds) * time.Second}
}

// CookieName 返回配置的 cookie 名。
func (s *Store) CookieName() string { return s.cookieName }

func sessionKey(sid string) string { return "session:" + sid }

// userSessionsKey 是「这个账号有哪些登录会话」的归集键，成员就是 sid 本身。
//
// 成员不带时间戳（与 session_relay_ticket 的手法差别就在这里）：撤销一次会话是直接
// 删 key，不需要算黑名单 TTL；而 session 是滑动 TTL，写进成员的时刻一滑就是错的。
func userSessionsKey(userID int64) string {
	return "user_sessions:" + strconv.FormatInt(userID, 10)
}

// Create 新建 session，返回 sid 与 session payload。
func (s *Store) Create(ctx context.Context, userID int64, client Client) (string, *Session, error) {
	sid, err := randomToken(32)
	if err != nil {
		return "", nil, err
	}
	csrf, err := randomToken(24)
	if err != nil {
		return "", nil, err
	}
	now := time.Now().UnixMilli()
	sess := &Session{
		UserID:       userID,
		CSRFToken:    csrf,
		CreatedAt:    now,
		UserAgent:    truncate(client.UserAgent, uaMaxLen),
		IP:           truncate(client.IP, ipMaxLen),
		LastActiveAt: now,
	}
	body, _ := json.Marshal(sess)
	if err := s.rc.Set(ctx, sessionKey(sid), body, s.ttl).Err(); err != nil {
		return "", nil, err
	}
	// 归集失败就让整次登录失败（fail-closed，与 TrackRelayTicket 同向）：进不了索引的
	// 会话既不会出现在清单里，也永远不会被「登出其它全部」撤掉——那是一次用户自己
	// 看不见、也关不掉的登录。宁可让他重登一次。
	if err := s.index(ctx, userID, sid); err != nil {
		// 已经写进去的 key 没人拿得到（sid 不返回），顺手删掉别让它占 14 天。
		_ = s.rc.Del(ctx, sessionKey(sid)).Err()
		return "", nil, err
	}
	return sid, sess, nil
}

// index 把 sid 收进账号的归集集合，并把集合 TTL 推到与会话同样远。
func (s *Store) index(ctx context.Context, userID int64, sid string) error {
	key := userSessionsKey(userID)
	if err := s.rc.SAdd(ctx, key, sid).Err(); err != nil {
		return err
	}
	return s.rc.Expire(ctx, key, s.ttl).Err()
}

// Get 取 session，命中则刷新 TTL 并记下最后活动时间；未命中返 (nil, nil)。
func (s *Store) Get(ctx context.Context, sid string) (*Session, error) {
	if sid == "" {
		return nil, nil
	}
	sess, err := s.read(ctx, sid)
	if err != nil || sess == nil {
		return nil, err
	}
	// 滑动 TTL：重写整条载荷而不是单发 EXPIRE，同一条命令顺带把「最后活动时间」记上。
	// 集合自身的 TTL 跟着一起滑，否则一条一直在用、TTL 一直被续的会话会在集合到点时
	// 从索引里掉出去，清单和「登出其它全部」从此都看不见它。
	//
	// SADD 不是多余的：滚动发布时，升级前建立的会话根本不在索引里（那时还没有这个
	// 集合），只 EXPIRE 的话它们既不出现在清单上、也扛得过「登出其它全部」——而丢了
	// 笔记本的人按的正是那个按钮。这样每被用到一次就自愈一条，索引与实际登录逐渐收敛。
	//
	// 三条写并成一次 pipeline：这是每个已登录请求都要走的路，多一个往返就是全站的
	// 常态开销。写失败一律忽略（与原先的 EXPIRE 同向）——滑不动 TTL 顶多让这次登录
	// 早一点到期，不该反过来把人从当前请求里踢出去。
	sess.LastActiveAt = time.Now().UnixMilli()
	body, _ := json.Marshal(sess)
	_, _ = s.rc.Pipelined(ctx, func(p goredis.Pipeliner) error {
		// XX：只在 key 还在时写。少了它，另一个副本在这次请求读到载荷之后、写回之前
		// 执行的登出就会被这条 SET 原地复活，「登出其它全部」变成撤不干净。
		p.SetXX(ctx, sessionKey(sid), body, s.ttl)
		p.SAdd(ctx, userSessionsKey(sess.UserID), sid)
		p.Expire(ctx, userSessionsKey(sess.UserID), s.ttl)
		return nil
	})
	return sess, nil
}

// read 读出载荷但**不**碰 TTL。
func (s *Store) read(ctx context.Context, sid string) (*Session, error) {
	val, err := s.rc.Get(ctx, sessionKey(sid)).Bytes()
	if errors.Is(err, goredis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var sess Session
	if err := json.Unmarshal(val, &sess); err != nil {
		return nil, err
	}
	return &sess, nil
}

// Exists 报告 session 是否还在，且**不**滑动 TTL。
//
// 与 Get 的区别就在这一点上：给长连接反复轮询「这次登录还有效吗」用 Get 的话，
// 一条空闲的 websocket 就能把 14 天的滑动 TTL 无限续下去，session 永远不过期。
func (s *Store) Exists(ctx context.Context, sid string) (bool, error) {
	if sid == "" {
		return false, nil
	}
	n, err := s.rc.Exists(ctx, sessionKey(sid)).Result()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ListByUser 列出一个账号当前全部登录会话，最近活动的在前。
//
// 存活判据一律是 session:<sid> 还在不在：滑动 TTL 让集合无法预知成员何时消失，
// 死成员只能在这里当场 SREM 回收，这是它唯一的回收路径。
//
// 全程不滑动任何 TTL——载荷用裸读而不是 Get 取，否则打开一次清单就等于把名下
// 所有会话都续了 14 天，「看一眼」变成了「全部续命」。
func (s *Store) ListByUser(ctx context.Context, userID int64) ([]Info, error) {
	key := userSessionsKey(userID)
	sids, err := s.rc.SMembers(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if len(sids) == 0 {
		return nil, nil
	}
	keys := make([]string, 0, len(sids))
	for _, sid := range sids {
		keys = append(keys, sessionKey(sid))
	}
	vals, err := s.rc.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	list := make([]Info, 0, len(sids))
	var dead []any
	for i, sid := range sids {
		raw, ok := vals[i].(string)
		if !ok { // key 不在了：这次登录已经过期
			dead = append(dead, sid)
			continue
		}
		var sess Session
		if err := json.Unmarshal([]byte(raw), &sess); err != nil {
			// 载荷坏了的会话连鉴权都过不去（Get 会报错），但 key 还在，不能当死成员
			// 摘掉——留着，等它自然过期后由下一次读清单回收。
			logger.Ctx(ctx).Warn("session.ListByUser: 会话载荷无法解析，本条不列出",
				zap.Int64("userId", userID), zap.Error(err))
			continue
		}
		list = append(list, Info{
			SID:          sid,
			UserAgent:    sess.UserAgent,
			IP:           sess.IP,
			CreatedAt:    sess.CreatedAt,
			LastActiveAt: sess.LastActiveAt,
		})
	}
	if len(dead) > 0 {
		if err := s.rc.SRem(ctx, key, dead...).Err(); err != nil {
			// 没摘掉不影响这次结果（死成员已经不在返回里），下次读清单再摘。
			logger.Ctx(ctx).Warn("session.ListByUser: 回收失效会话成员失败",
				zap.Int64("userId", userID), zap.Error(err))
		}
	}
	// 定序，最近活动的在前：集合成员本身是无序的，不排的话同一份清单每次刷新都在跳。
	sort.Slice(list, func(i, j int) bool {
		if list[i].LastActiveAt != list[j].LastActiveAt {
			return list[i].LastActiveAt > list[j].LastActiveAt
		}
		if list[i].CreatedAt != list[j].CreatedAt {
			return list[i].CreatedAt > list[j].CreatedAt
		}
		return list[i].SID < list[j].SID
	})
	return list, nil
}

// Delete 删除 session，并把它从账号的归集集合里摘掉。
func (s *Store) Delete(ctx context.Context, sid string) error {
	if sid == "" {
		return nil
	}
	// 先读出归属账号：集合键里有 uid，删完 key 就再也问不出来了。读不出来（已过期或
	// Redis 出错）不拦着删——删 key 才是登出的实质动作，索引里留下的死成员由
	// ListByUser 回收。
	sess, err := s.read(ctx, sid)
	if err != nil {
		logger.Ctx(ctx).Warn("session.Delete: 读取会话归属账号失败，索引成员留给读清单回收",
			zap.Error(err))
	}
	if err := s.rc.Del(ctx, sessionKey(sid)).Err(); err != nil {
		return err
	}
	if sess != nil {
		if err := s.rc.SRem(ctx, userSessionsKey(sess.UserID), sid).Err(); err != nil {
			// 会话已经删掉了，登出本身已经成功，不因为索引没摘干净把它报成失败。
			logger.Ctx(ctx).Warn("session.Delete: 从账号会话索引摘除失败，留给读清单回收",
				zap.Int64("userId", sess.UserID), zap.Error(err))
		}
	}
	return nil
}

// truncate 按字节上限截断，但落刀点退到最近的**字符**边界上：切出半个 rune 的
// 结果是一段非法 UTF-8，json.Marshal 会把它换成 U+FFFD，于是清单上多出一个乱码
// 尾巴。IP 是 ASCII，这一步对它没有区别。
func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
