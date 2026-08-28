// Package wireversion 复述本次构建所说的 agentre ↔ agentred wire 协议版本。
//
// 版本号的主人是 `@agentre-hub/agentre-wire` 的 package.json：那个包发布 schema、
// 生成的消息与编解码，它的发布号就是「协议」本身的版本。本仓库只钉一个不可变
// revision 消费它，Go 又读不到 package.json，所以在这里复述一份，由
// wireversion_test.go 盯着 frontend/pnpm-lock.yaml 里钉住的那个版本逐字相等 ——
// 改 pin 忘了改这里，构建直接红。
//
// 上游的对应物是桌面仓的 internal/pkg/wireversion。本仓库只**出示**版本（server 是
// daemon / 桌面端的调用方，中继那一跳只转发不透明字节，从不终结握手），所以这里没有
// 上游那套 Match / Reject 判定：对端按精确匹配校验，拒绝时把人话原样带回来。
package wireversion

// Protocol 是每一次握手自报的 wire 协议版本。
//
// 与 frontend/package.json 钉住的 @agentre-hub/agentre-wire 版本保持逐字一致。
const Protocol = "0.3.0"
