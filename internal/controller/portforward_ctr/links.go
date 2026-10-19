package portforward_ctr

import (
	"context"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/api/portforwardlink"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
)

// LinkAllocator 是「按 (账号, 设备, 映射 id) 幂等分配一个转发前缀」这一件事（ISP）。
// 实现是 portforward_svc.Links。
type LinkAllocator interface {
	Link(ctx context.Context, userID, deviceID, mappingID int64) (*portforward_svc.Link, error)
}

// Links 是 /v1/port-forwards/links 的控制器（spec「地址与路由」的「分配前缀」）。
type Links struct {
	devices DeviceLookup
	links   LinkAllocator
}

// NewLinks 装配控制器。devices 复用 Forward 控制器同一个窄接口（DeviceLookup），
// 保证「设备不是这个账号的 / 已撤销 / 不存在」三种情形答同一个 404——与 /fw/
// 今天的口径相同（spec「分配前缀」）。
func NewLinks(devices DeviceLookup, links LinkAllocator) *Links {
	return &Links{devices: devices, links: links}
}

// Create 对自己名下的一台设备、一条映射 id 分配（或复用）一个转发前缀。
func (l *Links) Create(c *gin.Context, req *portforwardlink.CreateRequest) (*portforwardlink.CreateResponse, error) {
	ctx := c.Request.Context()
	userID, err := ginctx.RequireUserID(c)
	if err != nil {
		return nil, err
	}
	// 归属判定在分配之前：查不到、不归他、已撤销一律 404，不生成、也不查询任何一个
	// 前缀——一个跨账号请求不该在这条路径上留下"这台设备存在"的任何痕迹。
	if _, err := l.devices.OwnedDevice(ctx, userID, req.DeviceID); err != nil {
		return nil, err
	}
	link, err := l.links.Link(ctx, userID, req.DeviceID, req.MappingID)
	if err != nil {
		return nil, err
	}
	return &portforwardlink.CreateResponse{Prefix: link.Prefix, URL: link.URL}, nil
}
