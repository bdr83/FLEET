'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ASSET_TYPE, dt, fuelLine, km, VR_STATUS } from '@/lib/format';
import { Badge, ErrorBox, Tone, useAction } from '@/components/ui';

/** A vehicle request (in-house fleet, internal@1) as the API returns it. */
export interface VReq {
  id: string; ref: string; legal_entity_id: string; requester_user_id: string; requester_name: string | null; requester_phone: string | null;
  department_id: string; department_name: string; cost_center: string | null; purpose: string; destination: string | null; passengers: number;
  with_driver: boolean; asset_type: string | null; starts_at: string; ends_at: string; notes: string | null; status: string;
  decided_by_name: string | null; decided_at: string | null; decision_note: string | null; task_id: string | null; asset_id: string | null;
  plate_no: string | null; allocated_type: string | null; driver_worker_id: string | null; driver_name: string | null;
  out_at: string | null; out_odometer_km: number | null; out_fuel: number | null; back_at: string | null; back_odometer_km: number | null;
  back_fuel: number | null; condition_note: string | null; km: number | null; version: number; created_at: string;
}

export const ASSET_TYPES = ['car', 'van', 'pickup', 'truck', 'bus', 'motorbike', 'other'];
export const typeLabel = (t: string | null) => (t ? ASSET_TYPE[t] ?? t : 'أي نوع');
/** A datetime-local value read as Kuwait time (UTC+3, no daylight saving). */
export const kwIso = (local: string) => new Date(`${local}:00+03:00`).toISOString();
export const period = (r: Pick<VReq, 'starts_at' | 'ends_at'>) => `${dt(r.starts_at)} – ${dt(r.ends_at).slice(dt(r.starts_at).slice(0, 10) === dt(r.ends_at).slice(0, 10) ? 11 : 0)}`;

/** The request's facts, shared by the office and the employee views. */
export function RequestFacts({ r }: { r: VReq }) {
  return (
    <>
      <div className="row"><Tone map={VR_STATUS} value={r.status} />{r.with_driver ? <Badge tone="info">مع سائق</Badge> : <Badge>قيادة ذاتية</Badge>}</div>
      <dl className="dl">
        <dt>الطالب</dt><dd>{r.requester_name ?? '—'} {r.requester_phone && <span className="num muted">{r.requester_phone}</span>}</dd>
        <dt>الإدارة</dt><dd>{r.department_name}{r.cost_center && <span className="muted"> · مركز تكلفة <span className="num">{r.cost_center}</span></span>}</dd>
        <dt>الغرض</dt><dd>{r.purpose}{r.destination && <span className="muted"> · إلى {r.destination}</span>}</dd>
        <dt>الفترة</dt><dd className="num">{period(r)}</dd>
        <dt>المطلوب</dt><dd>{typeLabel(r.asset_type)} · <span className="num">{r.passengers}</span> راكب</dd>
        {r.notes && <><dt>ملاحظات</dt><dd>{r.notes}</dd></>}
        {r.decided_at && <><dt>القرار</dt><dd>{r.decided_by_name ?? 'تلقائي'} · <span className="num">{dt(r.decided_at)}</span>{r.decision_note && <> · {r.decision_note}</>}</dd></>}
        {r.plate_no && <><dt>المركبة</dt><dd><strong className="num">{r.plate_no}</strong> · {typeLabel(r.allocated_type)}{r.driver_name && <> · السائق {r.driver_name}</>}</dd></>}
        {r.out_at && <><dt>الاستلام</dt><dd><span className="num">{dt(r.out_at)}</span> · {km(r.out_odometer_km)} · وقود {fuelLine(r.out_fuel)}</dd></>}
        {r.back_at && <><dt>الإرجاع</dt><dd><span className="num">{dt(r.back_at)}</span> · {km(r.back_odometer_km)} · وقود {fuelLine(r.back_fuel)} · المسافة <strong>{km(r.km)}</strong></dd></>}
        {r.condition_note && <><dt>حالة المركبة</dt><dd>{r.condition_note}</dd></>}
      </dl>
    </>
  );
}

/** Approve or reject (a rejection needs a reason). */
export function DecideForm({ r, onDone }: { r: VReq; onDone: (r: VReq) => void }) {
  const act = useAction();
  const [note, setNote] = useState('');
  const decide = (approve: boolean) => act.run(async () => onDone(await api<VReq>(`/internal/requests/${r.id}/decide`, { method: 'POST', body: { version: r.version, approve, ...(note ? { note } : {}) } })));
  return (
    <div className="stack">
      <ErrorBox error={act.error} />
      <label className="field">ملاحظة (إلزامية عند الرفض)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-label="ملاحظة القرار" /></label>
      <div className="row">
        <button className="primary" disabled={act.busy} onClick={() => void decide(true)}>موافقة</button>
        <button className="danger" disabled={act.busy || !note} onClick={() => void decide(false)}>رفض</button>
      </div>
    </div>
  );
}

/** Cancel with a reason, before the vehicle is handed over. */
export function CancelButton({ r, onDone }: { r: VReq; onDone: (r: VReq) => void }) {
  const act = useAction();
  if (!['pending', 'approved', 'allocated'].includes(r.status)) return null;
  return (
    <>
      <ErrorBox error={act.error} />
      <button className="small" disabled={act.busy} onClick={() => {
        const reason = window.prompt('سبب الإلغاء؟');
        if (reason !== null) void act.run(async () => onDone(await api<VReq>(`/internal/requests/${r.id}/cancel`, { method: 'POST', body: { version: r.version, ...(reason ? { reason } : {}) } })));
      }}>إلغاء الطلب</button>
    </>
  );
}
