package portforward_svc

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/portforward_link_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/dberr"
	"github.com/agentre-hub/agentre-server/internal/repository/portforward_link_repo"
)

// LinkConfig 是端口转发子域链接的部署配置（spec「地址与路由」的「配置」一节）。
type LinkConfig struct {
	// BaseDomain 决定转发域：生产是 fw.agentrehub.com，dev 是
	// fw.agentre.docker.local。空串表示这个部署不提供转发。
	BaseDomain string
	// PublicURL 是这个部署对外的地址；转发地址的 scheme 与端口跟着它走，只有 host
	// 换成 "<前缀>.<BaseDomain>"。
	PublicURL string
}

// Link 是分配 / 复用的结果：前缀本身，以及拼好的完整地址。
type Link struct {
	Prefix string
	URL    string
}

// linkPrefixLength 是前缀的字符数（决策 1：12 位小写 base32，不带设备号和端口）。
const linkPrefixLength = 12

// uniqueKeyPrefix / uniqueKeyDeviceMapping 是 port_forward_links 两个唯一键的名字
// （migrations/202609210101_port_forward_links.go）。
const (
	uniqueKeyPrefix            = "uk_pfl_prefix"
	uniqueKeyDeviceMapping     = "uk_pfl_device_mapping"
	maxPrefixCollisions    int = 5
)

// Links 是端口转发子域链接的分配器：按 (设备, 映射 id) 幂等分配一个前缀（决策 2：
// 控制台第一次打开时分配，映射在就不变）。
//
// 设备归属判定**不在这里**：调用方（portforward_ctr）先用 device_svc.OwnedDevice
// 判过「这台设备是不是这个账号的」，走到这里时归属已经成立，这里只管前缀本身
// ——与 Pool 对 Forwarder 的分工同一条道理（归属判在控制器，池/分配器只管自己
// 那一件事）。
type Links struct {
	cfg  LinkConfig
	repo portforward_link_repo.PortForwardLinkRepo
	now  func() int64
}

// NewLinks 构造链接分配器。repo 通常是 portforward_link_repo.Link()。
func NewLinks(cfg LinkConfig, repo portforward_link_repo.PortForwardLinkRepo) *Links {
	return &Links{cfg: cfg, repo: repo, now: func() int64 { return time.Now().UnixMilli() }}
}

var defaultLinks *Links

// DefaultLinks 返回本进程那份链接分配器；未装配（没有配置 base_domain 的部署也会
// 装配一份，只是 Link 恒回 unavailable）时为 nil，调用方须自己判空。
func DefaultLinks() *Links     { return defaultLinks }
func SetDefaultLinks(l *Links) { defaultLinks = l }

// Link 按 (userID, deviceID, mappingID) 幂等分配一个前缀。
//
// 已有行直接复用（决策 2）；没有则生成一个新的随机前缀落库，撞在
// uk_pfl_device_mapping 上说明并发的另一次分配刚刚写完，回读那一行；撞在
// uk_pfl_prefix 上则是码空间内的常规碰撞，换一个前缀重试。
func (l *Links) Link(ctx context.Context, userID, deviceID, mappingID int64) (*Link, error) {
	if l.cfg.BaseDomain == "" {
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusServiceUnavailable, code.PortForwardLinksUnavailable)
	}
	existing, err := l.repo.FindByDeviceMapping(ctx, deviceID, mappingID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return l.toLink(existing), nil
	}

	for attempt := 1; ; attempt++ {
		prefix, err := randomPrefix()
		if err != nil {
			return nil, err
		}
		row := &portforward_link_entity.PortForwardLink{
			Prefix: prefix, UserID: userID, DeviceID: deviceID, MappingID: mappingID, Createtime: l.now(),
		}
		err = l.repo.Create(ctx, row)
		if err == nil {
			return l.toLink(row), nil
		}
		if dberr.IsDuplicateKey(err, uniqueKeyDeviceMapping) {
			winner, ferr := l.repo.FindByDeviceMapping(ctx, deviceID, mappingID)
			if ferr != nil {
				return nil, ferr
			}
			if winner != nil {
				return l.toLink(winner), nil
			}
			return nil, err
		}
		if dberr.IsDuplicateKey(err, uniqueKeyPrefix) {
			if attempt >= maxPrefixCollisions {
				logger.Ctx(ctx).Error("port forward link prefix collided too many times",
					zap.Int("attempts", attempt), zap.Error(err))
				return nil, err
			}
			continue
		}
		return nil, err
	}
}

// FindByPrefix 按前缀反查那一行（S4 的 Host 分发），查不到返回 (nil, nil)。前缀归不
// 归当前账号由调用方拿行上的 UserID 判。
func (l *Links) FindByPrefix(ctx context.Context, prefix string) (*portforward_link_entity.PortForwardLink, error) {
	return l.repo.FindByPrefix(ctx, prefix)
}

func (l *Links) toLink(row *portforward_link_entity.PortForwardLink) *Link {
	return &Link{Prefix: row.Prefix, URL: l.ForwardURL(row.Prefix)}
}

// ForwardURL 拼出 "<前缀>.<BaseDomain>" 的完整地址：scheme 与端口跟着 PublicURL
// 走（spec「配置」），端口留空则回落到 scheme 的缺省端口（url.URL 的通常语义）。
func (l *Links) ForwardURL(prefix string) string {
	scheme := "http"
	var port string
	if pub, err := url.Parse(l.cfg.PublicURL); err == nil && pub.Scheme != "" {
		scheme = pub.Scheme
		port = pub.Port()
	}
	host := prefix + "." + l.cfg.BaseDomain
	if port != "" {
		host += ":" + port
	}
	return (&url.URL{Scheme: scheme, Host: host, Path: "/"}).String()
}

// randomPrefix 生成一个 12 位小写 base32 随机串（决策 1）。
//
// base32 每个字符编 5 位，12 个字符需要至少 60 位随机量；取 8 字节（64 位）编码，
// 去掉 padding 后恰好交出 13 个字符，截取前 12 个——丢掉的最后一个字符只携带 4 位
// 随机量，保留的每一位都是满 5 位随机量。
func randomPrefix() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	enc := strings.ToLower(strings.TrimRight(base32.StdEncoding.EncodeToString(buf), "="))
	return enc[:linkPrefixLength], nil
}
