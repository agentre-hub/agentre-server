// Package exec_order_entity 维护「每台设备自己的执行目标排列」实体。
//
// 这里有两个「设备」轴，不可混同：**持有者**是排这份顺序的客户端（本轮只有
// kind=web 的浏览器会写），**被排序的目标**是 OrderJSON 里的 backend sync_id
// （它们各自指向某台机器）。一行的含义是「某个浏览器，对某个 Agent，把执行目标
// 排成这个次序」。
//
// 排列是**偏好**不是权威：账号级的执行目标集合仍在同步组里，解析时以集合为准
// ——排列里指向已不存在的 backend 的项忽略，集合里没被排列覆盖到的档按账号
// sort_order 补到尾部。因此这里不做任何「排列必须与集合一致」的校验。
package exec_order_entity

import "encoding/json"

// DeviceExecTargetOrder 是 device_exec_target_orders 的一行。主键是
// (UserID, DeviceID, AgentSyncID) 复合键，没有自增 id，也没有 createtime——
// 与同类的 sync_entity.DeviceLocalPath 一致。
type DeviceExecTargetOrder struct {
	UserID   int64 `gorm:"column:user_id;type:bigint;not null;primaryKey"`
	DeviceID int64 `gorm:"column:device_id;type:bigint;not null;primaryKey"`
	// AgentSyncID 是被排序的 Agent 的同步标识，与 sync_objects.sync_id 逐字节可比。
	AgentSyncID string `gorm:"column:agent_sync_id;type:varchar(255);not null;primaryKey"`
	// OrderJSON 是 backend sync_id 的有序 JSON 数组，整存整取（决策 13）。
	// 别直接读它，走 BackendSyncIDs / SetBackendSyncIDs。
	OrderJSON  string `gorm:"column:order_json;type:text;not null"`
	Updatetime int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*DeviceExecTargetOrder) TableName() string { return "device_exec_target_orders" }

// BackendSyncIDs 解出排列。正文损坏、行为空或接收者为 nil 时返回空——排列是偏好，
// 读不出来就按「没有排列」处理（回落账号 sort_order），不该让派发计划失败。
func (o *DeviceExecTargetOrder) BackendSyncIDs() []string {
	if o == nil || o.OrderJSON == "" {
		return nil
	}
	var ids []string
	if err := json.Unmarshal([]byte(o.OrderJSON), &ids); err != nil {
		return nil
	}
	return ids
}

// SetBackendSyncIDs 把排列写进 OrderJSON。nil 存成 `[]` 而不是 `null`：读侧因此
// 永远只面对「一个可能为空的数组」这一种形态。
func (o *DeviceExecTargetOrder) SetBackendSyncIDs(ids []string) error {
	if ids == nil {
		ids = []string{}
	}
	raw, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	o.OrderJSON = string(raw)
	return nil
}
