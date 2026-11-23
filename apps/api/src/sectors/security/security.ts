import { BadRequestException } from '@nestjs/common';

/**
 * Security guarding and patrols pack (security, sector 25). A site belongs to a customer and has ordered checkpoints,
 * each with a tag fixed on the spot that the guard types or scans as proof of passing; patrol times in the day, the days
 * it runs, a default guard and an optional patrol car. Each time on a running day a patrol is generated: a core task
 * booking the guard (and car) for the patrol. The guard marks each checkpoint scanned (with the right tag) or skipped
 * (with a reason), and reports incidents with a category and severity. A patrol cannot end with a checkpoint unmarked.
 * An incident stays open until the office closes it with a note.
 */
export const SECURITY = 'security@1';
export const isSecurity = (pack: string | null | undefined) => pack === SECURITY;

export const SCAN_EVENTS = ['scanned', 'skipped'] as const;
export type ScanEvent = (typeof SCAN_EVENTS)[number];
export const SKIP_REASONS = ['no_access', 'locked', 'unsafe', 'other'] as const;
export const CATEGORIES = ['intrusion', 'theft', 'fire', 'damage', 'suspicious', 'medical', 'safety', 'other'] as const;
export const SEVERITIES = ['low', 'medium', 'high'] as const;
/** Reasons a guard can give for a patrol that did not happen. [تخمين] */
export const FAIL_REASONS = ['site_closed', 'guard_unwell', 'vehicle_breakdown', 'emergency_elsewhere', 'other'] as const;

/** A patrol not under way this many minutes after its time is late. [تخمين] */
export const LATE_START_MIN = 15;
/** A checkpoint skipped on this many patrols in a row is flagged. [تخمين] */
export const SKIP_STREAK = 3;

/** A checkpoint tag: 3-24 letters, digits or dashes, compared without case or spaces. */
export const normTag = (x: unknown) => String(x ?? '').trim().toUpperCase().replace(/\s+/g, '');
export function parseTag(x: unknown): string {
  const t = normTag(x);
  if (!/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(t)) throw new BadRequestException('tag: 3-24 letters, digits or -');
  return t;
}

/** Patrol times of a day: up to 24 distinct HH:MM, sorted. */
export function parseTimes(x: unknown): string[] {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x) || x.length > 24) throw new BadRequestException('patrol_times must be up to 24 HH:MM');
  const out = [...new Set(x.map((t) => String(t)))];
  for (const t of out) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new BadRequestException(`patrol_times: ${t} is not HH:MM`);
  return out.sort();
}

/** Whether a checkpoint mark may be recorded. Returns a reject code or null. */
export function scanRule(event: ScanEvent, tag: string | null, expected: string, reason: string | null, source: 'guard' | 'office'): string | null {
  if (event === 'skipped') return reason ? null : 'skip_reason_required';
  if (source === 'office') return null; // the office records from the guard's call or the tag reader's log
  if (!tag) return 'tag_required';
  return normTag(tag) === expected ? null : 'tag_mismatch';
}

/** Why a patrol cannot end yet: a checkpoint unmarked. */
export function finishBlock(checkpoints: string[], marked: string[]): string | null {
  const m = new Set(marked);
  return checkpoints.some((c) => !m.has(c)) ? 'checkpoints_open' : null;
}

/** Share of planned checkpoints scanned, in percent (null with none planned). */
export const coverage = (scanned: number, planned: number) => (planned > 0 ? Math.round((scanned / planned) * 100) : null);
