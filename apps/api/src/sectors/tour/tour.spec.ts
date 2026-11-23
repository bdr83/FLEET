import { parseItinerary, returnRule, seatsOf, tripState } from './tour';

describe('tour rules', () => {
  const from = new Date('2026-12-01T05:00:00Z'), to = new Date('2026-12-03T20:00:00Z');
  it('itinerary: places with optional times inside the trip', () => {
    expect(parseItinerary(undefined, from, to)).toEqual([]);
    expect(parseItinerary([{ place: ' الرياض ', at: '2026-12-01T12:00:00Z', note: 'غداء' }, { place: 'مكة' }], from, to))
      .toEqual([{ place: 'الرياض', at: '2026-12-01T12:00:00.000Z', note: 'غداء' }, { place: 'مكة', at: null }]);
    expect(() => parseItinerary([{ place: '' }], from, to)).toThrow();
    expect(() => parseItinerary([{ place: 'x', at: '2026-12-05T00:00:00Z' }], from, to)).toThrow();
    expect(() => parseItinerary('x', from, to)).toThrow();
  });

  it('seats from the bus record', () => {
    expect(seatsOf({ seats: 50 })).toBe(50);
    expect(seatsOf({})).toBeNull();
    expect(seatsOf(null)).toBeNull();
  });

  it('trip state from its buses', () => {
    const t = { canceled_at: null, pax: 60 };
    expect(tripState(t, [])).toBe('planned');
    expect(tripState(t, [{ status: 'assigned', seats: 50, returned_at: null }])).toBe('planned');
    expect(tripState(t, [{ status: 'assigned', seats: 50, returned_at: null }, { status: 'assigned', seats: 30, returned_at: null }])).toBe('ready');
    expect(tripState(t, [{ status: 'in_progress', seats: 50, returned_at: null }, { status: 'assigned', seats: 30, returned_at: null }])).toBe('under_way');
    expect(tripState(t, [{ status: 'completed', seats: 50, returned_at: 'x' }, { status: 'canceled', seats: 30, returned_at: null }])).toBe('back');
    expect(tripState({ canceled_at: 'x', pax: 1 }, [])).toBe('canceled');
  });

  it('fewer back than boarded needs a note', () => {
    expect(returnRule(48, 46, null)).toBe('note_required');
    expect(returnRule(48, 46, 'بقيا في الرياض')).toBeNull();
    expect(returnRule(48, 48, null)).toBeNull();
    expect(returnRule(null, 10, null)).toBeNull();
  });
});
