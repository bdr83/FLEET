'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { DOC_TYPE } from '@/lib/format';
import { Badge, Empty, ErrorBox, useLoad } from '@/components/ui';
import { ExpiryBadge } from '@/components/docs';

interface Expiring {
  id: string; doc_type: string; number: string | null; expires_on: string; days_left: number;
  asset_id: string | null; plate_no: string | null; worker_id: string | null; worker_name: string | null; state: 'expired' | 'expiring';
}

/** Expired and soon-to-expire documents across vehicles and drivers. Documents are added from each vehicle or driver. */
export default function DocumentsPage() {
  const [days, setDays] = useState(30);
  const list = useLoad(() => api<{ data: Expiring[] }>(`/documents/expiring?days=${days}`).then((r) => r.data), [days]);
  const expired = list.data?.filter((d) => d.state === 'expired').length ?? 0;
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>الوثائق المنتهية والقريبة من الانتهاء</h1>
        <select aria-label="المدة" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
          {[7, 30, 60, 90].map((d) => <option key={d} value={d}>خلال {d} يومًا</option>)}
        </select>
      </div>
      <p className="muted" style={{ margin: 0 }}>تُضاف الوثائق من صفحة كل مركبة أو سائق.{expired > 0 && <> <Badge tone="danger">{expired} منتهية</Badge></>}</p>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا توجد وثائق تنتهي خلال {days} يومًا</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>الوثيقة</th><th>الرقم</th><th>تخص</th><th>الانتهاء</th></tr></thead>
          <tbody>
            {list.data?.map((d) => (
              <tr key={d.id}>
                <td>{DOC_TYPE[d.doc_type] ?? d.doc_type}</td>
                <td className="num">{d.number ?? '—'}</td>
                <td>{d.plate_no ? <>مركبة <span className="num">{d.plate_no}</span></> : d.worker_name ? `السائق ${d.worker_name}` : '—'}</td>
                <td><ExpiryBadge date={d.expires_on} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
