import { bookingState, meterFare, parseKm, servesClass, waitMinutes } from './taxi';

describe('taxi rules', () => {
  const t = { base: '0.350', per_km: '0.150', per_wait_min: '0.050', min_fare: '1.000' };
  it('metered fare: base, km, waiting beyond 5 free minutes, at least the minimum', () => {
    expect(meterFare(t, 10, 0)).toBe('1.850');
    expect(meterFare(t, 10, 8)).toBe('2.000'); // 3 paid minutes
    expect(meterFare(t, 2, 0)).toBe('1.000'); // minimum
    expect(meterFare(t, 12.5, 5.2)).toBe('2.275'); // 6 minutes counted, 1 paid
  });

  it('waiting from the later of arrival and the pickup time', () => {
    const p = new Date('2026-11-23T10:00:00Z');
    expect(waitMinutes(p, new Date('2026-11-23T09:50:00Z'), new Date('2026-11-23T10:04:00Z'))).toBe(4);
    expect(waitMinutes(p, new Date('2026-11-23T10:05:00Z'), new Date('2026-11-23T10:17:00Z'))).toBe(12);
    expect(waitMinutes(p, null, null)).toBe(0);
  });

  it('classes, km and states', () => {
    expect(servesClass('luxury', 'sedan')).toBe(true);
    expect(servesClass('sedan', 'luxury')).toBe(false);
    expect(servesClass('van', 'sedan')).toBe(false);
    expect(parseKm('12.5')).toBe(12.5);
    expect(() => parseKm(12.55)).toThrow();
    expect(() => parseKm(-1)).toThrow();
    const b = { canceled_at: null, arrived_at: null, picked_at: null, dropped_at: null };
    expect(bookingState(b, null)).toBe('new');
    expect(bookingState(b, 'assigned')).toBe('assigned');
    expect(bookingState(b, 'in_progress')).toBe('on_way');
    expect(bookingState({ ...b, arrived_at: 1 }, 'in_progress')).toBe('waiting');
    expect(bookingState({ ...b, arrived_at: 1, picked_at: 1 }, 'in_progress')).toBe('on_trip');
    expect(bookingState({ ...b, dropped_at: 1 }, 'in_progress')).toBe('done');
    expect(bookingState(b, 'failed')).toBe('failed');
    expect(bookingState({ ...b, canceled_at: 1 }, 'assigned')).toBe('canceled');
  });
});
