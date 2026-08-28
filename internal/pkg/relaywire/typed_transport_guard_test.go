package relaywire

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

// 线上 RPC carrier 只允许使用 agentre-wire Protobuf；通用 carrier 会绕过
// typed method/payload contract，因此不得进入 production tree。
func TestProductionTreeContainsNoGenericRPCCarrier(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	require.True(t, ok)
	genericPackage := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "json"+"rpc"))

	_, err := os.Stat(genericPackage)
	require.ErrorIs(t, err, os.ErrNotExist, "production tree must contain only the typed Protobuf RPC carrier")
}
