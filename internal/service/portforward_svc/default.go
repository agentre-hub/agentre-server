package portforward_svc

// defaultPool 是本进程那些端口转发连接，由装配处（internal/bootstrap）在中继与镜像
// 就位之后建起来。
//
// 未装配时是 nil，而不是一个拨不出去的空壳：「这个部署没有端口转发」与「池在跑、
// 只是此刻一条连接都没有」是两件事，路由层看见 nil 该答「这个部署上没有这条能力」，
// 而不是去拨一个不存在的中继。
var defaultPool *Pool

// Default 返回本进程那份端口转发连接池；未装配时返回 nil，调用方必须自己判。
func Default() *Pool { return defaultPool }

// SetDefault 装配本进程那份端口转发连接池。
func SetDefault(p *Pool) { defaultPool = p }
