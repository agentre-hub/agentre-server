package device_svc

import (
	"context"
	"net"
)

type clientInfoKey struct{}

type clientInfo struct {
	IP        string
	UserAgent string
}

// WithClientInfo 把请求来源 IP / UA 注入 ctx，供 token 审计字段使用。
func WithClientInfo(ctx context.Context, ip, ua string) context.Context {
	return context.WithValue(ctx, clientInfoKey{}, clientInfo{IP: ip, UserAgent: ua})
}

// clientInfoFromCtx 返回 ctx 里的来源信息；IP 非法或缺失时返回 nil（写库为 NULL，匹配 varchar(45) 列）。
func clientInfoFromCtx(ctx context.Context) (*string, string) {
	v, _ := ctx.Value(clientInfoKey{}).(clientInfo)
	var ipPtr *string
	if v.IP != "" && net.ParseIP(v.IP) != nil {
		ip := v.IP
		ipPtr = &ip
	}
	return ipPtr, v.UserAgent
}
