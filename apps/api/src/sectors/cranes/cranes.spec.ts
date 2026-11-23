import { isCritical, liftRule, parseChart, parseWind, ratedAt, utilization } from './cranes';

describe('crane lifting rules', () => {
  const chart = [{ radius_m: 3, capacity_t: 50 }, { radius_m: 10, capacity_t: 20 }, { radius_m: 20, capacity_t: 8 }];

  it('the load chart: radii increasing, capacity never increasing', () => {
    expect(parseChart(chart)).toEqual(chart);
    expect(() => parseChart([])).toThrow();
    expect(() => parseChart([{ radius_m: 5, capacity_t: 10 }, { radius_m: 5, capacity_t: 8 }])).toThrow();
    expect(() => parseChart([{ radius_m: 5, capacity_t: 10 }, { radius_m: 8, capacity_t: 12 }])).toThrow();
    expect(() => parseChart([{ radius_m: 0, capacity_t: 10 }])).toThrow();
  });

  it('the rated capacity: the row at the radius or the next larger, never interpolated up; null beyond', () => {
    expect(ratedAt(chart, 3)).toBe(50);
    expect(ratedAt(chart, 3.1)).toBe(20);
    expect(ratedAt(chart, 20)).toBe(8);
    expect(ratedAt(chart, 20.5)).toBeNull();
  });

  it('utilization and the critical lift', () => {
    expect(utilization(16, 20)).toBe(80);
    expect(utilization(1, 3)).toBe(33.3);
    expect(isCritical(74.9, false, false)).toBe(false);
    expect(isCritical(75, false, false)).toBe(true);
    expect(isCritical(10, true, false)).toBe(true);
    expect(isCritical(10, false, true)).toBe(true);
  });

  it('recording a lift: approval, wind and reasons', () => {
    const open = { status: 'planned', critical: false, approved_at: null };
    expect(liftRule(open, 'done', 5, null, 9.8)).toBeNull();
    expect(liftRule(open, 'done', null, null, 9.8)).toBe('wind_required');
    expect(liftRule(open, 'done', 10, null, 9.8)).toBe('wind_too_high');
    expect(liftRule(open, 'aborted', 12, null, 9.8)).toBe('abort_reason_required');
    expect(liftRule(open, 'aborted', 12, 'wind', 9.8)).toBeNull();
    expect(liftRule({ ...open, critical: true }, 'done', 5, null, 9.8)).toBe('lift_not_approved');
    expect(liftRule({ ...open, critical: true, approved_at: new Date() }, 'done', 5, null, 9.8)).toBeNull();
    expect(liftRule({ ...open, status: 'done' }, 'aborted', null, 'x', 9.8)).toBe('lift_closed');
    expect(parseWind('6.44', 'w')).toBe(6.4);
    expect(parseWind('', 'w')).toBeNull();
    expect(() => parseWind(70, 'w')).toThrow();
  });
});
