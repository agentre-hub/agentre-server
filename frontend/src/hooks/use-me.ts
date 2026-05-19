import { useEffect, useState } from 'react';
import { api, ApiError, setCsrfToken } from '@/lib/api';

export interface Me {
  user_id: number;
  email: string;
  display_name: string;
  avatar_url: string;
  github_login: string;
  csrf_token: string;
}

export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let alive = true;
    api<Me>('/v1/auth/me')
      .then((m) => {
        if (!alive) return;
        setMe(m);
        setCsrfToken(m.csrf_token);
      })
      .catch((e) => {
        if (alive) setError(e as ApiError);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { me, loading, error };
}
