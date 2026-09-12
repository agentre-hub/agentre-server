package sync_entity

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// R6 的级联判据：「删除一个 backend 时，引用它的执行目标列表项一并落墓碑」，靠
// 执行目标载荷里的 backend_sync_id 认出引用者。这个键名是跨仓库的约定——桌面端
// sync_svc/adapter_org.go 写出它，服务端 workspace_svc 的展示路径也读它。
//
// 解析不出来一律返回空串（= 不引用任何 backend）：级联是删除，宁可漏一条也不能
// 多删一条。漏的那条最坏是 R2a 的一次暂缓，多删的是用户还在用的配置。
func TestExecTargetBackendSyncID(t *testing.T) {
	cases := map[string]struct {
		payload string
		want    string
	}{
		"正常载荷":     {`{"agent_sync_id":"a","backend_sync_id":"be-1","sort_order":2}`, "be-1"},
		"只有引用":     {`{"backend_sync_id":"be-2"}`, "be-2"},
		"没有这个键":    {`{"agent_sync_id":"a","sort_order":0}`, ""},
		"取值不是字符串":  {`{"backend_sync_id":12}`, ""},
		"空串":       {`{"backend_sync_id":""}`, ""},
		"坏 JSON":   {`{"agent_sync_id":"a"`, ""},
		"墓碑的空对象":   {`{}`, ""},
		"整个载荷是空的":  {``, ""},
		"载荷根本不是对象": {`[1,2,3]`, ""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, c.want, ExecTargetBackendSyncID(c.payload))
		})
	}
}
