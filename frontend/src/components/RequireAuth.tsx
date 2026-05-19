import { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useMe } from '@/hooks/use-me';

export default function RequireAuth({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const { me, loading, error } = useMe();
  if (loading) return <div className="p-6">Loading...</div>;
  if (error || !me) {
    const next = encodeURIComponent(loc.pathname + loc.search);
    window.location.replace(`/login?next=${next}`);
    return null;
  }
  return <>{children}</>;
}
