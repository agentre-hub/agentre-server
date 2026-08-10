package follow_test

import (
	"reflect"
	"strings"
	"testing"

	api "agentre-server/internal/api/follow"
	"agentre-server/internal/model/entity/follow_entity"
)

// 硬不变量守卫（R14）：agentre-server 不持有任何会话内容，关注名单是唯一例外，
// 且它存的只是「指向」——目标设备指纹 + 会话标识 + 关注时间（+ 失效标记）。
// 这里用字段白名单锁住名单 payload：一旦有人往名单里加标题 / 消息 / 转录之类的
// 内容字段，下面的比较会立刻红，而不是靠调用方自觉不填。
func TestFollowPayload_OnlyPointers_Guard(t *testing.T) {
	forbidden := []string{"title", "message", "transcript", "content", "text", "prompt", "summary"}

	// API 载荷层：名单 item 与列表响应。
	checkStruct(t, api.FollowItem{}, map[string]bool{
		"DeviceFingerprint": true, "SessionID": true, "FollowedAt": true, "Invalid": true,
	}, forbidden, "FollowItem")
	checkStruct(t, api.ListFollowsResponse{}, map[string]bool{"Items": true}, forbidden, "ListFollowsResponse")

	// 数据层实体：gorm 列（即落库列）同样只有指向 + 时间戳。
	checkStruct(t, follow_entity.FollowedSession{}, map[string]bool{
		"ID": true, "UserID": true, "DeviceFingerprint": true,
		"SessionID": true, "FollowedAt": true, "Createtime": true, "Updatetime": true,
	}, forbidden, "FollowedSession")
}

func checkStruct(t *testing.T, v any, allowed map[string]bool, forbidden []string, name string) {
	t.Helper()
	typ := reflect.TypeOf(v)
	if typ.NumField() != len(allowed) {
		t.Errorf("%s 字段数 %d != 白名单 %d（多出的字段 = 名单里多了不该有的东西）",
			name, typ.NumField(), len(allowed))
	}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if _, ok := allowed[field.Name]; !ok {
			t.Errorf("%s.%s 不在白名单里：载荷出现了名单不该有的字段", name, field.Name)
		}
		lower := strings.ToLower(field.Name)
		for _, f := range forbidden {
			if strings.Contains(lower, f) {
				t.Errorf("%s.%s 命中内容字段词 %q：硬不变量被破坏", name, field.Name, f)
			}
		}
	}
}
