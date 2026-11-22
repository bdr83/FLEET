import { detention, normalizeCargo, normalizePlace, quantities, tripDetention, weightMismatch } from './freight';

const at = (min: number) => new Date(Date.UTC(2026, 10, 22, 8, min));

describe('freight pack', () => {
  it('detention is charged by the quarter hour after the free time', () => {
    expect(detention(at(0), at(100), 120)).toEqual({ minutes: 100, billable_hours: 0 });
    expect(detention(at(0), at(121), 120)).toEqual({ minutes: 121, billable_hours: 0.25 });
    expect(detention(null, at(10), 0)).toEqual({ minutes: 0, billable_hours: 0 });
    expect(tripDetention({ at_pickup: at(0), loaded: at(180), at_dropoff: at(200), unloaded: at(345) }, 120)).toEqual({ minutes: 85, hours: 1.5 });
  });
  it('quantities follow the bill unit', () => {
    const s = { planned_km: 85, cargo_weight_kg: 18000, loaded_weight_kg: 17800, delivered_weight_kg: null };
    expect(quantities({ ...s, bill_unit: 'trip' }, 1)).toEqual({ trip: 1, hour: 1 });
    expect(quantities({ ...s, bill_unit: 'km' })).toEqual({ km: 85 });
    expect(quantities({ ...s, bill_unit: 'ton' })).toEqual({ ton: 17.8 });
    expect(quantities({ ...s, loaded_weight_kg: null, bill_unit: 'ton' })).toEqual({ ton: 18 });
  });
  it('weight mismatch uses the tolerance', () => {
    expect(weightMismatch(18000, 17700, 2)).toBe(false);
    expect(weightMismatch(18000, 17600, 2)).toBe(true);
    expect(weightMismatch(null, 17600, 2)).toBe(false);
  });
  it('validates cargo and places', () => {
    expect(normalizeCargo({ description: 'أسمنت', weight_kg: '25000' })).toEqual({ description: 'أسمنت', weight_kg: 25000 });
    expect(() => normalizeCargo({ description: 'x', weight_kg: 200000 })).toThrow();
    expect(() => normalizePlace({}, 'pickup', { required: true })).toThrow();
    expect(normalizePlace({ name: 'ميناء الشويخ', contact_phone: '50000001' }, 'pickup')).toEqual({ name: 'ميناء الشويخ', contact_phone: '+96550000001' });
  });
});
