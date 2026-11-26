'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dt } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, Empty, ErrorBox, Kpi, useAction, useLoad } from '@/components/ui';

interface Entity { id: string; name: string; currency: string }
interface Link {
  protocol: 'json2' | 'jsonrpc'; base_url: string; database: string | null; login: string | null; journal_id: number;
  account_map: Record<string, string>; sync_from: string; enabled: boolean; last_ok_at: string | null; last_error: string | null;
}
interface Status {
  link: Link | null;
  accounts: { code: string; name: string }[];
  counts: { sent: number; failed: number; waiting: number } | null;
  failures: { journal_id: string; source_type: string; posted_at: string; attempts: number; last_error: string; next_attempt_at: string | null }[];
}
interface TestResult {
  ok: boolean; error?: string; journal?: string; company?: string | null; company_currency?: string | null;
  currency_matches?: boolean; missing_accounts?: string[]; unmapped_accounts?: string[];
}

const SOURCE: Record<string, string> = {
  invoice: 'فاتورة', invoice_reversal: 'إلغاء فاتورة', payment: 'دفعة', payment_reversal: 'عكس دفعة', expense: 'مصروف',
  cod_collection: 'تحصيل COD', cod_deposit: 'إيداع COD', cod_payout: 'تسوية COD',
};
const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

/** Settings tab: links one legal entity's ledger to the customer's own Odoo, so every journal lands there as a posted entry. */
export function OdooLink() {
  const entities = useLoad(() => api<{ data: Entity[] }>('/legal-entities').then((r) => r.data));
  const [entityId, setEntityId] = useState('');
  useEffect(() => { if (!entityId && entities.data?.length) setEntityId(entities.data[0].id); }, [entities.data, entityId]);
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        يرسل كل قيد في دفترنا (الفواتير، الدفعات، المصروفات، تحصيل COD) إلى Odoo الخاص بشركتك كقيد يومية مرحّل، مرة واحدة فقط.
        يبقى التشغيل هنا، والمحاسبة الكاملة والتقارير المالية في Odoo. يعمل مع Odoo Community و Enterprise.
      </p>
      <ErrorBox error={entities.error} />
      {(entities.data?.length ?? 0) > 1 && (
        <label className="field" style={{ maxWidth: 320 }}>الشركة القانونية
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            {entities.data!.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      )}
      {entityId && <EntityLink key={entityId} entity={entities.data!.find((e) => e.id === entityId)!} />}
    </div>
  );
}

function EntityLink({ entity }: { entity: Entity }) {
  const me = useMe();
  const write = can(me, 'org:write');
  const operate = can(me, 'billing:write');
  const st = useLoad(() => api<Status>(`/integrations/odoo?legal_entity_id=${entity.id}`));
  const [f, setF] = useState({ protocol: 'json2', base_url: '', database: '', login: '', api_key: '', journal_id: '', sync_from: today(), enabled: true });
  const [map, setMap] = useState<Record<string, string>>({});
  const [test, setTest] = useState<TestResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = useAction();

  useEffect(() => {
    const l = st.data?.link;
    if (!l) return;
    setF({ protocol: l.protocol, base_url: l.base_url, database: l.database ?? '', login: l.login ?? '', api_key: '', journal_id: String(l.journal_id), sync_from: l.sync_from, enabled: l.enabled });
    setMap(l.account_map);
  }, [st.data?.link]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  const save = (e: React.FormEvent) => {
    e.preventDefault(); setNote(null); setTest(null);
    void act.run(async () => {
      await api('/integrations/odoo', { method: 'PUT', body: {
        legal_entity_id: entity.id, protocol: f.protocol, base_url: f.base_url.trim(), database: f.database.trim() || null,
        login: f.login.trim() || null, api_key: f.api_key || undefined, journal_id: Number(f.journal_id),
        account_map: Object.fromEntries(Object.entries(map).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])),
        sync_from: f.sync_from, enabled: f.enabled,
      } });
      setF((x) => ({ ...x, api_key: '' })); setNote('تم الحفظ'); await st.reload();
    });
  };
  const runTest = () => { setNote(null); void act.run(async () => setTest(await api<TestResult>('/integrations/odoo/test', { method: 'POST', body: { legal_entity_id: entity.id } }))); };
  const sendNow = async (requeue: boolean) => {
    if (requeue) await api('/integrations/odoo/retry', { method: 'POST', body: { legal_entity_id: entity.id } });
    const r = await api<{ sent: number; failed: number; error: string | null }>('/integrations/odoo/sync', { method: 'POST', body: { legal_entity_id: entity.id } });
    setNote(r.error ? `توقفت المزامنة: ${r.error}` : `أُرسل ${r.sent} قيد، وتعذّر ${r.failed}`);
    await st.reload();
  };
  const syncNow = () => { setNote(null); void act.run(() => sendNow(false)); };
  const retry = () => { setNote(null); void act.run(() => sendNow(true)); };

  const s = st.data;
  const linked = !!s?.link;
  return (
    <div className="stack">
      <ErrorBox error={st.error ?? act.error} />
      {note && <div className="alert ok">{note}</div>}
      {linked && s!.counts && (
        <section className="card stack">
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>حالة المزامنة</h2>
            {s!.link!.enabled ? (s!.link!.last_error ? <Badge tone="danger">متوقفة</Badge> : <Badge tone="success">تعمل</Badge>) : <Badge>موقوفة</Badge>}
          </div>
          <div className="grid g4">
            <Kpi label="أُرسلت" value={s!.counts.sent} tone="success" />
            <Kpi label="بانتظار الإرسال" value={s!.counts.waiting} />
            <Kpi label="تعذّر إرسالها" value={s!.counts.failed} tone={s!.counts.failed ? 'danger' : undefined} />
          </div>
          {s!.link!.last_error && <div className="alert">{s!.link!.last_error}</div>}
          <p className="muted" style={{ margin: 0 }}>
            آخر مزامنة ناجحة: {s!.link!.last_ok_at ? dt(s!.link!.last_ok_at) : 'لم تتم بعد'}. تعمل المزامنة تلقائيًا كل 5 دقائق.
          </p>
          {operate && <div className="row" style={{ gap: 8 }}>
            <button onClick={syncNow} disabled={act.busy}>زامن الآن</button>
            {s!.counts.failed > 0 && <button onClick={retry} disabled={act.busy}>أعد محاولة القيود المتعذرة</button>}
          </div>}
          {s!.failures.length > 0 && (
            <div className="tbl-wrap"><table>
              <thead><tr><th>القيد</th><th>التاريخ</th><th>المحاولات</th><th>السبب</th><th>المحاولة التالية</th></tr></thead>
              <tbody>{s!.failures.map((x) => (
                <tr key={x.journal_id}><td>{SOURCE[x.source_type] ?? x.source_type}</td><td className="num">{dt(x.posted_at)}</td>
                  <td className="num">{x.attempts}</td><td>{x.last_error}</td><td className="num">{x.next_attempt_at ? dt(x.next_attempt_at) : ''}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}

      <form className="card stack" onSubmit={save}>
        <h2 style={{ margin: 0 }}>{linked ? 'إعدادات الربط' : `ربط ${entity.name} مع Odoo`}</h2>
        {!linked && !write && <Empty>لم يُربط Odoo بعد. يربطه مدير الشركة من هنا.</Empty>}
        <div className="form-2">
          <label className="field">نوع الربط
            <select value={f.protocol} onChange={set('protocol')} disabled={!write}>
              <option value="json2">Odoo 19 أو أحدث (JSON-2)</option>
              <option value="jsonrpc">Odoo 17 أو 18 (JSON-RPC)</option>
            </select>
          </label>
          <label className="field">رابط Odoo<input value={f.base_url} onChange={set('base_url')} dir="ltr" placeholder="https://mycompany.odoo.com" required disabled={!write} /></label>
          <label className="field">اسم قاعدة البيانات {f.protocol === 'json2' && <span className="muted">(اختياري)</span>}
            <input value={f.database} onChange={set('database')} dir="ltr" required={f.protocol === 'jsonrpc'} disabled={!write} /></label>
          {f.protocol === 'jsonrpc' && <label className="field">بريد مستخدم الربط في Odoo<input value={f.login} onChange={set('login')} dir="ltr" required disabled={!write} /></label>}
          <label className="field">مفتاح الـ API {linked && <span className="muted">(اتركه فارغًا لإبقاء المفتاح المحفوظ)</span>}
            <input value={f.api_key} onChange={set('api_key')} type="password" dir="ltr" autoComplete="off" required={!linked} disabled={!write} /></label>
          <label className="field">رقم دفتر اليومية في Odoo<input value={f.journal_id} onChange={set('journal_id')} type="number" min={1} className="num" required disabled={!write} /></label>
          <label className="field">أرسل القيود ابتداءً من<input value={f.sync_from} onChange={set('sync_from')} type="date" className="num" required disabled={!write} /></label>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={f.enabled} onChange={set('enabled')} style={{ width: 'auto' }} disabled={!write} /> الربط مفعّل
          </label>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          أنشئ مفتاح الـ API في Odoo من: التفضيلات ثم أمان الحساب ثم مفتاح API جديد، لمستخدم له صلاحية المحاسبة. رقم الدفتر يظهر في رابط صفحة الدفتر
          (يفضّل دفتر العمليات المتنوعة). القيود قبل التاريخ المختار لا تُرسل، فأدخل الأرصدة الافتتاحية في Odoo مباشرة.
        </p>

        <h3 style={{ margin: 0 }}>ربط الحسابات</h3>
        <p className="muted" style={{ margin: 0 }}>اكتب رمز الحساب المقابل في دليل حسابات Odoo لكل حساب من حساباتنا. القيد الذي فيه حساب غير مربوط لا يُرسل ويظهر سببه أعلاه.</p>
        <div className="tbl-wrap"><table>
          <thead><tr><th>حسابنا</th><th>رمز الحساب في Odoo</th></tr></thead>
          <tbody>{s?.accounts.map((a) => (
            <tr key={a.code}>
              <td><span className="num">{a.code}</span> {a.name}</td>
              <td><input value={map[a.code] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [a.code]: e.target.value }))} dir="ltr" className="num" maxLength={64} disabled={!write} style={{ maxWidth: 180 }} /></td>
            </tr>
          ))}</tbody>
        </table></div>

        {write && <div className="row" style={{ gap: 8 }}>
          <button className="primary" disabled={act.busy}>حفظ</button>
          {linked && <button type="button" onClick={runTest} disabled={act.busy}>اختبر الاتصال</button>}
        </div>}
        {test && (test.ok
          ? <div className="alert ok">الاتصال يعمل: الدفتر «{test.journal}»{test.company ? ` في ${test.company}` : ''}، والحسابات المربوطة موجودة.{test.unmapped_accounts?.length ? ` حسابات لم تُربط بعد: ${test.unmapped_accounts.join('، ')}.` : ''}</div>
          : <div className="alert">
              {test.error ?? [
                test.missing_accounts?.length ? `هذه الرموز غير موجودة في Odoo: ${test.missing_accounts.join('، ')}.` : '',
                test.currency_matches === false ? `عملة الشركة في Odoo (${test.company_currency}) تختلف عن عملتنا (${entity.currency}).` : '',
              ].filter(Boolean).join(' ')}
            </div>)}
      </form>
    </div>
  );
}
