import { eligibility, firstName, hhmm, normalizeSite, roundHours, shiftMinutes, siteLine, workDates } from './staffing';

describe('staffing helpers', () => {
  it('rounds worked time to the step', () => {
    expect(roundHours(490, 15)).toBe(8.25); // 8h10 → 8h15
    expect(roundHours(487, 15)).toBe(8);    // 8h07 → 8h00
    expect(roundHours(480, 60)).toBe(8);
    expect(roundHours(45, 1)).toBe(0.75);
    expect(roundHours(0, 15)).toBe(0);
    expect(roundHours(-5, 15)).toBe(0);
  });
  it('checks documents for the placement period', () => {
    const req = ['driving_license', 'residency'];
    expect(eligibility([{ doc_type: 'driving_license', expires_on: '2027-06-01' }, { doc_type: 'residency', expires_on: null }], req, '2026-12-01', '2026-12-31'))
      .toEqual({ status: 'ok', issues: [] });
    const warn = eligibility([{ doc_type: 'driving_license', expires_on: '2026-12-15' }, { doc_type: 'residency', expires_on: '2027-01-01' }], req, '2026-12-01', '2026-12-31');
    expect(warn.status).toBe('warn');
    expect(warn.issues).toEqual([{ doc_type: 'driving_license', problem: 'expires_during', expires_on: '2026-12-15' }]);
    const blocked = eligibility([{ doc_type: 'driving_license', expires_on: '2026-11-30' }], req, '2026-12-01', '2026-12-31');
    expect(blocked.status).toBe('blocked');
    expect(blocked.issues.map((i) => i.problem)).toEqual(['expired', 'missing']);
    // the longest-lasting copy counts (a renewed licence next to the old one)
    expect(eligibility([{ doc_type: 'driving_license', expires_on: '2026-01-01' }, { doc_type: 'driving_license', expires_on: '2028-01-01' }], ['driving_license'], '2026-12-01', '2026-12-31').status).toBe('ok');
  });
  it('validates shift times and computes length across midnight', () => {
    expect(hhmm('08:00', 'x')).toBe('08:00');
    expect(() => hhmm('8:00', 'x')).toThrow();
    expect(() => hhmm('24:00', 'x')).toThrow();
    expect(shiftMinutes('08:00', '17:00')).toBe(540);
    expect(shiftMinutes('22:00', '06:00')).toBe(480);
  });
  it('lists working dates on the given weekdays', () => {
    // 2026-11-22 is a Sunday
    expect(workDates('2026-11-22', '2026-11-28', [0, 1, 2, 3, 4])).toEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
    expect(workDates('2026-11-22', '2026-11-28', [5, 6])).toEqual(['2026-11-27', '2026-11-28']);
  });
  it('normalizes the site and shows the customer a first name only', () => {
    expect(normalizeSite({ name: 'مستودع الري', area: 'الري', block: '1', contact_phone: '50000001', lat: 29.3, lng: 47.9 })).toMatchObject({ name: 'مستودع الري', contact_phone: '+96550000001', lat: 29.3 });
    expect(() => normalizeSite({ lat: 29.3 })).toThrow();
    expect(siteLine({ name: 'مستودع الري', area: 'الري', block: '1' })).toBe('مستودع الري، الري، ق 1');
    expect(firstName('  فهد  عبدالله المطيري ')).toBe('فهد');
    expect(firstName(null)).toBeNull();
  });
});
