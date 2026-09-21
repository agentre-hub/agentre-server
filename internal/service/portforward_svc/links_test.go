package portforward_svc

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"testing"

	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/portforward_link_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/portforward_link_repo/mock_portforward_link_repo"
)

// bizError 取一个服务层错误上钉着的业务码与状态码（与 device_svc 测试同一个约定）。
func bizError(t *testing.T, err error) *httputils.Error {
	t.Helper()
	var he *httputils.Error
	require.True(t, errors.As(err, &he), "服务层的拒绝必须是成形的 httputils.Error，实际 %T: %v", err, err)
	return he
}

func newLinksForTest(t *testing.T, cfg LinkConfig) (*Links, *mock_portforward_link_repo.MockPortForwardLinkRepo) {
	t.Helper()
	ctrl := gomock.NewController(t)
	repo := mock_portforward_link_repo.NewMockPortForwardLinkRepo(ctrl)
	l := NewLinks(cfg, repo)
	l.now = func() int64 { return 1000 }
	return l, repo
}

// 对同一个 (设备, 映射 id) 重复调用，拿到的永远是已经分配过的那个前缀（决策 2），
// 不生成新的随机值——这是幂等分配的第一步。
func TestLink_GivenAnExistingRow_ReturnsItsPrefixWithoutCreating(t *testing.T) {
	l, repo := newLinksForTest(t, LinkConfig{BaseDomain: "fw.agentre.docker.local", PublicURL: "http://docker.local:8443"})
	repo.EXPECT().FindByDeviceMapping(gomock.Any(), int64(12), int64(3)).
		Return(&portforward_link_entity.PortForwardLink{
			Prefix: "abcdefghijkl", UserID: 7, DeviceID: 12, MappingID: 3,
		}, nil)

	got, err := l.Link(context.Background(), 7, 12, 3)

	require.NoError(t, err)
	assert.Equal(t, "abcdefghijkl", got.Prefix)
	assert.Equal(t, "http://abcdefghijkl.fw.agentre.docker.local:8443/", got.URL)
}

// 首次调用：没有已有行，服务生成一个 12 位小写 base32 前缀并落库。
func TestLink_GivenNoExistingRow_GeneratesA12CharLowercaseBase32Prefix(t *testing.T) {
	l, repo := newLinksForTest(t, LinkConfig{BaseDomain: "fw.agentrehub.com", PublicURL: "https://app.agentrehub.com"})
	repo.EXPECT().FindByDeviceMapping(gomock.Any(), int64(12), int64(3)).Return(nil, nil)
	var created *portforward_link_entity.PortForwardLink
	repo.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, link *portforward_link_entity.PortForwardLink) error {
			created = link
			return nil
		})

	got, err := l.Link(context.Background(), 7, 12, 3)

	require.NoError(t, err)
	require.NotNil(t, created)
	assert.Len(t, got.Prefix, 12)
	assert.Regexp(t, regexp.MustCompile(`^[a-z2-7]{12}$`), got.Prefix)
	assert.Equal(t, got.Prefix, created.Prefix)
	assert.Equal(t, int64(7), created.UserID)
	assert.Equal(t, int64(12), created.DeviceID)
	assert.Equal(t, int64(3), created.MappingID)
	// 生产用 PublicURL 的 scheme，默认端口（443）不出现在地址里（spec「配置」）。
	assert.Equal(t, "https://"+got.Prefix+".fw.agentrehub.com/", got.URL)
}

// dev 上 PublicURL 带着显式端口，转发地址的 scheme 与端口都跟它一致（spec「配置」：
// 「转发地址的 scheme 与端口跟 PublicURL 一致，所以 dev 上是
// http://<前缀>.fw.agentre.docker.local:8443/」）。
func TestLink_ForwardURL_FollowsPublicURLSchemeAndPort(t *testing.T) {
	l, repo := newLinksForTest(t, LinkConfig{BaseDomain: "fw.agentre.docker.local", PublicURL: "http://docker.local:8443"})
	repo.EXPECT().FindByDeviceMapping(gomock.Any(), gomock.Any(), gomock.Any()).Return(nil, nil)
	repo.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)

	got, err := l.Link(context.Background(), 7, 12, 3)

	require.NoError(t, err)
	assert.Equal(t, "http://"+got.Prefix+".fw.agentre.docker.local:8443/", got.URL)
}

// 并发的第一次分配：Create 撞在 (device_id, mapping_id) 唯一键上，说明另一个请求
// 刚刚写完那一行，重新查一次拿到它、而不是把冲突当成错误上抛。
func TestLink_GivenConcurrentFirstAllocation_ReturnsTheWinnersRow(t *testing.T) {
	l, repo := newLinksForTest(t, LinkConfig{BaseDomain: "fw.agentrehub.com", PublicURL: "https://app.agentrehub.com"})
	dup := &mysql.MySQLError{Number: 1062, Message: "Duplicate entry '12-3' for key 'port_forward_links.uk_pfl_device_mapping'"}
	gomock.InOrder(
		repo.EXPECT().FindByDeviceMapping(gomock.Any(), int64(12), int64(3)).Return(nil, nil),
		repo.EXPECT().Create(gomock.Any(), gomock.Any()).Return(dup),
		repo.EXPECT().FindByDeviceMapping(gomock.Any(), int64(12), int64(3)).
			Return(&portforward_link_entity.PortForwardLink{Prefix: "winnerprefx", UserID: 7, DeviceID: 12, MappingID: 3}, nil),
	)

	got, err := l.Link(context.Background(), 7, 12, 3)

	require.NoError(t, err)
	assert.Equal(t, "winnerprefx", got.Prefix)
}

// 随机前缀本身撞了 uk_pfl_prefix（全局唯一）：重新生成一个再试，而不是把碰撞当成
// 错误上抛——碰撞是这个码空间下的常规事件，不是异常。
func TestLink_GivenPrefixCollision_RetriesWithANewPrefix(t *testing.T) {
	l, repo := newLinksForTest(t, LinkConfig{BaseDomain: "fw.agentrehub.com", PublicURL: "https://app.agentrehub.com"})
	dup := &mysql.MySQLError{Number: 1062, Message: "Duplicate entry 'xxxxxxxxxxxx' for key 'port_forward_links.uk_pfl_prefix'"}
	repo.EXPECT().FindByDeviceMapping(gomock.Any(), int64(12), int64(3)).Return(nil, nil)
	first := repo.EXPECT().Create(gomock.Any(), gomock.Any()).Return(dup)
	repo.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil).After(first)

	got, err := l.Link(context.Background(), 7, 12, 3)

	require.NoError(t, err)
	assert.Len(t, got.Prefix, 12)
}

// 没配 base_domain 的部署不提供转发（spec「配置」），答复是「这个部署此刻提供不了
// 端口转发」——不查库、不生成前缀，与某一台设备或映射无关。
func TestLink_GivenNoBaseDomain_ReturnsUnavailableWithoutTouchingTheRepo(t *testing.T) {
	l, repo := newLinksForTest(t, LinkConfig{PublicURL: "https://app.agentrehub.com"})
	repo.EXPECT().FindByDeviceMapping(gomock.Any(), gomock.Any(), gomock.Any()).Times(0)
	repo.EXPECT().Create(gomock.Any(), gomock.Any()).Times(0)

	_, err := l.Link(context.Background(), 7, 12, 3)

	require.Error(t, err)
	he := bizError(t, err)
	assert.Equal(t, code.PortForwardLinksUnavailable, he.Code)
	assert.Equal(t, http.StatusServiceUnavailable, he.Status)
}

// Host 分发按前缀反查那一行（S4）：查到交回，查不到交回 nil，不当成错误。
func TestFindByPrefix_ReturnsTheRowOrNil(t *testing.T) {
	l, repo := newLinksForTest(t, LinkConfig{BaseDomain: "fw.agentrehub.com", PublicURL: "https://app.agentrehub.com"})
	row := &portforward_link_entity.PortForwardLink{Prefix: "abcdefghijkl", UserID: 7, DeviceID: 12, MappingID: 3}
	repo.EXPECT().FindByPrefix(gomock.Any(), "abcdefghijkl").Return(row, nil)
	repo.EXPECT().FindByPrefix(gomock.Any(), "mnopqrstuvwx").Return(nil, nil)

	got, err := l.FindByPrefix(context.Background(), "abcdefghijkl")
	require.NoError(t, err)
	assert.Equal(t, row, got)

	got, err = l.FindByPrefix(context.Background(), "mnopqrstuvwx")
	require.NoError(t, err)
	assert.Nil(t, got)
}

// 授权回跳要拼的是同一个地址：ForwardURL 与分配结果里的 URL 是同一个串。
func TestForwardURL_IsTheSameAddressTheLinkCarries(t *testing.T) {
	l, _ := newLinksForTest(t, LinkConfig{BaseDomain: "fw.agentre.docker.local", PublicURL: "http://docker.local:8443"})
	assert.Equal(t, "http://abcdefghijkl.fw.agentre.docker.local:8443/", l.ForwardURL("abcdefghijkl"))
}
