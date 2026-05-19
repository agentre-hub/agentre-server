// Package api 包含所有 HTTP request/response 结构与路由注册。
//
// 每个 domain 子包（healthz/auth/device）里的 request struct 用 mux.Meta
// 打 path/method tag；controller 函数靠 cago 自动解码。
package api
