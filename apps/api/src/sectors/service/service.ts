import { BadRequestException } from '@nestjs/common';

/**
 * Technical maintenance (service pack, sector 22). Technicians visit customers' sites to repair, install or service
 * equipment (air conditioning, electrical, plumbing, appliances, lifts, generators). A job has a priority and a response
 * time; each visit is a core task booking the technician for its window. The technician records the arrival, then the
 * result (fixed, needs another visit, not fixed) with the work done, the parts used and the customer's name. Preventive
 * maintenance plans create jobs every period. Prices come from the office when the job is closed, or the contract.
 */
export const SERVICE = 'service@1';
export const isService = (pack: string | null | undefined) => pack === SERVICE;

export const STAGES = ['arrived', 'work_done'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { arrived: ['in_progress'], work_done: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { work_done: 'arrived' };
export const FAIL_REASONS = ['customer_absent', 'no_access', 'customer_canceled', 'other'] as const;

export const CATEGORIES = ['ac', 'electrical', 'plumbing', 'appliance', 'elevator', 'generator', 'other'] as const;
export const KINDS = ['repair', 'install', 'preventive'] as const;
export const PRIORITIES = ['urgent', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const RESULTS = ['fixed', 'follow_up', 'not_fixed'] as const;
export type Result = (typeof RESULTS)[number];

/** Hours to reach the customer by priority. [تخمين] to set per company or contract. */
export const RESPONSE_HOURS: Record<Priority, number> = { urgent: 4, normal: 24, low: 72 };
/** A visit books the technician this long unless the office says otherwise. [تخمين] */
export const VISIT_MIN = 120;
/** Preventive jobs are created this many days before they fall due. [تخمين] */
export const PLAN_HORIZON_DAYS = 7;
/** The same fault at the same customer within this many days of a fix counts as a repeat. [تخمين] */
export const REPEAT_DAYS = 30;

export const dueBy = (from: Date, p: Priority) => new Date(from.getTime() + RESPONSE_HOURS[p] * 3_600_000);

export type Part = { name: string; qty: number };

/** Parts used on a visit: up to 30 lines of a name and a quantity. Throws with the reason. */
export function parseParts(val: unknown, field = 'parts'): Part[] {
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val) || val.length > 30) throw new BadRequestException(`${field} must be a list of up to 30 parts`);
  return val.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const qty = typeof o.qty === 'number' ? o.qty : Number(o.qty);
    if (!name || name.length > 120) throw new BadRequestException(`${field}[${i}].name required, up to 120`);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 10000 || Math.round(qty * 100) !== qty * 100) throw new BadRequestException(`${field}[${i}].qty must be more than 0, two decimals`);
    return { name, qty };
  });
}

/** Where a job stands, from its visits: who has to act next. */
export function jobState(j: { canceled_at: unknown; closed_at: unknown }, visits: { status: string; result: Result | null }[]): string {
  if (j.canceled_at) return 'canceled';
  if (j.closed_at) return 'closed';
  const live = visits.filter((v) => !['canceled', 'failed'].includes(v.status));
  const open = live.find((v) => !v.result);
  if (open) return ['in_progress'].includes(open.status) ? 'on_site' : 'scheduled';
  const last = live.at(-1);
  if (!last) return 'new';
  return last.result === 'follow_up' ? 'follow_up' : 'to_close';
}
