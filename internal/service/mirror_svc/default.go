package mirror_svc

// defaultSupervisor 是本进程那份常驻镜像，由装配处（internal/bootstrap）在 Redis 与
// 中继就位之后建起来。
//
// 未装配时是 nil，而不是一个什么都不跟的空壳：「这个部署没有镜像」与「镜像在跑、
// 只是没跟住任何机器」是两件事，周期任务看见 nil 会安静跳过，看见空壳则会每个周期
// 都认真地扫一遍库。
var defaultSupervisor *Supervisor

// Default 返回本进程那份常驻镜像；未装配时返回 nil，调用方必须自己判。
func Default() *Supervisor { return defaultSupervisor }

// SetDefault 装配本进程那份常驻镜像。
func SetDefault(s *Supervisor) { defaultSupervisor = s }
