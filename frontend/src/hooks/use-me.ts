import { useEffect } from "react";

import { useApiQuery } from "@/hooks/use-api-query";
import { ApiError, setCsrfToken } from "@/lib/api";

export interface Me {
  user_id: number;
  email: string;
  display_name: string;
  avatar_url: string;
  github_login: string;
  csrf_token: string;
}

export function useMe() {
  const { data: me, loading, error } = useApiQuery<Me>("/v1/auth/me");

  // CSRF token 随 /me 一起下来，写进 sessionStorage 供后续写操作带上。
  useEffect(() => {
    if (me) setCsrfToken(me.csrf_token);
  }, [me]);

  return { me, loading, error: (error as ApiError | null) ?? null };
}
