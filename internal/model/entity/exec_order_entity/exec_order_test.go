package exec_order_entity

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 排列整存整取：写进去什么次序，读回来就是什么次序。
func TestBackendSyncIDs_RoundTrip(t *testing.T) {
	o := &DeviceExecTargetOrder{}
	require.NoError(t, o.SetBackendSyncIDs([]string{"backend-b", "backend-a"}))
	assert.Equal(t, `["backend-b","backend-a"]`, o.OrderJSON)
	assert.Equal(t, []string{"backend-b", "backend-a"}, o.BackendSyncIDs())
}

// 空排列存成 []，不存 null：读侧因此永远拿到「一个没有覆盖任何档的排列」这一种
// 形态，而不是多一处 nil 与 "null" 的分支。
func TestSetBackendSyncIDs_GivenNil_ThenStoresEmptyArray(t *testing.T) {
	o := &DeviceExecTargetOrder{}
	require.NoError(t, o.SetBackendSyncIDs(nil))
	assert.Equal(t, `[]`, o.OrderJSON)
	assert.Empty(t, o.BackendSyncIDs())
}

// 正文损坏（或行是空的）按「没有排列」处理：排列是偏好不是权威，读不出来就回落
// 账号 sort_order，不该让整个派发计划失败。
func TestBackendSyncIDs_GivenBrokenJSON_ThenEmpty(t *testing.T) {
	assert.Empty(t, (&DeviceExecTargetOrder{OrderJSON: "not json"}).BackendSyncIDs())
	assert.Empty(t, (&DeviceExecTargetOrder{}).BackendSyncIDs())
	assert.Empty(t, (*DeviceExecTargetOrder)(nil).BackendSyncIDs())
}
