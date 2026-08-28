package testkeys_test

import (
	"os/exec"
	"strings"
	"testing"
)

// testkeysPkg 是本包的完整导入路径；它 embed 了一对固定 RSA 私钥，
// 只允许出现在测试二进制里。
const testkeysPkg = "github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"

// productionBinaries 列出所有会被发布出去的构建目标。
// 新增 cmd/xxx 入口时，一并加到这里。
var productionBinaries = []string{
	"github.com/agentre-hub/agentre-server/cmd/server",
}

// TestTestkeysNotLinkedIntoProductionBinary 断言 testkeys 不在任何生产二进制的依赖图里。
//
// 这是隔离测试专用密钥的正确手段，不要改用 build tag：tag 只能保证「本文件不被编译」，
// 拦不住生产代码 import 本包——而那才是私钥真正会进二进制的路径。
func TestTestkeysNotLinkedIntoProductionBinary(t *testing.T) {
	for _, target := range productionBinaries {
		out, err := exec.Command("go", "list", "-deps", target).Output()
		if err != nil {
			t.Fatalf("go list -deps %s: %v", target, err)
		}
		for dep := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
			if strings.TrimSpace(dep) == testkeysPkg {
				t.Errorf(
					"%s 依赖 %s——测试用 RSA 私钥会被链接进生产二进制。\n"+
						"请改用 bootstrap.LoadServerConfig 从 JWT_PRIVATE_KEY_PEM 注入真实密钥；"+
						"testkeys 只允许被 _test.go 引用。详见 docs/testing.md#test-keys",
					target, testkeysPkg,
				)
			}
		}
	}
}
