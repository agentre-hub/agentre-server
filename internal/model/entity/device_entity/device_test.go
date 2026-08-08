package device_entity

import (
	"testing"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/stretchr/testify/assert"
)

func TestDevice_IsActive(t *testing.T) {
	assert.True(t, (&Device{Status: consts.ACTIVE}).IsActive())
	assert.False(t, (&Device{Status: consts.DELETE}).IsActive())
	assert.False(t, (*Device)(nil).IsActive())
}
