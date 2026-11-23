import { completion, doneRule, parseServices, visitState } from './landscape';

describe('landscape pack rules', () => {
  it('services: known codes, no repeats, in the standard order', () => {
    expect(parseServices(['irrigation', 'mowing', 'mowing'])).toEqual(['mowing', 'irrigation']);
    expect(() => parseServices([])).toThrow();
    expect(() => parseServices(undefined)).toThrow();
    expect(parseServices(undefined, 'services', 0)).toEqual([]);
    expect(() => parseServices(['swimming'])).toThrow();
  });
  it('the work done: a service, a note for an undone planned one, the irrigation state where there is a network, the bags', () => {
    const base = { planned: ['mowing', 'pruning'], done: ['mowing', 'pruning'], irrigation: 'ok', hasIrrigation: true, bags: 2, note: null };
    expect(doneRule(base)).toBeNull();
    expect(doneRule({ ...base, done: [] })).toBe('services_required');
    expect(doneRule({ ...base, done: ['mowing'] })).toBe('undone_note_required');
    expect(doneRule({ ...base, done: ['mowing'], note: 'المقص معطل' })).toBeNull();
    expect(doneRule({ ...base, irrigation: null })).toBe('irrigation_required');
    expect(doneRule({ ...base, irrigation: null, hasIrrigation: false })).toBeNull();
    expect(doneRule({ ...base, bags: null })).toBe('waste_bags_required');
  });
  it('completion share and visit state', () => {
    expect(completion(3, 2)).toBe(67);
    expect(completion(0, 1)).toBeNull();
    expect(visitState({ arrived_at: null, done_at: null }, 'assigned')).toBe('assigned');
    expect(visitState({ arrived_at: 1, done_at: null }, 'in_progress')).toBe('on_site');
    expect(visitState({ arrived_at: 1, done_at: 1 }, 'completed')).toBe('done');
    expect(visitState({ arrived_at: null, done_at: null }, 'canceled')).toBe('canceled');
  });
});
