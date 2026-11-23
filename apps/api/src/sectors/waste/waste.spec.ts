import { binCount, finishBlock, parseBins, parseNetKg, visitRule } from './waste';

describe('waste collection rules', () => {
  it('the bins at a point: known types, once each, 1-50 of a type', () => {
    expect(parseBins([{ type: 'bin_1100', count: 4 }, { type: 'compactor' }])).toEqual([{ type: 'bin_1100', count: 4 }, { type: 'compactor', count: 1 }]);
    expect(binCount([{ type: 'bin_1100', count: 4 }, { type: 'bin_240', count: 6 }])).toBe(10);
    expect(() => parseBins([])).toThrow();
    expect(() => parseBins([{ type: 'drum', count: 1 }])).toThrow();
    expect(() => parseBins([{ type: 'bin_240', count: 0 }])).toThrow();
    expect(() => parseBins([{ type: 'bin_240', count: 1 }, { type: 'bin_240', count: 2 }])).toThrow();
  });

  it('a visit: bins for a collection, a reason for a miss, not more than twice the bins', () => {
    expect(visitRule('collected', 4, null, 4)).toBeNull();
    expect(visitRule('collected', 0, null, 4)).toBeNull();
    expect(visitRule('collected', null, null, 4)).toBe('bins_required');
    expect(visitRule('collected', 9, null, 4)).toBe('bins_invalid');
    expect(visitRule('missed', null, null, 4)).toBe('miss_reason_required');
    expect(visitRule('missed', null, 'blocked', 4)).toBeNull();
  });

  it('a run ends with every point marked and a ticket if anything was collected', () => {
    expect(finishBlock(['a', 'b'], [{ point_id: 'a', event: 'collected' }], 1)).toBe('points_open');
    expect(finishBlock(['a', 'b'], [{ point_id: 'a', event: 'collected' }, { point_id: 'b', event: 'missed' }], 0)).toBe('dump_required');
    expect(finishBlock(['a'], [{ point_id: 'a', event: 'missed' }], 0)).toBeNull();
    expect(finishBlock(['a'], [{ point_id: 'a', event: 'collected' }], 1)).toBeNull();
  });

  it('the net weight on a ticket', () => {
    expect(parseNetKg('5240.55', 'w')).toBe(5240.6);
    expect(parseNetKg(undefined, 'w')).toBeNull();
    expect(() => parseNetKg(undefined, 'w', true)).toThrow();
    expect(() => parseNetKg(50000, 'w')).toThrow();
  });
});
