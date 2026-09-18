package engine

import (
	"reflect"
	"strings"
	"testing"

	"github.com/agentre-hub/agentre/pkg/syncwire"
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
			strings.Contains(name, "clipath") || strings.Contains(name, "cli_path") ||
			strings.Contains(name, "acp") || strings.Contains(name, "command") || strings.Contains(name, "args") {
			return true
		}
	}
	return false
}

// ACP 启动身份（acpCommand / acpArgs）是一段任意 argv，可能夹带凭据，因此与
// api_key / cli_path 同级：浏览器 DTO 的类型层不能有装得下它的字段。唯一的下发
// 通路是带鉴权的设备 JWT 快照（见 TestSnapshotBackend_DeliberatelyCarriesTheConfig）。
func TestBrowserBackendDTO_CannotCarryACPLaunchIdentity(t *testing.T) {
	for _, typ := range []reflect.Type{reflect.TypeOf(Backend{}), reflect.TypeOf(backendFields{})} {
		for i := 0; i < typ.NumField(); i++ {
			name := strings.ToLower(typ.Field(i).Name + " " + typ.Field(i).Tag.Get("json"))
			if strings.Contains(name, "acp") || strings.Contains(name, "command") || strings.Contains(name, "args") {
				t.Errorf("%s.%s 会把 ACP 启动身份漏给浏览器", typ.Name(), typ.Field(i).Name)
			}
		}
	}
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

// 后端 config 快照是整个服务端唯一允许把 ACP 启动身份下行的地方，且只给持设备
// JWT 的调用方、只给分给这台机器的后端。形状按 sync_id 寻址、正文是共享契约的
// 整份 AgentBackendConfig —— 不在这里再抄一份键表。
func TestSnapshotBackend_DeliberatelyCarriesTheConfig(t *testing.T) {
	config, ok := reflect.TypeOf(SnapshotBackend{}).FieldByName("Config")
	if !ok || config.Tag.Get("json") != "config" {
		t.Fatal("device snapshot must carry the full backend config by sync id")
	}
	if config.Type != reflect.TypeOf(syncwire.AgentBackendConfig{}) {
		t.Fatalf("snapshot backend config must be the shared syncwire type, got %s", config.Type)
	}
	key, ok := reflect.TypeOf(SnapshotBackend{}).FieldByName("BackendSyncID")
	if !ok || key.Tag.Get("json") != "backend_sync_id" {
		t.Fatal("device snapshot backend entry must be addressed by backend_sync_id")
	}
	backends, ok := reflect.TypeOf(SnapshotResponse{}).FieldByName("Backends")
	if !ok || backends.Tag.Get("json") != "backends" {
		t.Fatal("device snapshot response must expose the backends array")
	}
}

// env_json 是**刻意**下发的，与 api_key / cli_path 不同级——上面那道守卫因此不认它。
//
// 挡在类型层外的代价是控制台根本看不到这张表：桌面端填过的透传环境变量，在网页上
// 既列不出来也改不了，两个入口对同一份配置给出两种能力。所以按「控制台与桌面端对齐」
// 整表放行——读得到才编辑得动，编辑得动才不会在保存时把自己没见过的键抹掉。
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

// CLIOverlay 是**唯一**刻意携带 cli_path 的浏览器 DTO，所以它从上面那份清单里退出来，
// 换成这条正向断言。
//
// 挡着它的代价是控制台配不出可执行文件路径：网页上建的后端只能靠 $PATH 撞运气，
// 撞不上就没有第二条路。放开的是**读回自己配过的值**——不读回就编辑不了（打开是
// 空框，一保存把填过的路径抹掉）。
//
// 松的只有这一个字段。api_key 仍在探测器里：那是服务端替用户保管的凭据，只在设备
// 快照里出现；而 cli_path 是用户自己要填的配置。CLIByDevice 也仍在清单里——它是
// 后端列表上的按机器状态，那里只需要「装没装」，不需要路径正文。
func TestCLIOverlayDTO_DeliberatelyCarriesThePath(t *testing.T) {
	field, ok := reflect.TypeOf(CLIOverlay{}).FieldByName("CLIPath")
	if !ok || field.Tag.Get("json") != "cli_path" {
		t.Fatal("the browser CLI overlay must carry cli_path so the console can read back what it configured")
	}
	if browserDTOCarriesForbiddenField(reflect.TypeOf(CLIByDevice{})) {
		t.Error("the per-device status row must stay path-free; it only answers installed-or-not")
	}
}
