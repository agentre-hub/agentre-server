package engine

import (
	"reflect"
	"strings"
	"testing"
)

type forbiddenBrowserDTO struct {
	APIKey string `json:"api_key"`
}

// 浏览器 DTO 在类型层没有承接 API Key 或设备绝对路径的字段。控制器即使误把存储
// 载荷整体复制进来，也没有地方可以序列化出去；设备快照是唯一刻意的例外。
func TestBrowserResponses_CannotCarryCredentialsOrCLIPaths(t *testing.T) {
	browser := []reflect.Type{
		reflect.TypeOf(Provider{}),
		reflect.TypeOf(Backend{}),
		reflect.TypeOf(CLIOverlay{}),
		reflect.TypeOf(CLIByDevice{}),
	}
	for _, typ := range browser {
		if browserDTOCarriesForbiddenField(typ) {
			t.Errorf("%s can carry a browser-forbidden secret or path", typ.Name())
		}
	}
	if !browserDTOCarriesForbiddenField(reflect.TypeOf(forbiddenBrowserDTO{})) {
		t.Error("the field detector did not reject a deliberately violating browser DTO")
	}
}

func browserDTOCarriesForbiddenField(typ reflect.Type) bool {
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		name := strings.ToLower(field.Name + " " + field.Tag.Get("json"))
		if strings.Contains(name, "apikey") || strings.Contains(name, "api_key") ||
			strings.Contains(name, "clipath") || strings.Contains(name, "cli_path") {
			return true
		}
	}
	return false
}

func TestSnapshotResponse_ExplicitlyCarriesTheDeviceOnlyFields(t *testing.T) {
	provider, ok := reflect.TypeOf(SnapshotProvider{}).FieldByName("APIKey")
	if !ok || provider.Tag.Get("json") != "api_key" {
		t.Fatal("device snapshot must contain plaintext api_key for the authenticated device")
	}
	overlay, ok := reflect.TypeOf(SnapshotCLIOverlay{}).FieldByName("CLIPath")
	if !ok || overlay.Tag.Get("json") != "cli_path" {
		t.Fatal("device snapshot must contain the authenticated device's CLI overlay")
	}
}
