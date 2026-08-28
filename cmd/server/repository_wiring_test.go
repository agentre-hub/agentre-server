package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// 本守卫钉住的是「repository 单例装配」这一整类，而不是某一个 repo。
//
// 每个 repository 包都是同一副骨架：包级 `var defaultXxx XxxRepo` + `RegisterXxx()`
// 写入 + `Xxx()` 读出。accessor 在没人 Register 过的时候返回的是 nil 接口，于是
// service 第一次调用它就空指针 panic——而且只在生产上 panic：单测自己会调
// RegisterXxx(mock)，所以整套测试永远绿。webauthn_credential_repo 就是这么漏的：
// 它的 Register 在 b3d753d 里一次都没被写进 cmd/server/main.go，全部通行密钥端点
// 在真实服务器上首次调用即 500，直到 e2e 才暴露。
//
// 守卫放在 cmd/server/ 是因为它守的就是 main() 里那段注册块（docs/testing.md：
// guard 与被守的东西放在一起）。扫描范围同时包含 internal/bootstrap/：启动期装配
// 眼下分居两处（repository 在 main.go，service 单例在 bootstrap.RegisterDefaults），
// 把注册块搬去 bootstrap 是合法重构，不该因此把守卫弄红。
const repositoryImportPrefix = "github.com/agentre-hub/agentre-server/internal/repository/"

// TestEveryRepositoryRegistrarIsWiredIntoStartup 断言：internal/repository 下每一个
// 「Register*/accessor 成对」的包级单例，都在生产启动路径上真的被注册过。
//
// 只认成对的那些：accessor 才是生产上返回 nil 的那一头，没有 accessor 的 Register
// 谁也 deref 不到。今天两种口径的结果完全一致（11 个 Register 全部带 accessor）。
func TestEveryRepositoryRegistrarIsWiredIntoStartup(t *testing.T) {
	root := moduleRoot(t)

	declared := declaredRepositoryRegistrars(t, filepath.Join(root, "internal", "repository"))
	if len(declared) == 0 {
		t.Fatal("在 internal/repository 下没扫到任何 Register*/accessor 组合——" +
			"守卫本身失效了（路径变了？包骨架换了？），而不是「没有需要注册的 repo」")
	}

	wired := wiredRegistrars(t,
		filepath.Join(root, "cmd", "server"),
		filepath.Join(root, "internal", "bootstrap"),
	)

	var missing []string
	for _, name := range declared {
		if !wired[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("以下 repository 单例没有在生产启动路径上注册：%s\n"+
			"未注册意味着 accessor 返回 nil 接口，对应端点在真实服务器上首次调用即 panic，"+
			"而单测因为自己调了 Register*(mock) 永远发现不了。\n"+
			"请在 cmd/server/main.go 的注册块里补上 <pkg>.Register<Xxx>(<pkg>.New<Xxx>())。",
			strings.Join(missing, ", "))
	}
}

// TestRepositoryWiringGuardReportsAMissingRegistration 是守卫自己的守卫：喂一份
// 「声明了两个单例、启动路径只注册了其中一个」的样本，确认漏掉的那个会被点名。
//
// 缺了这一条，上面那个测试在扫描逻辑写错（比如选择器匹配从来不命中）时会安静地全绿，
// 和「确实都注册了」长得一模一样——正是本轮要修的那个失败模式本身。
func TestRepositoryWiringGuardReportsAMissingRegistration(t *testing.T) {
	root := t.TempDir()
	repositoryRoot := filepath.Join(root, "internal", "repository")
	writeFixture(t, filepath.Join(repositoryRoot, "wired_repo", "wired.go"), `package wired_repo

type WiredRepo interface{ Do() }

var defaultRepo WiredRepo

func Wired() WiredRepo          { return defaultRepo }
func RegisterWired(i WiredRepo) { defaultRepo = i }
func NewWired() WiredRepo       { return nil }
`)
	writeFixture(t, filepath.Join(repositoryRoot, "forgotten_repo", "forgotten.go"), `package forgotten_repo

type ForgottenRepo interface{ Do() }

var defaultRepo ForgottenRepo

func Forgotten() ForgottenRepo          { return defaultRepo }
func RegisterForgotten(i ForgottenRepo) { defaultRepo = i }
func NewForgotten() ForgottenRepo       { return nil }
`)
	// 只有 accessor 的那一半不算数：没有 Register 就没有「忘记注册」可言。
	writeFixture(t, filepath.Join(repositoryRoot, "helper_repo", "helper.go"), `package helper_repo

func Helper() int { return 0 }
`)
	// 启动文件里用了别名导入，且只注册了两个里的一个。
	writeFixture(t, filepath.Join(root, "cmd", "server", "main.go"), `package main

import (
	aliased "github.com/agentre-hub/agentre-server/internal/repository/wired_repo"
)

func main() {
	aliased.RegisterWired(aliased.NewWired())
}
`)
	// 测试文件里的注册不算数：单测自己 Register(mock) 正是让漏装配藏住的原因。
	writeFixture(t, filepath.Join(root, "cmd", "server", "main_test.go"), `package main

import "github.com/agentre-hub/agentre-server/internal/repository/forgotten_repo"

func init() { forgotten_repo.RegisterForgotten(nil) }
`)

	declared := declaredRepositoryRegistrars(t, repositoryRoot)
	if want := []string{"forgotten_repo.RegisterForgotten", "wired_repo.RegisterWired"}; !slices.Equal(declared, want) {
		t.Fatalf("declaredRepositoryRegistrars() = %v, want %v", declared, want)
	}

	wired := wiredRegistrars(t, filepath.Join(root, "cmd", "server"))

	if !wired["wired_repo.RegisterWired"] {
		t.Error("别名导入的注册没被认出来——守卫会把已经装配好的 repo 误报成漏装配")
	}
	if wired["forgotten_repo.RegisterForgotten"] {
		t.Error("_test.go 里的注册被当成了生产装配——漏装配就是这样被单测掩盖的")
	}
}

// declaredRepositoryRegistrars 返回 repositoryRoot 下所有「Register*/accessor 成对」
// 的单例，形如 "user_repo.RegisterUser"，按名字排序。
func declaredRepositoryRegistrars(t *testing.T, repositoryRoot string) []string {
	t.Helper()

	var out []string
	for _, pkg := range parsePackages(t, repositoryRoot, true) {
		registrars := map[string]string{} // 单例名 -> 限定后的 Register 名
		accessors := map[string]bool{}
		for _, file := range pkg.files {
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Recv != nil || !fn.Name.IsExported() {
					continue
				}
				switch {
				case strings.HasPrefix(fn.Name.Name, "Register") && paramCount(fn) == 1:
					registrars[strings.TrimPrefix(fn.Name.Name, "Register")] = pkg.name + "." + fn.Name.Name
				case paramCount(fn) == 0 && resultCount(fn) == 1:
					accessors[fn.Name.Name] = true
				}
			}
		}
		for singleton, qualified := range registrars {
			if accessors[singleton] {
				out = append(out, qualified)
			}
		}
	}
	sort.Strings(out)
	return out
}

// wiredRegistrars 返回 dirs 下的非测试文件里实际调用到的 repository Register*，
// 键形如 "user_repo.RegisterUser"。导入别名按导入路径归一，因此改别名不会误报。
func wiredRegistrars(t *testing.T, dirs ...string) map[string]bool {
	t.Helper()

	out := map[string]bool{}
	for _, dir := range dirs {
		for _, pkg := range parsePackages(t, dir, false) {
			for _, file := range pkg.files {
				local := repositoryImportNames(file)
				ast.Inspect(file, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					sel, ok := call.Fun.(*ast.SelectorExpr)
					if !ok || !strings.HasPrefix(sel.Sel.Name, "Register") {
						return true
					}
					ident, ok := sel.X.(*ast.Ident)
					if !ok {
						return true
					}
					if pkgName, ok := local[ident.Name]; ok {
						out[pkgName+"."+sel.Sel.Name] = true
					}
					return true
				})
			}
		}
	}
	return out
}

// repositoryImportNames 把文件里对 internal/repository/* 的导入映射成
// 「本文件用的标识符 -> 包名」。
func repositoryImportNames(file *ast.File) map[string]string {
	out := map[string]string{}
	for _, spec := range file.Imports {
		importPath, err := strconv.Unquote(spec.Path.Value)
		if err != nil || !strings.HasPrefix(importPath, repositoryImportPrefix) {
			continue
		}
		pkgName := path.Base(importPath)
		local := pkgName
		if spec.Name != nil {
			local = spec.Name.Name
		}
		out[local] = pkgName
	}
	return out
}

type parsedPackage struct {
	name  string
	files []*ast.File
}

// parsePackages 解析 root 下的非测试 Go 文件；recursive 为真时逐层下钻（repository
// 是一层子包），否则只看 root 本身。mock_* 目录是 mockgen 产物，跳过。
func parsePackages(t *testing.T, root string, recursive bool) []parsedPackage {
	t.Helper()

	var out []parsedPackage
	fset := token.NewFileSet()
	walk := func(dir string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read dir %s: %v", dir, err)
		}
		pkg := parsedPackage{}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			file, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.SkipObjectResolution)
			if err != nil {
				t.Fatalf("parse %s: %v", filepath.Join(dir, name), err)
			}
			pkg.name = file.Name.Name
			pkg.files = append(pkg.files, file)
		}
		if len(pkg.files) > 0 {
			out = append(out, pkg)
		}
	}

	if !recursive {
		walk(root)
		return out
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read dir %s: %v", root, err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), "mock_") {
			continue
		}
		walk(filepath.Join(root, entry.Name()))
	}
	return out
}

func paramCount(fn *ast.FuncDecl) int {
	return fieldCount(fn.Type.Params)
}

func resultCount(fn *ast.FuncDecl) int {
	return fieldCount(fn.Type.Results)
}

func fieldCount(list *ast.FieldList) int {
	if list == nil {
		return 0
	}
	n := 0
	for _, field := range list.List {
		if len(field.Names) == 0 {
			n++
			continue
		}
		n += len(field.Names)
	}
	return n
}

// moduleRoot 从当前工作目录向上找 go.mod：测试的 cwd 是包目录，守卫要扫的却是整仓。
func moduleRoot(t *testing.T) string {
	t.Helper()

	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("没找到 go.mod——守卫定位不到仓库根")
		}
		dir = parent
	}
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
