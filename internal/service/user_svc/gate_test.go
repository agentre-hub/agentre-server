package user_svc

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
)

// setupGate 给闸门一台独享的 miniredis（好 FastForward 观察 TTL 上界）与一个 repo mock。
func setupGate(t *testing.T, ttl time.Duration) (*mock_user_repo.MockUserRepo, *miniredis.Miniredis, AccountGate) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	repo := mock_user_repo.NewMockUserRepo(ctrl)
	user_repo.RegisterUser(repo)
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return repo, mini, NewGate(client, ttl)
}

// errCode 取出闸门拒绝时用的业务码：中间件按它渲染 code/msg/data 信封。
func errCode(t *testing.T, err error) int {
	t.Helper()
	var he *httputils.Error
	require.True(t, errors.As(err, &he), "闸门的拒绝必须是成形的 httputils.Error，实际 %T: %v", err, err)
	return he.Code
}

func TestAccountGate_ActiveAccountPasses(t *testing.T) {
	repo, _, gate := setupGate(t, time.Minute)
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
		Return(&user_entity.User{ID: 7, Status: consts.ACTIVE, Email: "a@b.com"}, nil)

	assert.NoError(t, gate.Check(context.Background(), 7))
}

// 取账号行不过滤状态、交给 user_entity.Check：封禁与「查无此行」因此是两个能分辨的
// 结论，被封用户第一次能读到「用户已被封禁」而不是笼统的「未授权」。
func TestAccountGate_BannedAccountRejectedAsUserBanned(t *testing.T) {
	repo, _, gate := setupGate(t, time.Minute)
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
		Return(&user_entity.User{ID: 7, Status: consts.BAN, Email: "a@b.com"}, nil)

	err := gate.Check(context.Background(), 7)
	require.Error(t, err)
	assert.Equal(t, code.UserBanned, errCode(t, err))
}

func TestAccountGate_MissingAccountRejectedAsUserNotFound(t *testing.T) {
	repo, _, gate := setupGate(t, time.Minute)
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).Return(nil, nil)

	err := gate.Check(context.Background(), 7)
	require.Error(t, err)
	assert.Equal(t, code.UserNotFound, errCode(t, err))
}

// 缓存的是判定结论，不是账号行：email 一类字段不该被复制进 Redis。
func TestAccountGate_CachesVerdictNotTheAccountRow(t *testing.T) {
	repo, mini, gate := setupGate(t, time.Minute)
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
		Return(&user_entity.User{ID: 7, Status: consts.BAN, Email: "a@b.com"}, nil)

	require.Error(t, gate.Check(context.Background(), 7))

	cached, err := mini.Get(gateKey(7))
	require.NoError(t, err)
	assert.NotContains(t, cached, "a@b.com", "缓存里只该有判定结论")
}

// 可观察的生效上界：改库封禁后最多一个 TTL，该账号在所有入口失效。TTL 内不再查库，
// TTL 一到就必须重新查——两条一起钉住，否则「缓存」要么等于没缓存、要么等于永不失效。
func TestAccountGate_VerdictExpiresAfterConfiguredTTL(t *testing.T) {
	const ttl = time.Minute
	repo, mini, gate := setupGate(t, ttl)
	ctx := context.Background()
	gomock.InOrder(
		repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
			Return(&user_entity.User{ID: 7, Status: consts.ACTIVE}, nil),
		repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
			Return(&user_entity.User{ID: 7, Status: consts.BAN}, nil),
	)

	require.NoError(t, gate.Check(ctx, 7))
	require.NoError(t, gate.Check(ctx, 7), "TTL 内的第二次判定该走缓存，不再查库")

	mini.FastForward(ttl + time.Second)

	err := gate.Check(ctx, 7)
	require.Error(t, err, "TTL 过后必须重新查库，改库封禁才会生效")
	assert.Equal(t, code.UserBanned, errCode(t, err))
}

// 读缓存失败回落查库：Redis 抖一下不该让封禁判定整个失效，也不该把请求全部拒掉。
func TestAccountGate_CacheReadFailureFallsBackToDatabase(t *testing.T) {
	repo, mini, gate := setupGate(t, time.Minute)
	mini.SetError("LOADING Redis is loading the dataset in memory")
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
		Return(&user_entity.User{ID: 7, Status: consts.BAN}, nil)

	err := gate.Check(context.Background(), 7)
	require.Error(t, err)
	assert.Equal(t, code.UserBanned, errCode(t, err))
}

func TestAccountGate_CacheReadFailureStillPassesActiveAccount(t *testing.T) {
	repo, mini, gate := setupGate(t, time.Minute)
	mini.SetError("LOADING Redis is loading the dataset in memory")
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
		Return(&user_entity.User{ID: 7, Status: consts.ACTIVE}, nil)

	assert.NoError(t, gate.Check(context.Background(), 7))
}

// 缓存与库都判不出来时拒绝（fail-closed）：这是授权判定本身，判不出来就放行等于
// 封禁在 Redis/DB 抖动期间整个失效。与 WatchRelayCredential 的 fail-open 刻意相反。
func TestAccountGate_DatabaseFailureRejects(t *testing.T) {
	repo, mini, gate := setupGate(t, time.Minute)
	mini.SetError("LOADING Redis is loading the dataset in memory")
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
		Return(nil, errors.New("dial tcp: connection refused"))

	err := gate.Check(context.Background(), 7)
	require.Error(t, err, "缓存与库都判不出来时必须拒绝，不能放行")
	assert.Equal(t, code.Unauthorized, errCode(t, err))
}

// 查库失败不写缓存：否则一次抖动会把「拒绝」冻结一整个 TTL。
func TestAccountGate_DatabaseFailureIsNotCached(t *testing.T) {
	repo, _, gate := setupGate(t, time.Minute)
	ctx := context.Background()
	gomock.InOrder(
		repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
			Return(nil, errors.New("dial tcp: connection refused")),
		repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
			Return(&user_entity.User{ID: 7, Status: consts.ACTIVE}, nil),
	)

	require.Error(t, gate.Check(ctx, 7))
	assert.NoError(t, gate.Check(ctx, 7), "库恢复后下一次判定就该恢复放行")
}
