// Package release 是「控制台的 latest 从哪来」这件事的 HTTP 契约（规格
// 2026-09-03-client-upgrade-guidance「控制台呈现与 latest 来源」）：浏览器读服务端
// 自己缓存的最新发布版本号，不直连上游。
package release

import "github.com/cago-frame/cago/server/mux"

// LatestRequest 只读，没有任何参数——latest 是账号无关的全局事实。
type LatestRequest struct {
	mux.Meta `path:"/v1/release/latest" method:"GET"`
}

// LatestResponse 里 Known=false 时 Version 必须是空串：拉取失败、配置被关闭、还没
// 拉到过，这三种情形都折成 Known=false，不能借「没有版本号」冒充「已是最新」
// （决策 19）。
type LatestResponse struct {
	Known   bool   `json:"known"`
	Version string `json:"version,omitempty"`
}
