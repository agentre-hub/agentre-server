import {
  Laptop,
  AlertTriangle,
  Github,
  Key,
  Info,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import {
  Button,
  Alert,
  AlertTitle,
  AlertDescription,
  Checkbox,
} from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";
import { api, ApiError } from "@/lib/api";
import { ACCOUNT_CODES, PASSKEY_LOGIN_CODES } from "@/lib/errorCodes";
import { passkeySupport } from "@/lib/passkeySupport";
import { parseUserCode } from "@/lib/userCode";
import {
  decodeRequestOptions,
  encodeAssertionResponse,
  type RawRequestOptions,
} from "@/lib/webauthn";

/**
 * 后端 err query 参数 → i18n key 后缀。未收录的码（含任何不成形状的值）一律显示通用文案，不回显 URL 里的内容。
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
 * （`{code,msg,data}` 的 code），进不了 URL 的 err 参数——err 参数是小写标识符。
 * 这张表就是那一次翻译：不翻，所有非取消的失败都会并成一条。
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
 * 里各有一句文案——少一条，它就落到「登录未完成」那句通用兜底，用户读不到这条路
 * 自己的说法。
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

/**
 * next 是否本站相对路径。判据与后端 redirectpath.Local 同口径：以 / 开头、第二个
 * 字符不是 / 或 \\、整串无反斜杠与控制字符。next 来自 URL，谁都能填，凡是前端
 * 自己据它跳转或据它印上下文的地方都先过这道闸。
 */
function isLocalPath(next: string): boolean {
  if (!next.startsWith("/") || next.startsWith("//")) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\\\u0000-\u001f\u007f]/.test(next);
}

/**
 * 从登录后的落点 next 里认出设备码。
 *
 * 设备授权链接 `/device?user_code=XXX` 在未登录时被 RequireAuth 整个编码进 next，
 * user_code 不在顶层。只认本站相对路径（isLocalPath）；否则外站 next 也能在我们的
 * 登录页上印出一条「设备授权」的上下文。pathname 必须正好是 /device，码要过
 * parseUserCode（不合法就当没有）。
 */
export function userCodeFromNext(next: string): string | null {
  if (!isLocalPath(next)) return null;
  let url: URL;
  try {
    url = new URL(next, "http://local.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://local.invalid" || url.pathname !== "/device") {
    return null;
  }
  return parseUserCode(url.searchParams.get("user_code") ?? "");
}

export default function Login() {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next") ?? "";
  // 顶层 user_code 与 next 里的等价，过同一道 parseUserCode；两者并存时以顶层为准
  // （它是显式给的）。不过闸的值当没有：它会印在「设备授权」眉题下面。
  const userCode =
    parseUserCode(params.get("user_code") ?? "") ||
    userCodeFromNext(next) ||
    "";
  const err = params.get("err");

  /** 通行密钥仪式在途。整条链路只有这一处写操作，防的是连点。 */
  const [passkeyPending, setPasskeyPending] = useState(false);

  /**
   * 「我已阅读并同意」勾没勾。
   *
   * 不落盘、不预勾、不记上一次：同意是**这一次**登录时做出的表示，不是账号上的
   * 一个设置。此前这里是一句「继续即表示你同意」的旁白，把同意藏进点登录这个
   * 动作的副作用里 —— 用户没有表示过任何东西，我们却当他表示了。
   */
  const [consented, setConsented] = useState(false);

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

      // 登录成功，后端已经设置 session cookie。落点只认本站路径（GitHub 那条路由
      // 后端的 redirectpath.Local 把关，这条路是前端自己跳，闸要自己守）。
      window.location.assign(isLocalPath(next) ? next : "/");
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
      : t("login.errors.generic");

  // 通行密钥被取消不算错误，只是平和的重试提示
  const showError = !!err && !isPasskeyCancelled;
  // 用不了就整块不出，一个字也不解释：站在登录页前的人既改不了自己的浏览器有多
  // 老，也改不了本站架在什么地址上，读完那句解释无事可做。（账号页不同 —— 那里
  // 有一颗按不动的「添加」按钮，欠用户一个理由。）
  const passkeys = passkeySupport();

  /**
   * 同意块。首次登录与失败后重试是同一套按钮，它摆在按钮**上面** —— 一颗按不动的
   * 按钮必须让人在它上方就读到原因。
   *
   * 文字用原生 `<label>` 而不是共享包的 `Label`：后者是 `flex items-center` 的
   * 表单项标签，句子里嵌着的两条链接会被排成三个并列的 flex 项，断不了行。
   *
   * 链接嵌在 label 里是安全的：HTML 规范把落在**交互内容后代**上的点击排除在
   * label 激活行为之外，所以点《服务条款》只会打开它，不会顺手替用户勾上同意。
   * login.test.tsx 里那条「点条款链接不勾选」守的就是这一点。
   */
  const consent = (
    <div
      data-testid="login-consent"
      className="flex items-start gap-2.5 text-left"
    >
      <Checkbox
        id="login-consent-box"
        checked={consented}
        onCheckedChange={(checked) => setConsented(checked === true)}
        className="mt-0.5"
      />
      <label
        htmlFor="login-consent-box"
        className="text-xs leading-snug text-muted-foreground"
      >
        <Trans
          i18nKey="login.consent"
          components={{
            terms: (
              <Link
                to="/terms"
                className="text-foreground underline underline-offset-4"
              />
            ),
            privacy: (
              <Link
                to="/privacy"
                className="text-foreground underline underline-offset-4"
              />
            ),
          }}
        />
      </label>
    </div>
  );

  return (
    <AuthLayout>
      <div className="w-full max-w-[424px] space-y-6 rounded-2xl bg-sheet p-6 shadow-overlay sm:p-9">
        {/* 眉题与标题同一组，组内间距与设备授权页一致（gap-2.5）。不用负外边距去抵
            卡片的 space-y：Tailwind v4 的 space-y 落在前一个元素的下外边距上，负值会
            直接把标题拉上来压住眉题。 */}
        <div className="flex flex-col gap-2.5">
          {userCode && (
            <div className="flex items-center gap-[7px] text-primary-text">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              <span className="text-xs font-semibold">
                {t("device.eyebrow")}
              </span>
            </div>
          )}
          <PageTitle>{t("login.title")}</PageTitle>
        </div>

        {userCode && (
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
          <Alert className="bg-secondary">
            <Info className="h-4 w-4" />
            <AlertDescription className="text-sm text-secondary-foreground">
              {t("login.errors.passkey_cancelled")}
            </AlertDescription>
          </Alert>
        )}

        {showError && (
          <Alert
            variant="destructive"
            className="border-destructive bg-destructive-soft"
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="font-semibold text-destructive-text">
              {t("login.failureTitle")}
            </AlertTitle>
            {errorText && (
              <AlertDescription className="text-sm text-destructive-text">
                {errorText}
              </AlertDescription>
            )}
          </Alert>
        )}

        {consent}
        <Button className="w-full" disabled={!consented} onClick={onLogin}>
          <Github className="mr-2 h-4 w-4" />
          {t("login.github")}
        </Button>

        {passkeys === "available" && (
          <>
            <p className="text-center text-xs uppercase text-muted-foreground">
              {t("login.or")}
            </p>

            <Button
              variant="outline"
              className="w-full"
              disabled={passkeyPending || !consented}
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
        )}
      </div>
    </AuthLayout>
  );
}
