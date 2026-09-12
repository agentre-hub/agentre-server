// Package wireversion 交出本次构建在 agentre ↔ agentred 握手里出示的两个版本。
//
// 协议版本的主人是协议 module 自己：它写在 .proto 的 (agentre.wire.protocol_version)
// 文件选项上，由 pkg/wire/protocolversion 从 descriptor 读出来。本仓库钉一个不可变
// revision 消费那个 module，schema 与它的版本号因此一同进来 —— Go 侧不再复述一份，
// Protocol 只是把它转出去，没有会漂的抄本。
//
// 本仓库拥有的只有窗口的下沿：MinSupported 是「这个 build 还接受多老的对端」，是本次
// 构建的策略而不是协议的属性（同一份协议，不同宿主可以把地板放在不同高度），所以它
// 留在这里，由 wireversion_test.go 盯着。
//
// 上游的对应物是桌面仓的 internal/pkg/wireversion。本仓库只**出示**版本（server 是
// daemon / 桌面端的调用方，中继那一跳只转发不透明字节，从不终结握手），所以这里没有
// 上游那套 Match / Reject 判定：对端按精确匹配校验，拒绝时把人话原样带回来。
package wireversion

import "github.com/agentre-hub/agentre/pkg/wire/protocolversion"

// Protocol 是每一次握手自报的 wire 协议版本，来自已钉住的协议 module 里 schema 自报的
// 那一格。它不是常量：值由 pkg/wire 的 pin 决定，改 pin 就跟着走。
var Protocol = protocolversion.Protocol()

// MinSupported 是本副本在 auth.account 握手里出示的、自己还能接受的最旧对端版本。
//
// 它是本次构建自己的策略，所以留成字面量：协议 module 说不了「谁还愿意跟多老的对端讲
// 话」。本轮它与 Protocol 相等，不产生宽限窗口——出示它是握手的前提：对端要求这个字段
// 能解析出一个版本，空串会被当作版本不匹配拒掉（spec「协议：版本窗口与自报版本」一节，
// 决策 3）。从下一轮只加字段、不改方法集的改动开始，这里可以让 floor 落后于 Protocol
// 而不必打断全网；在那之前，两者必须逐字相等，wireversion_test.go 盯着。
const MinSupported = "0.5.0"
