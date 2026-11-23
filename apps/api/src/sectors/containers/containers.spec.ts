import { ctrState, daysLate, nextLeg, normContainer } from './containers';

describe('containers rules', () => {
  it('ISO 6346 container numbers with the check digit', () => {
    expect(normContainer('CSQU3054383')).toBe('CSQU3054383'); // the standard's own example
    expect(normContainer('csqu 305438-3')).toBe('CSQU3054383');
    expect(normContainer('CSQU3054384')).toBeNull();
    expect(normContainer('CSQ3054383')).toBeNull();
    expect(normContainer('CSQX3054383')).toBeNull();
    expect(normContainer(42)).toBeNull();
  });

  it('days late after a free date, in Kuwait days', () => {
    expect(daysLate(null, null)).toBe(0);
    expect(daysLate('2026-03-10', '2026-03-10T20:00:00Z')).toBe(0); // 23:00 in Kuwait, still the free day
    expect(daysLate('2026-03-10', '2026-03-10T21:30:00Z')).toBe(1); // 00:30 on the 11th
    expect(daysLate('2026-03-10', '2026-03-08T10:00:00Z')).toBe(0);
    expect(daysLate('2026-03-10', null, new Date('2026-03-14T08:00:00Z'))).toBe(4);
  });

  it('the legs of each direction, in order', () => {
    expect(nextLeg('import', [])).toBe('port_to_customer');
    expect(nextLeg('import', [{ kind: 'port_to_customer' }])).toBe('empty_to_depot');
    expect(nextLeg('import', [{ kind: 'port_to_customer' }, { kind: 'empty_to_depot' }])).toBeNull();
    expect(nextLeg('export', [])).toBe('empty_to_customer');
    expect(nextLeg('local', [{ kind: 'transfer' }])).toBeNull();
  });

  it('where the container stands', () => {
    const j = { canceled_at: null, closed_at: null, at_customer_at: null, done_at: null };
    expect(ctrState(j, [])).toBe('waiting');
    expect(ctrState(j, [{ status: 'in_progress' }])).toBe('in_transit');
    expect(ctrState({ ...j, at_customer_at: 'x' }, [{ status: 'completed' }])).toBe('at_customer');
    expect(ctrState({ ...j, at_customer_at: 'x' }, [{ status: 'completed' }, { status: 'in_progress' }])).toBe('in_transit');
    expect(ctrState({ ...j, done_at: 'x' }, [])).toBe('done');
    expect(ctrState({ ...j, closed_at: 'x' }, [])).toBe('closed');
  });
});
