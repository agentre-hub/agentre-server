// Package conversationid 复述 conversation_id 的**派生规则** —— 一条对话在桌面端、
// agentred 与 server 三套库以及线格式上的唯一身份
// （2026-08-31-conversation-centric-addressing.md 决策 1 / 2）。
//
// 新对话由**发起端**在建档那一刻铸 UUIDv7（浏览器 / 桌面端）；本仓库不发起对话，
// 只镜像别人发起的那些，所以这里没有 New()：server 铸号就意味着建对话要联网、
// server 要知道每条对话的存在，那正是决策 1 拒掉的两件事。
//
// 存量对话按 UUIDv5 确定性派生，那就是 Derive。三份存量在迁移时互不通信，只有
// 确定性派生才能让两边独立算出同一个值；算不一致的那一天，镜像里的存量对话全体
// 成孤儿。**本仓库不得 import agentre 模块**（AGENTS.md），所以 Namespace 与 Derive
// 是桌面仓 internal/pkg/conversationid 的一份重新声明；它们等值这件事不靠约定，
// 靠 conversationid_test.go 里那组与上游逐字相同的向量。先例：
// sync_entity/payload.go 与桌面端 syncwire.GuardPayload 的双份维护。
package conversationid

import "github.com/google/uuid"

// Namespace 是派生存量 conversation_id 用的 UUIDv5 命名空间，持有对话存量的仓库
// 共用同一个值（本仓库与桌面仓 agentre）。
//
// 取值可复算：UUIDv5(uuid.NameSpaceURL, "https://agentre.dev/ns/conversation")。
// 之所以钉成字面量而不是每次现算，是因为它是跨仓库、跨版本的常量 —— 字面量能被
// 逐字比对，现算的表达式一旦在某个仓库里被改写就无声地分了家。
var Namespace = uuid.MustParse("44d41290-935a-525a-853c-81d0e171598e")

// Derive 按 (对端指纹, 对端会话 id) 确定性地派生一条**存量**对话的 conversation_id。
//
// 输入是这条对话的**发起端指纹** —— 也就是发起端向执行端出示、并被本库落进
// peer_fingerprint 那一列的值，不是承载它的那台机器的指纹；取错则本仓库与桌面端
// 算出不同的 uuid。两段之间垫一个 NUL：少了它，("ab","1") 与 ("a","b1") 会撞成同一条。
//
// 同一组输入永远得到同一个输出，因此回填可以重跑、可以分批、可以在每个持有存量的
// 仓库里各跑一遍。
func Derive(namespace uuid.UUID, peerFingerprint, peerSessionID string) string {
	name := make([]byte, 0, len(peerFingerprint)+1+len(peerSessionID))
	name = append(name, peerFingerprint...)
	name = append(name, 0)
	name = append(name, peerSessionID...)
	return uuid.NewSHA1(namespace, name).String()
}
