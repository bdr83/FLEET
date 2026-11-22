import { needsApproval, outsideHours, tripCost } from './internal';

describe('internal fleet helpers', () => {
  it('decides when a manager has to approve', () => {
    const on = { require_approval: true, auto_approve_max_hours: null };
    expect(needsApproval(on, 3, false)).toBe(true);
    expect(needsApproval(on, 3, true)).toBe(false);                       // the manager's own request
    expect(needsApproval({ ...on, require_approval: false }, 30, false)).toBe(false);
    expect(needsApproval({ ...on, auto_approve_max_hours: 4 }, 4, false)).toBe(false); // short trip
    expect(needsApproval({ ...on, auto_approve_max_hours: 4 }, 4.5, false)).toBe(true);
  });
  it('flags trips outside working hours in the company time zone', () => {
    const tz = 'Asia/Kuwait'; // UTC+3
    const at = (h: string) => new Date(`2026-12-01T${h}:00+03:00`);
    expect(outsideHours(at('09:00'), at('12:00'), tz, '07:00', '17:00')).toBe(false);
    expect(outsideHours(at('07:00'), at('17:00'), tz, '07:00', '17:00')).toBe(false); // ends exactly at closing
    expect(outsideHours(at('06:30'), at('09:00'), tz, '07:00', '17:00')).toBe(true);
    expect(outsideHours(at('16:00'), at('18:00'), tz, '07:00', '17:00')).toBe(true);
    expect(outsideHours(at('09:00'), new Date('2026-12-02T10:00:00+03:00'), tz, '07:00', '17:00')).toBe(true); // overnight
  });
  it('charges distance and driver time in fils', () => {
    expect(tripCost(120, 0, '0.150', '2.000')).toBe('18.000');
    expect(tripCost(120, 2, '0.150', '2.000')).toBe('22.000');
    expect(tripCost(0, 0, '0.100', '0')).toBe('0.000');
    expect(tripCost(33, 1.5, '0.115', '1.250')).toBe('5.670'); // 3.795 + 1.875
  });
});
