package mirror_svc

import (
	"context"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// TranscriptImportPeer 是一条已经建好的连接上、导入这一族的四个方法。谁拨的号、
// 怎么对上请求 ID 在这里一律不可见（与 RelaySession 同一条边界）。
type TranscriptImportPeer interface {
	TranscriptImportScan(context.Context, *agentrewire.TranscriptImportScanRequest) (*agentrewire.TranscriptImportScanResponse, error)
	TranscriptImportOpen(context.Context, *agentrewire.TranscriptImportOpenRequest) (*agentrewire.TranscriptImportOpenResponse, error)
	TranscriptImportTurns(context.Context, *agentrewire.TranscriptImportTurnsRequest) (*agentrewire.TranscriptImportTurnsResponse, error)
	TranscriptImportExecute(context.Context, *agentrewire.TranscriptImportExecuteRequest) (*agentrewire.TranscriptImportExecuteResponse, error)
}

// Imports 是「够到那台机器,问它磁盘上的会话」这一件事。内容怎么呈现、导完归谁,
// 都不在这里 —— 本类型只负责把请求送到那台机器并把 wire 上的两种失败翻译成业务
// 判据（离线）；协议错误原样返回。
//
// 与 Sessions.DeleteOnMachine 同一条路子:每次自己拨一条短连接,用完就收,即使本副本
// 正跟着这台机器也一样。导入是用户手点出来的、极少发生,而复用常驻连接要把那条
// 连接的生命周期暴露给请求路径。
type Imports struct {
	sup *Supervisor
}

func NewImports(sup *Supervisor) *Imports { return &Imports{sup: sup} }

// WithPeer 拨一条通往这台机器的短连接,把它交给 fn,回来时收掉。
//
// 一次 WithPeer 一条连接、由调用方在里面发几个请求:预览要 open + turns 两次调用,
// 各拨一条等于每看一条候选就多握一次手,而握手要签一张凭据、走一整轮中继。
//
// fn 交回的错误经翻译再上交:wire 上的错误码只该出现在会说 wire 的这一层。
func (i *Imports) WithPeer(
	ctx context.Context, userID int64, fingerprint string,
	fn func(context.Context, TranscriptImportPeer) error,
) error {
	conn, err := i.sup.dial(ctx, machineKey{userID: userID, fingerprint: fingerprint}, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	return fn(ctx, conn)
}

var _ TranscriptImportPeer = (*machineConn)(nil)
