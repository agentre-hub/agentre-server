package conversationid_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/pkg/conversationid"
)

// Given 决策 2 的一组固定输入向量，When 派生存量对话 id，Then 逐位等于钉死的期望值。
//
// 这是决策 2 确定性的**唯一机械保证**，也是本仓库唯一有资格声称「我和桌面端算的是
// 同一个 uuid」的东西：桌面端 / agentred / server 三份存量在迁移时互不通信，只有三边
// 独立算出同一个值，镜像里那些存量对话才不会在换键之后全体成孤儿。
//
// 这张表里的 namespace 与期望输出**逐字**抄自桌面仓的
// internal/pkg/conversationid/conversationid_test.go（本仓库不得 import 那个模块，
// 所以派生本身在这里重新声明了一份）。改动其中任何一位等于宣布一次不兼容迁移。
func TestDerive_GivenTheDecisionTwoVectors_ThenMatchesTheCrossRepositoryExpectation(t *testing.T) {
	assert.Equal(t, "44d41290-935a-525a-853c-81d0e171598e", conversationid.Namespace.String())

	cases := []struct {
		fingerprint string
		sessionID   string
		want        string
	}{
		{"sha256:aaaa", "1", "dd5414f5-0877-5e9d-9656-b3b44e49697f"},
		{"sha256:aaaa", "2", "4d7f58e9-9881-5189-a9cd-b62f817db549"},
		{"sha256:bbbb", "1", "88f2b427-8035-57d5-8e8b-64fa700ea77a"},
		// 空指纹是「未登录账号的 daemon / 自己对端」那条路径上的合法输入，它同样必须确定。
		{"", "1", "d7bb9a66-20f7-5477-9ecd-cec26ec3d769"},
	}
	for _, c := range cases {
		got := conversationid.Derive(conversationid.Namespace, c.fingerprint, c.sessionID)
		assert.Equal(t, c.want, got, "%q/%q", c.fingerprint, c.sessionID)
		assert.Equal(t, uuid.Version(5), uuid.MustParse(got).Version())
	}
}

// Given 两条只在分隔位置不同的输入，When 派生，Then 得到不同的 id ——
// 拼接必须带分隔符，否则 ("ab","1") 与 ("a","b1") 会撞成同一条对话。
func TestDerive_GivenInputsThatOnlyDifferInFieldBoundary_ThenDoesNotCollide(t *testing.T) {
	assert.NotEqual(t,
		conversationid.Derive(conversationid.Namespace, "ab", "1"),
		conversationid.Derive(conversationid.Namespace, "a", "b1"),
	)
}
