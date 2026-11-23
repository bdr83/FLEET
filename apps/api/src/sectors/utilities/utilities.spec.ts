import { dueFrom, jobState, minutes, permitBlock, safetyCheck } from './utilities';

describe('utilities field work rules', () => {
  it('the due time by priority', () => {
    const r = new Date('2026-11-23T08:00:00Z');
    expect(dueFrom(r, 'emergency').toISOString()).toBe('2026-11-23T10:00:00.000Z');
    expect(dueFrom(r, 'urgent').toISOString()).toBe('2026-11-24T08:00:00.000Z');
  });

  it('the safety checklist: the permit on site only when digging; unanswered fails', () => {
    expect(safetyCheck({ isolation: true, ppe: true, barriers: true }, false)).toEqual({ items: ['isolation', 'ppe', 'barriers'], failed: [] });
    expect(safetyCheck({ isolation: true, ppe: true, barriers: true }, true).failed).toEqual(['permit_on_site']);
    expect(safetyCheck({ isolation: 'yes' }, false).failed).toEqual(['isolation', 'ppe', 'barriers']);
  });

  it('the permit: needed when digging, valid on the day', () => {
    expect(permitBlock(false, null, null, '2026-11-23')).toBeNull();
    expect(permitBlock(true, null, null, '2026-11-23')).toBe('permit_required');
    expect(permitBlock(true, 'D-1', '2026-11-22', '2026-11-23')).toBe('permit_expired');
    expect(permitBlock(true, 'D-1', '2026-11-23', '2026-11-23')).toBeNull();
  });

  it('the state of an order', () => {
    const j = { canceled_at: null, arrived_at: null, isolated_at: null, restored_at: null };
    expect(jobState(j, null)).toBe('open');
    expect(jobState(j, 'assigned')).toBe('assigned');
    expect(jobState(j, 'in_progress')).toBe('en_route');
    expect(jobState({ ...j, arrived_at: 1 }, 'in_progress')).toBe('on_site');
    expect(jobState({ ...j, arrived_at: 1, isolated_at: 1, restored_at: 1 }, 'in_progress')).toBe('restored');
    expect(jobState(j, 'completed')).toBe('done');
    expect(jobState({ ...j, canceled_at: 1 }, 'completed')).toBe('canceled');
    expect(minutes('2026-11-23T08:00:00Z', '2026-11-23T08:45:00Z')).toBe(45);
    expect(minutes(null, '2026-11-23T08:45:00Z')).toBeNull();
  });
});
