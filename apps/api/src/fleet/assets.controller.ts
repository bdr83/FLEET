import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { pgToHttp, v } from '../common/validate';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';

export const ASSET_TYPES = ['car', 'motorbike', 'van', 'pickup', 'truck', 'mixer', 'pump', 'trailer', 'bus', 'excavator', 'loader', 'crane', 'forklift', 'bulldozer', 'roller', 'grader', 'other'] as const;
export const ASSET_STATUSES = ['available', 'in_use', 'out_of_service', 'retired'] as const;
const COLS = `id, legal_entity_id, branch_id, asset_type, plate_no, status, make, model, year, vin, odometer_km, capacity, notes, created_at`;

function fields(b: Record<string, unknown>) {
  return {
    branch_id: v.uuid(b.branch_id, 'branch_id'),
    plate_no: v.str(b.plate_no, 'plate_no', { max: 20 }),
    make: v.str(b.make, 'make', { max: 60 }),
    model: v.str(b.model, 'model', { max: 60 }),
    year: v.int(b.year, 'year', 1980, 2100),
    vin: v.str(b.vin, 'vin', { max: 30 }),
    odometer_km: v.int(b.odometer_km, 'odometer_km', 0, 10_000_000),
    notes: v.str(b.notes, 'notes', { max: 1000 }),
    capacity: v.obj(b.capacity, 'capacity'),
  };
}

@Controller('v1/assets')
@UseGuards(AuthGuard)
export class AssetsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Perm('fleet:read')
  list(@Auth() a: AuthContext, @Query('status') status?: string, @Query('type') type?: string, @Query('branch_id') branch?: string) {
    const st = v.oneOf(status, 'status', ASSET_STATUSES);
    const ty = v.oneOf(type, 'type', ASSET_TYPES);
    const br = v.uuid(branch, 'branch_id');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ${COLS} FROM fleet.asset
          WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR asset_type = $2) AND ($3::uuid IS NULL OR branch_id = $3)
            AND (cardinality($4::uuid[]) = 0 OR branch_id IS NULL OR branch_id = ANY($4::uuid[]))
          ORDER BY plate_no NULLS LAST LIMIT 500`, [st, ty, br, a.branchIds])).rows,
    }));
  }

  @Get(':id')
  @Perm('fleet:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.db.withTenant(a, async (c) => (await c.query(`SELECT ${COLS} FROM fleet.asset WHERE id = $1`, [id])).rows[0]);
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post()
  @Perm('fleet:write')
  async create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true });
    const type = v.oneOf(b?.asset_type, 'asset_type', ASSET_TYPES, { required: true });
    const f = fields(b);
    return this.db.withTenant(a, async (c) => {
      const id = randomUUID();
      try {
        const r = await c.query(
          `INSERT INTO fleet.asset (id, tenant_id, legal_entity_id, branch_id, asset_type, plate_no, status, make, model, year, vin, odometer_km, capacity, notes)
           VALUES ($1,$2,$3,$4,$5,$6,'available',$7,$8,$9,$10,$11,COALESCE($12::jsonb,'{}'),$13) RETURNING ${COLS}`,
          [id, a.tenantId, le, f.branch_id, type, f.plate_no, f.make, f.model, f.year, f.vin, f.odometer_km, f.capacity && JSON.stringify(f.capacity), f.notes]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'asset.created', targetType: 'asset', targetId: id, after: r.rows[0] });
        return r.rows[0];
      } catch (e) { return pgToHttp(e); }
    });
  }

  @Patch(':id')
  @Perm('fleet:write')
  async update(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const status = v.oneOf(b?.status, 'status', ASSET_STATUSES);
    const f = fields(b ?? {});
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`SELECT ${COLS} FROM fleet.asset WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundException();
      if (f.odometer_km !== null && before.odometer_km !== null && f.odometer_km < before.odometer_km) {
        throw new BadRequestException('odometer cannot go backwards');
      }
      try {
        const r = await c.query(
          `UPDATE fleet.asset SET status = COALESCE($2, status), branch_id = COALESCE($3, branch_id), plate_no = COALESCE($4, plate_no),
             make = COALESCE($5, make), model = COALESCE($6, model), year = COALESCE($7, year), vin = COALESCE($8, vin),
             odometer_km = COALESCE($9, odometer_km), capacity = COALESCE($10::jsonb, capacity), notes = COALESCE($11, notes)
           WHERE id = $1 RETURNING ${COLS}`,
          [id, status, f.branch_id, f.plate_no, f.make, f.model, f.year, f.vin, f.odometer_km, f.capacity && JSON.stringify(f.capacity), f.notes]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'asset.updated', targetType: 'asset', targetId: id, before, after: r.rows[0] });
        return r.rows[0];
      } catch (e) { return pgToHttp(e); }
    });
  }
}
