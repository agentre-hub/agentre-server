package engine_svc

import (
	"encoding/json"
	"strings"

	"github.com/agentre-hub/agentre/pkg/syncwire"
)

// providerDoc 是 llm_provider 载荷的顶层 JSON 键表，规矩与 backendDoc 相同（规格
// backend-config-sync 问题 6）：控制台写供应商时不整体解进 syncwire.LLMProviderPayload
// 再整体编码，只改请求涉及的那几个键，其余（含服务端不认识的键）原样保留。models
// 数组同理：不带 Models 就不碰那个键，数组里每个模型元素服务端不认识的键因此也
// 原样活下来。单模型端点（provider_model.go）在这基础上再细到数组里的某一个元素。
type providerDoc map[string]json.RawMessage

// newProviderDoc 是新建供应商的起点：契约的每个顶层键都在（空串 / false / 空数组），
// 与 syncwire.LLMProviderPayload 零值编码出的键集一致。
func newProviderDoc() providerDoc {
	raw, err := json.Marshal(syncwire.LLMProviderPayload{Models: []syncwire.LLMProviderModel{}})
	if err != nil {
		panic(err) // 零值结构体的编码不会失败
	}
	doc, _ := parseProviderDoc(string(raw))
	return doc
}

// parseProviderDoc 解出存着的载荷；不是 JSON 对象时 ok=false。
func parseProviderDoc(payload string) (providerDoc, bool) {
	var doc providerDoc
	if err := json.Unmarshal([]byte(payload), &doc); err != nil {
		return nil, false
	}
	if doc == nil {
		doc = providerDoc{}
	}
	return doc, true
}

func (d providerDoc) str(key string) string {
	var v string
	_ = json.Unmarshal(d[key], &v)
	return v
}

func (d providerDoc) setString(key string, v *string) {
	if v == nil {
		return
	}
	raw, err := json.Marshal(*v)
	if err != nil {
		return
	}
	d[key] = raw
}

func (d providerDoc) setBool(key string, v *bool) {
	if v == nil {
		return
	}
	raw, err := json.Marshal(*v)
	if err != nil {
		return
	}
	d[key] = raw
}

// apply 按请求涉及的键改：与 backendDoc.apply 同一套「缺席即不改」约定。
func (d providerDoc) apply(in ProviderWriteInput, create bool) {
	d.setString("name", in.Name)
	d.setString("type", in.Type)
	d.setString("base_url", in.BaseURL)
	d.setString("default_model_key", in.DefaultModelKey)
	d.applyAPIKey(in.APIKey)
	if in.Models != nil {
		if raw, err := json.Marshal(contractModels(*in.Models)); err == nil {
			d["models"] = raw
		}
	}
	if _, ok := d["models"]; !ok {
		d["models"] = json.RawMessage(`[]`)
	}
	if in.Enabled != nil {
		d.setBool("enabled", in.Enabled)
	} else if create {
		v := true
		d.setBool("enabled", &v)
	}
}

// applyAPIKey 保持既有语义（规格「供应商 API Key」）：空值或掩码回填值都不改存着的
// 凭据。浏览器编辑器从不显示明文，回填的要么是空框、要么是控制台自己拼的
// 「掩码符号+尾四位」占位符，两种都不是用户真正要改成的新密钥。
func (d providerDoc) applyAPIKey(v *string) {
	if v == nil {
		return
	}
	if strings.TrimSpace(*v) == "" || isMaskedAPIKey(*v, d.str("api_key")) {
		return
	}
	d.setString("api_key", v)
}

// maskedAPIKeyBullets 与控制台前端 enginePorts.ts 的 maskedKey() 用同一个占位符
// （"••••" + masked_tail），这里只做「回填的是占位符，别当新密钥」的防御性识别。
const maskedAPIKeyBullets = "••••"

func isMaskedAPIKey(candidate, stored string) bool {
	tail := maskedTail(stored)
	if tail == "" {
		return false
	}
	return strings.TrimSpace(candidate) == maskedAPIKeyBullets+tail
}

func validProviderDoc(d providerDoc) bool {
	return strings.TrimSpace(d.str("name")) != "" && strings.TrimSpace(d.str("type")) != "" && strings.TrimSpace(d.str("base_url")) != ""
}

func (d providerDoc) encode() (string, error) {
	raw, err := json.Marshal(d)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// view 把存着的载荷投成浏览器视图；解进 syncwire.LLMProviderPayload 只是为了复用
// browserProvider 的字段搬运，不影响落库——落库走的是 encode() 保留原始字节。
func (d providerDoc) view(key string) ProviderView {
	var p syncwire.LLMProviderPayload
	if raw, err := d.encode(); err == nil {
		_ = json.Unmarshal([]byte(raw), &p)
	}
	return browserProvider(key, p)
}
