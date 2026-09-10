package sync_entity

import "encoding/json"

// ExecTargetBackendSyncID 取出一条 kind=agent_exec_target 的载荷里引用的 backend
// 同步标识（`backend_sync_id`），取不到时返回空串。
//
// 这个键名是跨仓库的约定，不是本文件新造的：桌面端 sync_svc/adapter_org.go 写出它
// （`json:"backend_sync_id"`），服务端 workspace_svc 的展示路径也读它。它是一个同步
// 标识——字符串、跨机稳定——因此正好落在共享守卫 syncwire.GuardPayload 放行的那一侧
// （以 id 结尾但取值不是数字），两条规则不冲突。
//
// **解析不出来一律当「不引用任何 backend」。** 它唯一的调用方是 R6 的级联删除
// （sync_svc.PurgeDeviceSyncObjects），那里宁可漏删一条也不能多删一条：漏的那条最坏
// 是接收端按 R2a 暂缓一次，多删的是用户还在用的配置。因此这里不返回 error——没有
// 任何一个调用方会想在「载荷读不懂」时把删除扩大化。
func ExecTargetBackendSyncID(payload string) string {
	var p struct {
		BackendSyncID string `json:"backend_sync_id"`
	}
	if err := json.Unmarshal([]byte(payload), &p); err != nil {
		return ""
	}
	return p.BackendSyncID
}
