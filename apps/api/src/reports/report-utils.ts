import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';

export interface Range { from: Date; to: Date; tz: string }
/** Longest period one report may cover, to keep queries bounded. [تخمين] raise with read replicas. */
export const MAX_RANGE_DAYS = 93;

export async function parseRange(c: PoolClient, q: Record<string, string | undefined>): Promise<Range> {
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('from and to are required timestamps');
  if (to <= from) throw new BadRequestException('to must be after from');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new BadRequestException(`range longer than ${MAX_RANGE_DAYS} days`);
  const tz = q.tz ?? 'Asia/Kuwait';
  if (!/^[A-Za-z_]+(\/[A-Za-z_]+){0,2}$/.test(tz) || !(await c.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [tz])).rowCount) {
    throw new BadRequestException('unknown tz');
  }
  return { from, to, tz };
}

export interface CsvResponse { setHeader(name: string, value: string): void }

/** CSV with a UTF-8 BOM so Excel shows Arabic correctly. Cells that start with = + - @ are prefixed to block formula injection. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (val: unknown) => {
    if (val === null || val === undefined) return '';
    let s = val instanceof Date ? val.toISOString() : typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.join(','), ...rows.map((r) => columns.map((k) => cell(r[k])).join(','))].join('\r\n') + '\r\n';
}

export function respond(res: CsvResponse, format: string | undefined, name: string, rows: Record<string, unknown>[], columns: string[], extra: Record<string, unknown> = {}) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return toCsv(rows, columns);
  }
  if (format !== undefined && format !== 'json') throw new BadRequestException('format must be json or csv');
  return { ...extra, columns, data: rows };
}
