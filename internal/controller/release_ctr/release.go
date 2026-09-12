// Package release_ctr 把 release_svc 的判定接到 HTTP：控制器本身不判定「知不知道」，
// 只把服务层已经算好的答案原样落进响应（决策 19：不知道就是不知道，不能借「没有
// version」冒充「已是最新」——这条在服务层已经成立，这里只是不把它弄丢）。
package release_ctr

import (
	"context"

	api "github.com/agentre-hub/agentre-server/internal/api/release"
	"github.com/agentre-hub/agentre-server/internal/service/release_svc"
)

type Release struct{}

func New() *Release { return &Release{} }

func (r *Release) Latest(ctx context.Context, _ *api.LatestRequest) (*api.LatestResponse, error) {
	svc := release_svc.Release()
	if svc == nil {
		// 没装配这个服务的部署（多是测试）：如实回「不知道」，不是把整条请求判成故障
		// ——未装配与「配置关闭」在这里是同一个可观察结果。
		return &api.LatestResponse{Known: false}, nil
	}
	latest, found, err := svc.Latest(ctx)
	if err != nil {
		// 这里的 err 是基础设施故障（比如 Redis 读错），不是「不知道」——两者必须分开：
		// 前者要如实报错，后者才折成 known:false。
		return nil, err
	}
	if !found {
		return &api.LatestResponse{Known: false}, nil
	}
	return &api.LatestResponse{Known: true, Version: latest.Version}, nil
}
