/**
 * Utilities field work (utilities pack, sector 24). Contractors for electricity, water and telecom networks get work
 * orders (UJ-n): the type of work, the network, a priority that sets the time to arrive, the location and the network
 * asset, and the customers affected. Digging needs a valid excavation permit before isolating and working, and the road
 * reinstated before the order closes. A crew (vehicle and lead) is booked to the order and records: arrived, isolated
 * (with the safety checklist), restored (with the result), and reinstated. Response time runs from the report to the
 * arrival, outage time from the report to the restoration.
 */
export const UTILITIES = 'utilities@1';
export const isUtilities = (pack: string | null | undefined) => pack === UTILITIES;

export const NETWORKS = ['electricity', 'water', 'telecom'] as const;
export const JOB_TYPES = ['outage', 'repair', 'connection', 'meter', 'inspection', 'excavation'] as const;
export const PRIORITIES = ['emergency', 'urgent', 'planned'] as const;
export type Priority = (typeof PRIORITIES)[number];
/** Minutes from the report to the crew on site, by priority. [تخمين] to align with each client's contract. */
export const RESPONSE_MIN: Record<Priority, number> = { emergency: 120, urgent: 1440, planned: 7 * 1440 };

export const STAGES = ['ut_arrived', 'ut_isolated', 'ut_restored', 'ut_reinstated'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { ut_arrived: ['in_progress'], ut_isolated: ['in_progress'], ut_restored: ['in_progress'], ut_reinstated: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { ut_isolated: 'ut_arrived', ut_restored: 'ut_isolated', ut_reinstated: 'ut_restored' };
export const FAIL_REASONS = ['vehicle_breakdown', 'no_access', 'permit_refused', 'materials_missing', 'site_unsafe', 'other'] as const;

/** The safety checklist before work: isolation and lock-out, PPE, barriers and signs; the permit on site when digging. [تخمين] */
export const CHECKS = ['isolation', 'ppe', 'barriers', 'permit_on_site'] as const;
/** An excavation not reinstated this many days after the repair is flagged. [تخمين] */
export const REINSTATE_DAYS = 3;
/** A permit expiring within this many days on an open order is flagged. [تخمين] */
export const PERMIT_WARN_DAYS = 2;

/** The checklist items that apply and the failed ones (an unanswered item fails). */
export function safetyCheck(checks: Record<string, unknown>, needsPermit: boolean): { items: string[]; failed: string[] } {
  const items = CHECKS.filter((c) => c !== 'permit_on_site' || needsPermit);
  return { items, failed: items.filter((c) => checks[c] !== true) };
}

/** Whether work may start under the permit on a day (YYYY-MM-DD). Returns a reject code or null. */
export function permitBlock(needsPermit: boolean, permitNo: string | null, expires: string | null, day: string): string | null {
  if (!needsPermit) return null;
  if (!permitNo || !expires) return 'permit_required';
  return expires < day ? 'permit_expired' : null;
}

/** The due time to be on site, from the report and the priority. */
export const dueFrom = (reportedAt: Date, priority: Priority) => new Date(reportedAt.getTime() + RESPONSE_MIN[priority] * 60_000);

export type JobState = 'open' | 'assigned' | 'en_route' | 'on_site' | 'isolated' | 'restored' | 'done' | 'failed' | 'canceled';

/** Where an order stands, from its stage times and its task. */
export function jobState(j: { canceled_at: unknown; arrived_at: unknown; isolated_at: unknown; restored_at: unknown }, taskStatus: string | null): JobState {
  if (j.canceled_at) return 'canceled';
  if (taskStatus === 'failed') return 'failed';
  if (taskStatus && ['completed', 'reviewed', 'invoiced'].includes(taskStatus)) return 'done';
  if (j.restored_at) return 'restored';
  if (j.isolated_at) return 'isolated';
  if (j.arrived_at) return 'on_site';
  if (taskStatus === 'in_progress') return 'en_route';
  if (taskStatus && taskStatus !== 'canceled') return 'assigned';
  return 'open';
}

/** Minutes between two times, rounded; null when either is missing. */
export const minutes = (from: Date | string | null, to: Date | string | null) =>
  from && to ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000) : null;
