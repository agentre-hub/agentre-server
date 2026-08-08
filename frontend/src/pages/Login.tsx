import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

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

  const errorText =
    err && (KNOWN_ERRORS as readonly string[]).includes(err)
      ? t(`login.errors.${err}`)
      : err;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm space-y-6 rounded-xl border p-6 sm:p-8">
        <h1 className="text-2xl font-semibold">{t("login.title")}</h1>
        {errorText && <Alert variant="destructive">{errorText}</Alert>}
        <Button className="w-full" onClick={onLogin}>
          {t("login.github")}
        </Button>
      </div>
    </div>
  );
}
