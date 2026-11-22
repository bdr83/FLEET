import { addMinutes, isoDow, latestMarks, onTime, parseDays, parseStops, WORK_WEEK } from './shuttle';

describe('staff transport rules', () => {
  it('stops: rising minutes within the trip', () => {
    expect(parseStops([{ name: 'سكن المهبولة' }, { name: 'المنقف', offset_min: 15, area: 'المنقف' }, { name: 'المصفاة', offset_min: 45 }], 60))
      .toEqual([{ name: 'سكن المهبولة', offset_min: 0 }, { name: 'المنقف', offset_min: 15, area: 'المنقف' }, { name: 'المصفاة', offset_min: 45 }]);
    expect(() => parseStops([{ name: 'a' }, { name: 'b' }], 60)).toThrow(/offset_min/);
    expect(() => parseStops([{ name: 'a', offset_min: 20 }, { name: 'b', offset_min: 10 }], 60)).toThrow(/before the previous/);
    expect(() => parseStops([{ name: 'a', offset_min: 90 }], 60)).toThrow(/within the trip/);
    expect(() => parseStops([], 60)).toThrow();
  });

  it('days and weekdays', () => {
    expect(parseDays(undefined)).toEqual(WORK_WEEK);
    expect(parseDays([5, 1, 1])).toEqual([1, 5]);
    expect(() => parseDays([0])).toThrow();
    expect(isoDow('2026-11-22')).toBe(7); // a Sunday
    expect(isoDow('2026-11-27')).toBe(5); // a Friday
    expect(addMinutes('05:30', 45)).toBe('06:15');
    expect(addMinutes('23:50', 20)).toBe('00:10');
  });

  it('the last mark counts; departure on time within the grace', () => {
    const m = latestMarks([
      { rider_id: 'a', event: 'no_show', occurred_at: '2026-11-22T03:00:00Z' },
      { rider_id: 'a', event: 'boarded', occurred_at: '2026-11-22T03:05:00Z' },
      { rider_id: 'b', event: 'no_show', occurred_at: '2026-11-22T03:01:00Z' },
    ]);
    expect(m.get('a')!.event).toBe('boarded');
    expect(m.get('b')!.event).toBe('no_show');
    const dep = new Date('2026-11-22T03:00:00Z');
    expect(onTime(dep, new Date('2026-11-22T03:09:00Z'))).toBe(true);
    expect(onTime(dep, new Date('2026-11-22T03:11:00Z'))).toBe(false);
    expect(onTime(dep, null)).toBeNull();
  });
});
