'use client';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import { api } from '@/lib/api';
import { ago, taskSummary, TASK_STATUS } from '@/lib/format';
import { Badge, Empty, ErrorBox } from '@/components/ui';

interface LiveDriver {
  worker_id: string; display_name: string; shift_id: string; started_at: string; plate_no: string | null;
  recorded_at: string | null; lat: number | null; lng: number | null; accuracy_m: number | null; battery_pct: number | null; stale: boolean;
  task_id: string | null; task_status: string | null; task_attributes: Record<string, unknown> | null;
}
interface Track { distance_km: number; duration_min: number; max_kmh: number | null; points: { lat: number; lng: number; recorded_at: string }[] }

/** Map tiles: OpenStreetMap by default for development. Production needs a tile provider with a commercial licence. [تحقق محلي] */
const TILES = process.env.NEXT_PUBLIC_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = process.env.NEXT_PUBLIC_TILE_ATTRIBUTION ?? '© OpenStreetMap contributors';
const KUWAIT: [number, number] = [29.3759, 47.9774];
const POLL_MS = 15_000;

/** Drivers on shift with their last position (only while on shift, D6). Polls with since= so only movers are re-sent. */
export default function LiveMap() {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const markers = useRef(new Map<string, Leaflet.CircleMarker>());
  const trackLine = useRef<Leaflet.Polyline | null>(null);
  const [drivers, setDrivers] = useState<Record<string, LiveDriver>>({});
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const fitted = useRef(false);

  // Map setup (client only)
  useEffect(() => {
    let off = false;
    void import('leaflet').then((mod) => {
      if (off || !box.current || map.current) return;
      L.current = mod;
      map.current = mod.map(box.current, { center: KUWAIT, zoom: 11 });
      mod.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map.current);
    });
    return () => {
      off = true;
      // stop pending pan/zoom animations first: removing mid-animation throws inside Leaflet
      map.current?.stop(); map.current?.off(); map.current?.remove();
      map.current = null; markers.current.clear();
    };
  }, []);

  // Polling. A full reload every 10 polls drops drivers whose shift ended.
  useEffect(() => {
    let since: string | null = null;
    let n = 0;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      const full = since === null || n++ % 10 === 0;
      try {
        const r = await api<{ server_time: string; drivers: LiveDriver[] }>(`/map/live${full ? '' : `?since=${encodeURIComponent(since!)}`}`);
        if (stop) return;
        since = r.server_time;
        setDrivers((prev) => {
          const next: Record<string, LiveDriver> = full ? {} : { ...prev };
          for (const d of r.drivers) next[d.worker_id] = d;
          return next;
        });
        setError(null);
      } catch (e) { setError((e as Error).message); }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, []);

  // Draw markers whenever the driver list changes
  useEffect(() => {
    const m = map.current, lib = L.current;
    if (!m || !lib) return;
    const seen = new Set<string>();
    for (const d of Object.values(drivers)) {
      if (d.lat == null || d.lng == null) continue;
      seen.add(d.worker_id);
      const color = d.stale ? '#8a94a6' : d.task_status === 'in_progress' ? '#d97706' : '#0f7a5c';
      let mk = markers.current.get(d.worker_id);
      if (!mk) {
        mk = lib.circleMarker([d.lat, d.lng], { radius: 9, weight: 2, color: '#fff', fillOpacity: 1 }).addTo(m);
        mk.on('click', () => setSelected(d.worker_id));
        markers.current.set(d.worker_id, mk);
      }
      mk.setLatLng([d.lat, d.lng]).setStyle({ fillColor: color });
      mk.bindTooltip(`${d.display_name}${d.plate_no ? ` · ${d.plate_no}` : ''}`, { direction: 'top' });
    }
    for (const [id, mk] of markers.current) if (!seen.has(id)) { mk.remove(); markers.current.delete(id); }
    if (!fitted.current && seen.size) {
      fitted.current = true;
      m.fitBounds(lib.latLngBounds([...markers.current.values()].map((x) => x.getLatLng())), { maxZoom: 14, padding: [40, 40], animate: false });
    }
  }, [drivers]);

  // Selected driver: load today's shift route
  const sel = selected ? drivers[selected] : null;
  useEffect(() => {
    trackLine.current?.remove(); trackLine.current = null; setTrack(null);
    if (!sel?.shift_id) return;
    let off = false;
    void api<Track>(`/shifts/${sel.shift_id}/track`).then((t) => {
      if (off || !map.current || !L.current) return;
      setTrack(t);
      if (t.points.length > 1) trackLine.current = L.current.polyline(t.points.map((p) => [p.lat, p.lng]), { color: '#1d6fb8', weight: 4, opacity: 0.7 }).addTo(map.current);
    }).catch(() => undefined);
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.shift_id]);

  const focus = (d: LiveDriver) => {
    setSelected(d.worker_id);
    if (d.lat != null && d.lng != null) map.current?.setView([d.lat, d.lng], 15, { animate: false });
  };
  const list = Object.values(drivers).sort((a, b) => a.display_name.localeCompare(b.display_name, 'ar'));
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>الخريطة الحية</h1>
        <span className="muted">تتحدث كل {POLL_MS / 1000} ثانية · يظهر موقع السائق أثناء المناوبة فقط</span>
      </div>
      <ErrorBox error={error} />
      <div className="map-grid">
        <div ref={box} className="map card" aria-label="الخريطة" />
        <aside className="card stack" style={{ overflow: 'auto' }}>
          <h2>في المناوبة ({list.length})</h2>
          {list.length === 0 && <Empty>لا يوجد سائق في المناوبة الآن</Empty>}
          {list.map((d) => (
            <button key={d.worker_id} onClick={() => focus(d)} className={`driver-row ${selected === d.worker_id ? 'on' : ''}`}>
              <span className="row spread" style={{ width: '100%' }}>
                <strong>{d.display_name}</strong>
                {d.lat == null ? <Badge>بلا موقع</Badge> : d.stale ? <Badge tone="warning">متوقف التحديث</Badge> : <Badge tone="success">مباشر</Badge>}
              </span>
              <span className="muted">{d.plate_no ?? 'بلا مركبة'} · آخر تحديث {ago(d.recorded_at)}{d.battery_pct != null && ` · ${d.battery_pct}%`}</span>
              {d.task_id && <span>{TASK_STATUS[d.task_status ?? '']?.label}: {taskSummary(d.task_attributes)}</span>}
            </button>
          ))}
          {sel && track && (
            <div className="card" style={{ background: 'var(--surface-2)' }}>
              <strong>مسار المناوبة: {sel.display_name}</strong>
              <div>{track.distance_km} كم · {track.duration_min} دقيقة{track.max_kmh != null && ` · أقصى سرعة ${track.max_kmh} كم/س`}</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
