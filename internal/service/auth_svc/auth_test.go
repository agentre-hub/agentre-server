package auth_svc

import (
	"context"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
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

func TestIssueRelayTicket_ResolvesToTheAccountWebPeerUntilExpiry(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()
	sid, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)

	ticket, err := s.IssueRelayTicket(ctx, sid, 7)
	require.NoError(t, err)
	assert.NotEmpty(t, ticket.Token)
	assert.Equal(t, credstore.AccountPeerFingerprint(7), ticket.PeerFingerprint)
	assert.Equal(t, 2*time.Minute, ticket.ExpiresIn)

	for range 3 {
		got, resolveErr := s.ResolveCredential(ctx, ticket.Token)
		require.NoError(t, resolveErr, "有效期内可以反复核验")
		assert.Equal(t, int64(7), got.AccountID)
		assert.Zero(t, got.DeviceID, "网页不是设备")
		assert.Equal(t, credstore.KindRelayClient, got.Kind)
		assert.Equal(t, ticket.PeerFingerprint, got.PeerFingerprint)
		assert.NotEmpty(t, got.Handle)
		assert.Greater(t, got.ExpiresAt, time.Now().UnixMilli())
	}

	mini.FastForward(2*time.Minute + time.Second)
	_, err = s.ResolveCredential(ctx, ticket.Token)
	assert.ErrorIs(t, err, device_svc.ErrBearerInvalid, "过期的票与未知的票同一个结论")
}

// 票的撤销挂在签发它的会话上：取不到会话就发不出票，而不是发一张登出撤不掉的票。
func TestIssueRelayTicket_RejectsMissingSession(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	_, err := s.IssueRelayTicket(ctx, "", 7)
	assert.Error(t, err)
}

// S4：登出之后，这次会话换出的票据立即失效；同账号另一个浏览器的票不受牵连。
func TestEndSession_InvalidatesTicketsIssuedByThatSession(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()
	sidA, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	sidB, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	ticketA, err := s.IssueRelayTicket(ctx, sidA, 7)
	require.NoError(t, err)
	ticketB, err := s.IssueRelayTicket(ctx, sidB, 7)
	require.NoError(t, err)

	require.NoError(t, s.EndSession(ctx, sidA))

	_, err = s.ResolveCredential(ctx, ticketA.Token)
	assert.ErrorIs(t, err, device_svc.ErrBearerInvalid, "登出后仍在有效期内的票必须立即失效")
	_, err = s.ResolveCredential(ctx, ticketB.Token)
	assert.NoError(t, err, "另一个浏览器的会话没有登出，它的票不该被牵连")
}

// server 自用凭据从同一份存储解析，带着它自己的类型与对端身份，不挂在任何会话上。
func TestResolveCredential_ServerCredentialKeepsItsOwnKind(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	token, err := credstore.New(redis.Default()).IssueServerMirror(ctx, 7, "server-mirror:replica-a")
	require.NoError(t, err)

	got, err := s.ResolveCredential(ctx, token)
	require.NoError(t, err)
	assert.Equal(t, int64(7), got.AccountID)
	assert.Equal(t, credstore.KindServerMirror, got.Kind)
	assert.Equal(t, "server-mirror:replica-a", got.PeerFingerprint)
}

func TestResolveCredential_UnknownIsInvalid(t *testing.T) {
	testutils.Redis(t)
	s := newSvc()

	_, err := s.ResolveCredential(context.Background(), "never-issued")
	assert.ErrorIs(t, err, device_svc.ErrBearerInvalid)
	_, err = s.ResolveCredential(context.Background(), "")
	assert.ErrorIs(t, err, device_svc.ErrBearerInvalid)
}

// Redis 不可用时判不出来，这不是「票无效」：错误要让调用方认得出，由它 fail-closed。
func TestResolveCredential_RedisUnavailableIsUnverifiable(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()
	sid, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	ticket, err := s.IssueRelayTicket(ctx, sid, 7)
	require.NoError(t, err)

	mini.Close()

	_, err = s.ResolveCredential(ctx, ticket.Token)
	assert.ErrorIs(t, err, ErrCredentialUnverifiable)
	assert.NotErrorIs(t, err, device_svc.ErrBearerInvalid)
	_, err = s.IssueRelayTicket(ctx, sid, 7)
	assert.Error(t, err, "记不下来就不发票")
}

// 一条已经建好的 client 连接活得比票久得多：票只有 2 分钟，连接可以挂几个小时。
// 归属会话在 upgrade 时解析一次、留在闭包里，票过期之后登出照样撤得掉它。
func TestWatchRelayCredential_SurvivesTicketExpiry(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	sid, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	ticket, err := s.IssueRelayTicket(ctx, sid, 7)
	require.NoError(t, err)
	p, err := s.ResolveCredential(ctx, ticket.Token)
	require.NoError(t, err)

	revoked := s.WatchRelayCredential(ctx, p.Handle) // upgrade 时解析一次
	assert.False(t, revoked(ctx))

	mini.FastForward(5 * time.Minute) // 票早已过期，连接还开着
	assert.False(t, revoked(ctx))

	require.NoError(t, s.EndSession(ctx, sid))
	assert.True(t, revoked(ctx), "登出必须能撤掉一条比票活得久的连接")
}

// 撤销判据逐会话独立：登出一个浏览器只撤它自己的连接。
func TestWatchRelayCredential_IsScopedToTheIssuingSession(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	sidA, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	sidB, _, err := s.StartSession(ctx, 7) // 同账号的另一个浏览器
	require.NoError(t, err)
	browserA := watchTicket(t, s, sidA)
	browserB := watchTicket(t, s, sidB)

	require.NoError(t, s.EndSession(ctx, sidA))

	assert.True(t, browserA(ctx))
	assert.False(t, browserB(ctx), "登出一个浏览器不能撤掉同账号另一个浏览器的连接")
}

// 句柄在 upgrade 时已经查不到记录（票刚被撤、或根本不是这里签的），这条连接没有任何
// 可以复查的依据，按已撤销处理。
func TestWatchRelayCredential_UnknownHandleIsRevoked(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	assert.True(t, s.WatchRelayCredential(ctx, "no-such-handle")(ctx))
	assert.True(t, s.WatchRelayCredential(ctx, "")(ctx))
}

// 判不出来就不断连：撤销本身早已生效（session 已删），这里只是收尾；一次 Redis 抖动
// 把全部中继连接一起踢下线，比晚一个心跳才踢差得多。
func TestWatchRelayCredential_FailsOpenWhenRedisIsUnavailable(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()
	s := newSvc()

	sid, _, err := s.StartSession(ctx, 7)
	require.NoError(t, err)
	revoked := watchTicket(t, s, sid)

	mini.Close()
	assert.False(t, revoked(ctx))
}

func watchTicket(t *testing.T, s AuthSvc, sid string) RelayCredentialWatch {
	t.Helper()
	ctx := context.Background()
	ticket, err := s.IssueRelayTicket(ctx, sid, 7)
	require.NoError(t, err)
	p, err := s.ResolveCredential(ctx, ticket.Token)
	require.NoError(t, err)
	return s.WatchRelayCredential(ctx, p.Handle)
}

// 「登出其它全部」结束除当前之外的全部会话，并如实返回撤销条数。被结束的会话换出的
// relay ticket 随之失效，与 EndSession 同一个结论。
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
	otherTicket, err := s.IssueRelayTicket(ctx, otherA, 7)
	require.NoError(t, err)
	currentTicket, err := s.IssueRelayTicket(ctx, current, 7)
	require.NoError(t, err)

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

	_, err = s.ResolveCredential(ctx, otherTicket.Token)
	assert.ErrorIs(t, err, device_svc.ErrBearerInvalid, "被结束的会话仍在有效期内的中继票必须失效")
	_, err = s.ResolveCredential(ctx, currentTicket.Token)
	assert.NoError(t, err, "当前会话的票照常可用")

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
