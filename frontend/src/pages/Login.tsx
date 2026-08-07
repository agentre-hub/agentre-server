import { LucideIcon, Laptop, AlertTriangle, Github } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import AuthLayout from "@/components/AuthLayout";

/** 后端 err query 参数 → i18n key 后缀。未知值原样透出。 */
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

  const onLogin = () => {
    const u = new URLSearchParams();
    if (next) u.set("next", next);
    if (userCode) u.set("user_code", userCode);
    // 用 assign 而不是 `href =`：语义相同（都保留历史记录），
    // 但与 RequireAuth 的 window.location.replace 保持同一种写法。
    window.location.assign("/v1/auth/oauth/github/authorize?" + u.toString());
  };

  const onRetryLogin = () => {
    const u = new URLSearchParams();
    if (next) u.set("next", next);
    if (userCode) u.set("user_code", userCode);
    // Clear err and redirect to authorize
    window.location.assign("/v1/auth/oauth/github/authorize?" + u.toString());
  };

  const errorText =
    err && (KNOWN_ERRORS as readonly string[]).includes(err)
      ? t(`login.errors.${err}`)
      : err;

  const showError = !!err;

  return (
    <AuthLayout>
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-9">
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
            <Alert variant="destructive" className="border-destructive bg-destructive-soft">
              <AlertTriangle className="h-4 w-4" />
              <div>
                <div className="font-semibold text-destructive">
                  {t("login.failureTitle")}
                </div>
                <div className="text-sm text-destructive">{errorText}</div>
              </div>
            </Alert>
            <Button
              className="w-full"
              onClick={onRetryLogin}
            >
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
