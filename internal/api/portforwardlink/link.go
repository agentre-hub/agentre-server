// Package portforwardlink 定义控制台分配端口转发子域前缀这一个端点的请求 / 响应
// 形状（规格 2026-09-21-port-forward-subdomain「地址与路由」的「分配前缀」）。
//
// 转发本身（<前缀>.<base_domain> 上的裸字节代理）没有、也不会有请求 / 响应结构体；
// 这里恰恰相反——/v1/port-forwards/links 是一个普通的 JSON 端点，走 mux.Meta declare
// 的这套。
package portforwardlink

import "github.com/cago-frame/cago/server/mux"

// CreateRequest 对自己名下的一台设备、一条映射 id 申请（或复用）一个转发前缀。
type CreateRequest struct {
	mux.Meta  `path:"/v1/port-forwards/links" method:"POST"`
	DeviceID  int64 `json:"device_id"  binding:"required"`
	MappingID int64 `json:"mapping_id" binding:"required"`
}

// CreateResponse 交回这条 (设备, 映射 id) 的前缀与完整地址。对同一个 (设备, 映射 id)
// 重复调用，拿到的永远是同一个前缀（决策 2）。
type CreateResponse struct {
	Prefix string `json:"prefix"`
	URL    string `json:"url"`
}
