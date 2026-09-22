// Package redirectpath 是「一个请求方给的跳转落点能不能原样放进 Location」这一件事的
// 唯一判据。登录后的 next（auth_ctr）与转发登录的 return（portforward_ctr）问的是
// 同一个问题，两份各写一遍迟早漂开，而漂开的那一份就是一个开放重定向。
package redirectpath

import "strings"

// Local 仅允许本站的相对路径；其它一律收敛成 "/"。
//
// 判据不是「以 / 开头、且不以 // 开头」那么简单，因为浏览器解析 URL 的规则比这条宽：
//
//   - **反斜杠等于斜杠。** 按 WHATWG URL 规范，特殊 scheme（http/https）下 \ 与 /
//     等价，所以 /\evil.com 在浏览器里就是 //evil.com —— 一个跳出本站的
//     protocol-relative URL，而上面那条判据放它过去。
//   - **控制字符会先被删掉。** 浏览器在解析前剥掉 URL 里的 tab / CR / LF，于是
//     "/<TAB>/evil.com" 也变成 //evil.com。
//
// 所以这里反过来做：必须以 / 开头，第二个字符不能是 / 或 \，并且整串不含反斜杠与
// 控制字符。真实的路径不需要这两类字符（要带就得是百分号编码），因此这条收紧不会
// 挡掉任何正常的落点。
func Local(in string) string {
	if !strings.HasPrefix(in, "/") || strings.HasPrefix(in, "//") {
		return "/"
	}
	if strings.ContainsFunc(in, func(r rune) bool { return r == '\\' || r < 0x20 || r == 0x7f }) {
		return "/"
	}
	return in
}
