import {
  Laptop,
  AlertTriangle,
  Github,
  Key,
  Info,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  Alert,
  AlertTitle,
  AlertDescription,
} from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";
import { api, ApiError } from "@/lib/api";
import { ACCOUNT_CODES, PASSKEY_LOGIN_CODES } from "@/lib/errorCodes";
import { passkeySupport } from "@/lib/passkeySupport";
import {
  decodeRequestOptions,
  encodeAssertionResponse,
  type RawRequestOptions,
} from "@/lib/webauthn";

/**
 * 后端 err query 参数认得出的形状：小写字母开头的 snake_case 短标识，
 * 与下面 KNOWN_ERRORS 里那些同源（auth_ctr 只会重定向出这类值）。
 *
 * err 是从 URL 来的，谁都能给受害者递一条链接。未知码原样透出的本意是透出
 * 一个**码**——不加这道形状检查，`/login?err=<任意一句话>` 就能在我们自己的
 * 域名、自己的失败卡里印一句话，等于一条免费的钓鱼提示（React 会转义 HTML，
 * 所以这不是 XSS，是文案伪造）。不成形状的值只当「失败了」，不回显内容。
 */
const ERR_CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * 后端 err query 参数 → i18n key 后缀。未收录但成形状的码原样透出。
 *
 * 导出是为了让 __tests__/login-error-contract.test.ts 拿它去和 auth_ctr 的
 * 重定向逐条比对——这份清单与后端各存一份，没有守卫就会悄悄分叉。
 */
export const KNOWN_ERRORS = [
  "oauth_state_invalid",
  "oauth_exchange_failed",
  "oauth_profile_failed",
  "github_email_missing",
  "access_denied",
  "user_banned",
] as const;

/**
 * 后端信封业务码 → 通行密钥登录这条路上的 err 码。
 *
 * 规格「通行密钥 · 失败」：「challenge 过期或不匹配、origin 不在允许列表、凭证
 * 不属于任何可用账号、认证器被用户取消、计数器回退——每一种给各自的错误码与
 * 文案，不压成一句「登录失败」」。后端确实给了各自的码，但那是信封里的**数字**
 * （`{code,msg,data}` 的 code），进不了 URL 的 err 参数——ERR_CODE_SHAPE 只认
 * 小写标识符。这张表就是那一次翻译：不翻，所有非取消的失败都会并成一条。
 *
 * user_banned 复用 GitHub 那条路已有的码与文案：闸门排在建立会话之前（规格
 * 「账号闸门 · 登录路径」），两条登录路径上被封账号读到的该是同一句话。
 */
const CODE_TO_ERR: ReadonlyArray<readonly [number, string]> = [
  [PASSKEY_LOGIN_CODES.PasskeyChallengeInvalid, "passkey_challenge_invalid"],
  [PASSKEY_LOGIN_CODES.PasskeyOriginNotAllowed, "passkey_origin_not_allowed"],
  [PASSKEY_LOGIN_CODES.PasskeyCredentialUnknown, "passkey_credential_unknown"],
  [PASSKEY_LOGIN_CODES.PasskeyCounterRollback, "passkey_counter_rollback"],
  [ACCOUNT_CODES.UserBanned, "user_banned"],
];

/**
 * 通行密钥这条路上前端自己造出来的 err 码，与 KNOWN_ERRORS 一样要在两份 locale
 * 里各有一句文案——少一条，未收录码就走「原样透出」那条兜底分支，用户在失败卡里
 * 读到的是 `passkey_failed` 这串标识符本身。
 *
 * user_banned 不在这里：它由后端重定向出来、已经收在 KNOWN_ERRORS 里，
 * 两处都登记会让 login-error-contract 的两道守卫互相打架。
 *
 * 导出是为了让 __tests__/login-error-contract.test.ts 逐条核实那两份文案。
 */
export const PASSKEY_ERRORS = [
  "passkey_cancelled",
  "passkey_failed",
  "passkey_challenge_invalid",
  "passkey_origin_not_allowed",
  "passkey_credential_unknown",
  "passkey_counter_rollback",
] as const;

/**
 * 把一次通行密钥登录的失败翻成 err 码。
 *
 * 用户在系统弹窗上按了取消是 DOMException/NotAllowedError，不是错误；服务端判出
 * 来的失败带业务码，按 CODE_TO_ERR 翻；剩下的（网络断了、非 JSON 的 502、认证器
 * 自己抽风）才落到 passkey_failed 这个兜底上。
 */
function passkeyLoginErr(e: unknown): string {
  if (e instanceof DOMException && e.name === "NotAllowedError") {
    return "passkey_cancelled";
  }
  if (e instanceof ApiError) {
    const hit = CODE_TO_ERR.find(([code]) => code === e.code);
    if (hit) return hit[1];
  }
  return "passkey_failed";
}

export default function Login() {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next") ?? "";
  const userCode = params.get("user_code") ?? "";
  const err = params.get("err");

  /** 通行密钥仪式在途。整条链路只有这一处写操作，防的是连点。 */
  const [passkeyPending, setPasskeyPending] = useState(false);

  // 首次登录与失败后重试走的是同一件事：带着 next / user_code 重新发起
  // authorize（err 不透传，它是上一次的结果）。所以只有一个处理函数。
  const onLogin = () => {
    const u = new URLSearchParams();
    if (next) u.set("next", next);
    if (userCode) u.set("user_code", userCode);
    // 用 assign 而不是 `href =`：语义相同（都保留历史记录），
    // 但与 RequireAuth 的 window.location.replace 保持同一种写法。
    window.location.assign("/v1/auth/oauth/github/authorize?" + u.toString());
  };

  // 这条路径上的失败都落回登录页自己：err 换成码、next / user_code 原样带回去，
  // 不带回去就等于把设备授权的上下文丢在半路，用户重试完会停在总览而不是回到授权。
  const backToLogin = (errCode: string) => {
    const u = new URLSearchParams();
    u.set("err", errCode);
    if (next) u.set("next", next);
    if (userCode) u.set("user_code", userCode);
    window.location.assign("/login?" + u.toString());
  };

  const onPasskeyLogin = async () => {
    // 整条仪式期间按钮既不禁用也不换样子，用户很容易再点一次；而第二次
    // `credentials.get` 会让浏览器中止第一次，抛 NotAllowedError → 被判成
    // 「用户取消」→ 一次本来会成功的登录被自己的第二次点击取消掉。
    if (passkeyPending) return;
    setPasskeyPending(true);
    try {
      // 1. 取登录选项。走 api() 而不是裸 fetch：回应是 cago 的
      //    `{code,msg,data}` 信封，publicKey 在 data 里面。
      const begin = await api<{ publicKey: RawRequestOptions }>(
        "/v1/passkeys/login/begin",
        { method: "POST" },
      );

      // 2. 调用浏览器的凭证选择器。challenge 与 allowCredentials[].id 从
      //    服务端过来是 base64url 字符串，而这两个字段在 WebAuthn 的 IDL 里是
      //    BufferSource——不先解成 ArrayBuffer，这一步直接抛 TypeError。
      const credential = (await navigator.credentials.get({
        publicKey: decodeRequestOptions(begin.publicKey),
      })) as PublicKeyCredential | null;

      if (!credential) {
        // 用户取消了选择——浏览器多数情况下抛 NotAllowedError，少数返回 null。
        // 这不是错误，只是用户的选择，所以回登录页显示平和的提示
        backToLogin("passkey_cancelled");
        setPasskeyPending(false);
        return;
      }

      // 3. 发送响应完成登录。回程反过来：认证器给的是 ArrayBuffer，后端要的是
      //    同一种 base64url 字符串，而 JSON.stringify 会把 ArrayBuffer 变成 `{}`。
      await api("/v1/passkeys/login/finish", {
        method: "POST",
        body: JSON.stringify({
          credential: encodeAssertionResponse(credential),
        }),
      });

      // 登录成功，后端已经设置 session cookie
      window.location.assign(next || "/");
    } catch (err) {
      // 服务端判失败、网络错误、认证器异常都落这里。信封里的业务码是数字、
      // 进不了 URL，先翻成这条路自己的 err 码再带回登录页。
      backToLogin(passkeyLoginErr(err));
      setPasskeyPending(false);
    }
  };

  const isPasskeyCancelled = err === "passkey_cancelled";
  // 两张表都要查：KNOWN_ERRORS 是后端重定向出来的，PASSKEY_ERRORS 是通行密钥
  // 这条路上前端自己造的，两者都有各自的 locale 文案。
  const translated =
    !!err &&
    ((KNOWN_ERRORS as readonly string[]).includes(err) ||
      (PASSKEY_ERRORS as readonly string[]).includes(err));
  const errorText = !err
    ? null
    : translated
      ? t(`login.errors.${err}`)
      : ERR_CODE_SHAPE.test(err)
        ? err
        : null;

  // 通行密钥被取消不算错误，只是平和的重试提示
  const showError = !!err && !isPasskeyCancelled;
  // 不能用时还要分清是哪一种：源不是安全上下文（本站有时用 http 提供）要说出来，
  // 浏览器太老则保持沉默 —— 那不是本站能替他解决的事。
  const passkeys = passkeySupport();

  return (
    <AuthLayout>
      <div className="w-full max-w-[424px] space-y-6 rounded-lg border border-border bg-card p-6 sm:p-9">
        <PageTitle>{t("login.title")}</PageTitle>

        {userCode && !showError && !isPasskeyCancelled && (
          <div className="flex items-start gap-3 rounded-md bg-primary-soft p-3.5 text-primary-text">
            <Laptop className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium">
                {t("login.userCodeLabel")}
              </div>
              <div className="font-mono text-sm tracking-wide">{userCode}</div>
            </div>
          </div>
        )}

        {isPasskeyCancelled && (
          <Alert className="border-border bg-secondary">
            <Info className="h-4 w-4" />
            <AlertDescription className="text-sm text-secondary-foreground">
              {t("login.errors.passkey_cancelled")}
            </AlertDescription>
          </Alert>
        )}

        {showError ? (
          <>
            <Alert
              variant="destructive"
              className="border-destructive bg-destructive-soft"
            >
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle className="font-semibold text-destructive">
                {t("login.failureTitle")}
              </AlertTitle>
              {errorText && (
                <AlertDescription className="text-sm text-destructive">
                  {errorText}
                </AlertDescription>
              )}
            </Alert>
            <Button className="w-full" onClick={onLogin}>
              {t("login.retryLogin")}
            </Button>
          </>
        ) : (
          <>
            <Button className="w-full" onClick={onLogin}>
              <Github className="mr-2 h-4 w-4" />
              {t("login.github")}
            </Button>

            {passkeys === "available" ? (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">
                      {t("login.or")}
                    </span>
                  </div>
                </div>

                <Button
                  variant="outline"
                  className="w-full"
                  disabled={passkeyPending}
                  aria-busy={passkeyPending || undefined}
                  onClick={onPasskeyLogin}
                >
                  {passkeyPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Key className="mr-2 h-4 w-4" />
                  )}
                  {t("login.passkey")}
                </Button>
              </>
            ) : passkeys === "insecure-origin" ? (
              // 不摆一颗按不动的按钮：这里没有用户能执行的下一步，只有一句事实。
              // 但整块静默消失也不行——注册过通行密钥的人会以为功能没了。
              <p className="text-center text-xs text-muted-foreground">
                {t("login.passkeyInsecureOrigin")}
              </p>
            ) : null}
          </>
        )}

        <p className="text-center text-xs text-muted-foreground">
          {t("login.footer")}
        </p>
      </div>
    </AuthLayout>
  );
}
