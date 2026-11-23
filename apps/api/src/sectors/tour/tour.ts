import { BadRequestException } from '@nestjs/common';

/**
 * Tourist and charter buses (tour pack, sector 13). Travel agencies, schools, companies and groups hire buses with drivers
 * for a trip: a day out, an event, or several days across the border (Umrah, a tour of the Gulf). A trip has a group of
 * passengers, a start and an end, an itinerary and a price from the office. One or more buses are added to it; each is a
 * core task booking the bus and its driver for the whole trip. The driver counts heads and reads the odometer when the
 * group boards, and again on the way back: fewer heads back needs a note. Cross-border trips need the passenger list.
 */
export const TOUR = 'tour@1';
export const isTour = (pack: string | null | undefined) => pack === TOUR;

export const STAGES = ['tr_boarded', 'tr_returned'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { tr_boarded: ['in_progress'], tr_returned: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { tr_returned: 'tr_boarded' };
export const FAIL_REASONS = ['bus_breakdown', 'accident', 'border_refused', 'group_canceled', 'other'] as const;

/** A trip whose buses or passenger list are short this many days before it starts is flagged. [تخمين] */
export const WARN_DAYS = 3;
/** A bus not under way this many minutes after the trip's start is late. [تخمين] */
export const LATE_START_MIN = 15;

export interface Stop { at: string | null; place: string; note?: string }

/** The itinerary: 1-40 stops, each a place and an optional time (ISO) within the trip. */
export function parseItinerary(val: unknown, from: Date, to: Date): Stop[] {
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val) || val.length > 40) throw new BadRequestException('itinerary must be a list of up to 40 stops');
  return val.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const place = typeof o.place === 'string' ? o.place.trim() : '';
    if (!place || place.length > 120) throw new BadRequestException(`itinerary[${i}].place required (up to 120)`);
    let at: string | null = null;
    if (o.at !== undefined && o.at !== null && o.at !== '') {
      const d = new Date(String(o.at));
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`itinerary[${i}].at must be a timestamp`);
      if (d < from || d > to) throw new BadRequestException(`itinerary[${i}].at must be within the trip`);
      at = d.toISOString();
    }
    const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 200) : undefined;
    return { at, place, ...(note ? { note } : {}) };
  });
}

/** Seats of a bus from its fleet record, or null when unknown. */
export const seatsOf = (capacity: unknown) => {
  const s = (capacity as { seats?: unknown } | null)?.seats;
  return Number.isInteger(s) ? (s as number) : null;
};

/** Where a trip stands from its buses: planned (buses short), ready, under_way, back, canceled. */
export function tripState(t: { canceled_at: unknown; pax: number }, buses: { status: string; seats: number | null; returned_at: unknown }[]): string {
  if (t.canceled_at) return 'canceled';
  const live = buses.filter((b) => !['canceled', 'failed'].includes(b.status));
  if (live.length && live.every((b) => b.returned_at || ['completed', 'reviewed', 'invoiced'].includes(b.status))) return 'back';
  if (live.some((b) => b.status === 'in_progress')) return 'under_way';
  const seats = live.reduce((s, b) => s + (b.seats ?? 0), 0);
  return live.length && seats >= t.pax ? 'ready' : 'planned';
}

/** A return with fewer heads than boarded must say why (someone stayed, or was left behind). */
export function returnRule(boarded: number | null, back: number, note: string | null): string | null {
  if (boarded !== null && back < boarded && !note) return 'note_required';
  return null;
}
