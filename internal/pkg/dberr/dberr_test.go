package dberr

import (
	"errors"
	"fmt"
	"testing"

	"github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/assert"
)

// 一张表上有多个唯一键时，「撞了哪一个」决定业务该吞掉还是该报错，所以判断必须
// 按索引名收敛到一个键上，不能只看「是不是 1062」。
func TestIsDuplicateKey_MatchesOnlyTheNamedIndex(t *testing.T) {
	err := &mysql.MySQLError{
		Number:  1062,
		Message: "Duplicate entry '7-s1' for key 'sync_objects.uk_sync_objects_identity'",
	}

	assert.True(t, IsDuplicateKey(err, "uk_sync_objects_identity"))
	assert.False(t, IsDuplicateKey(err, "uk_sync_objects_location"),
		"另一个唯一键上的冲突必须报错，不能被当成身份键冲突吞掉")
}

// MySQL 8 起错误文本里的索引名带表名前缀，5.7 不带。两种都要认，否则换一个
// 小版本就会静默失配——而失配的后果是把该抛的错吞掉。
func TestIsDuplicateKey_AcceptsBothMessageForms(t *testing.T) {
	qualified := &mysql.MySQLError{
		Number:  1062,
		Message: "Duplicate entry '7-s1' for key 'sync_objects.uk_sync_objects_identity'",
	}
	bare := &mysql.MySQLError{
		Number:  1062,
		Message: "Duplicate entry '7-s1' for key 'uk_sync_objects_identity'",
	}

	assert.True(t, IsDuplicateKey(qualified, "uk_sync_objects_identity"))
	assert.True(t, IsDuplicateKey(bare, "uk_sync_objects_identity"))
}

// 索引名不能用「包含」去匹配：uk_x 是 uk_x_location 的前缀，用 Contains 会把
// 后者的冲突认成前者的。
func TestIsDuplicateKey_DoesNotMatchAnIndexNamePrefix(t *testing.T) {
	err := &mysql.MySQLError{
		Number:  1062,
		Message: "Duplicate entry '7-s1' for key 'sync_objects.uk_sync_objects_identity_v2'",
	}

	assert.False(t, IsDuplicateKey(err, "uk_sync_objects_identity"))
}

// 别的错误号（以及包装过的、nil 的）都不是重复键。
func TestIsDuplicateKey_RejectsEverythingElse(t *testing.T) {
	assert.False(t, IsDuplicateKey(nil, "uk_x"))
	assert.False(t, IsDuplicateKey(errors.New("boom"), "uk_x"))
	assert.False(t, IsDuplicateKey(&mysql.MySQLError{
		Number:  1406,
		Message: "Data too long for column 'content' at row 1",
	}, "uk_x"))
}

// 错误经常被 fmt.Errorf("%w") 包过一层再往上传，errors.As 必须能穿透。
func TestIsDuplicateKey_UnwrapsWrappedErrors(t *testing.T) {
	wrapped := fmt.Errorf("save sync object: %w", &mysql.MySQLError{
		Number:  1062,
		Message: "Duplicate entry '7-s1' for key 'sync_objects.uk_sync_objects_identity'",
	})

	assert.True(t, IsDuplicateKey(wrapped, "uk_sync_objects_identity"))
}
