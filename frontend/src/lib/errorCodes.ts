/**
 * 后端业务错误码里前端需要分支的那些。
 *
 * 键名刻意与 internal/pkg/code/code.go 的 Go 常量名逐字相同：
 * 守卫测试 src/__tests__/error-code-contract.test.ts 就是拿这个键去 code.go
 * 里重算 iota 比对的，改名即断链、测试即红。
 *
 * 不要就地裸写数字：code.go 的 Device Flow 段位是一串 iota，后端在中间插一个
 * 常量，后面每个码都会平移一位，而前端不会报错——它只会把某个失败认成另一个。
 */
export const DEVICE_FLOW_CODES = {
  /** 授权请求已过期。落到 /device/expired（design decision 9）。 */
  DeviceFlowExpiredToken: 30202,
  /** user_code 不存在、拼错或已被消费。就地标红、不跳页（design decision 10）。 */
  DeviceFlowUserCodeInvalid: 30205,
} as const;

/**
 * 通行密钥段位（30600 起）里 `/account` 用得到的那几个：注册两步
 * （begin/finish）与删除会遇到的失败。只声明这几个——登录失败的码在同一段位的
 * 末尾、由下面的 PASSKEY_LOGIN_CODES 单独声明，账号页的注册/管理端点不会返回
 * 那些码；守卫测试只逐条比对本表声明的名字，段位整体变长不会牵连这里。
 */
export const PASSKEY_CODES = {
  /** 该账号的通行密钥数量已达上限（决策 9：超出时明确拒绝）。 */
  PasskeyLimitReached: 30600,
  /** challenge 不存在、已过期，或不属于当前浏览器会话。 */
  PasskeyChallengeInvalid: 30601,
  /** 认证器的回应没通过校验。 */
  PasskeyVerificationFailed: 30602,
  /** 这把认证器已经注册过。 */
  PasskeyAlreadyRegistered: 30603,
  /** 删除时该账号名下没有这把通行密钥。 */
  PasskeyNotFound: 30604,
} as const;

/**
 * 通行密钥段位里**登录**这条路上的失败码。登录页要按它们分支：规格「通行密钥 ·
 * 失败」写明「每一种给各自的错误码与文案，不压成一句「登录失败」」，而后端的
 * 裁决只以信封里那个数字业务码出现——不在这里把码抠出来，前端就只能把所有
 * 非取消的失败并成一条。
 *
 * 与 PASSKEY_CODES 分两张表，是因为两条路径回得出的码不一样：注册 / 管理那几个
 * 端点回不出 origin、凭证反查、计数器回退这三种。两张表都由
 * `__tests__/error-code-contract.test.ts` 逐条对回 code.go，谁都漂移不了。
 * PasskeyChallengeInvalid 在两张表里都有，因为注册与登录的 finish 都会遇到它。
 */
export const PASSKEY_LOGIN_CODES = {
  /** challenge 不存在、已过期，或压根不是本服务发出的。 */
  PasskeyChallengeInvalid: 30601,
  /** 回应里的 origin 不在允许列表里——几乎总是部署配错，不是用户做错了什么。 */
  PasskeyOriginNotAllowed: 30605,
  /** 这把通行密钥不属于任何可用账号（已被删、或者换了一套服务端）。 */
  PasskeyCredentialUnknown: 30606,
  /** 签名计数器回退：认证器可能被克隆了（决策 13）。 */
  PasskeyCounterRollback: 30607,
} as const;

/**
 * 账号段位（30100 起）里登录路径要分支的那个。
 *
 * 账号闸门排在通行密钥登录建立会话之前（规格「账号闸门 · 登录路径」），被封账号
 * 在那条路上拿到的就是 UserBanned；GitHub 那条路由后端重定向成
 * `/login?err=user_banned`，通行密钥这条路没有重定向，只能由前端按码翻。
 */
export const ACCOUNT_CODES = {
  /** 账号已被封禁。 */
  UserBanned: 30101,
} as const;
