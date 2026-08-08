package usercode

import (
	"strings"
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

func TestGenerate_Unique(t *testing.T) {
	seen := map[string]struct{}{}
	for i := 0; i < 10000; i++ {
		c := Generate()
		if _, ok := seen[c]; ok {
			t.Fatalf("collision at %d: %s", i, c)
		}
		seen[c] = struct{}{}
	}
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
	_ = strings.Builder{}
}
