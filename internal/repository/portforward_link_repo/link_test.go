package portforward_link_repo

import (
	"errors"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/model/entity/portforward_link_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// FindByDeviceMapping 是幂等分配的第一步：已经存在的一行直接复用，不生成新的
// 随机前缀（spec「分配前缀」：对同一个 (设备, 映射 id) 重复调用永远拿到同一个前缀）。
func TestFindByDeviceMapping_ReturnsTheExistingRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewLink()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `port_forward_links` WHERE device_id=? AND mapping_id=?")).
		WillReturnRows(sqlmock.NewRows([]string{"id", "prefix", "user_id", "device_id", "mapping_id"}).
			AddRow(int64(1), "abcdefghijkl", int64(7), int64(12), int64(3)))

	got, err := r.FindByDeviceMapping(ctx, 12, 3)

	assert.NoError(t, err)
	assert.Equal(t, "abcdefghijkl", got.Prefix)
	assert.Equal(t, int64(7), got.UserID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// 查不到是 (nil, nil)，不是错误——本仓所有 FindXxx 的既有约定。
func TestFindByDeviceMapping_MissingRowIsNilNil(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewLink()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `port_forward_links` WHERE device_id=? AND mapping_id=?")).
		WillReturnRows(sqlmock.NewRows([]string{"id", "prefix", "user_id", "device_id", "mapping_id"}))

	got, err := r.FindByDeviceMapping(ctx, 12, 3)

	assert.NoError(t, err)
	assert.Nil(t, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// FindByPrefix 是 S4 的 Host 分发用来把前缀反查回 (账号, 设备, 映射 id) 的入口
// （interfaces: 「S2: link repo FindByPrefix + ForwardURL(prefix)」）。
func TestFindByPrefix_ReturnsTheOwningRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewLink()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `port_forward_links` WHERE prefix=?")).
		WillReturnRows(sqlmock.NewRows([]string{"id", "prefix", "user_id", "device_id", "mapping_id"}).
			AddRow(int64(1), "abcdefghijkl", int64(7), int64(12), int64(3)))

	got, err := r.FindByPrefix(ctx, "abcdefghijkl")

	assert.NoError(t, err)
	assert.Equal(t, int64(7), got.UserID)
	assert.Equal(t, int64(12), got.DeviceID)
	assert.Equal(t, int64(3), got.MappingID)
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestFindByPrefix_MissingRowIsNilNil(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewLink()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `port_forward_links` WHERE prefix=?")).
		WillReturnRows(sqlmock.NewRows([]string{"id", "prefix", "user_id", "device_id", "mapping_id"}))

	got, err := r.FindByPrefix(ctx, "abcdefghijkl")

	assert.NoError(t, err)
	assert.Nil(t, got)
	assert.NoError(t, mock.ExpectationsWereMet())
}

// Create 只管插入这一行；撞唯一键（prefix 碰撞、或并发的第一次分配撞了
// uk_pfl_device_mapping）时把 MySQL 的错误原样交回去，由 portforward_svc 按
// dberr.IsDuplicateKey 分流重试——仓储层不猜调用方想怎么处理冲突。
func TestCreate_InsertsTheRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewLink()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `port_forward_links`")).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	link := &portforward_link_entity.PortForwardLink{
		Prefix: "abcdefghijkl", UserID: 7, DeviceID: 12, MappingID: 3, Createtime: 1000,
	}
	assert.NoError(t, r.Create(ctx, link))
	assert.NoError(t, mock.ExpectationsWereMet())
}

func TestCreate_PropagatesDuplicateKeyError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewLink()

	boom := errors.New("Duplicate entry 'abcdefghijkl' for key 'port_forward_links.uk_pfl_prefix'")
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `port_forward_links`")).WillReturnError(boom)
	mock.ExpectRollback()

	link := &portforward_link_entity.PortForwardLink{
		Prefix: "abcdefghijkl", UserID: 7, DeviceID: 12, MappingID: 3, Createtime: 1000,
	}
	err := r.Create(ctx, link)
	assert.ErrorIs(t, err, boom)
	assert.NoError(t, mock.ExpectationsWereMet())
}
