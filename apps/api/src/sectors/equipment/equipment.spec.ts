import { billableDay, billableHours, hoursBetween, meter } from './equipment';

describe('equipment hire rules', () => {
  it('hour meter readings', () => {
    expect(meter('1250.5', 'm')).toBe(1250.5);
    expect(meter(0, 'm')).toBe(0);
    expect(meter(undefined, 'm')).toBeNull();
    expect(() => meter('12.55', 'm')).toThrow();
    expect(() => meter(-1, 'm')).toThrow();
    expect(() => meter(undefined, 'm', { required: true })).toThrow(/required/);
  });

  it('billable hours: the minimum, less our downtime', () => {
    expect(billableHours(9.5, 0, 8)).toBe(9.5);
    expect(billableHours(5, 0, 8)).toBe(8);
    expect(billableHours(4, 3, 8)).toBe(5);
    expect(billableHours(0, 10, 8)).toBe(0);
    expect(billableDay(2, 10)).toBe(1);
    expect(billableDay(10, 10)).toBe(0);
    expect(hoursBetween('07:00', '17:30')).toBe(10.5);
  });
});
