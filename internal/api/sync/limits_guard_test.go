package sync_test

import (
	"reflect"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre/pkg/syncwire"

	"github.com/agentre-hub/agentre-server/internal/api/sync"
)

// 批量上限有两处表达:契约里的常量,和本仓 gin 标签里的字面量。标签**引用不了常量**,
// 所以两者只能靠一条守卫钉在一起 —— 而它必须待在标签所在的这个仓库。
//
// 不钉的后果是静默的:桌面端按契约认为可以一批发 500,本仓把 max 改小了,超出的那一批
// 被 gin 整批打回,而客户端看到的只是一个笼统的参数错误。
func TestBindingTags_GivenTheBatchCaps_ThenTheyMatchTheSharedContract(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name  string
		typ   any
		field string
		want  int
	}{
		{"push items", sync.PushRequest{}, "Items", syncwire.MaxPushBatch},
		{"pull limit", sync.PullRequest{}, "Limit", syncwire.MaxPullLimit},
		{"local paths", sync.ReportLocalPathsRequest{}, "Items", syncwire.MaxLocalPathItems},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			field, ok := reflect.TypeOf(tc.typ).FieldByName(tc.field)
			require.True(t, ok, "%s 上没有 %s 字段", tc.name, tc.field)
			require.Contains(t, field.Tag.Get("binding"), "max="+strconv.Itoa(tc.want),
				"%s 的 binding 上限必须与 syncwire 的契约常量一致", tc.name)
		})
	}
}
