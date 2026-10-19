package redirectpath

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Local 是登录后「回到哪」与转发登录「回到哪」的唯一判据，也就是这两条流程有没有
// 开放重定向。按 WHATWG URL 规范，特殊 scheme（http/https）下反斜杠与斜杠等价，于是
// /\evil.com 在浏览器里会被解析成 protocol-relative URL，跳出本站。反斜杠与正斜杠
// 必须同等对待。
func TestLocal(t *testing.T) {
	for _, c := range []struct {
		name string
		in   string
		want string
	}{
		{name: "空 → 首页", in: "", want: "/"},
		{name: "站内路径原样保留", in: "/devices?tab=all", want: "/devices?tab=all"},
		{name: "协议相对 URL", in: "//evil.com", want: "/"},
		{name: "绝对 URL", in: "https://evil.com", want: "/"},
		{name: "反斜杠的协议相对 URL", in: "/\\evil.com", want: "/"},
		{name: "反斜杠开头", in: "\\evil.com", want: "/"},
		{name: "反斜杠混斜杠", in: "/\\/evil.com", want: "/"},
		{name: "斜杠混反斜杠", in: "//\\evil.com", want: "/"},
		// 浏览器解析前会把 tab / CR / LF 从 URL 里剥掉，于是这几个也都是 //evil.com。
		{name: "tab 撑开的协议相对 URL", in: "/\t/evil.com", want: "/"},
		{name: "换行撑开的协议相对 URL", in: "/\n/evil.com", want: "/"},
		{name: "回车撑开的协议相对 URL", in: "/\r/evil.com", want: "/"},
		{name: "DEL", in: "/a\x7fb", want: "/"},
	} {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, Local(c.in))
		})
	}
}
