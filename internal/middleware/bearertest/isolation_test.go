package bearertest_test

import (
	"os/exec"
	"strings"
	"testing"
)

// bearertestPkg 是本包的完整导入路径。它的 Resolver 认它自己发出的每一枚令牌，
// 只允许出现在测试二进制里。
const bearertestPkg = "github.com/agentre-hub/agentre-server/internal/middleware/bearertest"

// productionBinaries 列出所有会被发布出去的构建目标。新增 cmd/xxx 入口时，一并加到这里。
var productionBinaries = []string{
	"github.com/agentre-hub/agentre-server/cmd/server",
}

// TestBearertestNotLinkedIntoProductionBinary 断言 bearertest 不在任何生产二进制的依赖图里。
//
// 不用 build tag，因为 tag 拦不住生产代码
// import 本包——而那正是这道后门真正进入二进制的路径。
func TestBearertestNotLinkedIntoProductionBinary(t *testing.T) {
	for _, target := range productionBinaries {
		out, err := exec.Command("go", "list", "-deps", target).Output()
		if err != nil {
			t.Fatalf("go list -deps %s: %v", target, err)
		}
		for dep := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
			if strings.TrimSpace(dep) == bearertestPkg {
				t.Errorf("%s 依赖 %s——一个认任何自发令牌的解析方会被链接进生产二进制；"+
					"bearertest 只允许被 _test.go 引用", target, bearertestPkg)
			}
		}
	}
}
