'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { day, money, WO_KIND, WO_STATUS } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

interface Due { plan_id: string; name: string; asset_id: string; plate_no: string | null; odometer_km: number | null; due_km: number | null; km_left: number | null; due_on: string | null; days_left: number | null; has_open_work_order: boolean; state: string }
interface Wo { id: string; number: string; asset_id: string; plate_no: string | null; kind: string; status: string; out_of_service: boolean; description: string | null; vendor: string | null; opened_at: string; total_cost: string }
interface Plan { id: string; asset_id: string; plate_no: string | null; name: string; interval_km: number | null; interval_days: number | null; last_done_km: number | null; last_done_on: string | null; active: boolean }

type Tab = 'due' | 'orders' | 'plans';

export default function MaintenancePage() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('due');
  const write = can(me, 'fleet:write');
  const [opening, setOpening] = useState<{ asset_id?: string; plan_id?: string; kind?: string; description?: string } | null>(null);
  const router = useRouter();
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>الصيانة</h1>
        {write && <button className="primary" onClick={() => setOpening({})}>فتح أمر عمل</button>}
      </div>
      <Tabs<Tab> tabs={[['due', 'المستحقة'], ['orders', 'أوامر العمل'], ['plans', 'خطط الصيانة الوقائية']]} value={tab} onChange={setTab} />
      {tab === 'due' && <DueList onOpen={write ? (d) => setOpening({ asset_id: d.asset_id, plan_id: d.plan_id, kind: 'preventive', description: d.name }) : undefined} />}
      {tab === 'orders' && <Orders />}
      {tab === 'plans' && <Plans write={write} />}
      {opening && <OpenWo init={opening} onClose={() => setOpening(null)} onDone={(id) => router.push(`/maintenance/${id}`)} />}
    </div>
  );
}

function DueList({ onOpen }: { onOpen?: (d: Due) => void }) {
  const due = useLoad(() => api<{ data: Due[] }>('/maintenance/due').then((r) => r.data));
  return <>
    <ErrorBox error={due.error} />
    {due.data?.length === 0 ? <Empty>لا توجد صيانة مستحقة خلال 500 كم أو 14 يومًا</Empty> : (
      <div className="tbl-wrap"><table>
        <thead><tr><th>المركبة</th><th>الخطة</th><th>المتبقي بالكيلومتر</th><th>الموعد</th><th>الحالة</th><th></th></tr></thead>
        <tbody>{due.data?.map((d) => (
          <tr key={d.plan_id}>
            <td className="num">{d.plate_no ?? '—'}</td><td>{d.name}</td>
            <td className="num">{d.km_left != null ? d.km_left.toLocaleString('en-US') : '—'}</td>
            <td className="num">{d.due_on ? day(d.due_on) : '—'}</td>
            <td>{d.state === 'overdue' ? <Badge tone="danger">متأخرة</Badge> : <Badge tone="warning">قريبة</Badge>}{d.has_open_work_order && <> <Badge tone="info">لها أمر عمل</Badge></>}</td>
            <td>{onOpen && !d.has_open_work_order && <button className="small" onClick={() => onOpen(d)}>فتح أمر عمل</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )}
  </>;
}

function Orders() {
  const me = useMe();
  const [status, setStatus] = useState('');
  const list = useLoad(() => api<{ data: Wo[] }>(`/work-orders${status ? `?status=${status}` : ''}`).then((r) => r.data), [status]);
  const router = useRouter();
  const cur = me.legal_entities[0]?.currency ?? 'KWD';
  return <>
    <select aria-label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
      <option value="">كل الحالات</option>{Object.entries(WO_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
    </select>
    <ErrorBox error={list.error} />
    {list.data?.length === 0 ? <Empty>لا توجد أوامر عمل</Empty> : (
      <div className="tbl-wrap"><table>
        <thead><tr><th>الرقم</th><th>المركبة</th><th>النوع</th><th>الوصف</th><th>التكلفة</th><th>فُتح</th><th>الحالة</th></tr></thead>
        <tbody>{list.data?.map((w) => (
          <tr key={w.id} onClick={() => router.push(`/maintenance/${w.id}`)} style={{ cursor: 'pointer' }}>
            <td className="num"><Link href={`/maintenance/${w.id}`} onClick={(e) => e.stopPropagation()}>{w.number}</Link></td>
            <td className="num">{w.plate_no ?? '—'}</td><td>{WO_KIND[w.kind] ?? w.kind}</td><td>{w.description ?? '—'}</td>
            <td className="num">{money(w.total_cost, cur)}</td><td className="num">{day(w.opened_at)}</td>
            <td><Tone map={WO_STATUS} value={w.status} />{w.out_of_service && w.status !== 'done' && w.status !== 'canceled' && <> <Badge tone="danger">خارج الخدمة</Badge></>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )}
  </>;
}

function Plans({ write }: { write: boolean }) {
  const plans = useLoad(() => api<{ data: Plan[] }>('/maintenance/plans').then((r) => r.data));
  const assets = useAssets();
  const { f, bind, setF } = useForm({ asset_id: '', name: '', interval_km: '', interval_days: '' });
  const act = useAction();
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      await api('/maintenance/plans', { method: 'POST', body: clean({ asset_id: f.asset_id, name: f.name, interval_km: f.interval_km ? Number(f.interval_km) : '', interval_days: f.interval_days ? Number(f.interval_days) : '' }) });
      setF({ ...f, name: '', interval_km: '', interval_days: '' });
      await plans.reload();
    });
  };
  return <>
    <ErrorBox error={plans.error ?? act.error} />
    {plans.data?.length === 0 ? <Empty>لا توجد خطط. مثال: تغيير زيت كل 5,000 كم أو 90 يومًا.</Empty> : (
      <div className="tbl-wrap"><table>
        <thead><tr><th>المركبة</th><th>الخطة</th><th>كل (كم)</th><th>كل (يوم)</th><th>آخر تنفيذ</th></tr></thead>
        <tbody>{plans.data?.map((p) => (
          <tr key={p.id} style={p.active ? undefined : { opacity: 0.5 }}>
            <td className="num">{p.plate_no ?? '—'}</td><td>{p.name}</td>
            <td className="num">{p.interval_km?.toLocaleString('en-US') ?? '—'}</td><td className="num">{p.interval_days ?? '—'}</td>
            <td><span className="num">{p.last_done_on ? day(p.last_done_on) : '—'}</span>{p.last_done_km != null && <span className="muted num"> · {p.last_done_km.toLocaleString('en-US')} كم</span>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )}
    {write && (
      <form className="card form-2" onSubmit={add}>
        <label className="field">المركبة<select {...bind('asset_id')} required><option value="">اختر</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
        <label className="field">اسم الخطة<input {...bind('name')} required maxLength={120} placeholder="تغيير الزيت" /></label>
        <label className="field">كل كم كيلومتر<input {...bind('interval_km')} type="number" min={1} className="num" /></label>
        <label className="field">أو كل كم يوم<input {...bind('interval_days')} type="number" min={1} className="num" /></label>
        <div><button disabled={act.busy}>إضافة خطة</button></div>
      </form>
    )}
  </>;
}

function OpenWo({ init, onClose, onDone }: { init: { asset_id?: string; plan_id?: string; kind?: string; description?: string }; onClose: () => void; onDone: (id: string) => void }) {
  const assets = useAssets();
  const { f, bind, check } = useForm({ asset_id: init.asset_id ?? '', kind: init.kind ?? 'corrective', description: init.description ?? '', vendor: '', odometer_km: '', out_of_service: false });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const w = await api<{ id: string }>('/work-orders', {
        method: 'POST',
        body: { ...clean({ asset_id: f.asset_id, kind: f.kind, description: f.description, vendor: f.vendor, plan_id: init.plan_id, odometer_km: f.odometer_km ? Number(f.odometer_km) : '' }), out_of_service: f.out_of_service },
      });
      onDone(w.id);
    });
  };
  return (
    <Modal title="فتح أمر عمل" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-2">
          <label className="field">المركبة<select {...bind('asset_id')} required disabled={!!init.asset_id}><option value="">اختر</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          <label className="field">النوع<select {...bind('kind')}>{Object.entries(WO_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">الورشة / المورد<input {...bind('vendor')} maxLength={200} /></label>
          <label className="field">العداد (كم)<input {...bind('odometer_km')} type="number" min={0} className="num" /></label>
        </div>
        <label className="field">الوصف<textarea {...bind('description')} rows={2} maxLength={2000} /></label>
        <label className="row"><input {...check('out_of_service')} />إخراج المركبة من الخدمة حتى إغلاق الأمر (لا يمكن إسنادها)</label>
        <div className="row"><button className="primary" disabled={busy}>فتح</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}
