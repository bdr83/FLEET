'use client';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import type * as Leaflet from 'leaflet';
import { dt, STAGE, TASK_STATUS, time } from '@/lib/format';

interface Track {
  status: string; stage: string | null; company: string; window_from: string | null; window_to: string | null; area: string | null;
  pin: string | null; driver: string | null; position: { lat: number; lng: number; at: string } | null;
  events: { status: string; at: string }[];
}

const TILES = process.env.NEXT_PUBLIC_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = process.env.NEXT_PUBLIC_TILE_ATTRIBUTION ?? '© OpenStreetMap contributors';

/** What the recipient reads at each point, from the task status and the driver's last stage. */
function headline(t: Track): { title: string; step: number } {
  if (t.status === 'completed' || t.status === 'reviewed') return { title: 'تم تسليم طلبك', step: 4 };
  if (t.status === 'failed') return { title: 'تعذّر التسليم، سيتواصل معك فريق التوصيل', step: -1 };
  if (t.status === 'canceled') return { title: 'أُلغي الطلب', step: -1 };
  if (t.stage === 'at_dropoff') return { title: 'المندوب عند الباب', step: 3 };
  if (t.stage === 'picked_up' || t.status === 'in_progress') return { title: 'طلبك في الطريق إليك', step: 2 };
  if (t.status === 'accepted' || t.status === 'assigned') return { title: 'تم تجهيز مندوب لطلبك', step: 1 };
  return { title: 'استلمنا طلبك', step: 0 };
}
const STEPS = ['استلام الطلب', 'تعيين مندوب', 'في الطريق', 'عند الباب', 'تم التسليم'];

/** The recipient's page: status, delivery PIN, driver first name and live position while on the way. No login. */
export default function TrackPage() {
  const { token } = useParams<{ token: string }>();
  const [t, setT] = useState<Track | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/track/${token}`, { cache: 'no-store' });
        if (r.status === 404) { if (!stop) setMissing(true); return; }
        if (r.ok && !stop) setT(await r.json());
      } catch { /* offline: keep the last state */ }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(id); };
  }, [token]);

  if (missing) return <main className="track"><div className="card"><h1>الرابط غير صالح أو انتهت صلاحيته</h1></div></main>;
  if (!t) return <main className="track"><p className="muted">جارٍ التحميل…</p></main>;
  const h = headline(t);
  return (
    <main className="track">
      <div className="card stack">
        <div className="muted">{t.company}</div>
        <h1 data-testid="headline">{h.title}</h1>
        {h.step >= 0 && (
          <ol className="steps">
            {STEPS.map((s, i) => <li key={s} className={i <= h.step ? 'done' : ''}>{s}</li>)}
          </ol>
        )}
        {t.pin && (
          <div className="pin-box">
            <div>رمز الاستلام، أعطه للمندوب عند التسليم فقط</div>
            <div className="pin num" data-testid="track-pin">{t.pin}</div>
          </div>
        )}
        <dl className="dl">
          {t.area && <><dt>المنطقة</dt><dd>{t.area}</dd></>}
          {t.window_from && <><dt>موعد التوصيل</dt><dd><span className="num">{dt(t.window_from)}</span> إلى <span className="num">{time(t.window_to)}</span></dd></>}
          {t.driver && <><dt>المندوب</dt><dd>{t.driver}</dd></>}
          {t.stage && <><dt>آخر تحديث</dt><dd>{STAGE[t.stage] ?? t.stage}</dd></>}
        </dl>
        {t.position && <LiveMap p={t.position} />}
        <details>
          <summary>سجل الطلب</summary>
          <ul className="timeline">
            {t.events.map((e, i) => <li key={i}>{TASK_STATUS[e.status]?.label ?? e.status} <span className="muted num">{dt(e.at)}</span></li>)}
          </ul>
        </details>
      </div>
      <p className="muted" style={{ textAlign: 'center', fontSize: 12 }}>تتحدث الصفحة تلقائيًا كل 30 ثانية</p>
    </main>
  );
}

function LiveMap({ p }: { p: { lat: number; lng: number; at: string } }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const marker = useRef<Leaflet.CircleMarker | null>(null);
  useEffect(() => {
    let alive = true;
    void import('leaflet').then((L) => {
      if (!alive || !el.current) return;
      if (!map.current) {
        map.current = L.map(el.current, { zoomControl: false, attributionControl: true }).setView([p.lat, p.lng], 14, { animate: false });
        L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map.current);
        marker.current = L.circleMarker([p.lat, p.lng], { radius: 9, color: '#0E7490', fillOpacity: 0.9 }).addTo(map.current);
      } else {
        marker.current?.setLatLng([p.lat, p.lng]);
        map.current.setView([p.lat, p.lng], map.current.getZoom(), { animate: false });
      }
    });
    return () => { alive = false; };
  }, [p.lat, p.lng]);
  useEffect(() => () => { map.current?.stop(); map.current?.off(); map.current?.remove(); map.current = null; }, []);
  return <div><div ref={el} className="track-map" /><div className="muted" style={{ fontSize: 12 }}>موقع تقريبي للمندوب، آخر تحديث <span className="num">{time(p.at)}</span></div></div>;
}
