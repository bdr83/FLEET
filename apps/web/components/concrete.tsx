'use client';
import { api } from '@/lib/api';
import { CONCRETE_FAIL, ConcreteSite, dt, m3, POUR_STATE, siteLine, STAGE } from '@/lib/format';
import { Badge, ErrorBox, Tone, useLoad } from '@/components/ui';

interface Info {
  ticket: { ticket_no: string; seq: number; volume_m3: number; planned_arrival: string; batched_at: string | null; at_site: string | null; pour_start: string | null; pour_end: string | null;
    poured_m3: number | null; returned_m3: number | null; signed_by: string | null; signed_at: string | null; file_key: string | null; wait_minutes: number | null; age_minutes: number | null; stage: string | null };
  pour: { id: string; ref: string; mix_code: string; site: ConcreteSite; customer_name: string | null; state: string; pump_required: boolean; pump_plate: string | null };
  limits: { max_age_minutes: number; age_warn_minutes: number; free_wait_minutes: number };
  failure: { reason_code: string | null; note: string | null } | null;
}

/** The concrete side of a load task: the digital delivery ticket, stage times, concrete age and site waiting. */
export function ConcretePanel({ taskId, status }: { taskId: string; status: string }) {
  const info = useLoad(() => api<Info>(`/concrete/tasks/${taskId}`), [taskId, status]);
  const d = info.data;
  if (!d) return <section className="card"><h2>تذكرة التسليم</h2><ErrorBox error={info.error} /></section>;
  const { ticket: t, pour: p, limits } = d;
  const ageCls = t.age_minutes === null ? '' : t.age_minutes >= limits.max_age_minutes ? 'age over' : t.age_minutes >= limits.age_warn_minutes ? 'age warn' : '';
  return (
    <section className="card stack" data-testid="ticket">
      <div className="row spread"><h2 style={{ margin: 0 }}>تذكرة التسليم <span className="num">{t.ticket_no}</span></h2>{t.signed_at ? <Badge tone="success">موقّعة</Badge> : <Badge tone="warning">غير موقّعة</Badge>}</div>
      <dl className="dl">
        <dt>طلب الصب</dt><dd><span className="num">{p.ref}</span> <Tone map={POUR_STATE} value={p.state} /> · حمولة <span className="num">{t.seq}</span></dd>
        <dt>الموقع</dt><dd>{siteLine(p.site)}{p.site.contact_name && <span className="muted"> · {p.site.contact_name}</span>}</dd>
        <dt>الخلطة والكمية</dt><dd>{p.mix_code} · <span className="num">{m3(t.volume_m3)}</span>{p.pump_required && <span className="muted"> · مضخة {p.pump_plate ?? ''}</span>}</dd>
        <dt>الوصول المخطط</dt><dd className="num">{dt(t.planned_arrival)}</dd>
        <dt>وقت الخلط</dt><dd className="num">{dt(t.batched_at)}</dd>
        <dt>عمر الخرسانة</dt><dd>{t.age_minutes === null ? '—' : <span className={ageCls}><span className="num">{t.age_minutes}</span> د من حد <span className="num">{limits.max_age_minutes}</span> د</span>}</dd>
        <dt>وصل للموقع</dt><dd className="num">{dt(t.at_site)}</dd>
        <dt>الصب</dt><dd className="num">{t.pour_start ? `${dt(t.pour_start)} – ${t.pour_end ? dt(t.pour_end) : '…'}` : '—'}</dd>
        <dt>الانتظار</dt><dd>{t.wait_minutes === null ? '—' : <><span className="num">{t.wait_minutes}</span> د <span className="muted">(المجاني {limits.free_wait_minutes} د)</span></>}</dd>
        <dt>مصبوب / مرتجع</dt><dd className="num">{t.poured_m3 === null ? '—' : `${m3(t.poured_m3)} / ${m3(t.returned_m3 ?? 0)}`}</dd>
        <dt>وقّعها</dt><dd>{t.signed_by ?? '—'}{t.signed_at && <span className="muted num"> · {dt(t.signed_at)}</span>}</dd>
        {d.failure && <><dt>سبب الفشل</dt><dd>{d.failure.reason_code ? CONCRETE_FAIL[d.failure.reason_code] ?? d.failure.reason_code : '—'}{d.failure.note && <span className="muted"> · {d.failure.note}</span>}</dd></>}
        {t.stage && <><dt>آخر مرحلة</dt><dd>{STAGE[t.stage] ?? t.stage}</dd></>}
      </dl>
      {t.file_key?.startsWith('file:') && (
        <a href={`/api/v1/files/${t.file_key.slice(5)}`} target="_blank" rel="noreferrer">
          <img src={`/api/v1/files/${t.file_key.slice(5)}`} alt="صورة التذكرة أو التوقيع" className="pod-photo" />
        </a>
      )}
    </section>
  );
}
