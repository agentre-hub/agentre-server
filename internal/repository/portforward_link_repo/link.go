// Package portforward_link_repo 是端口转发子域前缀表的数据访问层（规格
// 2026-09-21-port-forward-subdomain「地址与路由」）。
package portforward_link_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"

	"github.com/agentre-hub/agentre-server/internal/model/entity/portforward_link_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source link.go -destination mock_portforward_link_repo/mock_link.go

type PortForwardLinkRepo interface {
	// FindByDeviceMapping 按 (device_id, mapping_id) 查一行，查不到返回 (nil, nil)。
	// 幂等分配的第一步：portforward_svc 先查这一条，命中就直接复用，不生成新的
	// 随机前缀（决策 2：每条映射一个固定前缀）。
	FindByDeviceMapping(ctx context.Context, deviceID, mappingID int64) (*portforward_link_entity.PortForwardLink, error)
	// FindByPrefix 按前缀查一行，查不到返回 (nil, nil)。S4 的 Host 分发从这里把
	// 前缀反查回 (账号, 设备, 映射 id)。
	FindByPrefix(ctx context.Context, prefix string) (*portforward_link_entity.PortForwardLink, error)
	// Create 插入一行新的前缀记录。prefix 或 (device_id, mapping_id) 撞了唯一键时
	// 把 MySQL 的错误原样交回去，由 portforward_svc 按 dberr.IsDuplicateKey 分流
	// 重试——仓储层不猜调用方想怎么处理冲突。
	Create(ctx context.Context, link *portforward_link_entity.PortForwardLink) error
}

var defaultRepo PortForwardLinkRepo

func Link() PortForwardLinkRepo          { return defaultRepo }
func RegisterLink(i PortForwardLinkRepo) { defaultRepo = i }
func NewLink() PortForwardLinkRepo       { return &repo{} }

type repo struct{}

func (r *repo) FindByDeviceMapping(
	ctx context.Context, deviceID, mappingID int64,
) (*portforward_link_entity.PortForwardLink, error) {
	return dbutil.FindOne[portforward_link_entity.PortForwardLink](
		db.Ctx(ctx).Where("device_id=? AND mapping_id=?", deviceID, mappingID))
}

func (r *repo) FindByPrefix(ctx context.Context, prefix string) (*portforward_link_entity.PortForwardLink, error) {
	return dbutil.FindOne[portforward_link_entity.PortForwardLink](db.Ctx(ctx).Where("prefix=?", prefix))
}

func (r *repo) Create(ctx context.Context, link *portforward_link_entity.PortForwardLink) error {
	return db.Ctx(ctx).Create(link).Error
}
