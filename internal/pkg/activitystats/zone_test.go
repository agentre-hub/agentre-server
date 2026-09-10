package activitystats

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestServerZone_NameIsResolvableOnTheOtherEnd 是这个包里最重要的一条守卫。
//
// 上报请求里的 time_zone 是**对端**拿去 LoadLocation 的，而 Go 的 time.Local.String()
// 在 TZ 环境变量没设的机器上就是字面量 "Local"（本仓的 Dockerfile、compose 与 helm
// 模板都不设 TZ）。"Local" 偏偏解得开 —— time.LoadLocation 对它有特判，交回的是**调用
// 进程自己的**本地时区。于是每台机器都按自己那边的时区切日界，一个账号下分散在各地的
// 机器把同一天劈到两格上，而这正是这条通道要避免的头一件事。
//
// 断言因此是「这个名字不是 Local，而且解出来的位置与我们自己用的那套日界同偏移」——
// 它在任何机器上都成立，不依赖跑测试的这台机器在哪个时区。
func TestServerZone_NameIsResolvableOnTheOtherEnd(t *testing.T) {
	name, loc := ServerZone()

	require.NotEmpty(t, name)
	assert.NotEqual(t, "Local", name,
		`"Local" 在对端解成对端自己的时区，等于没有指定时区`)

	resolved, err := time.LoadLocation(name)
	require.NoError(t, err, "对端 LoadLocation 得解得开这个名字")

	_, viaName := time.Now().In(resolved).Zone()
	_, viaLoc := time.Now().In(loc).Zone()
	assert.Equal(t, viaName, viaLoc,
		"交回的位置必须就是那个名字解出来的位置，否则服务端自己算的日界与它告诉对端的不是同一套")
}

// TestZoneFromPath 覆盖从 /etc/localtime 的软链目标里剥 IANA 名。
//
// 路径前缀各系统不同（Linux 是 /usr/share/zoneinfo，macOS 是
// /var/db/timezone/zoneinfo），所以判据是「zoneinfo 之后的那一段」而不是某个固定前缀。
func TestZoneFromPath(t *testing.T) {
	for _, c := range []struct {
		path string
		want string
	}{
		{"/var/db/timezone/zoneinfo/Asia/Shanghai", "Asia/Shanghai"},
		{"/usr/share/zoneinfo/Europe/Berlin", "Europe/Berlin"},
		{"/usr/share/zoneinfo/UTC", "UTC"},
		{"../usr/share/zoneinfo/America/Los_Angeles", "America/Los_Angeles"},
		// 剥不出来时交回空串，由调用方退到一个确定的兜底 —— 猜一个名字的后果是
		// 服务端与对端按两套日界切同一天。
		{"/etc/localtime", ""},
		{"", ""},
		{"/usr/share/zoneinfo", ""},
	} {
		assert.Equal(t, c.want, zoneFromPath(c.path), c.path)
	}
}
