package activitystats

import (
	"os"
	"strings"
	"sync"
	"time"
)

// localtimePath 是这台机器当前时区的软链，POSIX 上的既定位置。
const localtimePath = "/etc/localtime"

// zoneinfoSegment 是软链目标里那个把前缀与 IANA 名分开的路径段。前缀各系统不同
// （Linux 是 /usr/share/zoneinfo，macOS 是 /var/db/timezone/zoneinfo），名字总在它之后。
const zoneinfoSegment = "zoneinfo/"

var (
	serverZoneOnce sync.Once
	serverZoneName string
	serverZoneLoc  *time.Location
)

// ServerZone 交出这条通道唯一的那套日界：一个**对端解得开**的时区名，以及它解出来的
// 位置。服务端自己算「今天」用交回的位置，发给对端的是交回的名字 —— 两者必须是同一
// 套，所以它们由同一个函数一起交出来。
//
// 不能直接用 time.Local.String()：TZ 环境变量没设时（本仓的 Dockerfile、compose 与
// helm 模板都不设），Go 把 time.Local 的名字写死成字面量 "Local"。而 "Local" 偏偏
// 解得开 —— time.LoadLocation 对它有特判，交回的是**调用进程自己的**本地时区。发这个
// 名字出去，等于让每台机器按自己那边的时区切日界：一条 2026-08-28 02:00 CST 的对话在
// 一台 PDT 的机器上被切成 "2026-08-27"，热力图整格错位一天，而这正是这条通道声称要
// 避免的头一件事。
//
// 解析顺序，一旦某一步给出一个能自洽的答案就停：
//
//  1. time.Local 自己带名字（TZ 设了）—— 直接用。
//  2. 从 /etc/localtime 的软链目标里剥 IANA 名，并**校验它解出来的偏移与本进程当下
//     的偏移一致**。校验是必须的：剥错了名字比没有名字更糟，因为它看起来是对的。
//  3. 兜底 UTC，**位置也一并换成 UTC**。这一步不是在猜，而是在承认「说不出自己在哪个
//     时区」，于是服务端与所有对端一起改用一套确定的日界。名字与位置同时换，两侧才
//     不会各切各的。
//
// 只算一次：这台机器的时区在进程生命周期里不变，而这个函数在每一轮拉取的每一台机器上
// 都会被调到。
func ServerZone() (string, *time.Location) {
	serverZoneOnce.Do(func() {
		serverZoneName, serverZoneLoc = resolveServerZone()
	})
	return serverZoneName, serverZoneLoc
}

func resolveServerZone() (string, *time.Location) {
	if name := time.Local.String(); name != "" && name != "Local" {
		if _, err := time.LoadLocation(name); err == nil {
			return name, time.Local
		}
	}
	if target, err := os.Readlink(localtimePath); err == nil {
		if name := zoneFromPath(target); name != "" {
			if loc, err := time.LoadLocation(name); err == nil && sameOffsetNow(loc, time.Local) {
				return name, loc
			}
		}
	}
	return "UTC", time.UTC
}

// sameOffsetNow 判两个位置此刻是不是同一个偏移。用「此刻」而不是逐条历史规则比较，
// 是因为要挡的只有「剥出来的名字根本不是这台机器用的那个」这一种错。
func sameOffsetNow(a, b *time.Location) bool {
	now := time.Now()
	_, offsetA := now.In(a).Zone()
	_, offsetB := now.In(b).Zone()
	return offsetA == offsetB
}

// zoneFromPath 从 /etc/localtime 的软链目标里剥出 IANA 名，剥不出来交回空串。
func zoneFromPath(path string) string {
	idx := strings.LastIndex(path, zoneinfoSegment)
	if idx < 0 {
		return ""
	}
	return path[idx+len(zoneinfoSegment):]
}
