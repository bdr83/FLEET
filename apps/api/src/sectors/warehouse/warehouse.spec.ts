import { allocate, qtyOk, receiptVariance, StockRow } from './warehouse';

describe('warehouse pack rules', () => {
  const row = (location_code: string, qty: number, expiry: string | null = null, kind = 'storage', item_id = 'A'): StockRow =>
    ({ item_id, location_id: location_code, location_code, location_kind: kind, lot: null, expiry, qty });

  it('picks the first expiry first, skips quarantine and expired stock, and reports what is short', () => {
    const stock = [row('B-1', 10, '2027-03-01'), row('A-1', 5, '2027-01-01'), row('C-1', 50), row('Q-1', 100, '2026-12-01', 'quarantine'), row('X-1', 20, '2026-11-01')];
    const p = allocate([{ item_id: 'A', qty: 12 }], stock, '2026-11-22');
    expect(p.picks.map((x) => [x.location_code, x.qty])).toEqual([['A-1', 5], ['B-1', 7]]);
    expect(p.short).toEqual([]);
    const q = allocate([{ item_id: 'A', qty: 60 }, { item_id: 'A', qty: 10 }, { item_id: 'B', qty: 1 }], stock, '2026-11-22');
    expect(q.picks.reduce((s, x) => s + x.qty, 0)).toBe(65);
    expect(q.short).toEqual([{ item_id: 'A', qty: 5 }, { item_id: 'B', qty: 1 }]);
  });

  it('without expiry, the smaller bin first', () => {
    expect(allocate([{ item_id: 'A', qty: 4 }], [row('A-2', 10), row('A-9', 3)], '2026-11-22').picks.map((x) => [x.location_code, x.qty])).toEqual([['A-9', 3], ['A-2', 1]]);
  });

  it('receipt variance against the notice', () => {
    expect(receiptVariance([{ item_id: 'A', qty: 10 }, { item_id: 'B', qty: 5 }], [{ item_id: 'A', qty: 6 }, { item_id: 'A', qty: 4 }, { item_id: 'B', qty: 4 }, { item_id: 'C', qty: 1 }]))
      .toEqual([{ item_id: 'B', expected: 5, received: 4, diff: -1 }, { item_id: 'C', expected: 0, received: 1, diff: 1 }]);
    expect(receiptVariance(null, [{ item_id: 'A', qty: 1 }])).toEqual([]);
  });

  it('quantities', () => {
    expect([qtyOk(1), qtyOk(2.5), qtyOk(0.01), qtyOk(0), qtyOk(-1), qtyOk(1.234), qtyOk('3')]).toEqual([true, true, true, false, false, false, false]);
  });
});
