'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ASSET_STATUS, ASSET_TYPE, day } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { clean, Empty, ErrorBox, Modal, Tone, useAction, useForm, useLoad } from '@/components/ui';
import { DocsPanel } from '@/components/docs';

export interface Asset {
  id: string; legal_entity_id: string; asset_type: string; plate_no: string | null; status: string;
  make: string | null; model: string | null; year: number | null; vin: string | null; odometer_km: number | null; notes: string | null; created_at: string;
}

export default function AssetsPage() {
  const me = useMe();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const list = useLoad(() => api<{ data: Asset[] }>(`/assets?${new URLSearchParams(clean({ status, type }) as Record<string, string>)}`).then((r) => r.data), [status, type]);
  const [edit, setEdit] = useState<Asset | 'new' | null>(null);
  const write = can(me, 'fleet:write');
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>المركبات</h1>
        {write && <button className="primary" onClick={() => setEdit('new')}>إضافة مركبة</button>}
      </div>
      <div className="row">
        <select aria-label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">كل الحالات</option>
          {Object.entries(ASSET_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <select aria-label="النوع" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }}>
          <option value="">كل الأنواع</option>
          {Object.entries(ASSET_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا توجد مركبات بعد</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>اللوحة</th><th>النوع</th><th>الطراز</th><th>السنة</th><th>العداد (كم)</th><th>الحالة</th><th>أضيفت</th></tr></thead>
          <tbody>
            {list.data?.map((x) => (
              <tr key={x.id} onClick={() => setEdit(x)} style={{ cursor: 'pointer' }}>
                <td className="num"><strong>{x.plate_no ?? '—'}</strong></td>
                <td>{ASSET_TYPE[x.asset_type] ?? x.asset_type}</td>
                <td>{[x.make, x.model].filter(Boolean).join(' ') || '—'}</td>
                <td className="num">{x.year ?? '—'}</td>
                <td className="num">{x.odometer_km?.toLocaleString('en-US') ?? '—'}</td>
                <td><Tone map={ASSET_STATUS} value={x.status} /></td>
                <td className="num">{day(x.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {edit && <AssetForm asset={edit === 'new' ? null : edit} readOnly={!write} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void list.reload(); }} />}
    </div>
  );
}

function AssetForm({ asset, readOnly, onClose, onDone }: { asset: Asset | null; readOnly: boolean; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const { f, bind } = useForm({
    legal_entity_id: asset?.legal_entity_id ?? me.legal_entities[0]?.id ?? '', asset_type: asset?.asset_type ?? 'van',
    plate_no: asset?.plate_no ?? '', make: asset?.make ?? '', model: asset?.model ?? '', year: asset?.year?.toString() ?? '',
    vin: asset?.vin ?? '', odometer_km: asset?.odometer_km?.toString() ?? '', notes: asset?.notes ?? '', status: asset?.status ?? 'available',
  });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = clean({
        plate_no: f.plate_no, make: f.make, model: f.model, vin: f.vin, notes: f.notes,
        year: f.year ? Number(f.year) : '', odometer_km: f.odometer_km ? Number(f.odometer_km) : '',
      });
      if (asset) await api(`/assets/${asset.id}`, { method: 'PATCH', body: { ...body, status: f.status } });
      else await api('/assets', { method: 'POST', body: { ...body, legal_entity_id: f.legal_entity_id, asset_type: f.asset_type } });
      onDone();
    });
  };
  return (
    <Modal title={asset ? `المركبة ${asset.plate_no ?? ''}` : 'إضافة مركبة'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }} className="form-2">
          {!asset && me.legal_entities.length > 1 && (
            <label className="field">الشركة القانونية<select {...bind('legal_entity_id')}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          )}
          {!asset && (
            <label className="field">النوع<select {...bind('asset_type')}>{Object.entries(ASSET_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          )}
          <label className="field">رقم اللوحة<input {...bind('plate_no')} className="num" maxLength={20} required={!asset} /></label>
          <label className="field">الصانع<input {...bind('make')} maxLength={60} /></label>
          <label className="field">الطراز<input {...bind('model')} maxLength={60} /></label>
          <label className="field">سنة الصنع<input {...bind('year')} className="num" type="number" min={1980} max={2100} /></label>
          <label className="field">رقم الهيكل (VIN)<input {...bind('vin')} className="num" maxLength={30} /></label>
          <label className="field">العداد (كم)<input {...bind('odometer_km')} className="num" type="number" min={0} /></label>
          {asset && (
            <label className="field">الحالة<select {...bind('status')}>{Object.entries(ASSET_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</select></label>
          )}
        </fieldset>
        <label className="field">ملاحظات<textarea {...bind('notes')} rows={2} maxLength={1000} disabled={readOnly} /></label>
        {!readOnly && <div className="row"><button className="primary" disabled={busy}>حفظ</button><button type="button" onClick={onClose}>إلغاء</button></div>}
      </form>
      {asset && <DocsPanel owner={{ asset_id: asset.id }} />}
    </Modal>
  );
}
