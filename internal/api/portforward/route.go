// Package portforward 定义控制台端口转发这条地址的形状，也只定义这一件事：
//
//	/fw/<device_id>/<port>/<被转发应用自己的路径>
//
// 它住在 internal/api/ 下是因为 HTTP 契约的真理在这里——地址是给人看、给人复制的
// （规格 2026-09-09-console-port-forward-host 决策 4），而这条路径**没有**、也不会有
// 请求 / 响应结构体：/fw/ 是裸字节转发，不声明任何响应面。
//
// 路由本身挂在 internal/api/router.go 上，用的是裸 gin 的通配尾段：mux.Meta 是
// struct tag，只写得下字面量，装不下 *rest。
package portforward

import (
	"strconv"
	"strings"
)

// RoutePattern 是这条路由在 gin 里的形状。
//
// **刻意是一整条通配尾段，而不是 /fw/:device/:port/*rest。** 后者只匹配「两段之后还
// 有东西」的形状，/fw/12 与 /fw/ 会落到 gin 的 NoRoute 上——那里是 SPA 兜底，非 /v1/
// 的未命中路径一律回 index.html + 200（internal/web/embed.go），于是尾斜杠差一个就
// 得到一张白屏而状态码正常，没有任何东西会红（决策 10）。而 gin 的路由树不允许同一
// 段上既有 :param 又有 *catchAll，想两条都挂是挂不上的。
//
// 所以 /fw/ 之下的每一条请求都由本包接住，形状由 Parse 判——判不出来的自己答，不外溢。
const RoutePattern = "/fw/*forward"

// ParamName 是 RoutePattern 里那段通配的名字，控制器按它取剩余路径。
const ParamName = "forward"

// pathPrefix 是这条地址的固定头。Address.Prefix 与 RoutePattern 都从它长出来，
// 改地址形状时只有这一个地方要动。
const pathPrefix = "/fw"

// maxPort 是 TCP 端口的上界。0 不是一个可以连的端口，所以下界是 1。
const maxPort = 65535

// Address 是一条转发地址被拆开之后的样子。
type Address struct {
	// DeviceID 是地址里那台设备。它是 device_id 而不是指纹：地址要短、要能读、
	// 要和本仓 REST 的 ?device_id= 一致（决策 4），代价是服务端多一步翻成指纹。
	DeviceID int64
	// Port 是设备本机 127.0.0.1 上那个端口。端口有没有被声明由**设备**判，
	// 服务端不持有映射表。
	Port uint32
	// Prefix 是请求进入代理**之前**要剥掉的那一段，形如 /fw/12/3000。
	//
	// 剥这件事只做一次，且只在这里算出来：共享包取的是 r.URL.RequestURI()，跟着
	// http.StripPrefix 改过的路径走（决策 6）。多剥一层会把 /assets/x.js 变成
	// /x.js；少剥一层则被转发应用会看见 /fw/12/3000/assets/x.js。
	Prefix string
}

// Parse 拆 /fw 之后的那段剩余路径（gin 通配尾段的原样值，含前导斜杠）。
//
// 第二个返回值是「这确实是一条转发地址」。false 的一律由调用方自己答掉，
// **不得**放它落到 SPA 兜底上（决策 10）。
func Parse(rest string) (Address, bool) {
	if !strings.HasPrefix(rest, "/") {
		return Address{}, false
	}
	// 切三段：设备、端口、以及剩下的全部。剩下的可以为空（/fw/12/3000 与
	// /fw/12/3000/ 都是合法地址，见 Prefix 的说明）。
	parts := strings.SplitN(rest[1:], "/", 3)
	if len(parts) < 2 {
		return Address{}, false
	}
	deviceID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || deviceID <= 0 {
		return Address{}, false
	}
	// ParseUint 自己就拒掉负号与非数字；这里再判上界，因为端口不是「任意 32 位数」。
	// 不用 strconv.Atoi 再转：那条路上 "+80" 是合法的，而它不是这条地址的形状。
	port, err := strconv.ParseUint(parts[1], 10, 32)
	if err != nil || port == 0 || port > maxPort {
		return Address{}, false
	}
	return Address{
		DeviceID: deviceID,
		Port:     uint32(port),
		Prefix:   pathPrefix + "/" + parts[0] + "/" + parts[1],
	}, true
}
