package relaywire

import (
	"io/fs"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// sharedWirePackage 是 wire 生成代码唯一被允许的来源：桌面仓拥有 .proto 并把生成的 Go
// 发布为独立 module github.com/agentre-hub/agentre/pkg/wire，本仓只钉一个已推送的
// revision，不再自己留一份。
const sharedWirePackage = "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

// TestWireTypesComeFromTheSharedModule 守住 wire 类型确实来自共享 module 而非本仓副本。
//
// 本仓曾长期维护 internal/gen/agentrewire —— 一份手工从桌面仓拷来的 wire.pb.go，其唯一
// 守卫是一张手写的 enum 名单。那份拷贝在一次仓库改名的 sed 里被改坏过：rawDesc 是长度前缀
// 的 protobuf 字节串，字符串被改长而长度前缀没动，descriptor 解析越界，所有 import 它的包
// 在 init 阶段 panic，而 `go build ./...` 全程是绿的。副本消失后那张名单也不必再手工维护，
// 改由这里断言来源。
func TestWireTypesComeFromTheSharedModule(t *testing.T) {
	t.Parallel()

	require.Equal(t, sharedWirePackage, reflect.TypeOf(agentrewire.RpcFrame{}).PkgPath(),
		"wire 类型必须来自共享 module，而不是本仓重新长出来的副本")
}

// TestRepositoryShipsNoGeneratedWireCopy 守住本仓不会再长出第二份生成代码。
//
// 只断言类型来源是不够的：本仓完全可以再放一份 wire.pb.go 而让部分调用点改指它，
// 那样两份会在编译期同时合法，漂移只在两端同时上线时才暴露。
func TestRepositoryShipsNoGeneratedWireCopy(t *testing.T) {
	t.Parallel()

	_, filename, _, ok := runtime.Caller(0)
	require.True(t, ok)
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", ".."))

	scanned := 0
	require.NoError(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", "node_modules", "dist":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".go") {
			return nil
		}
		scanned++
		if strings.HasSuffix(entry.Name(), ".pb.go") {
			rel, err := filepath.Rel(root, path)
			require.NoError(t, err)
			t.Errorf("%s 是一份本仓自带的生成 wire 代码；它只应来自 %s", rel, sharedWirePackage)
		}
		return nil
	}))

	// 自证不空过：扫不到任何 Go 源码时全绿是没有意义的，那既可能是「没人违规」，
	// 也可能是 root 算错了而一个文件都没走到。
	require.NotZero(t, scanned, "walked %s but found no Go sources; the guard would pass vacuously", root)
}
