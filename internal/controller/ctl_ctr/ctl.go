// Package ctl_ctr 是 agrctl 资源接口的传输层（规格 2026-09-22 agrctl-resource-management
// 「server 执行者」）。
//
// 契约与桌面端的 `POST /ctl/v1/resources` 相同：请求是 protojson 的 CtlRequest，成功
// 响应是 protojson 的 CtlResponse，失败是 `{"error": "…"}`——agentred 的 ctl 代理因此
// 可以原样转发正文。它不走 mux 的 code/msg/data 信封，所以是裸 gin 处理器。
//
// 只挂在设备 access token 那一组（DeviceJWT）：浏览器会话进不来，所以这里没有 CSRF。
package ctl_ctr

import (
	"errors"
	"io"
	"net/http"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/cago-frame/cago/pkg/logger"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/ctl_svc"
)

const (
	// ResourcesPath 是资源读写；`?preview=1` 时写请求只回变更清单、不落库。
	ResourcesPath = "/v1/ctl/resources"
	// SendPath 接住 `agrctl send`，明确答「server 路径上不支持」。
	SendPath = "/v1/ctl/send"
	// maxBody 是请求正文上限：一次写入只是一份资源文档。
	maxBody = 1 << 20
)

type Ctl struct{ svc ctl_svc.CtlSvc }

// New 构造控制器；svc 为 nil 时每次请求现取 ctl_svc.Default()。
func New(svc ctl_svc.CtlSvc) *Ctl { return &Ctl{svc: svc} }

func (c *Ctl) service() ctl_svc.CtlSvc {
	if c.svc != nil {
		return c.svc
	}
	return ctl_svc.Default()
}

// Resources 处理 POST /v1/ctl/resources。正文里可能有密钥明文，所以它从不进日志。
func (c *Ctl) Resources(g *gin.Context) {
	body, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxBody))
	if err != nil {
		writeErr(g, http.StatusBadRequest, "read request body failed")
		return
	}
	var req agentrewire.CtlRequest
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(body, &req); err != nil {
		writeErr(g, http.StatusBadRequest, "invalid request body")
		return
	}
	caller := ctl_svc.Caller{UserID: ginctx.UserID(g), DeviceID: ginctx.DeviceID(g)}
	resp, err := c.service().Handle(g.Request.Context(), caller, &req, g.Query("preview") == "1")
	if err != nil {
		writeServiceErr(g, err)
		return
	}
	out, err := protojson.Marshal(resp)
	if err != nil {
		writeErr(g, http.StatusInternalServerError, "encode response failed")
		return
	}
	g.Data(http.StatusOK, "application/json", out)
}

// Send 处理 POST /v1/ctl/send：本 spec 在 server 路径上不支持派发。
func (c *Ctl) Send(g *gin.Context) {
	writeServiceErr(g, ctl_svc.ErrSendUnsupported)
}

// writeServiceErr：执行者的明确拒绝与服务层的业务错误原样透出（agrctl 印给用户）；
// 其余是内部错误，只记日志、不把细节交出去。
func writeServiceErr(g *gin.Context, err error) {
	var ce *ctl_svc.Error
	if errors.As(err, &ce) {
		writeErr(g, ce.Status, ce.Msg)
		return
	}
	var he *httputils.Error
	if errors.As(err, &he) && he.Status > 0 {
		writeErr(g, he.Status, he.Msg)
		return
	}
	logger.Ctx(g.Request.Context()).Error("ctl_ctr.Resources: request failed",
		zap.Int64("userId", ginctx.UserID(g)), zap.Int64("deviceId", ginctx.DeviceID(g)), zap.Error(err))
	writeErr(g, http.StatusInternalServerError, "internal error")
}

func writeErr(g *gin.Context, status int, msg string) {
	g.AbortWithStatusJSON(status, gin.H{"error": msg})
}
