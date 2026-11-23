/**
 * School transport (school pack, sector 10). A route carries students between their homes and a school: a direction
 * (to school in the morning, home in the afternoon), a departure time, school days, ordered stops, a default bus,
 * driver and attendant, and its students with their guardian's phone. Each school day a trip is generated per route:
 * a core task booking the bus and driver, and a second task booking the attendant, for the trip window.
 *
 * Child safety rules: the driver or the attendant marks each student boarded, absent or dropped (the last mark counts);
 * a student is dropped only after boarding; a young child going home is handed to a named adult; and a trip cannot be
 * closed while any student is still on the bus or any expected student is unmarked. Guardians tell the office in
 * advance when a student will be absent, so the bus does not wait at their stop.
 */
export const SCHOOL = 'school@1';
export const isSchool = (pack: string | null | undefined) => pack === SCHOOL;

export const DIRECTIONS = ['to_school', 'from_school'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const MARK_EVENTS = ['boarded', 'absent', 'dropped'] as const;
export type MarkEvent = (typeof MARK_EVENTS)[number];
/** An absence notice covers the morning trip, the afternoon trip, or both. */
export const ABSENCE_SCOPES = ['both', 'to_school', 'from_school'] as const;
export const REPORTED_BY = ['guardian', 'school', 'office'] as const;
/** Reasons a driver can give for a trip that did not run. [تخمين] to refine with the first school. */
export const FAIL_REASONS = ['vehicle_breakdown', 'accident', 'road_closed', 'school_closed', 'other'] as const;

/** A trip not under way this many minutes after its departure time is late. [تخمين] */
export const LATE_START_MIN = 10;
/** A student absent without notice on this many trips in a row is flagged to the school. [تخمين] */
export const ABSENT_STREAK = 3;
/** Grades up to this one (KG1, KG2, then grade 1-3) are handed to an adult by default. [تخمين] to set per school. */
export const HANDOVER_GRADES = ['KG1', 'KG2', '1', '2', '3'];

export type StudentState = 'waiting' | 'on_board' | 'dropped' | 'absent' | 'excused';

/** Where a student stands on a trip, from the standing mark and any absence notice. */
export function studentState(event: MarkEvent | null | undefined, excused: boolean): StudentState {
  if (event === 'boarded') return 'on_board';
  if (event === 'dropped') return 'dropped';
  if (event === 'absent') return 'absent';
  return excused ? 'excused' : 'waiting';
}

/**
 * Whether a new mark is allowed, given where the student stands now. Returns a reject code or null.
 * Going home, a student marked for hand-over is dropped only with the name of the adult who took them.
 */
export function markRule(now: StudentState, event: MarkEvent, o: { direction: Direction; handover: boolean; receivedBy: string | null }): string | null {
  if (event === 'dropped') {
    if (now !== 'on_board') return 'not_on_board';
    if (o.direction === 'from_school' && o.handover && !o.receivedBy) return 'receiver_required';
  }
  if (event === 'absent' && now === 'on_board') return 'already_on_board';
  return null;
}

/** Whether the trip can be closed: nobody left on the bus, and every expected student marked. */
export function finishRule(states: StudentState[]): string | null {
  if (states.includes('on_board')) return 'students_on_board';
  if (states.includes('waiting')) return 'students_unmarked';
  return null;
}

/** Default hand-over for a grade. */
export const needsHandover = (grade: string | null | undefined) => !!grade && HANDOVER_GRADES.includes(grade.trim().toUpperCase());
