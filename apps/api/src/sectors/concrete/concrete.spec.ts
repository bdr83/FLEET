import { ageMinutes, m3, normalizeSite, planLoads, siteLine, waiting } from './concrete';
import { mixerState } from './concrete.controller';

describe('concrete pack rules', () => {
  const at = new Date('2026-12-01T06:00:00Z');
  it('splits a pour into full trucks plus the remainder, timed for a continuous pour', () => {
    const p = planLoads({ volume_m3: 40, pour_rate_m3h: 30, scheduled_at: at, capacity_m3: 9, lead_minutes: 30, cycle_minutes: 120 });
    expect(p.loads.map((l) => l.volume_m3)).toEqual([9, 9, 9, 9, 4]);
    expect(p.spacing_minutes).toBe(18);           // 9 m³ at 30 m³/h
    expect(p.trucks_needed).toBe(5);              // ceil(120 / 18) = 7, capped by 5 loads
    expect(p.pour_minutes).toBe(80);
    expect(p.loads[1].arrive_at.toISOString()).toBe('2026-12-01T06:18:00.000Z');
    expect(p.loads[0].load_at.toISOString()).toBe('2026-12-01T05:30:00.000Z');
    expect(p.loads[0].return_at.toISOString()).toBe('2026-12-01T07:30:00.000Z');
  });
  it('a big pour needs fewer trucks than loads; a small one needs one', () => {
    expect(planLoads({ volume_m3: 200, pour_rate_m3h: 40, scheduled_at: at, capacity_m3: 10, lead_minutes: 30, cycle_minutes: 90 }).trucks_needed).toBe(6);
    const s = planLoads({ volume_m3: 3.5, pour_rate_m3h: 20, scheduled_at: at, capacity_m3: 9, lead_minutes: 30, cycle_minutes: 90 });
    expect(s.loads).toHaveLength(1);
    expect(s.trucks_needed).toBe(1);
  });
  it('continues numbering and timing after volume already loaded', () => {
    const p = planLoads({ volume_m3: 5, pour_rate_m3h: 30, scheduled_at: at, capacity_m3: 9, lead_minutes: 30, cycle_minutes: 120, startSeq: 4, already_m3: 18 });
    expect(p.loads[0]).toMatchObject({ seq: 4, volume_m3: 5 });
    expect(p.loads[0].arrive_at.toISOString()).toBe('2026-12-01T06:36:00.000Z');
  });
  it('no float drift on decimal volumes', () => {
    expect(planLoads({ volume_m3: 18.3, pour_rate_m3h: 30, scheduled_at: at, capacity_m3: 9.1, lead_minutes: 30, cycle_minutes: 120 }).loads.map((l) => l.volume_m3)).toEqual([9.1, 9.1, 0.1]);
  });
  it('waiting time and the quarter hours charged after the free time', () => {
    const t = (m: number) => new Date(at.getTime() + m * 60_000);
    expect(waiting(t(0), t(25), 30)).toEqual({ wait_minutes: 25, billable_hours: 0 });
    expect(waiting(t(0), t(31), 30)).toEqual({ wait_minutes: 31, billable_hours: 0.25 });
    expect(waiting(t(0), t(95), 30)).toEqual({ wait_minutes: 95, billable_hours: 1.25 });
    expect(waiting(null, t(5), 30)).toEqual({ wait_minutes: 0, billable_hours: 0 });
  });
  it('concrete age', () => {
    expect(ageMinutes(null)).toBeNull();
    expect(ageMinutes('2026-12-01T06:00:00Z', new Date('2026-12-01T07:15:00Z'))).toBe(75);
  });
  it('site and quantity validation', () => {
    expect(siteLine(normalizeSite({ name: 'برج الحمراء', area: 'شرق', block: '3', plot: '12' }))).toBe('برج الحمراء، شرق، ق 3، قسيمة 12');
    expect(normalizeSite({ contact_phone: '50000001' }).contact_phone).toBe('+96550000001');
    expect(() => normalizeSite({ lat: 200, lng: 1 })).toThrow();
    expect(m3('8.5', 'x')).toBe(8.5);
    expect(() => m3(8.555, 'x')).toThrow();
    expect(() => m3(0, 'x')).toThrow();
    expect(m3(0, 'x', { zero: true })).toBe(0);
  });
  it('mixer state from shift and stages', () => {
    const base = { worker_id: 'w', task_id: 't', task_status: 'in_progress', stage: null as string | null, done_at: null, lead_minutes: 30 };
    expect(mixerState({ ...base, worker_id: null })).toBe('off');
    expect(mixerState({ ...base, task_status: 'accepted' })).toBe('loading');
    expect(mixerState({ ...base, stage: 'loaded' })).toBe('on_road');
    expect(mixerState({ ...base, stage: 'at_site' })).toBe('waiting');
    expect(mixerState({ ...base, stage: 'pour_start' })).toBe('pouring');
    expect(mixerState({ ...base, stage: 'pour_end' })).toBe('returning');
    expect(mixerState({ ...base, task_id: null, done_at: new Date(Date.now() - 10 * 60_000) })).toBe('returning');
    expect(mixerState({ ...base, task_id: null, done_at: new Date(Date.now() - 60 * 60_000) })).toBe('available');
  });
});
