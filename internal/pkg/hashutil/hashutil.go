// Package hashutil 收纳各域共用的简单摘要算法。
//
// 它住在 internal/pkg：设备令牌以 sha256 摘要落库、头像以正文 sha256 做内容哈希，
// 两处必须逐字节同一种写法（大小写、编码），各写一份就是各漏一次的机会。
package hashutil

import (
	"crypto/sha256"
	"encoding/hex"
)

// SHA256Hex 交出正文 sha256 的小写十六进制。
func SHA256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
