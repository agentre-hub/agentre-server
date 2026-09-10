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

// pinnedWireVersion 读 frontend/pnpm-lock.yaml，返回钉住的 @agentre-hub/agentre-wire
// 版本。它是仓库里**已提交**的那份「钉住的包到底是哪个版本」的记录（node_modules 不
// 入库，CI 的 test-backend 也不装前端依赖），并且每次改 pin 重装都会跟着动。Go 读不到
// package.json，这是 Protocol 与 MinSupported 两条常量守卫共用的唯一锚点。
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

// Given 协议版本的主人是 @agentre-hub/agentre-wire 的 package.json，而这个仓库只钉一个
// 不可变 revision 消费它；When 读 Go 侧那个复述出来的常量；Then 它必须与钉住的那份包
// 的版本逐字相等。这条守卫是唯一挡住「握手自报一个没人认的版本」的东西。
func TestProtocol_GivenThePinnedWirePackage_WhenCompared_ThenTheGoConstantMatchesVerbatim(t *testing.T) {
	t.Parallel()

	require.Equal(t, pinnedWireVersion(t), wireversion.Protocol,
		"wireversion.Protocol 必须与 frontend/package.json 钉住的 @agentre-hub/agentre-wire 版本一同更新")
}

// Given server 侧新增的 MinSupported 复述的是与 Protocol 同一个来源（钉住的
// @agentre-hub/agentre-wire 版本）；When 与钉住的包版本及 Protocol 分别对比；Then 三者
// 逐字相等 —— 本轮它不产生宽限（spec 决策 3：「本轮它与 Protocol 相等、不产生宽限」），
// 漏改任何一处都必须炸,而不是悄悄留下一个比 Protocol 更旧的 floor。
func TestMinSupported_GivenThePinnedWirePackageAndProtocol_WhenCompared_ThenTheGoConstantMatchesBothVerbatim(t *testing.T) {
	t.Parallel()

	require.Equal(t, pinnedWireVersion(t), wireversion.MinSupported,
		"wireversion.MinSupported 必须与 frontend/package.json 钉住的 @agentre-hub/agentre-wire 版本一同更新")
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
