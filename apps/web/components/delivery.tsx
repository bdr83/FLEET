'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, FAIL_REASON, POD_METHOD, STAGE } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, ErrorBox, Modal, useAction, useLoad } from '@/components/ui';

interface DeliveryInfo {
  link: { token: string; pin: string; pin_attempts: number; expires_at: string } | null;
  milestones: { code: string; occurred_at: string; note: string | null; actor_name: string | null }[];
  pod: { method: string; recipient_name: string | null; file_key: string | null; verified: boolean; approved_at: string | null; created_at: string } | null;
  failure: { reason_code: string | null; note: string | null; occurred_at: string } | null;
}

export const trackUrl = (token: string) => (typeof window === 'undefined' ? `/track/${token}` : `${location.origin}/track/${token}`);

/** The delivery side of a task: recipient PIN and tracking link, stages, proof of delivery and failure reason. */
export function DeliveryPanel({ taskId, status, onChange }: { taskId: string; status: string; onChange: () => void }) {
  const me = useMe();
  const info = useLoad(() => api<DeliveryInfo>(`/delivery/tasks/${taskId}`), [taskId, status]);
  const act = useAction();
  const [rejecting, setRejecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const d = info.data;
  if (!d) return <section className="card"><h2>التوصيل</h2><ErrorBox error={info.error} /></section>;
  const active = ['ready', 'assigned', 'accepted', 'in_progress'].includes(status);
  const locked = (d.link?.pin_attempts ?? 0) >= 5;
  const writer = can(me, 'tasks:write');

  const copy = async () => {
    if (!d.link) return;
    try { await navigator.clipboard.writeText(trackUrl(d.link.token)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  const pod = (action: 'approve' | 'reject', body: Record<string, unknown> = {}) =>
    act.run(async () => { await api(`/delivery/tasks/${taskId}/pod/${action}`, { method: 'POST', body }); await info.reload(); onChange(); });

  return (
    <section className="card stack">
      <h2>التوصيل</h2>
      <ErrorBox error={act.error} />
      {d.link && (
        <dl className="dl">
          <dt>رمز المستلم</dt>
          <dd>
            <span className="num pin" data-testid="pin">{d.link.pin}</span>{' '}
            {locked ? <Badge tone="danger">مقفل بعد 5 محاولات خاطئة</Badge> : d.link.pin_attempts > 0 && <span className="muted">محاولات خاطئة: <span className="num">{d.link.pin_attempts}</span></span>}
          </dd>
          <dt>رابط التتبع</dt>
          <dd className="row">
            <a href={`/track/${d.link.token}`} target="_blank" rel="noreferrer">فتح الصفحة</a>
            <button type="button" onClick={copy}>{copied ? 'تم النسخ' : 'نسخ الرابط'}</button>
            {!active && <span className="muted">(لا يظهر الرمز بعد انتهاء الطلب)</span>}
          </dd>
        </dl>
      )}
      <div>
        <h3>المراحل</h3>
        {d.milestones.length === 0 ? <p className="muted">لم يسجّل السائق أي مرحلة بعد</p> : (
          <ul className="timeline">
            {d.milestones.map((m, i) => (
              <li key={i}><strong>{STAGE[m.code] ?? m.code}</strong> <span className="muted">· {m.actor_name ?? ''}</span><div className="muted num">{dt(m.occurred_at)}</div>{m.note && <div>{m.note}</div>}</li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3>إثبات التسليم</h3>
        {!d.pod ? <p className="muted">لا يوجد</p> : (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row">
              <span>{POD_METHOD[d.pod.method] ?? d.pod.method}</span>
              {d.pod.verified ? <Badge tone="success">موثّق</Badge> : <Badge tone="warning">بانتظار موافقة المكتب</Badge>}
              <span className="muted num">{dt(d.pod.created_at)}</span>
            </div>
            {d.pod.recipient_name && <div>استلمه: {d.pod.recipient_name}</div>}
            {d.pod.file_key && <div className="muted">الملف: <span className="num">{d.pod.file_key}</span></div>}
            {!d.pod.verified && writer && (
              <div className="row">
                <button className="primary" disabled={act.busy} onClick={() => pod('approve')}>قبول الإثبات</button>
                <button className="danger" disabled={act.busy} onClick={() => setRejecting(true)}>رفض</button>
              </div>
            )}
          </div>
        )}
      </div>
      {d.failure && (
        <div>
          <h3>سبب الفشل</h3>
          <div>{d.failure.reason_code ? FAIL_REASON[d.failure.reason_code] ?? d.failure.reason_code : '—'}{d.failure.note && <span className="muted"> · {d.failure.note}</span>}</div>
        </div>
      )}
      {rejecting && <RejectModal busy={act.busy} onClose={() => setRejecting(false)} onSubmit={async (reason) => { if (await pod('reject', { reason })) setRejecting(false); }} />}
    </section>
  );
}

function RejectModal({ onClose, onSubmit, busy }: { onClose: () => void; onSubmit: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="رفض إثبات التسليم" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }}>
        <label className="field">السبب<textarea name="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} /></label>
        <p className="muted" style={{ margin: 0 }}>لن تُعتمد المهمة حتى يوجد إثبات صحيح.</p>
        <div className="row"><button className="danger" disabled={busy || !reason.trim()}>رفض</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}
