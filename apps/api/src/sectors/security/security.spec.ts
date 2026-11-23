import { coverage, finishBlock, normTag, parseTag, parseTimes, scanRule } from './security';

describe('security pack rules', () => {
  it('checkpoint tags: case and spaces do not matter; 3-24 letters, digits or dashes', () => {
    expect(parseTag(' cp-01 ')).toBe('CP-01');
    expect(normTag('cp 01')).toBe('CP01');
    expect(() => parseTag('x')).toThrow();
    expect(() => parseTag('CP_01')).toThrow();
  });
  it('patrol times: distinct HH:MM, sorted', () => {
    expect(parseTimes(['22:00', '02:00', '22:00'])).toEqual(['02:00', '22:00']);
    expect(parseTimes(undefined)).toEqual([]);
    expect(() => parseTimes(['24:00'])).toThrow();
  });
  it('a scan needs the right tag from the guard; a skip needs a reason; the office records without a tag', () => {
    expect(scanRule('scanned', null, 'CP-01', null, 'guard')).toBe('tag_required');
    expect(scanRule('scanned', 'cp-02', 'CP-01', null, 'guard')).toBe('tag_mismatch');
    expect(scanRule('scanned', 'cp-01', 'CP-01', null, 'guard')).toBeNull();
    expect(scanRule('skipped', null, 'CP-01', null, 'guard')).toBe('skip_reason_required');
    expect(scanRule('skipped', null, 'CP-01', 'locked', 'guard')).toBeNull();
    expect(scanRule('scanned', null, 'CP-01', null, 'office')).toBeNull();
  });
  it('a patrol ends with every checkpoint marked; coverage in percent', () => {
    expect(finishBlock(['a', 'b'], ['a'])).toBe('checkpoints_open');
    expect(finishBlock(['a', 'b'], ['b', 'a'])).toBeNull();
    expect(coverage(2, 3)).toBe(67);
    expect(coverage(0, 0)).toBeNull();
  });
});
