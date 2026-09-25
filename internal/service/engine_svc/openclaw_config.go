package engine_svc

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/url"
	"strings"

	"github.com/cago-frame/cago/pkg/i18n"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

const (
	backendTypeOpenClaw       = "openclaw"
	openClawSessionPerAgentRE = "per-agentre-session"
	configKeyOpenClawGateway  = "openclawGatewayUrl"
	configKeyOpenClawSession  = "openclawSessionMode"
)

// NormalizeBackendConfig 按桌面端收同步行的同一规则校验并规范化 typ 这种后端的 config，
// 返回要落库的 config（其余键原样保留）。
//
// 桌面端的规则在 agentre 仓库 internal/model/entity/agent_backend_entity（agent_backend.go
// 的 NormalizeOpenClawGatewayURL、kinds.go 的 openClawKind.ValidateExtra），server 无法
// import；这里是它在 server 侧的唯一实现，用例表见 openclaw_config_test.go。它是后端写入
// 的边界：engine_svc 的创建/更新在落库前调它，ctl_svc 在预览时调它（审批卡出现之前就拒）。
// 目前只有 openclaw 需要判，其它类型原样返回。
// BackendFields 是一条后端里 NormalizeBackendConfig 要看的全部载荷键。
type BackendFields struct {
	Type            string
	ProviderKey     string
	ModelKey        string
	EnvJSON         string
	ReasoningEffort string
	Config          json.RawMessage
}

func NormalizeBackendConfig(ctx context.Context, b BackendFields) (json.RawMessage, error) {
	config := b.Config
	if strings.TrimSpace(b.Type) != backendTypeOpenClaw {
		return config, nil
	}
	doc := map[string]json.RawMessage{}
	if len(config) > 0 {
		if err := json.Unmarshal(config, &doc); err != nil || doc == nil {
			return nil, i18n.NewError(ctx, code.InvalidParameter)
		}
	}
	if reject := openClawForeignField(b, doc); reject != 0 {
		return nil, i18n.NewError(ctx, reject)
	}
	gateway, reject := normalizeOpenClawGatewayURL(configString(doc, configKeyOpenClawGateway))
	if reject != 0 {
		return nil, i18n.NewError(ctx, reject)
	}
	mode := strings.TrimSpace(configString(doc, configKeyOpenClawSession))
	if mode == "" {
		// 与桌面端 agent_backend_svc 创建时同口径：没给就是唯一的那一种。
		mode = openClawSessionPerAgentRE
	}
	if mode != openClawSessionPerAgentRE {
		return nil, i18n.NewError(ctx, code.EngineOpenClawSessionModeInvalid)
	}
	doc[configKeyOpenClawGateway], _ = json.Marshal(gateway)
	doc[configKeyOpenClawSession], _ = json.Marshal(mode)
	return json.Marshal(doc)
}

// normalizeOpenClawGatewayURL 与桌面端 NormalizeOpenClawGatewayURL 逐条同构：必填、ws/wss、
// 有主机、不含账号密码/查询/片段、ws 只许回环地址；规范化小写 scheme 与主机名。拒绝时返回
// 对应的错误码（0 表示通过；从不带 URL 本身，免得凭据进日志与响应）。
func normalizeOpenClawGatewayURL(raw string) (string, int) {
	fail := func(c int) (string, int) { return "", c }
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fail(code.EngineOpenClawGatewayURLRequired)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fail(code.EngineOpenClawGatewayURLInvalid)
	}
	u.Scheme = strings.ToLower(strings.TrimSpace(u.Scheme))
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return fail(code.EngineOpenClawGatewayURLScheme)
	}
	if u.Opaque != "" || u.Hostname() == "" {
		return fail(code.EngineOpenClawGatewayURLHost)
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return fail(code.EngineOpenClawGatewayURLCredentials)
	}
	hostname := strings.ToLower(strings.TrimSpace(u.Hostname()))
	loopback := hostname == "localhost"
	if ip := net.ParseIP(hostname); ip != nil {
		loopback = ip.IsLoopback()
	}
	if u.Scheme == "ws" && !loopback {
		return fail(code.EngineOpenClawGatewayURLPlaintextRemote)
	}
	port := u.Port()
	switch {
	case port != "":
		u.Host = net.JoinHostPort(hostname, port)
	case strings.Contains(hostname, ":"):
		u.Host = "[" + hostname + "]"
	default:
		u.Host = hostname
	}
	return u.String(), 0
}

// openClawForeignField 判 OpenClaw 后端是否带了别的后端类型的字段，返回对应的错误码
// （0 表示没有）。与桌面端逐条对应：kinds.go openClawKind.ValidateExtra 拒绑定、环境变量、
// 推理强度与 CLI 运行参数；agent_backend.go AgentBackend.Check 的 hasHermesConfig /
// hasACPConfig 拒 hermes / acp 的独占配置。空白值与空对象按桌面端 isEmptyJSONObject 当作没配。
func openClawForeignField(b BackendFields, config map[string]json.RawMessage) int {
	switch {
	case strings.TrimSpace(b.ProviderKey) != "" || strings.TrimSpace(b.ModelKey) != "":
		return code.EngineOpenClawProviderModelNotAllowed
	case !isEmptyObjectText(b.EnvJSON):
		return code.EngineOpenClawEnvNotAllowed
	case strings.TrimSpace(b.ReasoningEffort) != "":
		return code.EngineOpenClawReasoningEffortNotAllowed
	case configSet(config, "sandbox", "approval", "defaultPermissionMode", "defaultModel") ||
		!isEmptyObjectText(string(config["modelRoutes"])):
		return code.EngineOpenClawCLISettingsNotAllowed
	case configSet(config, "hermesUrl", "hermesAuthProvider", "hermesUserId", "acpCommand") ||
		!isEmptyArrayOrAbsent(config["acpArgs"]):
		return code.EngineOpenClawForeignConfigNotAllowed
	}
	return 0
}

// configSet 判 config 里这些键有没有一个配了值：缺席、null 与空白字符串都算没配，
// 其余任何取值（包括不是字符串的）都算配了——桌面端同样收不下它。
func configSet(config map[string]json.RawMessage, keys ...string) bool {
	for _, key := range keys {
		raw := bytes.TrimSpace(config[key])
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var v string
		if json.Unmarshal(raw, &v) != nil || strings.TrimSpace(v) != "" {
			return true
		}
	}
	return false
}

// isEmptyObjectText 与桌面端 isEmptyJSONObject 同口径：去空白后是 "" 或 "{}"。
func isEmptyObjectText(s string) bool {
	t := strings.TrimSpace(s)
	return t == "" || t == "{}"
}

// isEmptyArrayOrAbsent 判 acpArgs：缺席、null 或空数组才算没配（桌面端 len(ACPArgs) > 0 即拒）。
func isEmptyArrayOrAbsent(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return true
	}
	var args []json.RawMessage
	return json.Unmarshal(raw, &args) == nil && len(args) == 0
}

// configString 读 config 里的一个字符串键；缺席或不是字符串都读作空串。
func configString(doc map[string]json.RawMessage, key string) string {
	var v string
	_ = json.Unmarshal(doc[key], &v)
	return v
}
