package sync_entity

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// 看板并入账号级同步组（规格 2026-08-27-issues-board-project-scope「数据与迁移 ›
// 同步（跨仓）」）：标签目录、任务、以及两者的关联各是一个同步对象。
//
// 这三个 kind 不在 KindValid 里 = 设备把它们推上来会被 sync_svc 当成「不认识的
// 类型」整条丢掉（sync.go:225），而丢掉的是用户的任务本身。
func TestKindValid_GivenBoardKinds_ThenAccepted(t *testing.T) {
	for _, kind := range []string{KindLabel, KindIssue, KindIssueLabel} {
		t.Run(kind, func(t *testing.T) {
			assert.True(t, KindValid(kind))
		})
	}
	assert.Equal(t, "label", KindLabel)
	assert.Equal(t, "issue", KindIssue)
	assert.Equal(t, "issue_label", KindIssueLabel)
	assert.False(t, KindValid("issue_comment"), "取值域仍然是闭合的")
}

// 三种真实载荷（键名由桌面端 sync_svc/adapter_issue.go 定死，这一侧逐字消费）
// 全部通过守卫：里面没有任何一个键以 id 结尾配数字值——引用一律是同步标识。
func TestValidatePayload_GivenBoardPayloads_ThenAccepted(t *testing.T) {
	cases := map[string]struct {
		kind    string
		payload string
	}{
		"标签": {KindLabel, `{"name":"bug","tone":"red","status":1}`},
		"任务": {KindIssue, `{"title":"修个 bug","description":"正文","stage":"todo",` +
			`"position":65536,"project_sync_id":"01PROJ","agent_sync_id":"01AGENT",` +
			`"agent_backend_sync_id":"01BACKEND","llm_provider_key":"anthropic-main",` +
			`"llm_model_key":"anthropic-opus-01","closed_at":0}`},
		"关联": {KindIssueLabel, `{"issue_sync_id":"01ISSUE","label_sync_id":"01LABEL"}`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			assert.NoError(t, ValidatePayload(tc.kind, []byte(tc.payload)))
		})
	}
}

// 反方向：把桌面端的本地自增主键塞进同一批载荷必须被拒。三个 kind 一个都不例外
// ——它们与别的同步对象走的是同一条规则，不是新开一档豁免。
func TestValidatePayload_GivenBoardPayloadsWithNumericIDs_ThenRejected(t *testing.T) {
	cases := map[string]struct {
		kind    string
		payload string
	}{
		"任务带 project_id": {KindIssue, `{"title":"t","project_id":42}`},
		"任务带 agent_id":   {KindIssue, `{"title":"t","agent_id":7}`},
		"关联带 issue_id":   {KindIssueLabel, `{"issue_id":3,"label_sync_id":"01LABEL"}`},
		"关联带 labelId":    {KindIssueLabel, `{"issue_sync_id":"01ISSUE","labelId":9}`},
		"标签带自己的本地 id":    {KindLabel, `{"id":5,"name":"bug","tone":"red"}`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			assert.ErrorIs(t, ValidatePayload(tc.kind, []byte(tc.payload)), ErrPayloadLocalID)
		})
	}
}
