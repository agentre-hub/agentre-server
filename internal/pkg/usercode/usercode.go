// Package usercode 生成与规范化 RFC 8628 Device Flow 的 user_code。
//
// 字符集 32 字符，去 0/O/I/1/L 防混淆；6 位有效字符 + 1 个分隔符 '-'。
// 32^6 ≈ 1.07e9，10 分钟 TTL 下碰撞极不可能。
package usercode

import (
	"crypto/rand"
	"math/big"
	"strings"
)

const Alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

const codeLen = 6

// Generate 返回如 "A4F-7Q2" 的随机码。
func Generate() string {
	buf := make([]byte, codeLen)
	n := big.NewInt(int64(len(Alphabet)))
	for i := range buf {
		v, err := rand.Int(rand.Reader, n)
		if err != nil {
			panic(err)
		}
		buf[i] = Alphabet[v.Int64()]
	}
	return string(buf[:3]) + "-" + string(buf[3:])
}

// Normalize 接受大小写、空格和可选分隔符，返回 "XXX-XXX" 或失败。
func Normalize(in string) (string, bool) {
	s := strings.ToUpper(strings.TrimSpace(in))
	cleaned := make([]byte, 0, codeLen)
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch == '-' || ch == ' ' {
			continue
		}
		if !strings.ContainsRune(Alphabet, rune(ch)) {
			return "", false
		}
		cleaned = append(cleaned, ch)
		if len(cleaned) > codeLen {
			return "", false
		}
	}
	if len(cleaned) != codeLen {
		return "", false
	}
	return string(cleaned[:3]) + "-" + string(cleaned[3:]), true
}
