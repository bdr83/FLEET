import { dueBy, jobState, parseParts } from './service';

describe('technical maintenance rules', () => {
  it('response time by priority', () => {
    const t = new Date('2026-01-01T08:00:00Z');
    expect(dueBy(t, 'urgent').toISOString()).toBe('2026-01-01T12:00:00.000Z');
    expect(dueBy(t, 'normal').toISOString()).toBe('2026-01-02T08:00:00.000Z');
    expect(dueBy(t, 'low').toISOString()).toBe('2026-01-04T08:00:00.000Z');
  });

  it('parts used', () => {
    expect(parseParts(undefined)).toEqual([]);
    expect(parseParts([{ name: ' فريون R410 ', qty: '1.5' }])).toEqual([{ name: 'فريون R410', qty: 1.5 }]);
    expect(() => parseParts([{ name: '', qty: 1 }])).toThrow();
    expect(() => parseParts([{ name: 'x', qty: 0 }])).toThrow();
    expect(() => parseParts([{ name: 'x', qty: 1.234 }])).toThrow();
  });

  it('job state from its visits', () => {
    const j = { canceled_at: null, closed_at: null };
    expect(jobState(j, [])).toBe('new');
    expect(jobState(j, [{ status: 'assigned', result: null }])).toBe('scheduled');
    expect(jobState(j, [{ status: 'in_progress', result: null }])).toBe('on_site');
    expect(jobState(j, [{ status: 'completed', result: 'follow_up' }])).toBe('follow_up');
    expect(jobState(j, [{ status: 'completed', result: 'follow_up' }, { status: 'failed', result: null }])).toBe('follow_up');
    expect(jobState(j, [{ status: 'completed', result: 'fixed' }])).toBe('to_close');
    expect(jobState(j, [{ status: 'failed', result: null }])).toBe('new');
    expect(jobState({ ...j, closed_at: 'x' }, [])).toBe('closed');
  });
});
