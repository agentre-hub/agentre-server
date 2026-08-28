package accountchan_svc

import (
	"encoding/json"
	"fmt"
)

// 通道上的信号种类。每一种都只说「这一类东西变了，该拉了」，收到的客户端照常走
// 自己的读取路径（规格「实时通道只送信号，不送数据」）。
//
// 客户端遇到不认识的种类**忽略但不断连**——两端的消费者都是这么写的，所以新增一种
// 可以先发后收，不必两端同时上线。
const (
	// FrameTypeSyncVersion：这个账号的同步版本推进到了 Version。只有这一种带版本号。
	FrameTypeSyncVersion = "sync_version"
	// FrameTypeMirrorChanged：这个账号的会话镜像变了（新消息、等待输入、未读、
	// 会话增删）。镜像不在 sync_objects 的版本序列上，因此不带版本号。
	FrameTypeMirrorChanged = "mirror_changed"
	// FrameTypeDevicePresence：这个账号有设备上线。在线态是 relay 的 Redis TTL 键，
	// 同样不在版本序列上。
	//
	// **只有上线会发这条信号，下线不发**：在线态的模型就是「键在即在线，断连或进程
	// 失联后自动过期，不主动删除」（规格「在线态」），因此下线根本没有代码路径跑到
	// ——过期是 Redis 自己做的。为它加一次显式删除会引入重连竞态（后到的连接刚写下
	// 的键会被先前那条连接的收尾删掉），代价远大于收益。各端按兜底轮询在一个 TTL
	// 之后看到离线。
	FrameTypeDevicePresence = "device_presence"
)

// Frame 是账号通道服务与 Redis Pub/Sub 之间的 server-internal 业务信号。跨副本
// Pub/Sub 仍以 JSON 编解码这个内部形状；WebSocket 边界由 accountchan_ctr 映射成
// agentre-wire 的 typed Protobuf Notification，客户端不会解析这里的 JSON。
//
// 帧上带类型标记而不是只送一个裸版本号：通道是常连的账号级设施，日后会承载别的
// 通知，新增一种不必改协议（决策 20）。**不带对象内容**——那要求可靠投递与顺序，
// 而只送信号时漏一条最多退化成 30 秒轮询，不丢数据（决策 18）。
type Frame struct {
	// Type 是信号种类，取值见 FrameType* 常量。客户端遇到不认识的种类应当忽略。
	Type string `json:"type"`
	// Version 是该账号同步版本序列推进到的位置。它只用于「该拉了」的判断，
	// 拉哪些由客户端自己的游标决定，因此重复与乱序都无害。
	Version int64 `json:"version"`
}

// Encode 把一帧编成线上字节。编码只此一处，广播方与连接侧共用。
func (f Frame) Encode() ([]byte, error) {
	payload, err := json.Marshal(f)
	if err != nil {
		return nil, fmt.Errorf("encode account channel frame: %w", err)
	}
	return payload, nil
}

// DecodeFrame 解一帧。跨副本送来的字节由它还原，同时挡住不成形的载荷。
func DecodeFrame(payload []byte) (Frame, error) {
	var frame Frame
	if err := json.Unmarshal(payload, &frame); err != nil {
		return Frame{}, fmt.Errorf("decode account channel frame: %w", err)
	}
	if frame.Type == "" {
		return Frame{}, fmt.Errorf("decode account channel frame: missing type")
	}
	return frame, nil
}
