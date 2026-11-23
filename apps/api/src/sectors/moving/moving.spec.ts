import { moveState, parseItems, PLAN_BY_SIZE } from './moving';

describe('furniture moving rules', () => {
  it('item list from the survey', () => {
    expect(parseItems([{ room: ' الصالة ', name: ' كنبة ', qty: '2' }, { name: 'تلفزيون', fragile: true }])).toEqual([
      { room: 'الصالة', name: 'كنبة', qty: 2, fragile: false }, { room: null, name: 'تلفزيون', qty: 1, fragile: true }]);
    expect(() => parseItems('x')).toThrow();
    expect(() => parseItems([{ name: '' }])).toThrow();
    expect(() => parseItems([{ name: 'x', qty: 1.5 }])).toThrow();
    expect(() => parseItems([{ name: 'x', qty: 0 }])).toThrow();
  });

  it('hours and crew grow with the home', () => {
    expect(PLAN_BY_SIZE.villa.hours).toBeGreaterThan(PLAN_BY_SIZE.apt_2.hours);
    expect(PLAN_BY_SIZE.room.crew).toBeLessThanOrEqual(PLAN_BY_SIZE.studio.crew);
  });

  it('where a move stands', () => {
    const j = { canceled_at: null, closed_at: null, quoted_at: null, accepted_at: null, unloaded_at: null };
    expect(moveState(j, null)).toBe('new');
    expect(moveState({ ...j, quoted_at: 'x' }, null)).toBe('quoted');
    expect(moveState({ ...j, quoted_at: 'x', accepted_at: 'x' }, null)).toBe('accepted');
    expect(moveState({ ...j, quoted_at: 'x', accepted_at: 'x' }, { status: 'assigned' })).toBe('booked');
    expect(moveState({ ...j, quoted_at: 'x', accepted_at: 'x' }, { status: 'failed' })).toBe('accepted');
    expect(moveState({ ...j, quoted_at: 'x', accepted_at: 'x' }, { status: 'in_progress' })).toBe('moving');
    expect(moveState({ ...j, unloaded_at: 'x' }, { status: 'in_progress' })).toBe('delivered');
    expect(moveState({ ...j, closed_at: 'x' }, null)).toBe('closed');
    expect(moveState({ ...j, canceled_at: 'x' }, null)).toBe('canceled');
  });
});
