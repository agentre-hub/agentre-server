package wireversion_test

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"github.com/agentre-hub/agentre-server/internal/pkg/wireversion"
)

// pinnedWireVersion 读 frontend/pnpm-lock.yaml，返回 npm 那一侧钉住的
// @agentre-hub/agentre-wire 是哪个版本。它是仓库里**已提交**的那份记录（node_modules
// 不入库，CI 的 test-backend 也不装前端依赖），并且每次改 pin 重装都会跟着动 —— Go
// 读不到 package.json，这是从 Go 侧看得见 npm pin 的唯一锚点。
func pinnedWireVersion(t *testing.T) string {
	t.Helper()

	_, filename, _, ok := runtime.Caller(0)
	require.True(t, ok, "resolve guard test path")
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", ".."))

	// lockPath 由本测试文件自身在仓库里的位置推出，不来自输入。
	lockPath := filepath.Join(repoRoot, "frontend", "pnpm-lock.yaml")
	raw, err := os.ReadFile(lockPath)
	require.NoError(t, err)

	var lock struct {
		Packages map[string]struct {
			Version string `yaml:"version"`
		} `yaml:"packages"`
	}
	require.NoError(t, yaml.Unmarshal(raw, &lock))

	const wirePackage = "@agentre-hub/agentre-wire@"
	var pinned []string
	for key, entry := range lock.Packages {
		if len(key) > len(wirePackage) && key[:len(wirePackage)] == wirePackage {
			pinned = append(pinned, entry.Version)
		}
	}
	require.Len(t, pinned, 1, "锁文件里应当只钉住一个 @agentre-hub/agentre-wire")
	require.NotEmpty(t, pinned[0], "锁文件没记下 @agentre-hub/agentre-wire 的版本")
	return pinned[0]
}

// Given 这个仓库在两条轴上钉同一份 wire 协议 —— go.mod 里 pkg/wire 的 Go module
// revision，与 frontend/pnpm-lock.yaml 里 @agentre-hub/agentre-wire 的 npm pin —— 两边各
// 自有一个客户端在握手里自报版本（Go 侧 mirror_svc，浏览器侧 relay client 的
// PROTOCOL_VERSION）；When 把 npm 那一侧钉住的包版本，与 Go 那一侧从已钉 module 的
// schema 里读出来的 Protocol 对比；Then 两者逐字相等。
//
// 这条守卫已经不是「Go 常量复述了 npm pin」了：Protocol 现在直接来自 schema 自报的那
// 一格，没有抄本可漂。它改瞄准的是另一件事 —— 同一次构建里，浏览器打包的那份 wire 与
// Go 链接的那份 wire 必须声明同一代协议。下面的 TestPins_ 要求两条 pin 指向同一 commit，
// 这条是同一件事的语义面：比的是真的那个版本值，而不是 commit 相等这个代理。
func TestProtocol_GivenTheGoAndNpmPinsOfTheWireProtocol_WhenCompared_ThenBothDeclareTheSameVersion(t *testing.T) {
	t.Parallel()

	require.Equal(t, pinnedWireVersion(t), wireversion.Protocol,
		"go.mod 里 pkg/wire 的 pin 与 frontend/pnpm-lock.yaml 里 @agentre-hub/agentre-wire 的 pin 必须声明同一代协议")
}

// Given MinSupported 是本次构建自己的策略（「还接受多老的对端」），不是协议的属性，
// 所以它是本包唯一还留着的字面量；When 与本次握手自报的 Protocol 对比；Then 两者逐字
// 相等 —— 本轮窗口是一个点，不产生宽限（spec「协议：版本窗口与自报版本」决策 3）。
//
// 它此前比的是锁文件里钉住的包版本，那只是绕道说同一件事；现在 Protocol 自己就是那个
// 值，直接比即可。这条守卫不能删：本仓没有桌面仓 methodset_test.go 那条无条件断言
// MinSupported == Protocol 的守恒律，删掉之后这个下限就无人看管，可以悄悄落后于
// Protocol 而没人发难。要真的张开宽限窗口，请连同这条守卫一起有意改写。
func TestMinSupported_GivenThisBuildsOwnFloor_WhenComparedToProtocol_ThenTheWindowIsASinglePoint(t *testing.T) {
	t.Parallel()

	require.Equal(t, wireversion.Protocol, wireversion.MinSupported,
		"本轮 MinSupported 与 Protocol 相等，不产生宽限窗口（spec 决策 3）")
}

// Given Go 与 TypeScript 都消费同一份 wire 源码；When 两边各自钉不可变 revision；
// Then revision 必须相同。go.work 会让本地 Go 测试直接使用兄弟仓源码，这条守卫专门
// 防止独立 CI/构建下载到旧 Go module、前端却打包了更新的 TypeScript codec。
func TestPins_GivenGoAndTypeScriptWireDependencies_WhenCompared_ThenTheyUseTheSameRevision(t *testing.T) {
	t.Parallel()

	_, filename, _, ok := runtime.Caller(0)
	require.True(t, ok, "resolve guard test path")
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", ".."))

	manifest, err := os.ReadFile(filepath.Join(repoRoot, "frontend", "package.json"))
	require.NoError(t, err)
	goMod, err := os.ReadFile(filepath.Join(repoRoot, "go.mod"))
	require.NoError(t, err)

	tsMatch := regexp.MustCompile(`agentre-wire[^\n]*#([0-9a-f]{40})`).FindSubmatch(manifest)
	require.Len(t, tsMatch, 2, "frontend/package.json 必须把 agentre-wire 钉到完整 commit")
	goMatch := regexp.MustCompile(`agentre/pkg/wire v0\.0\.0-[0-9]{14}-([0-9a-f]{12})`).FindSubmatch(goMod)
	require.Len(t, goMatch, 2, "go.mod 必须把 pkg/wire 钉到 Go pseudo-version")

	require.True(t, strings.HasPrefix(string(tsMatch[1]), string(goMatch[1])),
		"Go pkg/wire 与 TypeScript agentre-wire 必须来自同一 commit")
}
