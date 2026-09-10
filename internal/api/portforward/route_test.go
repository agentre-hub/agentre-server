package portforward_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/api/portforward"
)

// 地址的形状是可见契约（规格决策 4：/fw/<device_id>/<port>/…），所以这里逐条钉住
// 「哪些算一条转发地址」以及「要剥掉的是哪一段」。前缀那一列尤其要紧：多剥一层会把
// /assets/x.js 变成 /x.js（决策 6）。
func TestParse_AcceptsWellFormedAddresses(t *testing.T) {
	cases := []struct {
		name     string
		rest     string
		deviceID int64
		port     uint32
		prefix   string
	}{
		{"根路径不带尾斜杠", "/12/3000", 12, 3000, "/fw/12/3000"},
		{"根路径带尾斜杠", "/12/3000/", 12, 3000, "/fw/12/3000"},
		{"子路径", "/12/3000/assets/x.js", 12, 3000, "/fw/12/3000"},
		{"端口上界", "/1/65535/", 1, 65535, "/fw/1/65535"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := portforward.Parse(c.rest)

			assert.True(t, ok)
			assert.Equal(t, c.deviceID, got.DeviceID)
			assert.Equal(t, c.port, got.Port)
			assert.Equal(t, c.prefix, got.Prefix)
		})
	}
}

// 形状不对的一律不成立。它们不能被当成「某台设备的某个端口」去拨号，也不能落到
// SPA 外壳上（决策 10），所以判据必须在这里就收住。
func TestParse_RejectsMalformedAddresses(t *testing.T) {
	cases := []struct {
		name string
		rest string
	}{
		{"只有斜杠", "/"},
		{"空", ""},
		{"缺端口", "/12"},
		{"缺端口只有尾斜杠", "/12/"},
		{"端口不是数字", "/12/http"},
		{"设备号不是数字", "/abc/3000"},
		{"端口为零", "/12/0"},
		{"端口越界", "/12/65536"},
		{"设备号为零", "/0/3000"},
		{"设备号为负", "/-1/3000"},
		{"端口带正号", "/12/+80"},
		{"不以斜杠开头", "12/3000"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, ok := portforward.Parse(c.rest)

			assert.False(t, ok)
		})
	}
}
