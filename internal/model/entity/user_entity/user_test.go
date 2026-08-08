package user_entity

import (
	"context"
	"testing"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/stretchr/testify/assert"
)

func TestUser_Check(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name    string
		in      *User
		wantErr bool
	}{
		{"nil", nil, true},
		{"active", &User{Status: consts.ACTIVE}, false},
		{"banned", &User{Status: consts.BAN}, true},
		{"deleted", &User{Status: consts.DELETE}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.in.Check(ctx)
			if c.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestUser_IsActive(t *testing.T) {
	assert.False(t, (*User)(nil).IsActive())
	assert.True(t, (&User{Status: consts.ACTIVE}).IsActive())
	assert.False(t, (&User{Status: consts.BAN}).IsActive())
}
