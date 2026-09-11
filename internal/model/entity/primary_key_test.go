package entity_test

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm/schema"

	"github.com/agentre-hub/agentre-server/internal/model/entity/activity_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_flow_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_token_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_identity_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/webauthn_credential_entity"
)

// allEntities 是每一个绑定了表名的实体。新增实体时在这里登记。
//
// sync_account_seqs 不在列：那张表刻意没有实体（见 sync_entity 的注释），全部走原生 SQL。
func allEntities() []any {
	return []any{
		&activity_entity.DailyBucket{},
		&agent_session_entity.DeleteTodo{},
		&agent_session_entity.DurableFrame{},
		&agent_session_entity.SessionSave{},
		&agent_session_entity.SessionSummary{},
		&device_entity.Device{},
		&device_flow_entity.DeviceFlowCode{},
		&device_token_entity.DeviceToken{},
		&sync_entity.DeviceLocalPath{},
		&sync_entity.DeviceSyncState{},
		&sync_entity.SyncAvatar{},
		&sync_entity.SyncObject{},
		&user_entity.Settings{},
		&user_entity.User{},
		&user_identity_entity.UserIdentity{},
		&webauthn_credential_entity.WebAuthnCredential{},
	}
}

// TestEveryEntityHasAutoIncrementIDPrimaryKey 钉死一条库级约定：每一张表都以单列自增
// `id` 为主键。
//
// 复合主键与自然主键都不算数 —— 一张表的行身份必须是一个与业务取值无关的数字。原来的
// 复合键/自然键降级为 UNIQUE KEY，它们表达的唯一性照旧成立。GORM 会从主键推 WHERE
// （Save / First / Delete(&e{})），实体上的主键声明与 DDL 差一格，同一段代码就会在内存
// 里和库里各认一套行身份。
func TestEveryEntityHasAutoIncrementIDPrimaryKey(t *testing.T) {
	cache := &sync.Map{}
	for _, model := range allEntities() {
		sch, err := schema.Parse(model, cache, schema.NamingStrategy{})
		require.NoErrorf(t, err, "parse %T", model)
		t.Run(sch.Table, func(t *testing.T) {
			names := make([]string, 0, len(sch.PrimaryFields))
			for _, f := range sch.PrimaryFields {
				names = append(names, f.DBName)
			}
			require.Equal(t, []string{"id"}, names)
			assert.True(t, sch.PrimaryFields[0].AutoIncrement,
				"primary key id is not autoIncrement")
		})
	}
}
