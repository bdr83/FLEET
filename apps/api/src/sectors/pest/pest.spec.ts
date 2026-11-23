import { inWarranty, jobState, parseApplications, reentryAt, treatRule } from './pest';

describe('pest pack rules', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('products used: up to 20 lines, quantity rounded to 2 decimals, place optional', () => {
    expect(parseApplications([{ product_id: id, qty: '12.345', location: ' المطبخ ' }])).toEqual([{ product_id: id, qty: 12.35, location: 'المطبخ' }]);
    expect(parseApplications(undefined)).toEqual([]);
    expect(() => parseApplications([{ product_id: id, qty: 0 }])).toThrow();
    expect(() => parseApplications([{ product_id: 'x', qty: 1 }])).toThrow();
  });
  it('a treatment needs the infestation level, the receiver, and products unless it is an inspection', () => {
    expect(treatRule('spray', 1, null, 'أم أحمد')).toBe('infestation_required');
    expect(treatRule('spray', 1, 'low', null)).toBe('receiver_required');
    expect(treatRule('spray', 0, 'low', 'أم أحمد')).toBe('products_required');
    expect(treatRule('inspection', 0, 'none', 'أم أحمد')).toBeNull();
  });
  it('re-entry after the longest interval; warranty by days since the treatment', () => {
    const at = new Date('2026-11-23T10:00:00Z');
    expect(reentryAt(at, [2, 4]).toISOString()).toBe('2026-11-23T14:00:00.000Z');
    expect(reentryAt(at, []).toISOString()).toBe(at.toISOString());
    expect(inWarranty(at, 30, new Date('2026-12-20T10:00:00Z'))).toBe(true);
    expect(inWarranty(at, 30, new Date('2026-12-24T10:00:00Z'))).toBe(false);
    expect(inWarranty(null, 30, at)).toBe(false);
  });
  it('job state from its stages and task', () => {
    const j = { canceled_at: null, arrived_at: null, treated_at: null };
    expect(jobState(j, null)).toBe('open');
    expect(jobState(j, 'assigned')).toBe('assigned');
    expect(jobState({ ...j, arrived_at: 1 }, 'in_progress')).toBe('on_site');
    expect(jobState({ ...j, treated_at: 1 }, 'completed')).toBe('done');
  });
});
