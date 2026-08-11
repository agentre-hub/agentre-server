package usercode

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestGenerate_Format(t *testing.T) {
	for i := 0; i < 1000; i++ {
		c := Generate()
		// 形如 ABC-DEF
		assert.Len(t, c, 7, "code %q wrong length", c)
		assert.Equal(t, byte('-'), c[3], "missing dash in %q", c)
		for _, r := range c {
			if r == '-' {
				continue
			}
			assert.Contains(t, Alphabet, string(r), "%q has forbidden char %q", c, r)
		}
	}
}

// TestGenerate_Unique 在码空间里抽 10000 个样本，断言碰撞数不超生日上界。
//
// 码空间 32^6 ≈ 1.07e9；10000 个样本的生日碰撞期望数是 n²/(2N) ≈ 0.047，
// 即「恰好在这一次抽样里撞上」的概率约 4.7% —— 所以**不能断言零碰撞**：
// 那会在正常的随机下偶发红（曾以 collision at 5878 红在 CI 上）。
// 改成「碰撞 ≤ 4」把误报率压到泊松 P(X≥5) ≈ 2e-9/次（实际永远不会误报），
// 同时仍能抓住码空间被大幅缩小的回归（例如 codeLen 6→4 时期望碰撞约 48 个）。
func TestGenerate_Unique(t *testing.T) {
	const (
		n     = 10000
		allow = 4
	)
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		seen[Generate()] = struct{}{}
	}
	assert.LessOrEqual(t, n-len(seen), allow,
		"碰撞 %d 个，远超生日上界，码空间可能被大幅缩小（alphabet/codeLen 回归？）",
		n-len(seen))
}

func TestNormalize(t *testing.T) {
	cases := []struct {
		in       string
		expected string
		ok       bool
	}{
		{"A4F-7Q2", "A4F-7Q2", true},
		{"a4f-7q2", "A4F-7Q2", true},
		{"a4f 7q2", "A4F-7Q2", true},     // 空格当分隔符
		{"A4F7Q2", "A4F-7Q2", true},      // 无分隔符
		{"  A4F-7Q2  ", "A4F-7Q2", true}, // 前后空白
		{"A4F-7Q", "", false},            // 短
		{"A4F-7Q21", "", false},          // 长
		{"O0I1L-XXX", "", false},         // 包含禁止字符
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := Normalize(c.in)
		assert.Equal(t, c.ok, ok, "in=%q", c.in)
		if ok {
			assert.Equal(t, c.expected, got, "in=%q", c.in)
		}
	}
}
