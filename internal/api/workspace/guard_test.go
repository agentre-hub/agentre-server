package workspace_test

import (
	"reflect"
	"strings"
	"testing"

	api "agentre-server/internal/api/workspace"
)

// 硬不变量守卫（R19）：workspace 的响应载荷不带项目路径 / CLIPath / EnvJSON。
// 包注释把它写成了「这些字段在视图对象里根本不存在」——这里让那句话有牙齿：
// 一旦有人往任何一个响应结构体（含嵌套的档 / 项目 / Agent 条目）里加一个这类
// 字段，下面的白名单比较会立刻红，而不是靠调用方自觉不填。
//
// 唯一的例外是 DispatchChoiceItem.Cwd：主动派活时选中的那台机器上的工作目录必须
// 带出去，否则 runtime.run 无处落脚（见 workspace.go 上它自己的注释）。它写在白
// 名单里，因此是一处**显式**的例外，而不是一道悄悄敞开的口子。
//
// 结构与隔壁 internal/api/follow/guard_test.go 同形，只是这里的可达面更大：
// 白名单按类型登记，再从三个响应根做一次反射深走，任何新出现的嵌套结构体没有
// 登记就会红——白名单因此不会随着载荷长大而悄悄过期。
func TestWorkspaceResponses_NeverCarryPathsOrSecrets_Guard(t *testing.T) {
	// 字段名里出现这些词 = 载荷在往「机器上的东西」而不是「指向」的方向长。
	forbidden := []string{"path", "cli", "env", "token", "secret", "credential", "prompt"}

	allowed := map[string][]string{
		"ListAgentsResponse": {"Agents"},
		"AgentItem": {
			"SyncID", "Name", "AvatarColor", "DepartmentName",
			"ExecTargets", "HasAvailableTarget",
		},
		"ExecTargetItem": {
			"Rank", "BackendSyncID", "IsLocalReference",
			"DeviceID", "DeviceName", "BackendType", "Availability", "Current",
		},
		"DispatchTargetResponse": {"AgentSyncID", "Tiers", "Chosen", "Projects"},
		"DispatchTierItem": {
			"Rank", "BackendSyncID", "DeviceID", "DeviceName",
			"BackendType", "Kind", "Availability", "Current",
		},
		// Cwd 是 R19 红线在主动派活场景下**唯一**的显式例外。
		"DispatchChoiceItem": {
			"DeviceFingerprint", "DeviceID", "DeviceName", "BackendType", "Kind", "Cwd",
		},
		"DeviceDetailResponse":       {"DeviceID", "Kind", "RunnableAgents", "Projects"},
		"RunnableAgentItem":          {"SyncID", "Name", "Rank"},
		"ProjectItem":                {"SyncID", "Name", "Configured"},
		"SetExecTargetOrderResponse": {},
	}

	seen := map[string]bool{}
	for _, root := range []any{
		api.ListAgentsResponse{},
		api.DispatchTargetResponse{},
		api.DeviceDetailResponse{},
		api.SetExecTargetOrderResponse{},
	} {
		walkResponseStruct(t, reflect.TypeOf(root), allowed, forbidden, seen)
	}

	// 反向核对：白名单里登记了却从任何响应根都走不到的类型 = 白名单已经过期，
	// 它守着的其实是一个没人再返回的结构体。
	for name := range allowed {
		if !seen[name] {
			t.Errorf("%s 在白名单里但从任何响应根都不可达：白名单已过期", name)
		}
	}
}

// walkResponseStruct 深走一个响应结构体：逐字段核对白名单与禁词，再对嵌套的
// 结构体 / 指针 / 切片元素递归，直到所有可达类型都被核对过一遍。
func walkResponseStruct(
	t *testing.T, typ reflect.Type,
	allowed map[string][]string, forbidden []string, seen map[string]bool,
) {
	t.Helper()
	for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct || typ.PkgPath() != reflect.TypeOf(api.ListAgentsResponse{}).PkgPath() {
		return
	}
	name := typ.Name()
	if seen[name] {
		return
	}
	seen[name] = true

	names, ok := allowed[name]
	if !ok {
		t.Errorf("%s 是响应载荷里的一个结构体，但没有登记在白名单里："+
			"新载荷必须先说清楚自己允许带哪些字段", name)
		return
	}
	allowedSet := make(map[string]bool, len(names))
	for _, n := range names {
		allowedSet[n] = true
	}
	if typ.NumField() != len(allowedSet) {
		t.Errorf("%s 字段数 %d != 白名单 %d（多出的字段 = 载荷里多了不该有的东西）",
			name, typ.NumField(), len(allowedSet))
	}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !allowedSet[field.Name] {
			t.Errorf("%s.%s 不在白名单里：响应出现了 workspace 不该带的字段", name, field.Name)
		}
		lower := strings.ToLower(field.Name)
		for _, f := range forbidden {
			if strings.Contains(lower, f) {
				t.Errorf("%s.%s 命中禁词 %q：R19 硬不变量被破坏", name, field.Name, f)
			}
		}
		walkResponseStruct(t, field.Type, allowed, forbidden, seen)
	}
}
