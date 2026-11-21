'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { addressLine, dt, FAIL_REASON, KwAddress, money, POD_METHOD, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, Empty, ErrorBox, Kpi, Tabs, useAction, useLoad } from '@/components/ui';

interface Row {
  id: string; ref: string | null; status: string; attributes: Record<string, unknown>; worker_name: string | null;
  window_to?: string | null; due_at?: string; method?: string; recipient_name?: string | null; proof_at?: string;
  reason_code?: string | null; note?: string | null; failed_at?: string; pin_attempts?: number;
}
interface Exceptions {
  late: Row[]; proofs: Row[]; returns: Row[]; pins: Row[];
  custody: { worker_id: string; display_name: string; currency: string; held: string; alert_at: string }[];
}
type Tab = 'exceptions' | 'import' | 'earnings' | 'settings';

/** Delivery hub: exceptions, auto-assignment, order import, driver earnings and the pack's settings. */
export default function DeliveryHub() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('exceptions');
  const tabs: [Tab, string][] = [['exceptions', 'الاستثناءات'], ...(can(me, 'tasks:write') ? [['import', 'استيراد الطلبات'] as [Tab, string]] : []),
    ...(can(me, 'reports:read') ? [['earnings', 'أرباح السائقين'] as [Tab, string]] : []), ['settings', 'الإعدادات']];
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>مركز التوصيل</h1>
        {can(me, 'tasks:assign') && <AutoAssign />}
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'import' && <ImportView />}
      {tab === 'earnings' && <EarningsView />}
      {tab === 'settings' && <SettingsView />}
    </div>
  );
}

function AutoAssign() {
  const act = useAction();
  const [res, setRes] = useState<{ assigned: unknown[]; skipped: unknown[] } | null>(null);
  return (
    <div className="row">
      {res && <span className="muted">أُسندت <span className="num">{res.assigned.length}</span> وبقيت <span className="num">{res.skipped.length}</span> بلا سائق مناسب</span>}
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy} title="يسند الطلبات الجاهزة لأقرب سائق في وردية ضمن النطاق والحد الأقصى"
        onClick={() => act.run(async () => setRes(await api('/delivery/auto-assign', { method: 'POST', body: {} })))}>إسناد تلقائي</button>
    </div>
  );
}

const ref = (r: Row) => <Link href={`/tasks/${r.id}`}>{r.ref ?? r.id.slice(0, 8)}</Link>;
const area = (r: Row) => addressLine(r.attributes?.dropoff as KwAddress) !== '—' ? addressLine(r.attributes?.dropoff as KwAddress) : String(r.attributes?.address ?? '—');

function ExceptionsView() {
  const ex = useLoad(() => api<Exceptions>('/delivery/exceptions'));
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="متأخرة" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
        <Kpi label="إثباتات بانتظار الموافقة" value={d.proofs.length} tone={d.proofs.length ? 'warning' : undefined} />
        <Kpi label="فاشلة لم تُرجع" value={d.returns.length} tone={d.returns.length ? 'warning' : undefined} />
        <Kpi label="عهدة نقدية عالية" value={d.custody.length} tone={d.custody.length ? 'danger' : undefined} />
      </div>
      <section className="card">
        <h2>متأخرة عن الموعد أو SLA</h2>
        {d.late.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>الطلب</th><th>المنطقة</th><th>السائق</th><th>كان مستحقًا</th></tr></thead>
            <tbody>{d.late.map((r) => <tr key={r.id}><td>{ref(r)}</td><td>{area(r)}</td><td>{r.worker_name ?? <Badge tone="warning">غير مسند</Badge>}</td><td className="num">{dt(r.due_at)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
      <section className="card">
        <h2>إثباتات تسليم بانتظار الموافقة</h2>
        {d.proofs.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>الطلب</th><th>النوع</th><th>المستلم</th><th>السائق</th><th>الوقت</th></tr></thead>
            <tbody>{d.proofs.map((r) => <tr key={r.id}><td>{ref(r)}</td><td>{POD_METHOD[r.method ?? ''] ?? r.method}</td><td>{r.recipient_name ?? '—'}</td><td>{r.worker_name ?? '—'}</td><td className="num">{dt(r.proof_at)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
      <section className="card">
        <h2>فاشلة لم تُرجع للمرسل</h2>
        {d.returns.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>الطلب</th><th>السبب</th><th>السائق</th><th>الوقت</th></tr></thead>
            <tbody>{d.returns.map((r) => <tr key={r.id}><td>{ref(r)}</td><td>{r.reason_code ? FAIL_REASON[r.reason_code] ?? r.reason_code : r.note ?? '—'}</td><td>{r.worker_name ?? '—'}</td><td className="num">{dt(r.failed_at)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
      {d.pins.length > 0 && (
        <section className="card">
          <h2>رموز مقفلة</h2>
          <p className="muted">أدخل السائق رمزًا خاطئًا 5 مرات. التسليم يحتاج صورة أو توقيعًا يوافق عليه المكتب.</p>
          <ul>{d.pins.map((r) => <li key={r.id}>{ref(r)} · {r.worker_name ?? '—'}</li>)}</ul>
        </section>
      )}
      <section className="card">
        <h2>سائقون بعهدة نقدية فوق الحد</h2>
        {d.custody.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>السائق</th><th>العهدة</th><th>الحد</th></tr></thead>
            <tbody>{d.custody.map((c) => <tr key={c.worker_id}><td>{c.display_name}</td><td className="num">{money(c.held, c.currency)}</td><td className="num">{money(c.alert_at, c.currency)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

/** Columns of the import sheet, in order. The first row of the pasted text may be this header. */
const COLS = ['external_order_id', 'recipient_name', 'recipient_phone', 'area', 'block', 'street', 'avenue', 'house', 'cod_amount', 'delivery_fee', 'notes'] as const;
const COL_AR = ['رقم الطلب', 'اسم المستلم', 'جوال المستلم', 'المنطقة', 'القطعة', 'الشارع', 'الجادة', 'المنزل', 'COD', 'رسم التوصيل', 'ملاحظات'];

/** Minimal CSV: commas or tabs (pasted from a sheet), double quotes for fields with commas. */
function parseSheet(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sep = line.includes('\t') ? '\t' : ',';
    const out: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    rows.push(out);
  }
  return rows;
}

function toOrder(r: string[]) {
  const g = (k: (typeof COLS)[number]) => r[COLS.indexOf(k)] || undefined;
  return {
    external_order_id: g('external_order_id'),
    recipient: { name: g('recipient_name'), phone: g('recipient_phone') },
    dropoff: { area: g('area'), block: g('block'), street: g('street'), avenue: g('avenue'), house: g('house') },
    cod_amount: g('cod_amount'), delivery_fee: g('delivery_fee'), notes: g('notes'),
  };
}

function ImportView() {
  const me = useMe();
  const [text, setText] = useState('');
  const [le, setLe] = useState(me.legal_entities[0]?.id ?? '');
  const act = useAction();
  const [res, setRes] = useState<{ created: number; duplicates: number; errors: { row: number; external_order_id: string | null; error: string }[] } | null>(null);
  let rows = parseSheet(text);
  if (rows[0] && (rows[0][0] === 'external_order_id' || rows[0][0] === COL_AR[0])) rows = rows.slice(1);
  const submit = () => act.run(async () => {
    setRes(await api('/delivery/import', { method: 'POST', body: { legal_entity_id: le, orders: rows.map(toOrder) } }));
  });
  return (
    <section className="card stack">
      <h2>استيراد طلبات التوصيل</h2>
      <p className="muted" style={{ margin: 0 }}>الصق الطلبات من جدول (Excel أو Google Sheets) أو ملف CSV. رقم الطلب يمنع التكرار: الطلب الموجود لا يُنشأ مرة ثانية. المطلوب لكل طلب: رقم الطلب وجوال المستلم والمنطقة.</p>
      <div className="muted">ترتيب الأعمدة: <span>{COL_AR.join('، ')}</span></div>
      {me.legal_entities.length > 1 && (
        <label className="field">الشركة القانونية
          <select value={le} onChange={(e) => setLe(e.target.value)}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
      )}
      <textarea name="sheet" rows={8} dir="auto" style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 13 }} value={text} onChange={(e) => { setText(e.target.value); setRes(null); }}
        placeholder={'TL-1001,أحمد,50000001,السالمية,5,10,,12,7.500,1.250,\nTL-1002,سارة,60000002,حولي,3,15,,4,,1.000,الدور الثاني'} />
      <ErrorBox error={act.error} />
      <div className="row">
        <button className="primary" disabled={act.busy || rows.length === 0 || rows.length > 500} onClick={submit}>استيراد <span className="num">{rows.length}</span> طلب</button>
        {rows.length > 500 && <span className="muted">الحد 500 طلب في المرة</span>}
      </div>
      {res && (
        <div className="stack" data-testid="import-result">
          <div className="alert ok">أُنشئ <span className="num">{res.created}</span> · مكرر <span className="num">{res.duplicates}</span> · أخطاء <span className="num">{res.errors.length}</span></div>
          {res.errors.length > 0 && (
            <div className="tbl-wrap"><table>
              <thead><tr><th>السطر</th><th>رقم الطلب</th><th>الخطأ</th></tr></thead>
              <tbody>{res.errors.map((e) => <tr key={e.row}><td className="num">{e.row + 1}</td><td className="num">{e.external_order_id ?? '—'}</td><td dir="ltr">{e.error}</td></tr>)}</tbody>
            </table></div>
          )}
        </div>
      )}
    </section>
  );
}

function EarningsView() {
  const [from, setFrom] = useState(`${todayKw().slice(0, 8)}01`);
  const [to, setTo] = useState(todayKw());
  const next = (d: string) => new Date(Date.parse(`${d}T00:00:00+03:00`) + 86_400_000).toISOString();
  const data = useLoad(() => api<{ data: { worker_id: string; display_name: string; delivered: number; failed: number; commission: string; cod_collected: string }[] }>(
    `/delivery/earnings?from=${encodeURIComponent(`${from}T00:00:00+03:00`)}&to=${encodeURIComponent(next(to))}`).then((r) => r.data), [from, to]);
  const rows = data.data ?? [];
  const total = rows.reduce((s, r) => s + Number(r.commission), 0);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <p className="muted" style={{ margin: 0 }}>العمولة = عدد التسليمات × عمولة التسليم + عدد المحاولات الفاشلة × عمولة الفشل (من الإعدادات). تقرير فقط، لا يُرحّل للدفاتر.</p>
      <ErrorBox error={data.error} />
      {data.data && rows.length === 0 ? <Empty>لا توجد تسليمات في الفترة</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>السائق</th><th>تسليمات</th><th>فاشلة</th><th>العمولة</th><th>COD محصّل</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.worker_id}><td>{r.display_name}</td><td className="num">{r.delivered}</td><td className="num">{r.failed}</td><td className="num">{money(r.commission)}</td><td className="num">{money(r.cod_collected)}</td></tr>)}</tbody>
          {rows.length > 0 && <tfoot><tr><th>الإجمالي</th><td /><td /><td className="num"><strong>{money(total)}</strong></td><td /></tr></tfoot>}
        </table></div>
      )}
    </section>
  );
}

interface Settings {
  require_pin: boolean; max_open_per_driver: number; auto_assign_radius_km: number; position_fresh_minutes: number; default_sla_minutes: number;
  commission_per_delivery: string; commission_per_failed: string; custody_alert_amount: string;
}
function SettingsView() {
  const me = useMe();
  const [le, setLe] = useState(me.legal_entities[0]?.id ?? '');
  const s = useLoad(() => api<Settings>(`/delivery/settings?legal_entity_id=${le}`), [le]);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState<Settings | null>(null);
  const cur = f ?? s.data;
  const writer = can(me, 'org:write');
  if (!cur) return <ErrorBox error={s.error} />;
  const set = (k: keyof Settings, val: unknown) => { setF({ ...cur, [k]: val }); setSaved(false); };
  const num = (k: keyof Settings, label: string, min: number, max: number, step = 1) => (
    <label className="field">{label}<input type="number" className="num" min={min} max={max} step={step} value={String(cur[k])} disabled={!writer}
      onChange={(e) => set(k, Number(e.target.value))} required /></label>
  );
  const amt = (k: keyof Settings, label: string) => (
    <label className="field">{label}<input className="num" inputMode="decimal" pattern="\d{1,9}(\.\d{1,3})?" value={String(cur[k])} disabled={!writer} onChange={(e) => set(k, e.target.value)} required /></label>
  );
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const r = await api<Settings>('/delivery/settings', { method: 'PUT', body: { legal_entity_id: le, ...cur } });
      setF(r); setSaved(true);
    });
  };
  return (
    <section className="card">
      <form className="form" onSubmit={save}>
        {me.legal_entities.length > 1 && (
          <label className="field">الشركة القانونية
            <select value={le} onChange={(e) => { setLe(e.target.value); setF(null); }}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          </label>
        )}
        <ErrorBox error={act.error} />
        {saved && <div className="alert ok">حُفظت الإعدادات</div>}
        <label className="row"><input type="checkbox" checked={cur.require_pin} disabled={!writer} onChange={(e) => set('require_pin', e.target.checked)} style={{ width: 'auto' }} />
          التسليم يحتاج رمز المستلم (أو صورة/توقيع يوافق عليه المكتب) عندما يكون للطلب رقم جوال</label>
        <div className="form-2">
          {num('max_open_per_driver', 'أقصى طلبات مفتوحة للسائق', 1, 50)}
          {num('auto_assign_radius_km', 'نطاق الإسناد التلقائي (كم)', 1, 200, 0.5)}
          {num('position_fresh_minutes', 'آخر موقع صالح خلال (دقيقة)', 1, 120)}
          {num('default_sla_minutes', 'مهلة التسليم لطلب بلا موعد (دقيقة)', 10, 1440)}
          {amt('commission_per_delivery', 'عمولة السائق لكل تسليم')}
          {amt('commission_per_failed', 'عمولة المحاولة الفاشلة')}
          {amt('custody_alert_amount', 'تنبيه العهدة النقدية عند')}
        </div>
        <p className="muted" style={{ margin: 0 }}>القيم الافتراضية تقديرية [تخمين] وتُضبط مع أول عميل تجريبي.</p>
        {writer && <div className="row"><button className="primary" disabled={act.busy}>حفظ</button></div>}
      </form>
    </section>
  );
}
