package user_svc

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
)

// AccountGate 是账号闸门：给定一个**已经通过凭据校验**的 user_id（session cookie 有效、
// device JWT 验签通过、或 relay ticket 验签通过），回答「这个账号现在还能用吗」。
//
// 一处判定，session / device JWT / relay 三条鉴权路径共用；已经建好的中继连接由
// relay_ctr 的逐次复查带着它走。四个中间件各写一遍必然漂移，而这是授权判定。
type AccountGate interface {
	// Check 放行返回 nil，拒绝返回一个带业务码的 401 错误（UserBanned / UserNotFound）。
	Check(ctx context.Context, userID int64) error
}

// DefaultGateCacheTTL 是判定结论的缓存时长，也就是「改库封禁后多久在所有入口失效」的
// 可观察上界。产品里没有封禁动作（consts.BAN 全仓无写入点、只能改库），因此没有封禁
// 事件可挂钩，主动撤销无从触发，只能靠这个短 TTL 收敛。
const DefaultGateCacheTTL = time.Minute

// gateVerdictUsable 是「账号可用」在缓存里的编码。其余取值都是 code.* 业务码本身。
const gateVerdictUsable = 0

type accountGate struct {
	rc  *goredis.Client
	ttl time.Duration
}

// NewGate 构造闸门。ttl 为 0 时退回 DefaultGateCacheTTL——0 会让 Redis 的 SET 变成
// 永不过期，封禁就再也生效不了。
func NewGate(rc *goredis.Client, ttl time.Duration) AccountGate {
	if ttl <= 0 {
		ttl = DefaultGateCacheTTL
	}
	return &accountGate{rc: rc, ttl: ttl}
}

var defaultGate AccountGate

// Gate 返回已装配的闸门；未装配时为 nil，调用方自行决定如何处理。
func Gate() AccountGate { return defaultGate }

// SetGate 装配闸门，由 bootstrap.RegisterDefaults 调用。
func SetGate(g AccountGate) { defaultGate = g }

// gateKey 是判定结论的缓存键。按 user_id 归集：判定只与账号有关，与它此刻用的是哪张
// 凭据无关，因此同一个账号的全部入口共用同一条结论。
func gateKey(userID int64) string { return "account_gate:" + strconv.FormatInt(userID, 10) }

func (g *accountGate) Check(ctx context.Context, userID int64) error {
	if userID == 0 {
		return i18n.NewUnauthorizedError(ctx, code.UserNotFound)
	}
	if verdict, ok := g.cached(ctx, userID); ok {
		return verdictError(ctx, verdict)
	}
	u, err := user_repo.User().FindIgnoreStatus(ctx, userID)
	if err != nil {
		// fail-closed：缓存判不出来、库也判不出来时**拒绝**请求。
		//
		// 这与 auth_svc.WatchRelayCredential 的 fail-open 刻意相反，别顺手统一掉：
		// 那里的复查只是一次**早已生效**的撤销的收尾（session 已删、jti 已拉黑），
		// 抖一下就把全部中继连接踢光，比晚一个心跳才踢差得多；而这里是授权判定
		// 本身——判不出来就放行，等于封禁在 Redis/DB 抖动期间整个失效。
		logger.Ctx(ctx).Warn("user_svc.AccountGate: 账号状态判定失败，按拒绝处理",
			zap.Int64("userId", userID), zap.Error(err))
		return i18n.NewUnauthorizedError(ctx, code.Unauthorized)
	}
	// 不过滤状态取回的账号行交给 user_entity.Check：行不存在给 UserNotFound、
	// status 为封禁给 UserBanned、非 ACTIVE 的其它状态给 UserNotFound。
	verdict := verdictOf(ctx, u)
	g.cache(ctx, userID, verdict)
	return verdictError(ctx, verdict)
}

// cached 读缓存里的判定结论。读失败不算判定失败：回落到查库（ok=false），由 Check
// 决定最终结论——Redis 抖动不该让封禁判定整个失效，也不该把请求全部拒掉。
func (g *accountGate) cached(ctx context.Context, userID int64) (int, bool) {
	val, err := g.rc.Get(ctx, gateKey(userID)).Result()
	switch {
	case err == nil:
	case errors.Is(err, goredis.Nil):
		return 0, false
	default:
		logger.Ctx(ctx).Warn("user_svc.AccountGate: 读账号状态缓存失败，回落查库",
			zap.Int64("userId", userID), zap.Error(err))
		return 0, false
	}
	verdict, err := strconv.Atoi(val)
	if err != nil {
		return 0, false
	}
	return verdict, true
}

// cache 写回判定结论。写失败只记 warn：后果仅仅是下一次判定还得查一次库，判定本身
// 不受影响；查库失败的那条路径**不写缓存**，免得一次抖动把拒绝冻结一整个 TTL。
func (g *accountGate) cache(ctx context.Context, userID int64, verdict int) {
	if err := g.rc.Set(ctx, gateKey(userID), strconv.Itoa(verdict), g.ttl).Err(); err != nil {
		logger.Ctx(ctx).Warn("user_svc.AccountGate: 写账号状态缓存失败，下次判定将再查一次库",
			zap.Int64("userId", userID), zap.Error(err))
	}
}

// verdictOf 把 user_entity.Check 的结论压成一个可缓存的业务码。缓存的是结论而不是
// 账号行：email 一类字段没有理由被复制进 Redis。
func verdictOf(ctx context.Context, u *user_entity.User) int {
	err := u.Check(ctx)
	if err == nil {
		return gateVerdictUsable
	}
	var he *httputils.Error
	if errors.As(err, &he) && he.Code != 0 {
		return he.Code
	}
	return code.Unauthorized
}

func verdictError(ctx context.Context, verdict int) error {
	if verdict == gateVerdictUsable {
		return nil
	}
	// 判定结论一律以 401 出口：凭据本身是有效的，被拒的是账号。
	return i18n.NewUnauthorizedError(ctx, verdict)
}
