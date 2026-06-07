import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

const ERR_MAP: Record<string, string> = {
  oauth_state_invalid:   'OAuth state 已过期，请重新发起登录。',
  oauth_exchange_failed: 'GitHub OAuth 兑换失败，请稍后重试或检查 GitHub OAuth App 配置。',
  oauth_profile_failed:  '无法获取 GitHub 用户信息。',
  github_email_missing:  '请在 GitHub 设置中将主邮箱设为已验证后重试。',
  access_denied:         '你取消了 GitHub 授权。',
  user_banned:           '账户已被封禁，请联系管理员。',
};

export default function Login() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next') ?? '';
  const userCode = params.get('user_code') ?? '';
  const err = params.get('err');

  const onLogin = () => {
    const u = new URLSearchParams();
    if (next) u.set('next', next);
    if (userCode) u.set('user_code', userCode);
    window.location.href = '/v1/auth/oauth/github/authorize?' + u.toString();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 p-8 border rounded-xl">
        <h1 className="text-2xl font-semibold">登录 AgentRe Server</h1>
        {err && <Alert variant="destructive">{ERR_MAP[err] ?? err}</Alert>}
        <Button className="w-full" onClick={onLogin}>使用 GitHub 登录</Button>
      </div>
    </div>
  );
}
