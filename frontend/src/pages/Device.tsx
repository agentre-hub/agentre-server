import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { api, ApiError } from '@/lib/api';

interface PendingInfo {
  device_kind: string;
  platform: string;
  version: string;
  capabilities: Record<string, boolean>;
  expires_in: number;
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function normalize(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '').split('');
  if (cleaned.length !== 6) return null;
  for (const c of cleaned) if (!ALPHABET.includes(c)) return null;
  return cleaned.slice(0, 3).join('') + '-' + cleaned.slice(3).join('');
}

export default function Device() {
  const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const initial = params.get('user_code') ?? '';
  const [code, setCode] = useState(initial);
  const [info, setInfo] = useState<PendingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const norm = normalize(initial);
    if (norm) loadPending(norm);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  async function loadPending(uc: string) {
    setError(null);
    try {
      const got = await api<PendingInfo>(`/v1/oauth/device/pending?user_code=${encodeURIComponent(uc)}`);
      setInfo(got);
      setCode(uc);
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
    }
  }

  async function onApprove() {
    if (!info) return;
    setSubmitting(true);
    try {
      await api(`/v1/oauth/device/approve`, {
        method: 'POST', body: JSON.stringify({ user_code: code }),
      });
      nav('/device/success');
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
    } finally { setSubmitting(false); }
  }

  async function onDeny() {
    if (!info) return;
    setSubmitting(true);
    try {
      await api(`/v1/oauth/device/deny`, {
        method: 'POST', body: JSON.stringify({ user_code: code }),
      });
      setError('已拒绝授权，可关闭此页面。');
      setInfo(null);
    } finally { setSubmitting(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-6 p-8 border rounded-xl">
        <h1 className="text-2xl font-semibold">设备授权</h1>
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A4F-7Q2" />
        {error && <Alert variant="destructive">{error}</Alert>}
        <Button onClick={() => { const n = normalize(code); if (n) loadPending(n); else setError('user_code 格式不正确'); }}>
          查询
        </Button>

        <Dialog open={!!info} onOpenChange={(o) => { if (!o) setInfo(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>授权该设备</DialogTitle>
              <DialogDescription>
                {info?.device_kind} ({info?.platform} {info?.version})
                <br />capabilities: {Object.entries(info?.capabilities ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onDeny} disabled={submitting}>拒绝</Button>
              <Button onClick={onApprove} disabled={submitting}>允许</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
