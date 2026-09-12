import { useState } from "react";

import { useAliveEffect } from "@/hooks/use-api-query";
import { api, ApiError, setCsrfToken } from "@/lib/api";

export interface Me {
  user_id: number;
  email: string;
  display_name: string;
  avatar_url: string;
  github_login: string;
  csrf_token: string;
}

/**
 * 当前登录的人，外加这条会话的 CSRF token。
 *
 * 不走 `useApiQuery`，是因为 token 的**发布时刻**在这里是有意义的：它必须在 `me`
 * 变成真值**之前**就位。`RequireAuth` 拿 `me` 当闸门，放行的那一次提交里整棵子树
 * 会一起挂上来，而 React 的 passive effect 自下而上跑——子树里那些「一挂上就发写
 * 请求」的（账号通道的取票 POST 是现成的一个）会跑在父组件的 effect 前面。把
 * `setCsrfToken` 放进 effect，等于保证首次登录的那一发写请求不带 token，被 CSRF
 * 中间件 403。
 *
 * 之所以只有**首次登录**看得见：`main.tsx` 的 `loadCsrfToken()` 在模块加载时从
 * sessionStorage 读一遍，第二次起手上早就有货了。
 *
 * 所以这里在 `.then` 里先发布 token 再交出 `me`，两者落在同一个微任务里、顺序写死。
 * 也因此不受挂载守卫管：token 是**这个标签页**的会话状态，不是这个组件的状态，
 * 组件卸载了它照样是对的。
 */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useAliveEffect((alive) => {
    api<Me>("/v1/auth/me")
      .then((got) => {
        setCsrfToken(got.csrf_token);
        if (!alive()) return;
        setMe(got);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive()) return;
        // 一律存真值，理由同 useApiQuery：调用方按 `error ? 错误态 : 骨架` 渲染。
        setError(
          e instanceof ApiError
            ? e
            : new ApiError(0, "/v1/auth/me 请求失败", 0),
        );
        setLoading(false);
      });
  }, []);

  return { me, loading, error };
}
