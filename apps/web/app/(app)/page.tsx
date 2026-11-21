'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ago, packLabel, taskSummary, time, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { AssignModal, BoardDriver } from '@/components/assign';
import { Badge, Empty, ErrorBox, Kpi, useLoad } from '@/components/ui';

interface QueueTask { id: string; ref: string | null; sector_pack: string; window_from: string | null; window_to: string | null; attributes: Record<string, unknown>; version: number }
interface Board { date: string | null; counts: Record<string, number>; queue: QueueTask[]; drivers: BoardDriver[] }

/** The dispatcher's home: today's numbers, tasks waiting for a driver, and who is on shift. Refreshes every 30 s. */
export default function DispatchBoard() {
  const me = useMe();
  const [date, setDate] = useState(todayKw());
  const board = useLoad(() => api<Board>(`/dispatch/board?date=${date}`), [date]);
  const [assigning, setAssigning] = useState<QueueTask | null>(null);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void board.reload(); }, 30_000);
    return () => clearInterval(t);
  }, [board.reload]);

  const c = board.data?.counts ?? {};
  const active = (c.assigned ?? 0) + (c.accepted ?? 0) + (c.in_progress ?? 0);
  const done = (c.completed ?? 0) + (c.reviewed ?? 0) + (c.invoiced ?? 0);
  const onShift = board.data?.drivers.filter((d) => d.shift_id).length ?? 0;
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>لوحة التوزيع</h1>
        <div className="row">
          <input type="date" aria-label="التاريخ" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
          <button className="small" onClick={() => board.reload()} disabled={board.loading}>تحديث</button>
          {can(me, 'tasks:write') && <Link className="btn primary small" href="/tasks?new=1">مهمة جديدة</Link>}
        </div>
      </div>
      <ErrorBox error={board.error} />
      <div className="grid g4">
        <Kpi label="بانتظار الإسناد" value={c.ready ?? 0} tone={(c.ready ?? 0) > 0 ? 'warning' : undefined} />
        <Kpi label="قيد التنفيذ" value={active} />
        <Kpi label="مكتملة" value={done} tone="success" />
        <Kpi label="فاشلة" value={c.failed ?? 0} tone={(c.failed ?? 0) > 0 ? 'danger' : undefined} />
        <Kpi label="سائقون في المناوبة" value={`${onShift} / ${board.data?.drivers.length ?? 0}`} />
      </div>
      <div className="grid g2">
        <section className="card">
          <h2>بانتظار الإسناد ({board.data?.queue.length ?? 0})</h2>
          {board.data && board.data.queue.length === 0 ? <Empty>لا توجد مهام بانتظار سائق</Empty> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>المرجع</th><th>الموعد</th><th>التفاصيل</th><th></th></tr></thead>
              <tbody>
                {board.data?.queue.map((t) => (
                  <tr key={t.id}>
                    <td><Link href={`/tasks/${t.id}`}>{t.ref ?? t.id.slice(0, 8)}</Link><div className="muted">{packLabel(t.sector_pack)}</div></td>
                    <td className="num">{t.window_from ? `${time(t.window_from)}–${time(t.window_to)}` : '—'}</td>
                    <td>{taskSummary(t.attributes)}</td>
                    <td>{can(me, 'tasks:assign') && <button className="small primary" onClick={() => setAssigning(t)}>إسناد</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
        <section className="card">
          <h2>السائقون</h2>
          {board.data && board.data.drivers.length === 0 ? <Empty>لا يوجد سائقون نشطون. أضفهم من صفحة السائقين.</Empty> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>السائق</th><th>الحالة</th><th>المركبة</th><th>مهام مفتوحة</th><th>آخر ظهور</th></tr></thead>
              <tbody>
                {board.data?.drivers.map((d) => (
                  <tr key={d.id}>
                    <td>{d.display_name}</td>
                    <td>{d.shift_id ? <Badge tone="success">في المناوبة</Badge> : <Badge>خارج المناوبة</Badge>}</td>
                    <td className="num">{d.plate_no ?? '—'}</td>
                    <td className="num">{d.open_tasks}</td>
                    <td>{ago(d.last_seen_at)}{d.battery_pct != null && <span className="muted num"> · {d.battery_pct}%</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      </div>
      {assigning && <AssignModal task={assigning} onClose={() => setAssigning(null)} onDone={() => { setAssigning(null); void board.reload(); }} />}
    </div>
  );
}
