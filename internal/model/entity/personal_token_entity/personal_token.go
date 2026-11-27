// Package personal_token_entity 维护个人 token：账号下带范围、可轮换、可吊销的长期凭据，
// 给外部工具（CI、脚本、agrctl acp）在没有人值守时使用（规格 2026-11-25 决策 7、8、19）。
package personal_token_entity

import (
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"
)

// 范围。一枚 token 能做什么全由它们决定；server 在 HTTP 接口上判，agentred 在 relay RPC
// 上判（决策 16），两边按这几个字面量对齐。
const (
	// ScopeRead 读资源、设备、会话、消息、待处理项，跟随会话输出。
	ScopeRead = "read"
	// ScopeChat 发起对话；对这枚 token 自己发起的会话继续、插话、停止、回答提问。
	ScopeChat = "chat"
	// ScopeApprove 对这枚 token 自己发起的会话批准或拒绝工具权限与审批卡。默认不给（决策 8）。
	ScopeApprove = "approve"
	// ScopeResourcesWrite 创建、修改、删除资源；测试供应商连接；导入模型。
	ScopeResourcesWrite = "resources:write"
	// ScopeDevicesWrite 改名、删除（吊销）、升级设备。
	ScopeDevicesWrite = "devices:write"
)

// canonicalScopes 是全部已知范围，也是落库与答复的固定次序：同一组范围不论调用方怎么排，
// 存下来、读出来都是同一个串。
var canonicalScopes = []string{ScopeRead, ScopeChat, ScopeApprove, ScopeResourcesWrite, ScopeDevicesWrite}

// MaxNameLength 是 token 名字的长度上限（与 personal_tokens.name 列宽一致）。
const MaxNameLength = 64

// DefaultLifetime 是创建时没给期限的 token 的有效期。
const DefaultLifetime = 30 * 24 * time.Hour

var (
	// ErrScopeInvalid 表示范围为空或含未知范围。
	ErrScopeInvalid = errors.New("personal token scope invalid")
	// ErrNameInvalid 表示名字为空、超长或含不允许的字符。
	ErrNameInvalid = errors.New("personal token name invalid")
)

// namePattern 只收命令行与 URL 路径里都不用转义的字符：名字会原样出现在
// /v1/personal-tokens/:name 上，也会被人敲在 `agrctl rotate token <name>` 里。
var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

type PersonalToken struct {
	ID     int64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID int64 `gorm:"column:user_id"`
	// Name 在账号内唯一（uk_personal_tokens_user_name，大小写不敏感）。
	Name string `gorm:"column:name"`
	// TokenHash 是当前密钥明文的 sha256 十六进制。明文只出现在创建 / 轮换那一次答复里，
	// server 从不保存它；轮换换掉的就是这一格，旧密钥因此立即查不到。
	TokenHash string `gorm:"column:token_hash"`
	// Scopes 是逗号连接的范围，按 canonicalScopes 的次序。
	Scopes string `gorm:"column:scopes;default:''"`
	// PeerFingerprint 是这枚 token 自己的对端身份：创建时生成，轮换不变（决策 19）——
	// agentred 按它认定「这枚 token 自己发起的会话」。
	PeerFingerprint string `gorm:"column:peer_fingerprint"`
	// CreatedByDeviceID 是创建它的设备；浏览器会话创建的为 0。只用于展示。
	CreatedByDeviceID int64 `gorm:"column:created_by_device_id;default:0"`
	// LifetimeMs 是期限规则：每次续期（创建、轮换）从那一刻起再算这么久；0 = 永不过期。
	LifetimeMs int64 `gorm:"column:lifetime_ms;default:0"`
	// ExpiresAt 是失效时刻（unix 毫秒）；0 = 永不过期。
	ExpiresAt  int64 `gorm:"column:expires_at;default:0"`
	LastUsedAt int64 `gorm:"column:last_used_at;default:0"`
	RotatedAt  int64 `gorm:"column:rotated_at;default:0"`
	Createtime int64 `gorm:"column:createtime;default:0"`
	Updatetime int64 `gorm:"column:updatetime;default:0"`
}

func (*PersonalToken) TableName() string { return "personal_tokens" }

// NormalizeScopes 校验并规整一组范围：去空白、去重、按固定次序。空集与未知范围都是
// ErrScopeInvalid——一枚什么都不能做的 token 只会让人以为它能做点什么。
func NormalizeScopes(scopes []string) ([]string, error) {
	seen := map[string]bool{}
	for _, raw := range scopes {
		scope := strings.TrimSpace(raw)
		if scope == "" {
			continue
		}
		if !slices.Contains(canonicalScopes, scope) {
			return nil, ErrScopeInvalid
		}
		seen[scope] = true
	}
	out := make([]string, 0, len(seen))
	for _, scope := range canonicalScopes {
		if seen[scope] {
			out = append(out, scope)
		}
	}
	if len(out) == 0 {
		return nil, ErrScopeInvalid
	}
	return out, nil
}

// NormalizeName 去掉首尾空白后校验名字：非空、不超过 MaxNameLength、只含字母数字与 . _ -，
// 且以字母或数字开头（不会被命令行当成一个 flag）。
func NormalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > MaxNameLength || !namePattern.MatchString(name) {
		return "", ErrNameInvalid
	}
	return name, nil
}

// SetScopes 写入一组已经 NormalizeScopes 过的范围。
func (t *PersonalToken) SetScopes(scopes []string) { t.Scopes = strings.Join(scopes, ",") }

// ScopeList 读出范围列表；没有范围时是空切片。
func (t *PersonalToken) ScopeList() []string {
	if t == nil || t.Scopes == "" {
		return []string{}
	}
	return strings.Split(t.Scopes, ",")
}

// Renew 按期限规则 lifetimeMs 从 nowMs 起续期：0 = 永不过期。创建与轮换都走它。
func (t *PersonalToken) Renew(nowMs, lifetimeMs int64) {
	t.LifetimeMs = lifetimeMs
	if lifetimeMs == 0 {
		t.ExpiresAt = 0
		return
	}
	t.ExpiresAt = nowMs + lifetimeMs
}

// NeverExpires 报告这枚 token 是否永不过期。
func (t *PersonalToken) NeverExpires() bool { return t != nil && t.ExpiresAt == 0 }

// ValidAt 判定这枚 token 在 nowMs 是否有效：行存在，且永不过期或尚未到期（到点即失效）。
// 删除即吊销，所以「行存在」就是「未吊销」。
func (t *PersonalToken) ValidAt(nowMs int64) bool {
	return t != nil && (t.ExpiresAt == 0 || nowMs < t.ExpiresAt)
}
