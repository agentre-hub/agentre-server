package sync_entity

// Wins 实现 R4 的收敛规则：同步版本号较大者胜；版本号相同时按来源机器指纹的字典序决定。
//
// 版本号取自账号级单调序列，因此后到达 server 的那一次上行必然拿到更大的版本，
// 平局那条实际上永不触发，作为兜底保留——它保证任意两个版本都可比，任意到达
// 顺序下所有端算出同一个胜者。客户端提交的时间戳（SyncUpdatedAt）不在这里出现，
// 也不该出现：它只用于展示与 30 天窗口计算。
func (o *SyncObject) Wins(other *SyncObject) bool {
	if other == nil {
		return true
	}
	if o.Version != other.Version {
		return o.Version > other.Version
	}
	return o.OriginFingerprint > other.OriginFingerprint
}
