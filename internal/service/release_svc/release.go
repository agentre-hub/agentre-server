// Package release_svc 是「控制台的 latest 从哪来」这件事在服务端的落点（规格
// 2026-09-03-client-upgrade-guidance「控制台呈现与 latest 来源」+ 决策 12、19）：
// 定时向上游拉一次最新发布版本、写进跨副本共享的 Redis 缓存，浏览器再经一个只读端点
// 读到同一份答案。
//
// 这一层刻意只做「最新版是多少」这一件事：不认设备、不写 devices.version、不改协议
// ——那些各自属于别的任务（见规格 T8 的握手写回、T10 的设备卡呈现）。
//
// 「不知道」是一等结果，不是错误的近似。拉取失败、配置被关闭、还没有过一次成功拉取，
// 这三种情形在 Latest 这里折成同一个 found=false，调用方不需要也不能分辨是哪一种
// ——决策 19 要求的是「拿不到就是拿不到」，不能借「没有值」冒充「已是最新」。
package release_svc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// cacheKey 是缓存在 Redis 里的唯一键。所有副本共享同一份：Pull 成功一次，所有副本的
// Latest 立刻看到同一个答案（多副本下不重复拉取、缓存共享 —— 决策 12）。
const cacheKey = "release:latest"

// DefaultCacheTTL 是缺省的缓存存活时间。持续拉取失败会让它自然过期,端点因此在
// 「上一次的旧值」与「不知道」之间只隔这么久,而不是无限期地回答一个可能早已过时
// 的版本号。
const DefaultCacheTTL = time.Hour

// Latest 是一次成功拉取沉淀下来的结果。
type Latest struct {
	// Version 是上游报出的版本号，原样保留（不解析、不比较）——这一层不做「是否可
	// 升级」的判定，那是消费端（桌面端 / 控制台设备卡）拿到自己那台机器的版本后才能
	// 做的事。
	Version string `json:"version"`
	// FetchedAt 是这次拉取成功的时刻，供消费端在需要时判断答案有多新；端点本身不
	// 依赖它做任何决定。
	FetchedAt time.Time `json:"fetched_at"`
}

// Upstream 是「去哪问最新发布版本号」这件事的窄接口。下载源可配置（决策 12：
// 「内网部署可以指向自己的镜像」），因此实现被抽在这背后而不是写死在 Pull 里。
type Upstream interface {
	LatestVersion(ctx context.Context) (string, error)
}

// Config 是这个服务的启动期配置，由 bootstrap.LoadServerConfig 解析、
// bootstrap.RegisterDefaults 装配。
type Config struct {
	// Enabled 为 false 时：Pull 直接返回、不发出任何上游请求；Latest 恒回
	// found=false。这是决策 12 的「可配置关闭」——控制台常部署在内网，浏览器（这里
	// 是服务端自己）未必连得到上游。
	Enabled bool
	// CacheTTL 是缓存值在 Redis 里的存活时间。拉取持续失败时，过期让端点从「上一次
	// 的旧值」自然退回「不知道」，而不是无限期地回答一个可能早已过时的版本号。
	CacheTTL time.Duration
}

// ReleaseSvc 是服务端「最新发布是什么」这件事的唯一出口。
type ReleaseSvc interface {
	// Pull 问一次上游并把结果写进共享缓存。配置关闭时直接返回 nil，不发出请求；
	// 上游失败时把错误原样交回给调用方（crontab 记日志），且不覆盖已有缓存
	// ——半成品答案不该顶掉上一次真正成功的结果。
	Pull(ctx context.Context) error
	// Latest 读缓存里的答案。found=false 涵盖三种情形——配置关闭、还没有一次成功
	// 拉取、缓存已过期——调用方不需要也不能分辨是哪一种。
	Latest(ctx context.Context) (Latest, bool, error)
}

type releaseSvc struct {
	cfg      Config
	upstream Upstream
	rc       *goredis.Client
}

// New 构造 ReleaseSvc。rc 是共享缓存本身——不是给这个进程用的本地缓存，多个副本共用
// 同一个 Redis 才是「缓存共享」这件事成立的原因。
//
// cfg.CacheTTL 为 0 时退回 DefaultCacheTTL——0 会让 Redis 的 SET 变成永不过期，一次
// 拉取失败之后旧答案就再也不会自然退回「不知道」。
func New(cfg Config, upstream Upstream, rc *goredis.Client) ReleaseSvc {
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = DefaultCacheTTL
	}
	return &releaseSvc{cfg: cfg, upstream: upstream, rc: rc}
}

var defaultRelease ReleaseSvc

// Release 返回已装配的服务；未装配时为 nil，调用方（crontab、controller）自行按
// 「不知道」处理，不 panic。
func Release() ReleaseSvc { return defaultRelease }

// SetDefault 装配默认实例，由 bootstrap.RegisterDefaults 调用。
func SetDefault(s ReleaseSvc) { defaultRelease = s }

func (s *releaseSvc) Pull(ctx context.Context) error {
	if !s.cfg.Enabled {
		return nil
	}
	version, err := s.upstream.LatestVersion(ctx)
	if err != nil {
		return fmt.Errorf("fetch latest release: %w", err)
	}
	latest := Latest{Version: version, FetchedAt: time.Now()}
	payload, err := json.Marshal(latest)
	if err != nil {
		return fmt.Errorf("marshal latest release: %w", err)
	}
	if err := s.rc.Set(ctx, cacheKey, payload, s.cfg.CacheTTL).Err(); err != nil {
		return fmt.Errorf("cache latest release: %w", err)
	}
	return nil
}

func (s *releaseSvc) Latest(ctx context.Context) (Latest, bool, error) {
	if !s.cfg.Enabled {
		return Latest{}, false, nil
	}
	raw, err := s.rc.Get(ctx, cacheKey).Result()
	if errors.Is(err, goredis.Nil) {
		return Latest{}, false, nil
	}
	if err != nil {
		return Latest{}, false, err
	}
	var latest Latest
	if err := json.Unmarshal([]byte(raw), &latest); err != nil {
		return Latest{}, false, fmt.Errorf("decode cached latest release: %w", err)
	}
	return latest, true, nil
}
