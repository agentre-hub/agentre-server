// Package portforward_link_entity 维护端口转发子域前缀这张表（规格
// 2026-09-21-port-forward-subdomain「地址与路由」决策 3）：前缀不透明，服务端要能
// 从 Host 反查设备，只能自己记一份 (前缀, 账号, 设备, 映射 id)。
package portforward_link_entity

// PortForwardLink 是一条 (设备, 映射 id) 与它的转发前缀之间的绑定。
//
// 行不可变：分配之后只读不写（控制台第一次打开时分配，映射在就不变，决策 2）。
// 设备上那条映射被删掉后，这一行原样保留——访问它时由设备答「没有这条映射」
// （spec「分配前缀」），所以这里没有软删除位，也没有 Updatetime：没有任何一条路径
// 会在插入之后再改这一行。
type PortForwardLink struct {
	ID int64 `gorm:"column:id;primaryKey;autoIncrement"`
	// Prefix 是 12 位小写 base32 随机串，不带设备号和端口（决策 1）。
	Prefix string `gorm:"column:prefix"`
	// UserID 是这条前缀所属的账号（表里的「账号」列）。设备本身也挂在一个账号下，
	// 但这里单独存一份：S4 的 Host 分发按前缀查这一行就能判「前缀属于这个账号」，
	// 不需要再跳去查一次设备表。
	UserID int64 `gorm:"column:user_id"`
	// DeviceID 是这条映射所在的设备（本仓的 devices.id，不是设备指纹）。
	DeviceID int64 `gorm:"column:device_id"`
	// MappingID 是设备本地库里那条端口转发映射的 id（agentre 仓
	// port_forward_entity 的主键）。映射本体仍然只存在设备上，服务端不存目标。
	MappingID  int64 `gorm:"column:mapping_id"`
	Createtime int64 `gorm:"column:createtime;default:0"`
}

func (*PortForwardLink) TableName() string { return "port_forward_links" }
