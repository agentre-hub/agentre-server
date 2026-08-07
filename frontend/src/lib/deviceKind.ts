/**
 * device_kind → 展示名。
 *
 * 三处要同一套规则：确认屏（DeviceApproval）、成功屏（DeviceSuccess）、
 * 设备列表（Devices）。各写一份的下场是「同一个 kind 在三屏上叫三个名字」，
 * 或者其中一处忘了兜底、把 `device.kind.foo` 这串死键名摆到用户脸上。
 *
 * t 的类型写成 `(key: string) => string` 而不是 i18next 的 TFunction：
 * 这里查的是运行期拼出来的动态键，与 loadErrorText 同一手法。
 */
export function deviceKindLabel(
  kind: string,
  t: (key: string) => string,
): string {
  const key = `device.kind.${kind}`;
  const translated = t(key);
  // i18next 查不到时把键原样返回，此时回退到后端给的原文。
  return translated === key ? kind : translated;
}
