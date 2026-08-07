import { Laptop, AlertTriangle, Github } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import AuthLayout from "@/components/AuthLayout";

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

/** 后端 err query 参数 → i18n key 后缀。未收录但成形状的码原样透出。 */
const KNOWN_ERRORS = [
  "oauth_state_invalid",
  "oauth_exchange_failed",
  "oauth_profile_failed",
  "github_email_missing",
  "access_denied",
  "user_banned",
] as const;

export default function Login() {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next") ?? "";
  const userCode = params.get("user_code") ?? "";
  const err = params.get("err");

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

  const errorText = !err
    ? null
    : (KNOWN_ERRORS as readonly string[]).includes(err)
      ? t(`login.errors.${err}`)
      : ERR_CODE_SHAPE.test(err)
        ? err
        : null;

  const showError = !!err;

  return (
    <AuthLayout>
      <div className="w-full max-w-[424px] space-y-6 rounded-lg border border-border bg-card p-6 sm:p-9">
        <h1 className="text-2xl font-semibold text-foreground">
          {t("login.title")}
        </h1>

        {!showError && (
          <p className="text-sm text-muted-foreground">
            {t("login.description")}
          </p>
        )}

        {userCode && !showError && (
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

        {showError ? (
          <>
            <Alert
              variant="destructive"
              className="border-destructive bg-destructive-soft"
            >
              <AlertTriangle className="h-4 w-4" />
              <div>
                <div className="font-semibold text-destructive">
                  {t("login.failureTitle")}
                </div>
                {errorText && (
                  <div className="text-sm text-destructive">{errorText}</div>
                )}
              </div>
            </Alert>
            <Button className="w-full" onClick={onLogin}>
              {t("login.retryLogin")}
            </Button>
          </>
        ) : (
          <Button className="w-full" onClick={onLogin}>
            <Github className="mr-2 h-4 w-4" />
            {t("login.github")}
          </Button>
        )}

        <p className="text-center text-xs text-subtle-foreground">
          {t("login.footer")}
        </p>
      </div>
    </AuthLayout>
  );
}
