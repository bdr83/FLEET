import { dueAt, newAwb, AWB_RE, scanOutcome, whereIs } from './courier';

describe('courier pack rules', () => {
  const p = (status: string, o: Partial<{ attempts: number; max_attempts: number; rto_at: string | null; rto_done_at: string | null }> = {}) =>
    ({ status, attempts: 0, max_attempts: 3, rto_at: null, rto_done_at: null, ...o });

  it('due time by service, in Kuwait time', () => {
    const now = new Date('2026-11-22T10:00:00Z'); // 13:00 in Kuwait
    expect(dueAt('express', now).toISOString()).toBe('2026-11-22T14:00:00.000Z');
    expect(dueAt('same_day', now).toISOString()).toBe('2026-11-22T20:59:00.000Z');
    expect(dueAt('next_day', now).toISOString()).toBe('2026-11-23T20:59:00.000Z');
    expect(dueAt('same_day', new Date('2026-11-22T22:30:00Z')).toISOString()).toBe('2026-11-23T20:59:00.000Z'); // 01:30 next day in Kuwait
  });

  it('waybill numbers', () => {
    expect(newAwb()).toMatch(AWB_RE);
    expect(newAwb()).toHaveLength(12);
  });

  it('hub scans', () => {
    expect(scanOutcome('received', p('ready'))).toEqual({ hub: 'set' });
    expect(scanOutcome('sorted', p('assigned'))).toEqual({ hub: 'keep' });
    expect(scanOutcome('dispatched', p('ready'))).toEqual({ hub: 'clear' });
    expect(scanOutcome('arrived', p('in_progress'))).toEqual({ error: 'with_driver' });
    expect(scanOutcome('received', p('completed'))).toEqual({ error: 'closed' });
    expect(scanOutcome('received', p('failed'))).toEqual({ error: 'awaiting_return' });
    expect(scanOutcome('returned', p('ready'))).toEqual({ error: 'not_failed' });
    expect(scanOutcome('rto_out', p('failed'))).toEqual({ error: 'not_rto' });
  });

  it('attempts, then return to the shipper', () => {
    expect(scanOutcome('returned', p('failed', { attempts: 1 }))).toEqual({ hub: 'set', reopen: true });
    expect(scanOutcome('returned', p('failed', { attempts: 1 }), true)).toEqual({ hub: 'set', rto: true });
    expect(scanOutcome('returned', p('failed', { attempts: 3 }))).toEqual({ hub: 'set', rto: true });
    const rto = p('failed', { attempts: 3, rto_at: '2026-11-22T10:00:00Z' });
    expect(scanOutcome('dispatched', rto)).toEqual({ hub: 'clear' });
    expect(scanOutcome('rto_out', rto)).toEqual({ hub: 'clear', rtoDone: true });
    expect(scanOutcome('received', { ...rto, rto_done_at: '2026-11-22T12:00:00Z' })).toEqual({ error: 'closed' });
  });

  it('where the parcel is', () => {
    expect(whereIs({ status: 'ready', current_hub_id: 'h', rto_at: null, rto_done_at: null })).toBe('at_hub');
    expect(whereIs({ status: 'ready', current_hub_id: null, rto_at: null, rto_done_at: null })).toBe('in_transit');
    expect(whereIs({ status: 'in_progress', current_hub_id: 'h', rto_at: null, rto_done_at: null })).toBe('with_driver');
    expect(whereIs({ status: 'failed', current_hub_id: 'h', rto_at: null, rto_done_at: null })).toBe('with_driver');
    expect(whereIs({ status: 'failed', current_hub_id: 'h', rto_at: 'x', rto_done_at: null })).toBe('at_hub');
    expect(whereIs({ status: 'completed', current_hub_id: null, rto_at: null, rto_done_at: null })).toBe('delivered');
    expect(whereIs({ status: 'failed', current_hub_id: null, rto_at: 'x', rto_done_at: 'x' })).toBe('rto_done');
  });
});
