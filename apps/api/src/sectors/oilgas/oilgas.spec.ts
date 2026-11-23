import { inspect, journeyState, missingDocs, nextCheckinDue, parseDocTypes } from './oilgas';

describe('oil and gas rules', () => {
  it('documents missing or expiring before the journey ends', () => {
    const docs = [{ doc_type: 'h2s', expires_on: '2026-12-31' }, { doc_type: 'site_pass', expires_on: '2026-11-30' }, { doc_type: 'medical', expires_on: null }];
    expect(missingDocs(docs, ['h2s', 'site_pass', 'medical'], '2026-11-30')).toEqual([]);
    expect(missingDocs(docs, ['h2s', 'site_pass', 'hazmat'], '2026-12-01')).toEqual(['site_pass', 'hazmat']);
  });

  it('the checklist: the H2S monitor only in an H2S zone, unanswered items fail', () => {
    const all = { tyres: true, brakes: true, lights: true, seat_belts: true, fire_extinguisher: true, first_aid: true, spill_kit: true };
    expect(inspect(all, false)).toEqual({ items: Object.keys(all), failed: [] });
    expect(inspect(all, true).failed).toEqual(['h2s_monitor']);
    expect(inspect({ ...all, brakes: 'yes' }, false).failed).toEqual(['brakes']);
  });

  it('doc type lists', () => {
    expect(parseDocTypes(['h2s', 'site_pass', 'h2s'], 'x')).toEqual(['h2s', 'site_pass']);
    expect(parseDocTypes(undefined, 'x')).toBeNull();
    expect(() => parseDocTypes(['H2S'], 'x')).toThrow();
  });

  it('journey states and the next call-in', () => {
    const j = { canceled_at: null, approved_at: null, departed_at: null, arrived_at: null };
    expect(journeyState(j, null)).toBe('draft');
    expect(journeyState({ ...j, approved_at: 'x' }, null)).toBe('approved');
    expect(journeyState(j, 'assigned')).toBe('assigned');
    expect(journeyState({ ...j, approved_at: 'x' }, 'accepted')).toBe('ready');
    expect(journeyState({ ...j, approved_at: 'x', departed_at: 'x' }, 'in_progress')).toBe('en_route');
    expect(journeyState({ ...j, approved_at: 'x', departed_at: 'x', arrived_at: 'x' }, 'in_progress')).toBe('arrived');
    expect(journeyState(j, 'completed')).toBe('done');
    expect(journeyState({ ...j, canceled_at: 'x' }, 'assigned')).toBe('canceled');
    const dep = new Date('2026-11-23T08:00:00Z');
    expect(nextCheckinDue(dep, null, 30).toISOString()).toBe('2026-11-23T08:30:00.000Z');
    expect(nextCheckinDue(dep, new Date('2026-11-23T08:20:00Z'), 30).toISOString()).toBe('2026-11-23T08:50:00.000Z');
  });
});
