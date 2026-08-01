// Package testkeys 提供单元测试使用的固定 RSA 密钥对。
//
// 本包只允许被 *_test.go 引用，因此不会被链接进 cmd/server 生产二进制。
// 这条性质由 isolation_test.go 断言，生产代码一旦 import 本包就会红。
package testkeys

import _ "embed"

//go:embed hubtest.key
var PrivatePEM []byte

//go:embed hubtest.pub
var PublicPEM []byte
