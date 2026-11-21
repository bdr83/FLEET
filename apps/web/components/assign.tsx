'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { can, useMe } from '@/components/me';
import { ErrorBox, Modal, useAction, useLoad } from '@/components/ui';

export interface BoardDriver {
  id: string; display_name: string; kind: string; shift_id: string | null; started_at: string | null;
  asset_id: string | null; plate_no: string | null; open_tasks: number; last_seen_at: string | null;
  lat: number | null; lng: number | null; battery_pct: number | null;
}
interface Asset { id: string; plate_no: string | null; asset_type: string; status: string; legal_entity_id: string }

/**
 * Assign or reassign one task. Drivers come from the dispatch board (tasks:read is enough);
 * vehicles are listed only for users who can read the fleet. A driver on shift brings their shift vehicle by default.
 */
export function AssignModal({ task, onClose, onDone }: {
  task: { id: string; version: number; ref?: string | null; legal_entity_id?: string };
  onClose: () => void; onDone: () => void;
}) {
  const me = useMe();
  const drivers = useLoad(() => api<{ drivers: BoardDriver[] }>('/dispatch/board').then((r) => r.drivers));
  const assets = useLoad(() => can(me, 'fleet:read')
    ? api<{ data: Asset[] }>('/assets').then((r) => r.data.filter((x) => x.status === 'available' || x.status === 'in_use'))
    : Promise.resolve([] as Asset[]));
  const [worker, setWorker] = useState('');
  const [asset, setAsset] = useState('');
  const [exclusive, setExclusive] = useState(false);
  const { busy, error, run } = useAction();

  const pickWorker = (id: string) => {
    setWorker(id);
    const d = drivers.data?.find((x) => x.id === id);
    if (d?.asset_id && !asset) setAsset(d.asset_id);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/tasks/${task.id}/assign`, { method: 'POST', body: { version: task.version, worker_id: worker, asset_id: asset || undefined, exclusive } });
      onDone();
    });
  };
  const list = (assets.data ?? []).filter((x) => !task.legal_entity_id || x.legal_entity_id === task.legal_entity_id);
  return (
    <Modal title={`إسناد المهمة ${task.ref ?? ''}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error ?? drivers.error} />
        <label className="field">السائق
          <select name="worker" value={worker} onChange={(e) => pickWorker(e.target.value)} required>
            <option value="">اختر سائقًا</option>
            {drivers.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name} — {d.shift_id ? 'في المناوبة' : 'خارج المناوبة'} · {d.open_tasks} مهام مفتوحة
              </option>
            ))}
          </select>
        </label>
        {can(me, 'fleet:read') && (
          <label className="field">المركبة (اختياري)
            <select name="asset" value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="">بدون مركبة</option>
              {list.map((x) => <option key={x.id} value={x.id}>{x.plate_no ?? x.id.slice(0, 8)} ({x.asset_type})</option>)}
            </select>
          </label>
        )}
        <label className="row"><input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} style={{ width: 'auto' }} />
          حجز حصري (يمنع تداخل مواعيد السائق في نفس الفترة)</label>
        <div className="row">
          <button className="primary" disabled={busy || !worker}>إسناد</button>
          <button type="button" onClick={onClose}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}
