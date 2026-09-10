package auth_svc

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
)

func newSvc() AuthSvc {
	return New(redis.Default(), session.New(redis.Default(), "server_session", 86400))
}

func TestOAuthState_Roundtrip(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()
	state, err := s.CreateOAuthState(ctx, OAuthStatePayload{Next: "/device", UserCode: "A4F-7Q2", IP: "1.2.3.4"})
	assert.NoError(t, err)
	assert.NotEmpty(t, state)

	got, err := s.ConsumeOAuthState(ctx, state)
	assert.NoError(t, err)
	assert.Equal(t, "/device", got.Next)
	assert.Equal(t, "A4F-7Q2", got.UserCode)

	again, _ := s.ConsumeOAuthState(ctx, state)
	assert.Nil(t, again)
}

func TestStartSession(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()
	sid, sess, err := s.StartSession(ctx, 42)
	assert.NoError(t, err)
	assert.NotEmpty(t, sid)
	assert.NotEmpty(t, sess.CSRFToken)
	assert.Equal(t, int64(42), sess.UserID)
}

func TestEndSession_BlacklistsTrackedRelayTickets(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()
	const ticketTTL = 2 * time.Minute

	require.NoError(t, s.TrackRelayTicket(ctx, "sid-a", "jti-a1", ticketTTL))
	require.NoError(t, s.TrackRelayTicket(ctx, "sid-a", "jti-a2", ticketTTL))
	require.NoError(t, s.TrackRelayTicket(ctx, "sid-b", "jti-b1", ticketTTL))

	require.NoError(t, s.EndSession(ctx, "sid-a"))

	assert.True(t, jwtblacklist.New(redis.Default()).Has(ctx, "jti-a1"))
	assert.True(t, jwtblacklist.New(redis.Default()).Has(ctx, "jti-a2"))
	// 另一次会话（可能是同账号的另一个浏览器）的票不受牵连
	assert.False(t, jwtblacklist.New(redis.Default()).Has(ctx, "jti-b1"))
	assert.False(t, mini.Exists(relayTicketKey("sid-a")), "撤完票该把归集键清掉")
	assert.True(t, mini.Exists(relayTicketKey("sid-b")))

	// 黑名单必须盖满票的整个可验签窗口（exp+jwt.Leeway），不能比票先过期。
	blacklistTTL := mini.TTL("jwt_blacklist:jti-a1")
	assert.Greater(t, blacklistTTL, ticketTTL)
	assert.LessOrEqual(t, blacklistTTL, ticketTTL+jwt.Leeway)
}

// 没人登出时，归集键跟着票自然过期，不会在 Redis 里按会话越堆越多。
func TestTrackRelayTicket_SetExpiresWithTheTicket(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	require.NoError(t, s.TrackRelayTicket(ctx, "sid-a", "jti-a1", 2*time.Minute))
	require.True(t, mini.Exists(relayTicketKey("sid-a")))

	mini.FastForward(2*time.Minute + jwt.Leeway + time.Second)
	assert.False(t, mini.Exists(relayTicketKey("sid-a")))
}

// 已过可验签窗口的票不再写黑名单：它验签本来就过不了，拉黑只是给 Redis 添垃圾。
func TestEndSession_SkipsRelayTicketsPastTheirWindow(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	// 直接塞一个「窗口在 1 秒前就结束了」的成员，模拟先签发、后来又续过键 TTL 的老票。
	stale := strconv.FormatInt(time.Now().Add(-time.Second).UnixMilli(), 10) + ":jti-stale"
	_, err := mini.SetAdd(relayTicketKey("sid-a"), stale)
	require.NoError(t, err)
	require.NoError(t, s.TrackRelayTicket(ctx, "sid-a", "jti-live", 2*time.Minute))

	require.NoError(t, s.EndSession(ctx, "sid-a"))

	assert.True(t, jwtblacklist.New(redis.Default()).Has(ctx, "jti-live"))
	assert.False(t, jwtblacklist.New(redis.Default()).Has(ctx, "jti-stale"))
}

// 一条已经建好的 client 连接活得比票久得多：票只有 2 分钟，连接可以挂几个小时。
// 归属会话在 upgrade 时解析一次、留在闭包里，票的登记过期之后登出照样撤得掉它。
func TestWatchRelayCredential_SurvivesTicketRegistrationExpiry(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	sid, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	require.NoError(t, s.TrackRelayTicket(ctx, sid, "jti-a", 2*time.Minute))

	revoked := s.WatchRelayCredential(ctx, "jti-a") // upgrade 时解析一次
	assert.False(t, revoked(ctx))

	mini.FastForward(5 * time.Minute) // 票和它的登记都早已过期，连接还开着
	assert.False(t, revoked(ctx))

	require.NoError(t, s.EndSession(ctx, sid))
	assert.True(t, revoked(ctx), "登出必须能撤掉一条比票活得久的连接")
}

// 撤销判据逐凭据独立：登出只撤这次会话签发的票，撤设备只撤那台设备的 jti。
func TestWatchRelayCredential_IsScopedToOneCredential(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	sidA, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	sidB, _, err := s.StartSession(ctx, 7) // 同账号的另一个浏览器
	require.NoError(t, err)
	require.NoError(t, s.TrackRelayTicket(ctx, sidA, "jti-a", 2*time.Minute))
	require.NoError(t, s.TrackRelayTicket(ctx, sidB, "jti-b", 2*time.Minute))

	browserA := s.WatchRelayCredential(ctx, "jti-a")
	browserB := s.WatchRelayCredential(ctx, "jti-b")
	// 原生端用的是设备 JWT，没有归属会话，只看 jti 黑名单。
	deviceOne := s.WatchRelayCredential(ctx, "jti-device-1")
	deviceTwo := s.WatchRelayCredential(ctx, "jti-device-2")

	require.NoError(t, s.EndSession(ctx, sidA))
	// device_svc.Revoke 的既有动作：把该设备已签发的 jti 拉黑。
	require.NoError(t, jwtblacklist.New(redis.Default()).Add(ctx, "jti-device-1", 900))

	assert.True(t, browserA(ctx))
	assert.False(t, browserB(ctx), "登出一个浏览器不能撤掉同账号另一个浏览器的连接")
	assert.True(t, deviceOne(ctx))
	assert.False(t, deviceTwo(ctx), "撤销一台设备不能撤掉同账号另一台设备的连接")
}

// 判不出来就不断连：撤销本身早已生效（session 已删、jti 已拉黑），这里只是收尾；
// 一次 Redis 抖动把全部中继连接一起踢下线，比晚一个心跳才踢差得多。
func TestWatchRelayCredential_FailsOpenWhenRedisIsUnavailable(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	sid, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	require.NoError(t, s.TrackRelayTicket(ctx, sid, "jti-a", 2*time.Minute))
	revoked := s.WatchRelayCredential(ctx, "jti-a")

	mini.Close()
	assert.False(t, revoked(ctx))
}

func TestTrackRelayTicket_RejectsEmptyIdentifiers(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	// sid 取不到时票是撤不掉的，必须让调用方（device_ctr.RelayTicket）失败在签发处。
	assert.Error(t, s.TrackRelayTicket(ctx, "", "jti-a1", time.Minute))
	assert.Error(t, s.TrackRelayTicket(ctx, "sid-a", "", time.Minute))
}

// 「登出其它全部」结束除当前之外的全部会话，并如实返回撤销条数。每一条都走与
// EndSession 相同的顺序：先把它签发、仍在有效期内的 relay ticket 拉黑，再删 session。
func TestEndOtherSessions_EndsOthersKeepsCurrentAndCountsRevoked(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	current, _, err := s.StartSession(ctx, 7, session.Client{UserAgent: "chrome", IP: "203.0.113.1"})
	require.NoError(t, err)
	otherA, _, err := s.StartSession(ctx, 7, session.Client{UserAgent: "firefox", IP: "203.0.113.2"})
	require.NoError(t, err)
	otherB, _, err := s.StartSession(ctx, 7, session.Client{UserAgent: "safari", IP: "203.0.113.3"})
	require.NoError(t, err)
	stranger, _, err := s.StartSession(ctx, 8, session.Client{UserAgent: "chrome", IP: "203.0.113.4"})
	require.NoError(t, err)
	require.NoError(t, s.TrackRelayTicket(ctx, otherA, "jti-other-a", 2*time.Minute))
	require.NoError(t, s.TrackRelayTicket(ctx, current, "jti-current", 2*time.Minute))

	revoked, err := s.EndOtherSessions(ctx, 7, current)
	require.NoError(t, err)
	assert.Equal(t, 2, revoked)

	got, err := s.GetSession(ctx, current)
	assert.NoError(t, err)
	assert.NotNil(t, got, "当前会话不受影响")
	for _, sid := range []string{otherA, otherB} {
		got, err := s.GetSession(ctx, sid)
		assert.NoError(t, err)
		assert.Nil(t, got, "其它会话必须全部结束")
	}
	got, err = s.GetSession(ctx, stranger)
	assert.NoError(t, err)
	assert.NotNil(t, got, "别的账号的会话不该被牵连")

	assert.True(t, jwtblacklist.New(redis.Default()).Has(ctx, "jti-other-a"), "被结束的会话仍有效的中继票必须先拉黑")
	assert.False(t, jwtblacklist.New(redis.Default()).Has(ctx, "jti-current"), "当前会话的票照常可用")

	// 再点一次：只剩当前这一条了，如实返回 0。
	revoked, err = s.EndOtherSessions(ctx, 7, current)
	require.NoError(t, err)
	assert.Equal(t, 0, revoked)
}

// 清单按账号归集，逐条给出 UA / IP / 两个时刻，sid 一并交给调用方去认「哪条是当前」。
func TestListSessions_ReturnsThisAccountsLoginsOnly(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	sid, _, err := s.StartSession(ctx, 11, session.Client{UserAgent: "curl/8.4.0", IP: "203.0.113.7"})
	require.NoError(t, err)
	_, _, err = s.StartSession(ctx, 12, session.Client{UserAgent: "chrome", IP: "203.0.113.8"})
	require.NoError(t, err)

	list, err := s.ListSessions(ctx, 11)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, sid, list[0].SID)
	assert.Equal(t, "curl/8.4.0", list[0].UserAgent)
	assert.Equal(t, "203.0.113.7", list[0].IP)
	assert.Positive(t, list[0].CreatedAt)
	assert.Positive(t, list[0].LastActiveAt)
}
