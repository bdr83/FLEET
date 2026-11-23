import { finishRule, markRule, needsHandover, studentState } from './school';

describe('school transport rules', () => {
  it('where a student stands', () => {
    expect(studentState(null, false)).toBe('waiting');
    expect(studentState(undefined, true)).toBe('excused');
    expect(studentState('boarded', true)).toBe('on_board');
    expect(studentState('dropped', false)).toBe('dropped');
    expect(studentState('absent', false)).toBe('absent');
  });

  it('marks: dropped only after boarding; a young child going home is handed to a named adult', () => {
    const home = { direction: 'from_school' as const, handover: true, receivedBy: null };
    expect(markRule('waiting', 'dropped', home)).toBe('not_on_board');
    expect(markRule('on_board', 'dropped', home)).toBe('receiver_required');
    expect(markRule('on_board', 'dropped', { ...home, receivedBy: 'أم أحمد' })).toBeNull();
    expect(markRule('on_board', 'dropped', { ...home, direction: 'to_school' })).toBeNull(); // dropped at school
    expect(markRule('on_board', 'absent', home)).toBe('already_on_board');
    expect(markRule('absent', 'boarded', home)).toBeNull(); // came late: the last mark counts
    expect(markRule('excused', 'boarded', home)).toBeNull();
  });

  it('a trip closes with nobody on the bus and everyone expected marked', () => {
    expect(finishRule(['dropped', 'absent', 'excused'])).toBeNull();
    expect(finishRule(['dropped', 'on_board'])).toBe('students_on_board');
    expect(finishRule(['dropped', 'waiting'])).toBe('students_unmarked');
    expect(finishRule([])).toBeNull();
  });

  it('hand-over by grade', () => {
    expect(needsHandover('kg2')).toBe(true);
    expect(needsHandover('3')).toBe(true);
    expect(needsHandover('7')).toBe(false);
    expect(needsHandover(null)).toBe(false);
  });
});
