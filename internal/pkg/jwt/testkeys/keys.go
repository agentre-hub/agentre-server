//go:build test || jwttestkeys

// Package testkeys 提供单元测试使用的固定 RSA 密钥对。
// 仅在带 build tag 时编译，绝不进生产二进制。
package testkeys

import _ "embed"

//go:embed hubtest.key
var PrivatePEM []byte

//go:embed hubtest.pub
var PublicPEM []byte
