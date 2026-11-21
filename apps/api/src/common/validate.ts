import { BadRequestException } from '@nestjs/common';
import { isUuid } from '../auth/tokens';

/** Small explicit validators: every field the API accepts is checked here, nothing is passed through. */
export const v = {
  str(val: unknown, field: string, { required = false, max = 200 } = {}): string | null {
    if (val === undefined || val === null || val === '') {
      if (required) throw new BadRequestException(`${field} required`);
      return null;
    }
    if (typeof val !== 'string' || val.trim().length > max) throw new BadRequestException(`${field} must be text up to ${max}`);
    return val.trim();
  },
  uuid(val: unknown, field: string, { required = false } = {}): string | null {
    if (val === undefined || val === null) {
      if (required) throw new BadRequestException(`${field} required`);
      return null;
    }
    if (!isUuid(val)) throw new BadRequestException(`${field} must be an id`);
    return val;
  },
  int(val: unknown, field: string, min: number, max: number): number | null {
    if (val === undefined || val === null) return null;
    if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max) throw new BadRequestException(`${field} must be an integer ${min}-${max}`);
    return val;
  },
  oneOf<T extends string>(val: unknown, field: string, options: readonly T[], { required = false } = {}): T | null {
    if (val === undefined || val === null) {
      if (required) throw new BadRequestException(`${field} required`);
      return null;
    }
    if (!options.includes(val as T)) throw new BadRequestException(`${field} must be one of ${options.join(', ')}`);
    return val as T;
  },
  obj(val: unknown, field: string): Record<string, unknown> | null {
    if (val === undefined || val === null) return null;
    if (typeof val !== 'object' || Array.isArray(val) || JSON.stringify(val).length > 4000) throw new BadRequestException(`${field} must be an object`);
    return val as Record<string, unknown>;
  },
  date(val: unknown, field: string): string | null {
    if (val === undefined || val === null) return null;
    if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val) || Number.isNaN(Date.parse(val))) throw new BadRequestException(`${field} must be YYYY-MM-DD`);
    return val;
  },
};

/** Maps Postgres constraint errors to 400s with a readable reason instead of 500s. */
export function pgToHttp(e: unknown): never {
  const code = (e as { code?: string }).code;
  const constraint = (e as { constraint?: string }).constraint;
  if (code === '23505') throw new BadRequestException(`duplicate (${constraint})`);
  if (code === '23503') throw new BadRequestException(`unknown reference (${constraint})`);
  if (code === '23514') throw new BadRequestException(`invalid value (${constraint})`);
  if (code === '42501') throw new BadRequestException('outside your scope');
  throw e;
}
