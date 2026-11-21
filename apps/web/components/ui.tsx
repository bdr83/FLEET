'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { TASK_STATUS } from '@/lib/format';

/** Loads data and exposes reload; keeps the last data while reloading so screens do not flash. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fnRef.current()); setError(null); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'تعذّر التحميل'); }
    finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);
  return { data, error, loading, reload, setData };
}

/** Runs an action, showing its error; returns true on success. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); return true; }
    catch (e) { setError(e instanceof ApiError ? e.message : 'تعذّر تنفيذ الطلب'); return false; }
    finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}

export function StatusBadge({ status }: { status: string }) {
  const s = TASK_STATUS[status] ?? { label: status, tone: 'muted' };
  return <span className={`badge t-${s.tone}`}>{s.label}</span>;
}
export function Badge({ tone = 'muted', children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge t-${tone}`}>{children}</span>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert" role="alert">{error}</div> : null;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row spread" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="small" onClick={onClose} aria-label="إغلاق">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Kpi({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="card kpi">
      <div className="l">{label}</div>
      <div className="v num" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
    </div>
  );
}

export function Tone({ map, value }: { map: Record<string, { label: string; tone: string }>; value: string }) {
  const s = map[value] ?? { label: value, tone: 'muted' };
  return <span className={`badge t-${s.tone}`}>{s.label}</span>;
}

/** A small typed form-state helper: f.x values plus bind('x') for inputs and selects. */
export function useForm<T extends Record<string, string | boolean>>(init: T) {
  const [f, setF] = useState<T>(init);
  const bind = (k: keyof T) => ({
    name: String(k),
    value: f[k] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value })),
  });
  const check = (k: keyof T) => ({
    name: String(k), checked: !!f[k], type: 'checkbox' as const, style: { width: 'auto' },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.checked })),
  });
  return { f, setF, bind, check };
}

/** Drops empty strings so optional fields are simply left out of the request. */
export function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

/** Vehicles for a select box (needs fleet:read). */
export function useAssets() {
  return useLoad(() => api<{ data: { id: string; plate_no: string | null; asset_type: string; status: string; legal_entity_id: string; odometer_km: number | null }[] }>('/assets').then((r) => r.data));
}
