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
  /** user_code 不存在、拼错或已被消费。就地标红、不跳页（design decision 10）。 */
  DeviceFlowUserCodeInvalid: 30205,
} as const;
