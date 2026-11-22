'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, ROLE } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Modal, Tabs, useAction, useForm, useLoad } from '@/components/ui';

type Tab = 'company' | 'members' | 'branches' | 'audit' | 'account';

export default function SettingsPage() {
  const me = useMe();
  const tabs: [Tab, string][] = [['company', 'الشركة والفوترة'], ['branches', 'الفروع']];
  if (can(me, 'members:read')) tabs.splice(1, 0, ['members', 'المستخدمون والصلاحيات']), tabs.push(['audit', 'سجل التدقيق']);
  tabs.push(['account', 'حسابي']);
  const [tab, setTab] = useState<Tab>('company');
  return (
    <div className="page stack">
      <div className="page-head"><h1>الإعدادات</h1></div>
      <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'company' && <Company />}
      {tab === 'members' && <Members />}
      {tab === 'branches' && <Branches />}
      {tab === 'audit' && <Audit />}
      {tab === 'account' && <Account />}
    </div>
  );
}

function Account() {
  const me = useMe();
  const { f, bind, setF } = useForm({ current_password: '', new_password: '' });
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setDone(false);
    void run(async () => {
      await api('/auth/password/change', { method: 'POST', body: f });
      setF({ current_password: '', new_password: '' }); setDone(true);
    });
  };
  return (
    <form className="form card" onSubmit={submit} style={{ maxWidth: 420 }}>
      <h2>تغيير كلمة المرور</h2>
      {me.email && <p className="muted" style={{ margin: 0 }}>الحساب: <span dir="ltr">{me.email}</span></p>}
      <ErrorBox error={error} />
      {done && <div className="alert ok">تم تغيير كلمة المرور</div>}
      <label className="field">كلمة المرور الحالية<input {...bind('current_password')} type="password" autoComplete="current-password" dir="ltr" /></label>
      <label className="field">كلمة المرور الجديدة <span className="muted">(8 أحرف على الأقل)</span><input {...bind('new_password')} type="password" autoComplete="new-password" dir="ltr" minLength={8} required /></label>
      <div><button className="primary" disabled={busy}>حفظ</button></div>
    </form>
  );
}

interface Entity { id: string; name: string; country: string; currency: string; timezone: string; cr_number: string | null; tax_rate: number; tax_number: string | null; invoice_prefix: string }
function Company() {
  const me = useMe();
  const list = useLoad(() => api<{ data: Entity[] }>('/legal-entities').then((r) => r.data));
  return <>
    <ErrorBox error={list.error} />
    {list.data?.map((e) => <EntityCard key={e.id} e={e} write={can(me, 'org:write')} onSaved={list.reload} />)}
  </>;
}

function EntityCard({ e, write, onSaved }: { e: Entity; write: boolean; onSaved: () => void }) {
  const { f, bind } = useForm({ tax_rate: String(e.tax_rate), tax_number: e.tax_number ?? '', invoice_prefix: e.invoice_prefix });
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      await api(`/legal-entities/${e.id}/billing`, { method: 'PATCH', body: { ...clean({ tax_number: f.tax_number, invoice_prefix: f.invoice_prefix.toUpperCase() }), tax_rate: Number(f.tax_rate) } });
      setSaved(true); onSaved();
    });
  };
  return (
    <section className="card stack">
      <h2>{e.name}</h2>
      <dl className="dl">
        <dt>الدولة</dt><dd>{e.country}</dd><dt>العملة</dt><dd>{e.currency}</dd><dt>المنطقة الزمنية</dt><dd className="num">{e.timezone}</dd>
        {e.cr_number && <><dt>السجل التجاري</dt><dd className="num">{e.cr_number}</dd></>}
      </dl>
      <form className="form-2" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">نسبة الضريبة على الفواتير %<input {...bind('tax_rate')} type="number" min={0} max={100} step="0.01" className="num" disabled={!write} /></label>
        <label className="field">الرقم الضريبي<input {...bind('tax_number')} className="num" maxLength={40} disabled={!write} /></label>
        <label className="field">بادئة رقم الفاتورة<input {...bind('invoice_prefix')} className="num" maxLength={8} pattern="[A-Za-z0-9]{1,8}" disabled={!write} /></label>
        {write && <div><button className="primary" disabled={busy}>حفظ</button>{saved && <span className="muted"> تم الحفظ</span>}</div>}
      </form>
      <p className="muted" style={{ margin: 0 }}>الكويت لا تطبّق ضريبة القيمة المضافة حاليًا، لذا القيمة الافتراضية صفر. اضبطها حسب نظام بلدك [تحقق محلي].</p>
    </section>
  );
}

interface Member { id: string; phone: string | null; email: string | null; display_name: string | null; role: string; customer_id: string | null; valid_until: string | null; created_at: string; user_id: string }
const ASSIGNABLE = ['admin', 'dispatcher', 'accountant', 'branch_supervisor', 'driver', 'employee', 'customer', 'owner'];
function Members() {
  const me = useMe();
  const list = useLoad(() => api<{ data: Member[] }>('/members').then((r) => r.data));
  const [adding, setAdding] = useState(false);
  const act = useAction();
  const write = can(me, 'members:write');
  const revoke = (m: Member) => act.run(async () => { await api(`/members/${m.id}`, { method: 'DELETE' }); await list.reload(); });
  const changeRole = (m: Member, role_code: string) => act.run(async () => { await api(`/members/${m.id}`, { method: 'PATCH', body: { role_code } }); await list.reload(); });
  return <>
    {write && <div><button className="primary" onClick={() => setAdding(true)}>إضافة مستخدم</button></div>}
    <p className="muted" style={{ margin: 0 }}>يدخل المستخدم ببريده وكلمة المرور (أو برقم جواله) ويرى شركتك في قائمته. السائقون يُضافون من صفحة السائقين.</p>
    <ErrorBox error={list.error ?? act.error} />
    {list.data?.length === 0 ? <Empty>لا يوجد مستخدمون</Empty> : (
      <div className="tbl-wrap"><table>
        <thead><tr><th>الاسم</th><th>البريد أو الجوال</th><th>الدور</th><th>أضيف</th><th></th></tr></thead>
        <tbody>{list.data?.map((m) => (
          <tr key={m.id}>
            <td>{m.display_name ?? '—'}{m.user_id === me.user_id && <> <Badge tone="info">أنت</Badge></>}</td>
            <td className="num" dir="ltr" style={{ textAlign: 'right' }}>{m.email ?? m.phone}</td>
            <td>{write && m.user_id !== me.user_id && m.role !== 'customer' && m.role !== 'driver'
              ? <select aria-label="الدور" value={m.role} onChange={(e) => changeRole(m, e.target.value)} disabled={act.busy} style={{ width: 'auto' }}>
                  {ASSIGNABLE.filter((r) => r !== 'customer' && r !== 'driver').map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
                </select>
              : ROLE[m.role] ?? m.role}</td>
            <td className="num">{dt(m.created_at)}</td>
            <td>{write && m.user_id !== me.user_id && <button className="small danger" disabled={act.busy} onClick={() => revoke(m)}>سحب الوصول</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )}
    {adding && <AddMember onClose={() => setAdding(false)} onDone={() => { setAdding(false); void list.reload(); }} />}
  </>;
}

function AddMember({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const { f, bind } = useForm({ by: 'email', email: '', password: '', phone: '', display_name: '', role_code: 'dispatcher', customer_id: '' });
  const customers = useLoad(() => f.role_code === 'customer' ? api<{ data: { id: string; name: string }[] }>('/customers?status=active').then((r) => r.data) : Promise.resolve([]), [f.role_code]);
  const { busy, error, run } = useAction();
  const roles = ASSIGNABLE.filter((r) => r !== 'driver' && (r !== 'owner' || me.role === 'owner'));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { by, ...rest } = f;
      const login = by === 'email' ? { phone: '' } : { email: '', password: '' };
      await api('/members', { method: 'POST', body: clean({ ...rest, ...login, customer_id: f.role_code === 'customer' ? f.customer_id : '' }) });
      onDone();
    });
  };
  return (
    <Modal title="إضافة مستخدم" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-2">
          <label className="field">طريقة الدخول<select {...bind('by')}><option value="email">البريد وكلمة المرور</option><option value="phone">رقم الجوال</option></select></label>
          {f.by === 'email' ? <>
            <label className="field">البريد الإلكتروني<input {...bind('email')} type="email" dir="ltr" required /></label>
            <label className="field">كلمة مرور أولى <span className="muted">(8 أحرف على الأقل، يغيّرها لاحقًا)</span><input {...bind('password')} type="text" dir="ltr" minLength={8} autoComplete="off" /></label>
          </> : (
            <label className="field">الجوال<input {...bind('phone')} className="num" inputMode="tel" required placeholder="+965 5xxx xxxx" /></label>
          )}
          <label className="field">الاسم<input {...bind('display_name')} maxLength={120} /></label>
          <label className="field">الدور<select {...bind('role_code')}>{roles.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></label>
          {f.role_code === 'customer' && (
            <label className="field">العميل (بوابة العملاء)<select {...bind('customer_id')} required><option value="">اختر</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          )}
        </div>
        {f.role_code === 'customer' && <p className="muted" style={{ margin: 0 }}>مستخدم بوابة العملاء يرى مهام عميله وفواتيره فقط.</p>}
        <div className="row"><button className="primary" disabled={busy}>إضافة</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}

function Branches() {
  const me = useMe();
  const list = useLoad(() => api<{ data: { id: string; legal_entity_id: string; name: string; active: boolean }[] }>('/branches').then((r) => r.data));
  const { f, bind, setF } = useForm({ name: '', legal_entity_id: me.legal_entities[0]?.id ?? '' });
  const act = useAction();
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => { await api('/branches', { method: 'POST', body: f }); setF({ ...f, name: '' }); await list.reload(); });
  };
  const toggle = (id: string, active: boolean) => act.run(async () => { await api(`/branches/${id}`, { method: 'PATCH', body: { active } }); await list.reload(); });
  const write = can(me, 'org:write');
  return <>
    <ErrorBox error={list.error ?? act.error} />
    {list.data?.length === 0 ? <Empty>لا توجد فروع. الفروع اختيارية وتُستخدم لتقييد صلاحيات المشرفين.</Empty> : (
      <table className="card"><tbody>{list.data?.map((b) => (
        <tr key={b.id} style={b.active ? undefined : { opacity: 0.5 }}><td>{b.name}</td><td>{b.active ? <Badge tone="success">نشط</Badge> : <Badge>متوقف</Badge>}</td>
          <td>{write && <button className="small" disabled={act.busy} onClick={() => toggle(b.id, !b.active)}>{b.active ? 'إيقاف' : 'تفعيل'}</button>}</td></tr>
      ))}</tbody></table>
    )}
    {write && (
      <form className="row" onSubmit={add}>
        <input {...bind('name')} placeholder="اسم الفرع" required maxLength={120} style={{ maxWidth: 260 }} />
        {me.legal_entities.length > 1 && <select {...bind('legal_entity_id')} style={{ width: 'auto' }}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
        <button disabled={act.busy}>إضافة فرع</button>
      </form>
    )}
  </>;
}

const ACTION_AR: Record<string, string> = {
  'task.created': 'إنشاء مهمة', 'task.updated': 'تعديل مهمة', 'invoice.issued': 'إصدار فاتورة', 'invoice.voided': 'إلغاء فاتورة', 'payment.created': 'تسجيل دفعة',
  'payment.reversed': 'عكس دفعة', 'member.added': 'إضافة مستخدم', 'member.updated': 'تعديل مستخدم', 'member.revoked': 'سحب وصول', 'contract.activate': 'تفعيل عقد',
};
function Audit() {
  const list = useLoad(() => api<{ data: { id: string; actor_type: string; action: string; target_type: string; at: string }[] }>('/audit-log').then((r) => r.data));
  return <>
    <ErrorBox error={list.error} />
    <p className="muted" style={{ margin: 0 }}>آخر 200 عملية حساسة.</p>
    <div className="tbl-wrap"><table>
      <thead><tr><th>الوقت</th><th>العملية</th><th>العنصر</th></tr></thead>
      <tbody>{list.data?.map((r) => <tr key={r.id}><td className="num">{dt(r.at)}</td><td>{ACTION_AR[r.action] ?? <span className="num">{r.action}</span>}</td><td className="num">{r.target_type}</td></tr>)}</tbody>
    </table></div>
  </>;
}
