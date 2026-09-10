package jwt

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// accountPeerFingerprintDomain 把派生钉在这一个用途上：换一个域串就是换一批身份，
// 所以它必须是常量、写在这里、并且永不改动 —— 改一次等于全账号的网页对端集体换人，
// 此前从网页发起的对话在镜像里当场成为孤儿。
const accountPeerFingerprintDomain = "agentre:account-web-peer:"

// AccountPeerFingerprint 交出一个账号的网页对端身份（决策 9）。
//
// 它由账号派生而不是浏览器自己生成，因此同一账号清空站点数据、换一台设备打开网页
// 拿到的仍是同一个值；而它**不进 devices 表**——浏览器不是可寻址设备，
// device_ctr/relay_ticket_test.go 那条边界是刻意的。
//
// 形态与设备指纹一致（sha256:<hex>），daemon 侧不必为两种来源分两条解析。
func AccountPeerFingerprint(userID int64) string {
	sum := sha256.Sum256([]byte(accountPeerFingerprintDomain + strconv.FormatInt(userID, 10)))
	return "sha256:" + hex.EncodeToString(sum[:])
}
