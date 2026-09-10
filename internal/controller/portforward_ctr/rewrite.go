package portforward_ctr

import (
	"bufio"
	"net"
	"net/http"
)

// failureRewriter 是包在 gin 的 ResponseWriter 外面的那一层，它只做一件事：**在共享包
// 答出 502 的那一刻，把那句纯文本换成一张完整的失败页**（规格决策 7）。
//
// 为什么非得在这里拦：共享包 portforwardhost 今天把七种失败全答成 text/plain + 写死
// 中文，没留任何渲染钩子；而用户此刻在浏览器标签里，需要的是一张说清下一步、且带得出
// 两个出口的页。回上游加钩子要再开一轮跨仓（记为下一轮）。
//
// 它看得见全部失败，也不会误伤成功的响应：共享包四处 writeFailure 全部发生在**响应头
// 到达之前**；头一旦发出就只会截断、不会再改状态码。
//
// # 三条纪律
//
//  1. **只缓冲到第一次 WriteHeader 的决策为止。** 状态码一定下来，这一层此后一个字节
//     都不再经手——攒响应体等于把流式与大文件下载一起掐掉。
//  2. **Flusher / Hijacker / Unwrap 一个都不能少。** 代理要 Flusher 做流式、要 Hijacker
//     做 101 升级，而它取这两个能力走的是 http.NewResponseController，靠 Unwrap 往下
//     找。少一个，流式或 WebSocket 当场失效（internal/api/portforward 那两条看门用例
//     会红）。
//  3. **判据只有状态码。** 不认上游的文案：那几句中文常量在上游仓且未导出，上游改一个
//     字这里就静默失灵，而本仓不会有任何东西红（决策 13）。
type failureRewriter struct {
	inner http.ResponseWriter
	// classify 在**看见 502 的那一刻**才被调用，交回该给用户的那张页。502 分不开
	// 「端口上没有服务」与「设备离线」，所以判据是二次在线读，见 PortForward.badGateway。
	classify func() failurePage
	// port 是页面里那句「127.0.0.1:<端口>」。
	port uint32

	// decided 是「状态码已经定下来了」。定下来之后这一层不再插手。
	decided bool
	// swallow 是「这次答复已经被换成失败页了」，此后上游写来的正文一律丢掉——留着
	// 就是把共享包那句纯文本追加在 </html> 后面。
	swallow bool
}

func (w *failureRewriter) Header() http.Header { return w.inner.Header() }

func (w *failureRewriter) WriteHeader(status int) {
	if w.decided {
		if !w.swallow {
			// 重复的 WriteHeader 交给底下那层照旧抱怨，与没有这一层时一模一样。
			w.inner.WriteHeader(status)
		}
		return
	}
	w.decided = true
	if status != http.StatusBadGateway {
		// 404（没有这个映射）、403（映射已停用）、500（升级失败）以及被转发应用自己的
		// 任何答复：状态码各自独立，原样放过（规格「失败的呈现」）。
		w.inner.WriteHeader(status)
		return
	}
	w.swallow = true
	writeFailurePage(w.inner, status, w.classify(), w.port)
}

func (w *failureRewriter) Write(chunk []byte) (int, error) {
	if !w.decided {
		w.WriteHeader(http.StatusOK)
	}
	if w.swallow {
		// 报「全写进去了」：上游那句纯文本已经被这一页取代，让它以为写失败只会让它
		// 提前收场，而收场本身还有别的出口。
		return len(chunk), nil
	}
	return w.inner.Write(chunk)
}

// Flush 同时也是一次状态码决策：net/http 的语义里 Flush 会把还没发的响应头发出去，
// 不在这里定下来的话，之后再来一个 502 就会在头已经上路之后才想改它。
func (w *failureRewriter) Flush() {
	if !w.decided {
		w.WriteHeader(http.StatusOK)
	}
	if w.swallow {
		return
	}
	if flusher, ok := w.inner.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Hijack 把连接交出去。交出去之后这一层再也看不见状态码（101 之后两个方向都只搬
// 字节），所以先把决策关掉。
func (w *failureRewriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.inner.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	w.decided = true
	return hijacker.Hijack()
}

// Unwrap 让 http.ResponseController 找得到底下那个 writer。共享包的 serveUpgraded 与
// 下行泵走的都是它。
func (w *failureRewriter) Unwrap() http.ResponseWriter { return w.inner }
