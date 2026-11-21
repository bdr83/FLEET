'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { session } from '@/lib/api';
import { ROLE } from '@/lib/format';
import { ErrorBox, useAction } from '@/components/ui';

interface Membership { tenant_id: string; tenant_name: string; tenant_status: string; role_code: string }

/** Phone → OTP → pick a company (or create the first one). */
function Login() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const [step, setStep] = useState<'phone' | 'code' | 'pick'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [list, setList] = useState<Membership[]>([]);
  const [company, setCompany] = useState('');
  const { busy, error, run } = useAction();

  const go = () => { router.replace(target); router.refresh(); };

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await session('request', { phone });
      setDevCode(r.dev_code ?? null);
      setStep('code');
    });
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await session('verify', { phone, code });
      const ms: Membership[] = r.memberships ?? [];
      if (ms.length === 1) { await session('select', { tenant_id: ms[0].tenant_id }); go(); return; }
      setList(ms);
      setStep('pick');
    });
  }
  const pick = (id: string) => run(async () => { await session('select', { tenant_id: id }); go(); });
  async function onboard(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => { await session('onboard', { name: company, country: 'KW' }); go(); });
  }

  return (
    <div className="login">
      <div className="card stack">
        <h1>إدارة الأساطيل</h1>
        <ErrorBox error={error} />
        {step === 'phone' && (
          <form className="form" onSubmit={requestCode}>
            <label className="field">رقم الجوال
              <input className="num" name="phone" inputMode="tel" autoComplete="tel" placeholder="+965 5xxx xxxx" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </label>
            <button className="primary" disabled={busy}>إرسال رمز التحقق</button>
          </form>
        )}
        {step === 'code' && (
          <form className="form" onSubmit={verify}>
            <p className="muted" style={{ margin: 0 }}>أرسلنا رمزًا إلى <span className="num">{phone}</span></p>
            {devCode && <div className="alert ok">رمز التطوير: <span className="num">{devCode}</span></div>}
            <label className="field">رمز التحقق
              <input className="num" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            </label>
            <button className="primary" disabled={busy}>دخول</button>
            <button type="button" onClick={() => { setStep('phone'); setCode(''); }}>تغيير الرقم</button>
          </form>
        )}
        {step === 'pick' && (
          <div className="stack">
            {list.length > 0 && <>
              <h2>اختر الشركة</h2>
              {list.map((m) => (
                <button key={m.tenant_id} className="row spread" style={{ width: '100%' }} disabled={busy} onClick={() => pick(m.tenant_id)}>
                  <span>{m.tenant_name}</span><span className="muted">{ROLE[m.role_code] ?? m.role_code}</span>
                </button>
              ))}
            </>}
            <form className="form" onSubmit={onboard}>
              <h2>{list.length ? 'أو أنشئ شركة جديدة' : 'لا توجد شركة مرتبطة برقمك، أنشئ شركتك'}</h2>
              <label className="field">اسم الشركة
                <input name="company" value={company} onChange={(e) => setCompany(e.target.value)} required maxLength={120} />
              </label>
              <button className="primary" disabled={busy}>إنشاء الشركة (تجربة مجانية)</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><Login /></Suspense>;
}
