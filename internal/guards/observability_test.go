// Package guards 存放跨仓库的机械守卫测试。
//
// 这里的测试不测任何业务行为，只断言「约定仍然被强制执行」：
// 配置里的规则还在、代码里没有出现被禁的形态。
// 它们跑在 `make test` 里，因此和业务测试一样会挡住 CI。
package guards_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// repoRoot 从当前包（internal/guards）回到仓库根。
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("repo root %s 里没有 go.mod: %v", root, err)
	}
	return root
}

// TestForbidigoStillWired 断言日志出口守卫还挂在 .golangci.yml 上。
//
// 光靠 golangci-lint 本身是不够的：规则被人从配置里删掉之后，lint 依旧是绿的，
// 没有任何信号。这条测试让「删掉规则」这件事本身变成一次失败的构建。
func TestForbidigoStillWired(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot(t), ".golangci.yml"))
	if err != nil {
		t.Fatalf("read .golangci.yml: %v", err)
	}

	var cfg struct {
		Linters struct {
			Enable   []string `yaml:"enable"`
			Settings struct {
				Forbidigo struct {
					Forbid []struct {
						Pattern string `yaml:"pattern"`
					} `yaml:"forbid"`
				} `yaml:"forbidigo"`
			} `yaml:"settings"`
		} `yaml:"linters"`
	}
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("parse .golangci.yml: %v", err)
	}

	if !slices.Contains(cfg.Linters.Enable, "forbidigo") {
		t.Fatal("linters.enable 里没有 forbidigo —— 日志出口守卫失效了。" +
			"见 docs/observability.md#logging")
	}

	var patterns []string
	for _, f := range cfg.Linters.Settings.Forbidigo.Forbid {
		patterns = append(patterns, f.Pattern)
	}
	for _, want := range []string{`^fmt\.Print.*$`, `^log\.(Print|Fatal|Panic).*$`} {
		if !slices.Contains(patterns, want) {
			t.Errorf("forbidigo.forbid 里缺少 %q —— 这条禁令没了。\n当前 patterns: %v", want, patterns)
		}
	}
}

// sensitiveFieldNames 是绝不允许原样进日志的字段名。
// 命中判断会先归一化（转小写、去掉下划线和连字符）。
var sensitiveFieldNames = []string{
	"password", "passwd", "secret", "clientsecret", "sessionsecret",
	"token", "accesstoken", "refreshtoken", "idtoken",
	"privatekey", "pem", "authorization", "cookie", "credential",
	"apikey", "otp", "usercode", "devicecode",
}

// safeSuffixes 是允许出现的派生形态——它们不含明文。
var safeSuffixes = []string{"hash", "id", "ttl", "expiresat", "kind", "type", "count", "len"}

// TestNoSensitiveFieldsInLogs 扫描所有非测试 Go 源码，
// 断言没有把敏感字段原样塞进 zap 字段。
//
// 目前仓库里是 0 违规，所以这是一条零成本锁定：现在钉住，
// 以后谁想 log 一个 refresh_token 会在 CI 上直接被拦下来，
// 而不是等到某天有人在日志里翻到一串能直接用的凭据。
func TestNoSensitiveFieldsInLogs(t *testing.T) {
	root := repoRoot(t)
	fset := token.NewFileSet()
	var violations []string

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			switch info.Name() {
			case "node_modules", "frontend", "dist", ".git", "bin":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return nil // 语法错误交给编译器报，不是这条守卫的职责
		}

		rel, _ := filepath.Rel(root, path)
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "zap" {
				return true
			}
			lit, ok := call.Args[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			key := strings.Trim(lit.Value, `"`)
			if isSensitive(key) {
				violations = append(violations, fmt.Sprintf(
					"%s:%d zap.%s(%q, ...)",
					rel, fset.Position(call.Pos()).Line, sel.Sel.Name, key,
				))
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(violations) > 0 {
		t.Errorf(
			"以下位置把敏感字段写进了日志：\n  %s\n\n"+
				"日志会进 logFile、会被采集、会被更多人看到——凭据一旦落进去就等于泄露。\n"+
				"改法：只记不可逆的派生值（%s 后缀），或者干脆不记这个字段。\n"+
				"见 docs/observability.md#sensitive-fields",
			strings.Join(violations, "\n  "),
			strings.Join(safeSuffixes, " / "),
		)
	}
}

func isSensitive(key string) bool {
	norm := strings.ToLower(key)
	norm = strings.ReplaceAll(norm, "_", "")
	norm = strings.ReplaceAll(norm, "-", "")

	for _, suffix := range safeSuffixes {
		if strings.HasSuffix(norm, suffix) {
			return false
		}
	}
	for _, bad := range sensitiveFieldNames {
		if strings.Contains(norm, bad) {
			return true
		}
	}
	return false
}
