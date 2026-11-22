'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, session } from '@/lib/api';
import { ROLE } from '@/lib/format';
import { ErrorBox, useAction } from '@/components/ui';

interface Membership { tenant_id: string; tenant_name: string; tenant_status: string; role_code: string }
type Step = 'email' | 'register' | 'forgot' | 'sent' | 'phone' | 'code' | 'pick';

/** Email + password (or phone → OTP when enabled) → pick a company, or create the first one. */
export function LoginForm({ phoneEnabled }: { phoneEnabled: boolean }) {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resetOn, setResetOn] = useState(false);
  const [list, setList] = useState<Membership[]>([]);
  const [company, setCompany] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => { session('methods').then((m) => setResetOn(!!m.password_reset)).catch(() => undefined); }, []);

  const go = () => { router.replace(target); router.refresh(); };
  const afterLogin = async (r: { memberships?: Membership[] }) => {
    const ms = r.memberships ?? [];
    if (ms.length === 1) { await session('select', { tenant_id: ms[0].tenant_id }); go(); return; }
    setList(ms);
    setStep('pick');
  };
  const submit = (fn: () => Promise<void>) => (e: React.FormEvent) => { e.preventDefault(); return run(fn); };

  const login = submit(async () => {
    try { await afterLogin(await session('login', { email, password })); }
    catch (e) { if (e instanceof ApiError && e.status === 401) throw new ApiError(401, 'البريد أو كلمة المرور غير صحيحة'); throw e; }
  });
  const register = submit(async () => {
    try { await afterLogin(await session('register', { email, password, display_name: name })); }
    catch (e) { if (e instanceof ApiError && e.status === 409) throw new ApiError(409, 'هذا البريد مسجّل، ادخل بكلمة المرور'); throw e; }
  });
  const forgot = submit(async () => { await session('forgot', { email }); setStep('sent'); });
  const requestCode = submit(async () => { const r = await session('request', { phone }); setDevCode(r.dev_code ?? null); setStep('code'); });
  const verify = submit(async () => afterLogin(await session('verify', { phone, code })));
  const pick = (id: string) => run(async () => { await session('select', { tenant_id: id }); go(); });
  const onboard = submit(async () => { await session('onboard', { name: company, country: 'KW' }); go(); });
  const to = (s: Step) => () => setStep(s);

  const emailField = (
    <label className="field">البريد الإلكتروني
      <input name="email" type="email" inputMode="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required />
    </label>
  );
  const passwordField = (isNew: boolean) => (
    <label className="field">كلمة المرور{isNew && <span className="muted"> (8 أحرف على الأقل)</span>}
      <input name="password" type="password" autoComplete={isNew ? 'new-password' : 'current-password'} dir="ltr" minLength={isNew ? 8 : undefined}
        value={password} onChange={(e) => setPassword(e.target.value)} required />
    </label>
  );

  return (
    <div className="login">
      <div className="card stack">
        <h1>إدارة الأساطيل</h1>
        <ErrorBox error={error} />
        {step === 'email' && (
          <form className="form" onSubmit={login}>
            {emailField}
            {passwordField(false)}
            <button className="primary" disabled={busy}>دخول</button>
            <div className="row spread">
              <button type="button" className="link" onClick={to('register')}>حساب جديد</button>
              {resetOn && <button type="button" className="link" onClick={to('forgot')}>نسيت كلمة المرور</button>}
            </div>
            {phoneEnabled && <button type="button" onClick={to('phone')}>الدخول برقم الجوال</button>}
          </form>
        )}
        {step === 'register' && (
          <form className="form" onSubmit={register}>
            <h2>حساب جديد</h2>
            <label className="field">الاسم
              <input name="display_name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </label>
            {emailField}
            {passwordField(true)}
            <button className="primary" disabled={busy}>إنشاء الحساب</button>
            <button type="button" onClick={to('email')}>لدي حساب</button>
          </form>
        )}
        {step === 'forgot' && (
          <form className="form" onSubmit={forgot}>
            <h2>استعادة كلمة المرور</h2>
            {emailField}
            <button className="primary" disabled={busy}>إرسال رابط الاستعادة</button>
            <button type="button" onClick={to('email')}>رجوع</button>
          </form>
        )}
        {step === 'sent' && (
          <div className="stack">
            <div className="alert ok">إذا كان البريد مسجّلًا فستصلك رسالة فيها رابط صالح لمدة ساعة.</div>
            <button type="button" onClick={to('email')}>رجوع للدخول</button>
          </div>
        )}
        {step === 'phone' && (
          <form className="form" onSubmit={requestCode}>
            <label className="field">رقم الجوال
              <input className="num" name="phone" inputMode="tel" autoComplete="tel" placeholder="+965 5xxx xxxx" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </label>
            <button className="primary" disabled={busy}>إرسال رمز التحقق</button>
            <button type="button" onClick={to('email')}>الدخول بالبريد</button>
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
              <h2>{list.length ? 'أو أنشئ شركة جديدة' : 'لا توجد شركة مرتبطة بحسابك، أنشئ شركتك'}</h2>
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
