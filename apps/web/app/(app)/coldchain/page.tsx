'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { dt, money, qtyText, TEMP_CLASS, time, todayKw } from '@/lib/format';
import { Badge, Empty, ErrorBox, Kpi, Tabs, useLoad } from '@/components/ui';

interface Ex {
  out_of_range: { id: string; route_id: string; route_ref: string; temp_class: string; temp_min: number; temp_max: number; reading_c: number; source: string; device_ref: string | null; recorded_at: string; stop_name: string | null }[];
  no_reading: { route_id: string; route_ref: string; temp_class: string; driver_name: string; plate_no: string; last_at: string | null }[];
  late: { task_id: string; route_ref: string; seq: number; name: string; window_from: string | null; window_to: string; done_at: string | null; driver_name: string; state: string }[];
  expiring: { task_id: string; route_ref: string; seq: number; name: string; route_date: string; item: string; expiry: string; qty: number }[];
  damaged: { task_id: string; route_ref: string; seq: number; name: string; damaged: Record<string, number>; value: string }[];
}
interface Row { id: string; ref: string; route_date: string; temp_class: string; plate_no: string; driver_name: string; stops: number; delivered_stops: number; refused_stops: number; on_time_stops: number; delivered_value: string; returned_value: string; damaged_value: string; hours: number | null; stops_per_hour: number | null; readings: number; readings_out: number }
interface Report { data: Row[]; totals: { routes: number; stops: number; delivered_stops: number; refused_stops: number; on_time_pct: number | null; delivered_value: string; returned_value: string; damaged_value: string; return_rate_pct: number | null; spoilage_pct: number | null; stops_per_hour: number | null; readings: number; temp_compliance_pct: number | null } }

const pct = (n: number | null) => (n === null ? '—' : `${n}%`);

/** Food distribution and cold chain (sector 3): temperature, delivery-window, expiry and damage exceptions, and the sector KPIs. Routes are planned in «التوزيع اليومي». */
export default function ColdchainPage() {
  const [tab, setTab] = useState<'exceptions' | 'report'>('exceptions');
  return (
    <div className="page stack">
      <div className="page-head"><h1>سلسلة التبريد</h1><Link href="/distribution">تخطيط المسارات</Link></div>
      <Tabs tabs={[['exceptions', 'الاستثناءات'], ['report', 'المؤشرات']]} value={tab} onChange={setTab} />
      {tab === 'exceptions' ? <ExceptionsView /> : <ReportView />}
    </div>
  );
}

function ExceptionsView() {
  const ex = useLoad(() => api<Ex>('/coldchain/exceptions'));
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  const table = (title: string, hint: string, head: string[], rows: React.ReactNode[][], id: string) => (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted">{hint}</p>
      {rows.length === 0 ? <Empty>لا يوجد</Empty> : (
        <div className="tbl-wrap"><table data-testid={id}><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
      )}
    </section>
  );
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="قراءات خارج النطاق (7 أيام)" value={d.out_of_range.length} tone={d.out_of_range.length ? 'danger' : undefined} />
        <Kpi label="مسارات مبردة بلا قراءة حديثة" value={d.no_reading.length} tone={d.no_reading.length ? 'warning' : undefined} />
        <Kpi label="تسليمات متأخرة عن النافذة" value={d.late.length} tone={d.late.length ? 'warning' : undefined} />
        <Kpi label="أصناف تنتهي صلاحيتها" value={d.expiring.length} tone={d.expiring.length ? 'danger' : undefined} />
      </div>
      {table('الحرارة خارج النطاق', 'من قراءات السائق أو المكتب أو جهاز التسجيل.', ['المسار', 'الفئة', 'القراءة', 'النطاق', 'المصدر', 'الوقت', 'عند'],
        d.out_of_range.map((x) => [<span key="r" className="num">{x.route_ref}</span>, TEMP_CLASS[x.temp_class], <strong key="c" className="num">{x.reading_c}°</strong>, <span key="n" className="num">{x.temp_min}° – {x.temp_max}°</span>,
          x.source === 'manual' ? 'يدوي' : x.device_ref, <span key="t" className="num">{dt(x.recorded_at)}</span>, x.stop_name ?? '—']), 'ex-temp')}
      {table('بلا قراءة حديثة', 'مسار مبرد أو مجمد على الطريق ولا قراءة منذ أكثر من 90 دقيقة [تخمين]. اطلب من السائق تسجيل الحرارة.', ['المسار', 'الفئة', 'السائق', 'المركبة', 'آخر قراءة'],
        d.no_reading.map((x) => [<span key="r" className="num">{x.route_ref}</span>, TEMP_CLASS[x.temp_class], x.driver_name, <span key="p" className="num">{x.plate_no}</span>, x.last_at ? <span key="l" className="num">{dt(x.last_at)}</span> : <Badge key="n" tone="danger">لا يوجد</Badge>]), 'ex-gap')}
      {table('خارج نافذة التسليم', 'تسليم بعد نهاية النافذة، أو نافذة انتهت ولم يُسلَّم.', ['المسار', '#', 'الجهة', 'النافذة', 'السائق', 'الحالة'],
        d.late.map((x) => [<span key="r" className="num">{x.route_ref}</span>, x.seq, x.name, <span key="w" className="num">{time(x.window_from)}–{time(x.window_to)}</span>, x.driver_name,
          x.state === 'overdue' ? <Badge key="s" tone="danger">لم يُسلَّم</Badge> : <Badge key="s" tone="warning">سُلّم {time(x.done_at)}</Badge>]), 'ex-late')}
      {table('الصلاحية', 'أصناف على مسارات لم تُسلَّم صلاحيتها تنتهي في يوم المسار أو قبله.', ['المسار', 'اليوم', 'الجهة', 'الصنف', 'الكمية', 'الصلاحية'],
        d.expiring.map((x) => [<span key="r" className="num">{x.route_ref}</span>, <span key="d" className="num">{x.route_date}</span>, x.name, x.item, <span key="q" className="num">{qtyText(x.qty)}</span>, <Badge key="e" tone="danger">{x.expiry}</Badge>]), 'ex-expiry')}
      {table('بضاعة تالفة عند التسليم', 'آخر 7 أيام، بقيمتها بسعر التوقف.', ['المسار', '#', 'الجهة', 'الكميات', 'القيمة'],
        d.damaged.map((x) => [<span key="r" className="num">{x.route_ref}</span>, x.seq, x.name, Object.entries(x.damaged).map(([k, n]) => `${k} ${qtyText(n)}`).join('، '), <span key="v" className="num">{money(x.value)}</span>]), 'ex-damaged')}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<Report>(`/coldchain/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4">
          <Kpi label="الالتزام بمواعيد التسليم" value={pct(x.on_time_pct)} />
          <Kpi label="خسائر التلف" value={money(x.damaged_value)} tone={Number(x.damaged_value) > 0 ? 'warning' : undefined} />
          <Kpi label="نسبة التلف" value={pct(x.spoilage_pct)} />
          <Kpi label="نسبة المرتجعات" value={pct(x.return_rate_pct)} />
          <Kpi label="توقفات في الساعة" value={x.stops_per_hour ?? '—'} />
          <Kpi label="قراءات ضمن النطاق" value={pct(x.temp_compliance_pct)} />
          <Kpi label="التسليمات" value={`${x.delivered_stops} من ${x.stops}`} />
          <Kpi label="رفض الاستلام" value={x.refused_stops} tone={x.refused_stops ? 'warning' : undefined} />
        </div>
        <section className="card">
          {r.data!.data.length === 0 ? <Empty>لا توجد مسارات في الفترة</Empty> : (
            <div className="tbl-wrap"><table data-testid="coldchain-report">
              <thead><tr><th>المسار</th><th>اليوم</th><th>الفئة</th><th>السائق</th><th>المسلّمة</th><th>في الموعد</th><th>المسلَّم</th><th>التالف</th><th>المرتجع</th><th>توقف/ساعة</th><th>القراءات</th></tr></thead>
              <tbody>{r.data!.data.map((s) => (
                <tr key={s.id}><td className="num">{s.ref}</td><td className="num">{s.route_date}</td><td>{TEMP_CLASS[s.temp_class]}</td><td>{s.driver_name}</td>
                  <td className="num">{s.delivered_stops}/{s.stops}</td><td className="num">{s.on_time_stops}</td><td className="num">{money(s.delivered_value)}</td>
                  <td className="num">{money(s.damaged_value)}</td><td className="num">{money(s.returned_value)}</td><td className="num">{s.stops_per_hour ?? '—'}</td>
                  <td className="num">{s.readings}{s.readings_out > 0 && <> <Badge tone="danger">{s.readings_out} خارج</Badge></>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>نسبة التلف = قيمة التالف ÷ (المسلَّم + التالف). نسبة المرتجعات = قيمة المرتجع ÷ المسلَّم. التوقفات في الساعة من الانطلاق إلى العودة.</p>
        </section>
      </>}
    </div>
  );
}
