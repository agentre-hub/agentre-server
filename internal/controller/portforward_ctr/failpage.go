package portforward_ctr

import (
	"fmt"
	"io"
	"net/http"
)

// 这个文件是本仓**唯一**的服务端渲染 HTML，也是唯一一处用户可见文案不走 t()。
//
// # i18n 豁免（规格 2026-09-09-console-port-forward-host 决策 8）
//
// AGENTS.md 第 3 条要求用户文案一律来自 t()。这两张页显式豁免，理由写在这里：
//
//   - 用户此刻在**一个转发地址上**（/fw/12/3000/...），不在 SPA 路由里，四周没有控制台
//     的外壳。302 到 /fw-error?... 会改掉地址栏，也会改掉「刷新」的语义——刷新之后重试
//     的必须是原来那条转发地址，而不是错误页自己。
//   - 本仓服务端渲染 HTML 无先例、无 i18n 通路：cago/pkg/i18n 只服务 JSON 错误信封，
//     取不到浏览器语言之外还要一整套模板本地化，而本轮只有两张页。
//   - 共享包 portforwardhost 的失败文案本来就是硬编码中文、没有 i18n 出口（规格
//     「已知约束」），这一层改写的正是它，只出中文与它同一条。
//
// 因此**文案限定中文**。这条豁免的射程就是这个文件里的两张页；别把它当成「服务端可以
// 写死文案」的先例。
//
// # 页面里没有的东西
//
//   - 没有外部资源（CDN、字体、图片、脚本）。这一页的宿主是**被转发的那个应用**的源，
//     控制台的静态资源在那里不一定拉得到，拉不到就只剩一张没样式的裸页。
//   - 没有同源风险提示。那是规格「安全」一节唯一的记录处，界面上不常驻它（上游决策 13）。
//   - 没有「正在读取…」这类解释性状态横幅。状态由两个出口本身表达。
//   - 没有任何用户可控数据被回显：文案是常量，端口是数字，「刷新」用的是空 href（浏览器
//     把它解析成当前地址），所以这一页**不需要转义**，也不会把请求路径反射回页面里。

// failurePage 是一张失败页说的那两句话。
type failurePage struct {
	// heading 同时用作 <title>：浏览器标签页上先看到的就是它。
	heading string
	// detail 说清下一步该做什么，%d 是设备本机那个端口。
	detail string
}

// 两张页。**区别必须说得出来**（上游规格「失败与恢复」）：一个要等机器回来，另一个
// 要去把服务起起来。它们只在这里定义，改写层与控制器自己的答复都取这两个值。
var (
	// offlinePage 是「设备离线」。两条来路：open 之前的在线判定不过，以及共享包答了
	// 502 而二次在线判定说它已经不在线（决策 13）。
	offlinePage = failurePage{
		heading: "设备离线",
		detail: "这台设备此刻没有连着 AgentRe，转发到它 127.0.0.1:%d 的请求送不过去。" +
			"等它重新上线之后刷新这一页。",
	}
	// noListenerPage 是「端口上没有服务」：共享包答了 502，而二次在线判定说设备还在线。
	//
	// 502 里另外两种（上游把请求断了、转发没完成）与它共用这一张。这是决策 13 明知的
	// 代价：规格没有为它们定页，而按状态码分不开它们——认上游那几句中文常量的话，
	// 上游改一个字这里就静默失灵，且本仓没有任何用例会红。
	noListenerPage = failurePage{
		heading: "端口上没有服务",
		detail: "设备连着，但它的 127.0.0.1:%d 上没有服务在监听。" +
			"到那台机器上把服务起起来，再刷新这一页。",
	}
)

// devicesPath 是「回到设备」那个出口。控制台的设备页（规格「失败的呈现」）。
const devicesPath = "/devices"

// failurePageTemplate 的四个空位依次是 <title>、<h1>、正文、「回到设备」的去处。
//
// 「刷新」用空 href：浏览器把它解析成**当前这条地址**，于是刷新重试的是原来那个转发
// 地址而不是错误页自己，且不必把请求 URI 回显进页面里。
const failurePageTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>%s</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#f6f7f8;color:#16181d;
font:16px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:32rem;padding:2rem 1.5rem}
h1{margin:0 0 .75rem;font-size:1.375rem;font-weight:600}
p{margin:0 0 1.5rem;color:#4b525c}
.exits{display:flex;gap:.75rem;flex-wrap:wrap}
.exits a{display:inline-block;padding:.5rem 1.125rem;border-radius:.5rem;font-size:.9375rem;
text-decoration:none;border:1px solid #d6dae0;color:inherit}
.exits a.primary{background:#16181d;border-color:#16181d;color:#fff}
@media (prefers-color-scheme:dark){
body{background:#111317;color:#e6e8ea}
p{color:#a2a9b3}
.exits a{border-color:#31353c}
.exits a.primary{background:#e6e8ea;border-color:#e6e8ea;color:#111317}
}
</style>
</head>
<body>
<main>
<h1>%s</h1>
<p>%s</p>
<div class="exits">
<a class="primary" href="">刷新</a>
<a href="%s">回到设备</a>
</div>
</main>
</body>
</html>
`

// failurePageContentType 是失败页的类型。共享包写的是 text/plain，改写时必须整个换掉，
// 不然浏览器会把这一整张页当纯文本印出来。
const failurePageContentType = "text/html; charset=utf-8"

// writeFailurePage 把一张页写出去。与共享包的 writeFailure 同一套缓存语义：no-store。
//
// Content-Length 显式删掉：上游可能已经在响应头里放过一个属于它自己那段正文的长度，
// 留着的话浏览器会按那个数截断这一页。
func writeFailurePage(w http.ResponseWriter, status int, page failurePage, port uint32) {
	header := w.Header()
	header.Set("Content-Type", failurePageContentType)
	header.Set("Cache-Control", "no-store")
	header.Del("Content-Length")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, fmt.Sprintf(failurePageTemplate,
		page.heading, page.heading, fmt.Sprintf(page.detail, port), devicesPath))
}
