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

func TestDevice_CapabilitySlice(t *testing.T) {
	d := &Device{Capabilities: []byte(`{"compute":true,"client":false,"file_browse":true}`)}
	got := d.CapabilityList()
	assert.ElementsMatch(t, []string{"compute", "file_browse"}, got)
}
