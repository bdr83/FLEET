import { charges, rentalAmount, rentalDays } from './rental';

const h = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000);

describe('car rental charges', () => {
  it('days: whole 24 h periods, a started day after the grace hour, at least one', () => {
    expect(rentalDays(h(0), h(3))).toBe(1);
    expect(rentalDays(h(0), h(24))).toBe(1);
    expect(rentalDays(h(0), h(24.9))).toBe(1);
    expect(rentalDays(h(0), h(25.5))).toBe(2);
    expect(rentalDays(h(0), h(72))).toBe(3);
  });

  it('amount: whole units, the days left pro rata up to one more unit', () => {
    expect(rentalAmount(3, 'day', 12.5)).toBe('37.500');
    expect(rentalAmount(7, 'week', 70)).toBe('70.000');
    expect(rentalAmount(9, 'week', 70)).toBe('90.000');
    expect(rentalAmount(13, 'week', 70)).toBe('130.000');
    expect(rentalAmount(45, 'month', 300)).toBe('450.000');
  });

  it('extra km, fuel short, damage', () => {
    const c = charges({ outAt: h(0), inAt: h(48), outKm: 1000, inKm: 1650, outFuel: 8, inFuel: 5, unit: 'day', rate: 15, kmPerDay: 250, extraKmRate: 0.05, fuelRate: 1.25, damage: 20 });
    expect(c).toEqual({ days: 2, rental_amount: '30.000', extra_km: 150, km_amount: '7.500', fuel_amount: '3.750', damage_amount: '20.000', total: '61.250' });
    const open = charges({ outAt: h(0), inAt: h(10), outKm: 0, inKm: 900, outFuel: 4, inFuel: 6, unit: 'day', rate: 10, kmPerDay: null, extraKmRate: 1, fuelRate: 1, damage: 0 });
    expect(open).toMatchObject({ days: 1, extra_km: 0, fuel_amount: '0.000', total: '10.000' });
  });
});
