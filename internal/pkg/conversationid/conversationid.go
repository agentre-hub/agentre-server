// Package conversationid 定义跨客户端和服务端一致的 conversation_id 派生规则。
// 新对话由发起端生成 UUIDv7；本包只为存量对话按 UUIDv5 确定性派生 ID。
package conversationid

import "github.com/google/uuid"

// Namespace 是跨仓库共用的 UUIDv5 命名空间。保持字面量可避免各实现漂移。
var Namespace = uuid.MustParse("44d41290-935a-525a-853c-81d0e171598e")

// Derive 按发起端指纹和对端会话 ID 确定性派生存量对话 ID。
// 两段以 NUL 分隔，避免不同输入组合产生相同字节序列。
func Derive(namespace uuid.UUID, peerFingerprint, peerSessionID string) string {
	name := make([]byte, 0, len(peerFingerprint)+1+len(peerSessionID))
	name = append(name, peerFingerprint...)
	name = append(name, 0)
	name = append(name, peerSessionID...)
	return uuid.NewSHA1(namespace, name).String()
}
