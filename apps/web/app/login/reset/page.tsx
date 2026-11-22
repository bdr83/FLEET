'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, session } from '@/lib/api';
import { ErrorBox, useAction } from '@/components/ui';

/** Opened from the reset email: sets a new password, then signs in. */
function Reset() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      try {
        const r = await session('reset', { token, password });
        const ms = r.memberships ?? [];
        if (ms.length === 1) await session('select', { tenant_id: ms[0].tenant_id });
        router.replace(ms.length === 1 ? '/' : '/login'); router.refresh();
      } catch (err) {
        if (err instanceof ApiError && err.status === 400 && /token/.test(err.message)) throw new ApiError(400, 'الرابط منتهي أو مستخدم، اطلب رابطًا جديدًا');
        throw err;
      }
    });
  };
  return (
    <div className="login">
      <div className="card stack">
        <h1>كلمة مرور جديدة</h1>
        <ErrorBox error={error} />
        <form className="form" onSubmit={submit}>
          <label className="field">كلمة المرور الجديدة <span className="muted">(8 أحرف على الأقل)</span>
            <input name="password" type="password" autoComplete="new-password" dir="ltr" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          </label>
          <button className="primary" disabled={busy || !token}>حفظ والدخول</button>
        </form>
      </div>
    </div>
  );
}

export default function ResetPage() { return <Suspense><Reset /></Suspense>; }
