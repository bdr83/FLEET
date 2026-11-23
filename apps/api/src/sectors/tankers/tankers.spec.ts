import { amount, classOf, loss, orderState } from './tankers';

describe('tanker rules', () => {
  it('water and fuel never share a tanker', () => {
    expect(classOf('water_fresh')).toBe('water');
    expect(classOf('water_brackish')).toBe('water');
    expect(classOf('diesel')).toBe('fuel');
    expect(classOf('kerosene')).toBe('fuel');
  });

  it('loss between filling and discharging, by product', () => {
    expect(loss('diesel', 10000, 9960)).toEqual({ litres: 40, pct: 0.4, flagged: false });
    expect(loss('diesel', 10000, 9900)).toEqual({ litres: 100, pct: 1, flagged: true });
    expect(loss('water_fresh', 10000, 9800)).toEqual({ litres: 200, pct: 2, flagged: false });
    expect(loss('water_fresh', null, 9800)).toBeNull();
  });

  it('amount per 1000 litres', () => {
    expect(amount('3.500', 10000)).toBe('35.000');
    expect(amount('3.500', 2750)).toBe('9.625');
    expect(amount(null, 1000)).toBeNull();
  });

  it('order state from its trip', () => {
    const o = { canceled_at: null, delivered_at: null };
    expect(orderState(o, null)).toBe('new');
    expect(orderState(o, 'assigned')).toBe('assigned');
    expect(orderState(o, 'in_progress')).toBe('on_way');
    expect(orderState(o, 'failed')).toBe('failed');
    expect(orderState({ ...o, delivered_at: 'x' }, 'in_progress')).toBe('delivered');
    expect(orderState({ ...o, canceled_at: 'x' }, null)).toBe('canceled');
  });
});
