/**
 * Containers and ports (containers pack, sector 6). A container moved between the port or the empty depot and the
 * customer's site. Import: port → customer, then the empty back to the depot. Export: an empty from the depot → customer,
 * then the full box to the port. Each leg is a core task booking the truck and its driver. The driver confirms the
 * container number at pickup, then the receiver or the gate receipt (EIR) at drop. The port's last free day (storage)
 * and the empty return date (detention) are watched; the office enters the amounts at closing.
 */
export const CONTAINERS = 'containers@1';
export const isContainers = (pack: string | null | undefined) => pack === CONTAINERS;

export const STAGES = ['ctr_picked', 'ctr_dropped'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { ctr_picked: ['in_progress'], ctr_dropped: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { ctr_dropped: 'ctr_picked' };
export const FAIL_REASONS = ['not_released', 'port_closed', 'customer_absent', 'truck_breakdown', 'wrong_container', 'other'] as const;

export const DIRECTIONS = ['import', 'export', 'local'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const SIZES = ['20', '40', '45'] as const;
export const TYPES = ['dry', 'high_cube', 'reefer', 'open_top', 'flat_rack', 'tank'] as const;
export const PORTS = ['shuwaikh', 'shuaiba', 'doha', 'other'] as const;
export const LEG_KINDS = ['port_to_customer', 'empty_to_depot', 'empty_to_customer', 'full_to_port', 'transfer'] as const;
export type LegKind = (typeof LEG_KINDS)[number];

/** The legs of each direction, in order. */
export const LEGS: Record<Direction, LegKind[]> = { import: ['port_to_customer', 'empty_to_depot'], export: ['empty_to_customer', 'full_to_port'], local: ['transfer'] };
/** A leg that ends at the customer (the box waits there), against one that ends the job (at the depot or the port). */
export const ENDS_AT_CUSTOMER: LegKind[] = ['port_to_customer', 'empty_to_customer'];
/** Legs that end at a port or depot gate need the gate receipt number; legs ending at a customer need the receiver. */
export const NEEDS_GATE_REF: LegKind[] = ['empty_to_depot', 'full_to_port'];

/** A leg books the truck this long unless the office says otherwise. [تخمين] */
export const LEG_MIN = 180;
/** Days before the last free day or the return date when the job is flagged. [تخمين] */
export const WARN_DAYS = 1;

const LETTERS: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  let n = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (n % 11 === 0) n++;
    m[ch] = n++;
  }
  return m;
})();

/** ISO 6346: 3 letters owner code, U/J/Z/R, 6 digits serial, 1 check digit. Spaces and dashes are dropped. */
export function normContainer(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{3}[UJZR][0-9]{7}$/.test(s)) return null;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (i < 4 ? LETTERS[s[i]] : Number(s[i])) * 2 ** i;
  return (sum % 11) % 10 === Number(s[10]) ? s : null;
}

/** Whole days late after a free date, up to an end time (or now), counted in Kuwait days. 0 when not late. */
export function daysLate(freeUntil: string | null, end: Date | string | null, now = new Date()): number {
  if (!freeUntil) return 0;
  const t = end ? new Date(end) : now;
  const day = new Date(t.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  return Math.max(0, Math.round((Date.parse(day) - Date.parse(freeUntil)) / 86_400_000));
}

/**
 * Where the container stands: waiting (at the port or depot), in_transit (a leg under way), at_customer, done (back at the
 * depot or gated in at the port: to close), closed, canceled.
 */
export function ctrState(j: { canceled_at: unknown; closed_at: unknown; at_customer_at: unknown; done_at: unknown }, legs: { status: string }[]): string {
  if (j.canceled_at) return 'canceled';
  if (j.closed_at) return 'closed';
  if (j.done_at) return 'done';
  if (legs.some((l) => l.status === 'in_progress')) return 'in_transit';
  if (j.at_customer_at) return 'at_customer';
  return 'waiting';
}

/** The next leg to book for a job, given the legs not canceled or failed; null when all are booked. */
export function nextLeg(direction: Direction, live: { kind: string }[]): LegKind | null {
  return LEGS[direction].find((k) => !live.some((l) => l.kind === k)) ?? null;
}
