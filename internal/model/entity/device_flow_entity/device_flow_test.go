package device_flow_entity

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestState_Transitions(t *testing.T) {
	c := &DeviceFlowCode{ExpiresAt: 1000}
	assert.False(t, c.IsAuthorized())
	assert.False(t, c.IsConsumed())
	assert.False(t, c.IsDenied())
	assert.True(t, c.IsExpired(1500))
	assert.False(t, c.IsExpired(500))

	c.AuthorizedUserID = 42
	c.ApprovedAt = 700
	assert.True(t, c.IsAuthorized())

	c.ConsumedAt = 800
	assert.True(t, c.IsConsumed())

	d := &DeviceFlowCode{DeniedAt: 900}
	assert.True(t, d.IsDenied())
}
