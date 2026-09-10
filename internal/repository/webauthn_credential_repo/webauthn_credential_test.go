package webauthn_credential_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/webauthn_credential_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// Create 落一把新密钥。绑定值一并钉住：凭证 ID 与公钥必须以**原始字节**入库，
// 少绑一列或先 base64 一道，登录时按凭证 ID 的反查就再也命不中。
func TestCreate_WritesRawCredentialBytes(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `webauthn_credentials`")).
		WithArgs(int64(7), []byte{0x01, 0x02}, []byte{0xa5, 0x01}, []byte{0x00, 0x01},
			uint32(3), "internal,hybrid", "我的 MacBook", true, true,
			int64(0), int64(1000), int64(1000)).
		WillReturnResult(sqlmock.NewResult(11, 1))
	mock.ExpectCommit()

	c := &webauthn_credential_entity.WebAuthnCredential{
		UserID: 7, CredentialID: []byte{0x01, 0x02}, PublicKey: []byte{0xa5, 0x01},
		AAGUID: []byte{0x00, 0x01}, SignCount: 3, Transports: "internal,hybrid",
		Name: "我的 MacBook", BackupEligible: true, BackupState: true,
		Createtime: 1000, Updatetime: 1000,
	}
	require.NoError(t, r.Create(ctx, c))
	assert.Equal(t, int64(11), c.ID)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 撞上凭证 ID 的全局唯一键要能被上层认出来：那是「这把认证器已经注册过」，
// 不是一次基础设施故障。压成同一个 error 的话，用户拿到的是「服务器内部错误」。
func TestCreate_DuplicateCredentialIDIsRecognisable(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `webauthn_credentials`")).
		WillReturnError(&mysql.MySQLError{
			Number:  1062,
			Message: "Duplicate entry 'x' for key 'webauthn_credentials.uk_webauthn_credentials_credential_id'",
		})
	mock.ExpectRollback()

	err := r.Create(ctx, &webauthn_credential_entity.WebAuthnCredential{UserID: 7, Name: "k"})
	assert.ErrorIs(t, err, ErrCredentialTaken)
}

// 清单只按账号取，最近添加的排在前面。排序钉在 SQL 上：sqlmock 按给定顺序回行，
// 只比第一行内容的话，把 ORDER BY 整句删掉这个用例照样绿。
func TestListByUser_AccountScopedNewestFirst(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	rows := sqlmock.NewRows([]string{
		"id", "user_id", "credential_id", "public_key", "aaguid", "sign_count",
		"transports", "name", "backup_eligible", "backup_state",
		"last_used_at", "createtime", "updatetime",
	}).
		AddRow(2, 7, []byte{0x02}, []byte{0xa5}, []byte{}, 0, "internal", "手机", true, true, 3000, 2000, 2000).
		AddRow(1, 7, []byte{0x01}, []byte{0xa5}, []byte{}, 0, "usb", "安全钥匙", false, false, 0, 1000, 1000)
	mock.ExpectQuery(regexp.QuoteMeta(
		"FROM `webauthn_credentials` WHERE user_id=? ORDER BY id DESC",
	)).WithArgs(int64(7)).WillReturnRows(rows)

	out, err := r.ListByUser(ctx, 7)
	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, "手机", out[0].Name)
	assert.Equal(t, int64(3000), out[0].LastUsedAt)
	assert.Equal(t, []byte{0x01}, out[1].CredentialID)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 上限判定要的是个数，不是整张表：拉全行只为了数一数，会把公钥一并读出来。
func TestCountByUser_CountsOnly(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT count(*) FROM `webauthn_credentials` WHERE user_id=?")).
		WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))

	n, err := r.CountByUser(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, int64(3), n)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 删除必须同时按 id 与 user_id 收敛：只按 id 删，任何登录用户都能删掉别人的密钥。
func TestDeleteByUser_ScopedToOwner(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `webauthn_credentials` WHERE id=? AND user_id=?")).
		WithArgs(int64(11), int64(7)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	deleted, err := r.DeleteByUser(ctx, 7, 11)
	require.NoError(t, err)
	assert.True(t, deleted)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 删不到行不是错误，而是「这把密钥不属于你或已经没了」——上层要据此回 404，
// 不能报成成功。
func TestDeleteByUser_MissingRowReportsNotDeleted(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `webauthn_credentials`")).
		WithArgs(int64(11), int64(8)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	deleted, err := r.DeleteByUser(ctx, 8, 11)
	require.NoError(t, err)
	assert.False(t, deleted)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 登录不要求任何标识，凭证 ID 是唯一的入口：按它反查得出所属账号与验签要的公钥。
// 反查必须只按 credential_id 收敛——带上 user_id 就等于要求登录方先说自己是谁，
// 而那正是这条路径刻意不做的事。
func TestFindByCredentialID_LooksUpTheOwningAccount(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	rows := sqlmock.NewRows([]string{
		"id", "user_id", "credential_id", "public_key", "aaguid", "sign_count",
		"transports", "name", "backup_eligible", "backup_state",
		"last_used_at", "createtime", "updatetime",
	}).AddRow(11, 7, []byte{0x01, 0x02}, []byte{0xa5, 0x01}, []byte{}, 5,
		"internal", "我的 MacBook", true, true, 3000, 1000, 1000)
	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT * FROM `webauthn_credentials` WHERE credential_id=? ORDER BY `webauthn_credentials`.`id` LIMIT ?",
	)).WithArgs([]byte{0x01, 0x02}, 1).WillReturnRows(rows)

	got, err := r.FindByCredentialID(ctx, []byte{0x01, 0x02})
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, int64(7), got.UserID)
	assert.Equal(t, []byte{0xa5, 0x01}, got.PublicKey)
	assert.Equal(t, uint32(5), got.SignCount)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 认不出来的凭证不是错误：登录方拿着一把本服务从没见过的密钥是常态（换了服务端、
// 密钥已被删）。上层要据此给出「这把密钥不属于任何可用账号」，而不是 500。
func TestFindByCredentialID_UnknownCredentialIsNotAnError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `webauthn_credentials` WHERE credential_id=?")).
		WithArgs([]byte{0x09}, 1).WillReturnRows(sqlmock.NewRows([]string{"id"}))

	got, err := r.FindByCredentialID(ctx, []byte{0x09})
	require.NoError(t, err)
	assert.Nil(t, got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 登录成功后要把签名计数器与最后使用时间写回去：计数器不写回，回退判定就永远
// 拿一个陈旧的基准去比；最后使用时间不写回，/account 的清单永远显示「从未使用」。
// 两列必须在同一条 UPDATE 里，且只动这一行。
func TestTouchUsage_WritesCounterAndLastUsed(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewWebAuthnCredential()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE `webauthn_credentials` SET `last_used_at`=?,`sign_count`=?,`updatetime`=? WHERE id=?",
	)).WithArgs(int64(4000), uint32(6), int64(4000), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	require.NoError(t, r.TouchUsage(ctx, 11, 6, 4000))
	require.NoError(t, mock.ExpectationsWereMet())
}
