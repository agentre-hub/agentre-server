package api_test

import (
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// 分层守卫。依赖只允许单向流动 —— app/controller → service → repository → model/entity，
// 而 internal/api 是**最上层**的传输契约（请求 / 响应 DTO 与路由注册）。
//
// 两条反向边必须为假，而它们在编译期完全合法，只有读 import 才看得见：
//
//  1. service / repository / model / pkg 不得 import internal/api 或 internal/controller。
//     服务层把 HTTP 响应 DTO 当返回值，等于让传输契约成为领域契约的一部分：改一个
//     json tag、加一个响应字段，就变成改服务层的签名；反过来服务层的调用方也再分不清
//     自己拿到的是领域对象还是「某个端点的形状」。正确做法是服务返回自己的 view，
//     controller 负责 view → DTO 的映射（internal/api 里做的就应该是这件事）。
//
//  2. internal/pkg 不得 import service / repository。它是横向工具层（错误码、jwt、
//     session…），反向依赖会让它再也不能被独立测试或复用，而「工具包认得业务」这件事
//     一旦发生就会自我强化。
//
//  3. controller 不得越过 service 直连 internal/repository。前两条大部分情况下会先被
//     编译器拦下（service / repository 反向依赖 api 或 model 多半直接成环），**这一条不会**：
//     repository 不认识 controller，所以 controller → repository 是一个完全合法、能编译、
//     能跑的新边。它唯一的代价要到以后才显形：仓储从「service 的实现细节」变成两个入口都
//     能改的共享状态，「一个业务动作要同时改哪几处」失去唯一落点；需要一次简单查询时，正确
//     做法是在 service 上开一个窄方法（DIP），不是把 repository 递出来。
//
// 只查**生产** import：测试文件偶尔要 import api 去断言请求 DTO 的 binding tag（例如
// mirror_svc 断言 DeviceAuthorizeRequest.Fingerprint 的 min/max 窗口），那是「测试读
// 契约」，不是生产依赖方向。
//
// 组合根（internal/bootstrap）不在这些规则里：它天生要认识每一层，它认识谁正是它存在的
// 理由。规则按被依赖方分类，所以 bootstrap 不会被误伤。
func TestLayeringDependenciesPointOneWay(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("go", "list", "-f", `{{.ImportPath}}|{{join .Imports " "}}`, "./internal/...") //nolint:gosec // 参数是本仓固定的包模式
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, out)
	}

	const module = "github.com/agentre-hub/agentre-server/"

	// layerOf 把仓外 import 归成空串，仓内的去掉 module 前缀。
	layerOf := func(path string) string {
		if !strings.HasPrefix(path, module) {
			return ""
		}
		return strings.TrimPrefix(path, module)
	}

	rules := []struct {
		describe string
		violated func(dependant, dependency string) bool
	}{
		{
			describe: "service / repository / model / pkg 不得 import internal/api 或 internal/controller",
			violated: func(dependant, dependency string) bool {
				lower := strings.HasPrefix(dependant, "internal/service/") ||
					strings.HasPrefix(dependant, "internal/repository/") ||
					strings.HasPrefix(dependant, "internal/model/") ||
					strings.HasPrefix(dependant, "internal/pkg/")
				upper := strings.HasPrefix(dependency, "internal/api") ||
					strings.HasPrefix(dependency, "internal/controller")
				return lower && upper
			},
		},
		{
			describe: "internal/pkg 不得 import service / repository",
			violated: func(dependant, dependency string) bool {
				isPkg := strings.HasPrefix(dependant, "internal/pkg/")
				lower := strings.HasPrefix(dependency, "internal/service/") ||
					strings.HasPrefix(dependency, "internal/repository/")
				return isPkg && lower
			},
		},
		{
			describe: "internal/controller 不得越过 service 直连 internal/repository",
			violated: func(dependant, dependency string) bool {
				return strings.HasPrefix(dependant, "internal/controller/") &&
					strings.HasPrefix(dependency, "internal/repository/")
			},
		},
	}

	packages := 0
	var violations []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "|", 2)
		if len(parts) != 2 {
			continue
		}
		dependant, imports := layerOf(parts[0]), strings.Fields(parts[1])
		if dependant == "" {
			continue
		}
		packages++
		for _, importPath := range imports {
			dependency := layerOf(importPath)
			if dependency == "" {
				continue
			}
			for _, r := range rules {
				if r.violated(dependant, dependency) {
					violations = append(violations, r.describe+" —— "+dependant+" → "+dependency)
				}
			}
		}
	}

	// 自证不空过：一个包都没读到（或包模式失效）时全绿是没有意义的。
	if packages == 0 {
		t.Fatal("go list 没列出任何包，守卫会静默全绿")
	}

	sort.Strings(violations)
	for _, violation := range violations {
		t.Errorf("依赖方向反了：%s", violation)
	}
}
