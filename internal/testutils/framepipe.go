package testutils

import (
	"io"
	"sync"

	"github.com/agentre-hub/agentre/pkg/wire/protorpc"
)

// MemFrameConn 是一条内存里的 protorpc.FrameConn,与同对的另一条组成一条双向管道。
//
// 生产上,服务端这一侧是「协议引擎 ← relayFrameConn → 中继 → daemon」;用例只认引擎
// 那一端(*protorpc.Conn),所以造同一个接缝:一条真的 protorpc.Conn,底下换成 channel,
// 对面那条既能当设备(注册 handler 应答),也能故意不跑 Serve 让帧留在缓冲里可以数。
//
// 它住在这里而不是各自复制一份:`portforward_svc` 与 `portforward_ctr` 两个包的用例
// 都要同一对管道,复制出来的第二份迟早漂开。本仓零 build tag(AGENTS.md 非协商项 2),
// 共享测试资产靠**包隔离**——本包只被 _test.go import,Go linker 因此不会把它链进
// cmd/server。
type MemFrameConn struct {
	in   chan []byte
	out  chan []byte
	done chan struct{}
	once sync.Once
}

var _ protorpc.FrameConn = (*MemFrameConn)(nil)

// NewFramePipe 造一对互相接通的内存帧连接。client 那一端给本端 protorpc.Conn,
// device 那一端给「设备」。
func NewFramePipe() (client, device *MemFrameConn) {
	toDevice := make(chan []byte, 64)
	toClient := make(chan []byte, 64)
	client = &MemFrameConn{in: toClient, out: toDevice, done: make(chan struct{})}
	device = &MemFrameConn{in: toDevice, out: toClient, done: make(chan struct{})}
	return client, device
}

// ReadFrame 交出对面写来的一帧;本端被 Close 之后交回 io.EOF。
func (c *MemFrameConn) ReadFrame() ([]byte, error) {
	select {
	case frame := <-c.in:
		return frame, nil
	case <-c.done:
		return nil, io.EOF
	}
}

// WriteFrame 把一帧送去对面;本端被 Close 之后交回 protorpc.ErrConnClosed。
func (c *MemFrameConn) WriteFrame(frame []byte) error {
	select {
	case c.out <- frame:
		return nil
	case <-c.done:
		return protorpc.ErrConnClosed
	}
}

func (c *MemFrameConn) Close() error {
	c.once.Do(func() { close(c.done) })
	return nil
}

func (c *MemFrameConn) Done() <-chan struct{} { return c.done }

// Pending 是「还没被对面消化的帧数」。设备那一侧刻意不跑 Serve 时,收到的每一帧都留在
// 缓冲里可以数——「这次请求到底有没有发到设备上」因此是可断言的。
func (c *MemFrameConn) Pending() int { return len(c.in) }
