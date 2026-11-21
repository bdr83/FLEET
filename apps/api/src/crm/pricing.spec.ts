import { priceTask, Rate } from './pricing';

const rates: Rate[] = [
  { id: 'r1', sector_pack: null, unit: 'task', price: '1.500' },
  { id: 'r2', sector_pack: 'delivery@1', unit: 'task', price: '1.250' },
  { id: 'r3', sector_pack: null, unit: 'km', price: '0.100', included_qty: 5 },
  { id: 'r4', sector_pack: 'concrete@1', unit: 'm3', price: '22.000', min_charge: '66.000' },
];

describe('contract pricing', () => {
  it('a specific rate wins over the general one', () => {
    expect(priceTask(rates, 'delivery@1').total).toBe('1.250');
    expect(priceTask(rates, 'moving@1').total).toBe('1.500');
  });
  it('included quantity is free, the rest is charged without float drift', () => {
    const q = priceTask(rates, 'delivery@1', { task: 1, km: 12.3 });
    expect(q.lines.find((l) => l.unit === 'km')).toMatchObject({ billable_qty: 7.3, amount: '0.730' });
    expect(q.total).toBe('1.980');
  });
  it('minimum charge applies to small loads', () => {
    expect(priceTask(rates, 'concrete@1', { m3: 2 }).total).toBe('66.000');
    expect(priceTask(rates, 'concrete@1', { m3: 8 }).total).toBe('176.000');
    expect(priceTask(rates, 'concrete@1', { m3: 0 }).total).toBe('0.000');
  });
  it('reports units without a rate instead of pricing them at zero silently', () => {
    expect(priceTask(rates, 'delivery@1', { task: 1, hour: 3 }).unpriced).toEqual(['hour']);
  });
  it('rejects negative quantities', () => {
    expect(() => priceTask(rates, 'delivery@1', { km: -1 })).toThrow();
  });
});
