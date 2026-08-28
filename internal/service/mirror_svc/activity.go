package mirror_svc

import (
	"context"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// ActivityRollupClient 是一台机器上「交出日滚存」这一件事，只有这一个方法。
//
// 窄到只剩一个方法是刻意的：滚存回包里只有天、几个不透明标识和一个计数，而镜像那
// 几个方法的回包里有标题与转录内容。把它并进 RelaySession 会让镜像那一侧顺手够得着
// 滚存、也让滚存这一侧够得着转录，而这两件事的隐私边界不一样
// （machineconn.go 上 ActivityRollup 的注释）。
//
// 消费它的服务在自己那一侧声明一个结构等价的接口，因此这里不必也不该反向 import
// 那个包：依赖只能从上往下走一条道。
type ActivityRollupClient interface {
	ActivityRollup(
		ctx context.Context, req *agentrewire.ActivityRollupRequest,
	) (*agentrewire.ActivityRollupResponse, error)
}

// WithMachine 拨一条通往这台机器的短连接，把它交给 fn，**无论成败都收掉**。
//
// 与 Imports.WithPeer / Sessions.DeleteOnPeer 同一条路子：每次自己拨、用完就收，
// 即使本副本此刻正跟着这台机器也一样。理由在这里比在那两处更硬——常驻那条连接是
// 为镜像建的，它的租约、重同步与实时通知都围着转录转；活跃统计只该问出计数，借用
// 那条连接等于把两条隐私边界不同的通道拧成一条，还会让一次周期性的拉取牵动常驻
// 连接的生命周期。
//
// 机器联系不上时交出 ErrMachineOffline，fn 一次都不跑：调用方据此跳过这台机器
// （它回来时下一轮自然被拉到），而不是把它记成一次失败。
func (s *Supervisor) WithMachine(
	ctx context.Context, userID int64, fingerprint string, fn func(ActivityRollupClient) error,
) error {
	conn, err := s.dial(ctx, machineKey{userID: userID, fingerprint: fingerprint}, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	return fn(conn)
}

var _ ActivityRollupClient = (*machineConn)(nil)
