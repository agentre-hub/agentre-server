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

// env_json 是**刻意**下发的，与 api_key / cli_path 不同级——上面那道守卫因此不认它。
//
// 它曾经和 cli_path 一起被挡在类型层外（浏览器只能通过只收 sync_id 的 is-sandbox
// 接口补一个固定键）。那条规则的代价是控制台根本看不到这张表：用户在桌面端填过的
// 透传环境变量，在网页上既列不出来也改不了，两个入口对同一份配置给出两种能力。
// 本轮按「控制台与桌面端对齐」把它整表放行——读得到才编辑得动，编辑得动才不会在
// 保存时把自己没见过的键抹掉。
//
// api_key 与 cli_path 没有跟着松：前者是服务端替用户保管的凭据（只在设备快照里
// 出现），后者是那台机器上的绝对路径，浏览器两样都不需要知道。
func TestBrowserBackendDTO_DeliberatelyCarriesTheEnvTable(t *testing.T) {
	view, ok := reflect.TypeOf(Backend{}).FieldByName("EnvJSON")
	if !ok || view.Tag.Get("json") != "env_json" {
		t.Fatal("the browser Backend DTO must carry env_json so the console can render the env table")
	}
	write, ok := reflect.TypeOf(backendFields{}).FieldByName("EnvJSON")
	if !ok || !strings.HasPrefix(write.Tag.Get("json"), "env_json") {
		t.Fatal("the browser write DTO must accept env_json so the console can save the env table")
	}
}
