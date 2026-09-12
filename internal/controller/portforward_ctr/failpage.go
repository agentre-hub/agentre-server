package portforward_ctr

import (
	"fmt"
	"io"
	"net/http"

	"github.com/agentre-hub/agentre/pkg/wire/portforwardhost"
)

// 这个文件是本仓**唯一**的服务端渲染 HTML，也是唯一一处用户可见文案不走 t()。
//
// # i18n 豁免（规格 2026-09-09-console-port-forward-host 决策 8，射程由
// 2026-09-09-console-forward-failure-pages 决策 8 扩到四张页）
//
// AGENTS.md 第 3 条要求用户文案一律来自 t()。这四张页显式豁免，理由写在这里：
//
//   - 用户此刻在**一个转发地址上**（/fw/12/3000/...），不在 SPA 路由里，四周没有控制台
//     的外壳。302 到 /fw-error?... 会改掉地址栏，也会改掉「刷新」的语义——刷新之后重试
//     的必须是原来那条转发地址，而不是错误页自己。
//   - 本仓服务端渲染 HTML 无先例、无 i18n 通路：cago/pkg/i18n 只服务 JSON 错误信封，
//     取不到浏览器语言之外还要一整套模板本地化。
//   - 共享包 portforwardhost 的默认文案本来就是硬编码中文、没有 i18n 出口，本文件出的
//     正是取代它的那一份，只出中文与它同一条。
//
// 因此**文案限定中文**。这条豁免的射程就是这个文件里的四张页与三句纯文本；别把它当成
// 「服务端可以写死文案」的先例。
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

// 四张页。**区别必须说得出来**（上游规格「失败与恢复」）：一张要去重新建映射、一张要去
// 把映射启用、一张要去把服务起起来、一张要等机器回来。每一张都对应共享包已经判好的
// 一种失败，本层不再自己猜（规格 2026-09-09-console-forward-failure-pages 决策 3/4）。
var (
	// notDeclaredPage 是 portforwardhost.FailureNotDeclared：设备上没有这个端口的映射。
	// 措辞指向**控制台**——用户刚刚就是在这里建的映射，而他未必装了桌面端。
	notDeclaredPage = failurePage{
		heading: "这个端口没有转发映射",
		detail: "这台设备上没有 127.0.0.1:%d 的端口转发映射。" +
			"到控制台的设备页里建一条，再打开这个地址。",
	}
	// disabledPage 是 portforwardhost.FailureDisabled：映射在，但被停用了。
	disabledPage = failurePage{
		heading: "这条端口转发已停用",
		detail: "127.0.0.1:%d 的转发映射还在，但它已经被停用了。" +
			"到控制台的设备页里把它重新启用，再刷新这一页。",
	}
	// noListenerPage 是 portforwardhost.FailureNoListener：设备连着、映射启用，但那个
	// 端口上没有服务在监听。
	noListenerPage = failurePage{
		heading: "端口上没有服务",
		detail: "设备连着，但它的 127.0.0.1:%d 上没有服务在监听。" +
			"到那台机器上把服务起起来，再刷新这一页。",
	}
	// offlinePage 是「够不着那台设备」。两条来路：共享包判出的
	// portforwardhost.FailureDeviceUnreachable，以及本层在 open 之前那次在线判定不过
	// （后者不经过共享代理，见 portforward.go 的 failureOffline）。
	offlinePage = failurePage{
		heading: "设备离线",
		detail: "这台设备此刻没有连着 Agentre，转发到它 127.0.0.1:%d 的请求送不过去。" +
			"等它重新上线之后刷新这一页。",
	}
)

// failurePages 是「哪几种失败值得一整张页」。四种都是用户**照着页面能做成一件事**的：
// 去建映射、去启用、去起服务、去等机器（规格决策 5）。
var failurePages = map[portforwardhost.FailureKind]failurePage{
	portforwardhost.FailureNotDeclared:       notDeclaredPage,
	portforwardhost.FailureDisabled:          disabledPage,
	portforwardhost.FailureNoListener:        noListenerPage,
	portforwardhost.FailureDeviceUnreachable: offlinePage,
}

// 其余三种给一句话（规格决策 6）：要么是瞬时的、要么用户无从下手，一整张页给不出比
// 一句话更多的东西——两个出口里「刷新」是它们唯一说得通的动作，而那正是浏览器自己
// 就有的按钮。措辞仍是控制台自己的，不用共享包那份桌面端口径的默认值。
var failureTexts = map[portforwardhost.FailureKind]string{
	portforwardhost.FailureUpstreamGone:       "设备上这个端口的服务把这次请求断开了。刷新这一页重试。",
	portforwardhost.FailureForwardIncomplete:  incompleteText,
	portforwardhost.FailureUpgradeUnavailable: "这条转发交不出底层连接，升级到 WebSocket 没能做成。",
}

// incompleteText 是「说不出是哪一件事」的那一句。两处用它，因为对用户而言它们是同一
// 件事：共享包判出的 FailureForwardIncomplete（「这条流收场了，但说不出是上面哪一
// 种」），以及共享包将来长出的、我们还不认识的第八种。写成两份字面量只会让改了一处
// 的人以为改全了。
const incompleteText = "这次转发没有完成。刷新这一页重试。"

// RenderFailure 是交给共享代理的渲染钩子（portforwardhost.WithFailureRenderer）。
//
// 它**只**在代理自己的失败上被调用：被转发应用自己的响应（含它自己答的 4xx/5xx）
// 一个字节都不经过这里，这是共享包对宿主的承诺（上游规格
// 2026-09-09-forward-failure-attribution 要求 1，已由真设备探针实测）。因此本层不按
// 状态码嗅探改写响应：状态码分不开「谁答的」，会把应用自己的 502 也改写掉。
//
// 状态码照用共享包为该种类选定的那一个：本轮不改任何一种失败的状态码。
//
// 它是包级函数、不带任何请求态：代理按端口缓存、跨请求共用，装在构造处的钩子必须对
// 每一次请求都成立。
func RenderFailure(w http.ResponseWriter, _ *http.Request, f portforwardhost.Failure) {
	if page, ok := failurePages[f.Kind]; ok {
		writeFailurePage(w, f.Status, page, f.Port)
		return
	}
	text, ok := failureTexts[f.Kind]
	if !ok {
		// 还不认识的那一种**不能沉默地套上面某一张页**：那等于替一件我们还不认识的
		// 事编一个下一步。
		text = incompleteText
	}
	writeFailureText(w, f.Status, text)
}

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

const (
	// failurePageContentType 是那四张页的类型。
	failurePageContentType = "text/html; charset=utf-8"
	// failureTextContentType 是那三句纯文本的类型，也是本层自有失败答复的类型
	// （portforward.go 的 answer）。
	failureTextContentType = "text/plain; charset=utf-8"
)

// writeFailurePage 把一张页写出去。
func writeFailurePage(w http.ResponseWriter, status int, page failurePage, port uint32) {
	writeFailureBody(w, status, failurePageContentType, fmt.Sprintf(failurePageTemplate,
		page.heading, page.heading, fmt.Sprintf(page.detail, port), devicesPath))
}

// writeFailureText 把一句话写出去，形状与共享包的默认答复一致（末尾带换行）。
func writeFailureText(w http.ResponseWriter, status int, text string) {
	writeFailureBody(w, status, failureTextContentType, text+"\n")
}

// writeFailureBody 是这个文件所有答复的唯一出口。
//
// 缓存语义与共享包的默认答复同一套：no-store。一张 404 的失败页按 HTTP 的启发式规则
// 本来是可以被浏览器缓存的，而它说的是一件随时会变的事（映射建好了、服务起起来了）。
//
// Content-Length 显式删掉：这里写的是**自己**这一段正文，头里若留着一个别的数，
// 浏览器就会按那个数截断它。今天没有哪条来路会留下这个头——共享代理判出失败时还一个
// 响应头都没往 w 里放（proxy.go 里 fail 的四处调用全在拷贝设备响应头之前），控制器
// 自己那条（portforward.go 的 answer）更是连代理都没借到——所以这一行不是在替谁兜
// 底，只是让这个出口的答复自洽，不取决于调用方在 header 里留过什么。
func writeFailureBody(w http.ResponseWriter, status int, contentType, body string) {
	header := w.Header()
	header.Set("Content-Type", contentType)
	header.Set("Cache-Control", "no-store")
	header.Del("Content-Length")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
