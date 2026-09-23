// Package ctl_svc 是 agrctl 资源管理在 server 上的执行者（规格 2026-09-22
// agrctl-resource-management「server 执行者」）。
//
// 控制台派发到 agentred 的会话里，agent 调 agrctl，agentred 在会话里审批后把请求转给
// 这里。契约是 pkg/wire 的 Ctl* 消息：执行者只接受按 id 的操作与字段集合，名字解析、
// flag 与输出格式都在 agrctl 客户端（决策 7）。字段前后值由这里对照当前数据自己算，
// 密钥只标记「已写入」，从不回显明文。
//
// 读直接取同步组的行（id 就是 sync_objects.id；模型没有自己的行，id 由「提供方同步
// 标识 + ModelKey」确定性地派生）；写一律经 workspace_svc / engine_svc 的现有写路径，
// 因此同步版本照常推进、账号信号照常广播。
package ctl_svc

import (
	"context"
	"fmt"
	"net/http"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/service/engine_svc"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// Caller 是出示设备 Bearer 的那台机器。账号与设备都取自鉴权上下文。
type Caller struct {
	UserID   int64
	DeviceID int64
}

// CtlSvc 执行一次 ctl 请求。preview 为真时写请求只算变更清单、不落库——agentred 在
// 会话里出审批卡之前用它拿到真实的前后值（决策 6、7）。
type CtlSvc interface {
	Handle(ctx context.Context, caller Caller, req *agentrewire.CtlRequest, preview bool) (*agentrewire.CtlResponse, error)
}

type ctlSvc struct {
	org    OrgWriter
	engine EngineWriter
	newKey func() string
}

// New 构造执行者。org / engine 为 nil 时每次调用现取 workspace_svc / engine_svc 的
// 默认单例（engine_svc 的默认值由 main 在 cago 启动前装配，构造期钉死会拿到旧的那份）。
func New(org OrgWriter, engine EngineWriter) CtlSvc {
	return &ctlSvc{org: org, engine: engine, newKey: newModelKey}
}

var defaultSvc CtlSvc = New(nil, nil)

func Default() CtlSvc     { return defaultSvc }
func SetDefault(s CtlSvc) { defaultSvc = s }

func (s *ctlSvc) orgWriter() OrgWriter {
	if s.org != nil {
		return s.org
	}
	return workspace_svc.Default()
}

func (s *ctlSvc) engineWriter() EngineWriter {
	if s.engine != nil {
		return s.engine
	}
	return engine_svc.Default()
}

// Error 是一次 ctl 请求的明确拒绝：Status 是 HTTP 状态，Msg 原样进 `{"error": …}`，
// agrctl 把它印给用户。消息里从不带密钥。
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

func badRequest(format string, a ...any) error {
	return &Error{Status: http.StatusBadRequest, Msg: fmt.Sprintf(format, a...)}
}

func notFound(kind agentrewire.CtlKind, id int64) error {
	return &Error{Status: http.StatusNotFound, Msg: fmt.Sprintf("%s id %d not found", kindNames[kind], id)}
}

// unsupported 是本 spec 在 server 路径上明确不做的操作（send、OpenClaw token、桌面
// 设备的本机路径）。
func unsupported(format string, a ...any) error {
	return &Error{Status: http.StatusUnprocessableEntity, Msg: fmt.Sprintf(format, a...)}
}

// ErrSendUnsupported 是 `agrctl send` 打到 server 上时的回答。
var ErrSendUnsupported = unsupported(
	"send is not supported for sessions dispatched from the web console; dispatch the task from the console instead")

// kindNames 是错误消息与变更清单里的资源名，与 agrctl 的资源名一致。
var kindNames = map[agentrewire.CtlKind]string{
	agentrewire.CtlKind_CTL_KIND_AGENT:      "agent",
	agentrewire.CtlKind_CTL_KIND_DEPARTMENT: "department",
	agentrewire.CtlKind_CTL_KIND_PROJECT:    "project",
	agentrewire.CtlKind_CTL_KIND_PROVIDER:   "provider",
	agentrewire.CtlKind_CTL_KIND_MODEL:      "model",
	agentrewire.CtlKind_CTL_KIND_BACKEND:    "backend",
}

// Handle 见接口注释。
func (s *ctlSvc) Handle(
	ctx context.Context, caller Caller, req *agentrewire.CtlRequest, preview bool,
) (*agentrewire.CtlResponse, error) {
	switch op := req.GetOp().(type) {
	case *agentrewire.CtlRequest_List:
		st, err := loadState(ctx, caller)
		if err != nil {
			return nil, err
		}
		items, err := st.list(op.List.GetKind())
		if err != nil {
			return nil, err
		}
		return &agentrewire.CtlResponse{Result: &agentrewire.CtlResponse_List{
			List: &agentrewire.CtlListResponse{Items: items},
		}}, nil
	case *agentrewire.CtlRequest_Get:
		st, err := loadState(ctx, caller)
		if err != nil {
			return nil, err
		}
		res, err := st.get(op.Get.GetKind(), op.Get.GetId())
		if err != nil {
			return nil, err
		}
		return &agentrewire.CtlResponse{Result: &agentrewire.CtlResponse_Get{
			Get: &agentrewire.CtlGetResponse{Resource: res},
		}}, nil
	case *agentrewire.CtlRequest_Write:
		resp, err := s.write(ctx, caller, op.Write, preview)
		if err != nil {
			return nil, err
		}
		return &agentrewire.CtlResponse{Result: &agentrewire.CtlResponse_Write{Write: resp}}, nil
	default:
		return nil, badRequest("empty request: one of list, get, write is required")
	}
}
