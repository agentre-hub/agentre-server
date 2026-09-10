package mirror_svc

import (
	"context"
	"errors"
	"fmt"
	"time"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// upgradeCallTimeout 是这一次调用等应答的预算。
//
// 它必须与镜像那几个方法共用的 Config.CallTimeout（缺省 15 秒）分开：那个数是按
// 「问一句答一句」的会话 RPC 给的，而 daemon 的受理判定把解析发布、下载、校验、
// 替换**全部**跑完才应答——这正是 DOWNLOAD_FAILED / NOT_WRITABLE / ALREADY_LATEST
// 能作为这次调用确定性结果的原因。换一个几十 MB 的二进制不会在 15 秒里跑完，沿用
// 那个预算等于让每一次真能成功的升级都在本端超时：控制器把超时折成 500、控制台落进
// failed 态，而那台机器照样升完重启，界面从此再没有东西把它纠正回来。
//
// 取 5 分钟，与控制台自己那扇「升级中」的窗口同宽（前端 use-device-upgrade 的
// TIMEOUT_MS）：更长没有意义（用户那侧已经按超时收场），更短则会把还在下载的机器
// 判死。
const upgradeCallTimeout = 5 * time.Minute

// ErrMirrorUnavailable 是「这个部署没装配镜像」：没有镜像就没有通往那台机器的连接，
// 一键升级因此够不着它。与 ErrMachineOffline 分开——那是机器不在线，这是本端没有这
// 条能力，用户能做的事不一样（前者等它回来，后者只能用命令卡兜底）。
var ErrMirrorUnavailable = errors.New("mirror is not assembled on this deployment")

// UpgradeRejectReason 是一次远程一键升级没被受理的原因，取值与
// agentrewire.AgentredSelfUpdateRejectReason 一一对应。
//
// 翻成字符串常量而不是把 protobuf 枚举透传上去：这一层之上是 HTTP 与浏览器，
// 它们不该知道 wire 上的编号，而编号一旦漂进 JSON 契约就再也改不动了。
type UpgradeRejectReason string

const (
	// UpgradeRejectNone 表示这次调用被受理，没有拒绝原因。
	UpgradeRejectNone UpgradeRejectReason = ""
	// UpgradeRejectActiveTurns 这台机器上还有对话在跑，且请求没有带 force。
	UpgradeRejectActiveTurns UpgradeRejectReason = "active_turns"
	// UpgradeRejectInProgress 同一台机器上已经有一次升级在跑。
	UpgradeRejectInProgress UpgradeRejectReason = "in_progress"
	// UpgradeRejectNotWritable 目标安装路径不可写。
	UpgradeRejectNotWritable UpgradeRejectReason = "not_writable"
	// UpgradeRejectAlreadyLatest 这个通道上已经是最新版本。
	UpgradeRejectAlreadyLatest UpgradeRejectReason = "already_latest"
	// UpgradeRejectDownloadFailed 解析发布、下载或校验失败。
	UpgradeRejectDownloadFailed UpgradeRejectReason = "download_failed"
)

// upgradeRejectReasons 把 wire 枚举翻成这一层的取值。桌面端
// （remote_device_svc.UpgradeRejectReason）用的是同一张表的同一份取值：两端与命令行
// 对同一个拒绝说同一句话（决策 22），前提是先对同一个拒绝叫同一个名字。
var upgradeRejectReasons = map[agentrewire.AgentredSelfUpdateRejectReason]UpgradeRejectReason{
	agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_UNSPECIFIED:     UpgradeRejectNone,
	agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_ACTIVE_TURNS:    UpgradeRejectActiveTurns,
	agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_IN_PROGRESS:     UpgradeRejectInProgress,
	agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_NOT_WRITABLE:    UpgradeRejectNotWritable,
	agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_ALREADY_LATEST:  UpgradeRejectAlreadyLatest,
	agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_DOWNLOAD_FAILED: UpgradeRejectDownloadFailed,
}

// UpgradeResult 是一次远程一键升级的受理结果，字段与
// agentrewire.AgentredSelfUpdateResponse 一一对应。
type UpgradeResult struct {
	Accepted bool
	// RejectReason 为空串即 Accepted。
	RejectReason UpgradeRejectReason
	// Message 是那句人话，**逐字**来自 daemon（与 `agentred update` 命令行、与桌面端
	// 同一句话——决策 22）。这一层不重写它，界面也不该重翻一遍。
	Message string
	// ActiveTurns 只在 RejectReason 是 active_turns 时非零。
	ActiveTurns int32
	// TargetVersion 是 daemon 解析出来准备安装的版本；受理时非空，部分拒绝原因
	// （如 already_latest）也会带上。
	TargetVersion string
}

// SelfUpdatePeer 是一条已经建好的连接上、自更新这一个方法。与 ActivityRollupClient
// 同一条理由的窄接口：这条调用问的是「把你自己换成新版本」，与镜像那几个够得着转录
// 内容的方法不是同一件事，不该并进 RelaySession。
type SelfUpdatePeer interface {
	AgentredSelfUpdate(
		ctx context.Context, req *agentrewire.AgentredSelfUpdateRequest,
	) (*agentrewire.AgentredSelfUpdateResponse, error)
}

// UpgradeMachine 让那台机器把自己升上去，交回 daemon 的受理判定。
//
// 与 Imports.WithPeer / Sessions.DeleteOnMachine / WithMachine 同一条路子：每次自己拨一条
// 短连接、用完就收，即使本副本此刻正跟着这台机器也一样。这里的理由格外硬——受理之后
// daemon 就会重启，这条连接必然断；把它借给常驻镜像等于让一次升级去掐镜像的连接。
//
// 「升成了没有」不在这里答：daemon 受理之后就重启了，升级过程本身在这条连接上不可
// 观察。判据是**重连之后版本变没变**（spec「远程一键升级」），那属于调用方（控制台
// 的设备卡轮询 devices.version）。
func (s *Supervisor) UpgradeMachine(
	ctx context.Context, userID int64, fingerprint string, force bool,
) (UpgradeResult, error) {
	if s == nil {
		return UpgradeResult{}, ErrMirrorUnavailable
	}
	conn, err := s.dial(ctx, machineKey{userID: userID, fingerprint: fingerprint}, nil)
	if err != nil {
		return UpgradeResult{}, err
	}
	defer conn.Close()
	// 这条连接是这次升级专用的短连接（上面那段），本方法是它唯一的使用者，握手也已经
	// 做完——此刻改它的调用预算不与任何人竞争。换掉的只是这一条，常驻镜像上那些会话
	// RPC 仍旧按 Config.CallTimeout 走。
	conn.timeout = upgradeCallTimeout
	// Channel 有意不填：空串 = 「这台机器自己配着的那个通道」，控制台不必（也无从）
	// 知道那台机器跟的是 stable 还是 beta。
	resp, err := conn.AgentredSelfUpdate(ctx, &agentrewire.AgentredSelfUpdateRequest{Force: force})
	if err != nil {
		return UpgradeResult{}, fmt.Errorf("agentred self update on peer: %w", err)
	}
	return UpgradeResult{
		Accepted:      resp.GetAccepted(),
		RejectReason:  upgradeRejectReasons[resp.GetRejectReason()],
		Message:       resp.GetMessage(),
		ActiveTurns:   resp.GetActiveTurns(),
		TargetVersion: resp.GetTargetVersion(),
	}, nil
}

var _ SelfUpdatePeer = (*machineConn)(nil)
