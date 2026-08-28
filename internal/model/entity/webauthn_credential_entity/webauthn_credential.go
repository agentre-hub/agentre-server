// Package webauthn_credential_entity 维护通行密钥（WebAuthn 凭证）实体。
//
// 一行就是用户在某台认证器上注册的一把密钥。只存「验签 + 展示」需要的东西：
// 公钥、签名计数器、备份标志、用户自己起的名字。刻意**不**存 attestation 原文
// ——本服务不接 FIDO Metadata Service，那段数据没有任何读取方，留着它只是把一坨
// 敏感字节搬进库里。
package webauthn_credential_entity

// WebAuthnCredential 是一把已注册的通行密钥。
type WebAuthnCredential struct {
	ID     int64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID int64 `gorm:"column:user_id;type:bigint;not null"`
	// CredentialID 是凭证 ID 的**原始字节**（不是 base64）。全局唯一：登录时不要求
	// 任何标识，只能按它反查账号。
	CredentialID []byte `gorm:"column:credential_id;type:varbinary(512);not null"`
	// PublicKey 是 COSE 编码的凭证公钥，验签用。
	PublicKey []byte `gorm:"column:public_key;type:varbinary(1024);not null"`
	// AAGUID 是认证器型号标识，16 字节；同步型认证器常常返回全零。只作为事实存下来，
	// **不**用它去猜设备型号当名字（决策：名字由用户自己输入）。
	AAGUID []byte `gorm:"column:aaguid;type:varbinary(16);not null"`
	// SignCount 是认证器自报的签名计数器。同步型认证器恒为 0。
	SignCount uint32 `gorm:"column:sign_count;type:int unsigned;not null;default:0"`
	// Transports 是认证器自报的传输方式，逗号分隔（usb,nfc,ble,internal,hybrid）。
	// 登录时原样回给浏览器，帮它把提示引到对的通道上。
	Transports string `gorm:"column:transports;type:varchar(128);not null;default:''"`
	// Name 由用户在提交前输入，必填、限长。
	Name string `gorm:"column:name;type:varchar(64);not null"`
	// BackupEligible / BackupState 是凭证是否可备份、当前是否已备份。存下来才能在
	// 「这把密钥只在这台设备上」和「它在云端有副本」之间说得清楚。
	BackupEligible bool `gorm:"column:backup_eligible;type:boolean;not null;default:false"`
	BackupState    bool `gorm:"column:backup_state;type:boolean;not null;default:false"`
	// LastUsedAt 是最后一次用它登录的时刻（毫秒）；从未用过时为 0。
	LastUsedAt int64 `gorm:"column:last_used_at;type:bigint;not null;default:0"`
	Createtime int64 `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime int64 `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*WebAuthnCredential) TableName() string { return "webauthn_credentials" }
