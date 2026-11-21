import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { normalizePhone } from '../common/phone';
import { pgToHttp, v } from '../common/validate';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';

export const WORKER_KINDS = ['driver', 'courier', 'technician', 'supervisor', 'guard'] as const;
export const WORKER_STATUSES = ['active', 'on_leave', 'suspended', 'left'] as const;
const DRIVER_ROLE = '00000000-0000-4000-8000-000000000006';
const COLS = `w.id, w.legal_entity_id, w.branch_id, w.kind, w.display_name, w.phone, w.status, w.employer_party_id, w.user_id, w.created_at`;

/**
 * Drivers and other field staff. Adding a worker with a phone also gives them a
 * "driver" membership so they can log in to the driver app with OTP (unless they
 * already belong to the company with another role).
 */
@Controller('v1/workers')
@UseGuards(AuthGuard)
export class WorkersController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Perm('fleet:read')
  list(@Auth() a: AuthContext, @Query('status') status?: string, @Query('kind') kind?: string) {
    const st = v.oneOf(status, 'status', WORKER_STATUSES);
    const k = v.oneOf(kind, 'kind', WORKER_KINDS);
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ${COLS} FROM workforce.worker w
          WHERE ($1::text IS NULL OR w.status = $1) AND ($2::text IS NULL OR w.kind = $2)
            AND (cardinality($3::uuid[]) = 0 OR w.branch_id IS NULL OR w.branch_id = ANY($3::uuid[]))
          ORDER BY w.display_name LIMIT 500`, [st, k, a.branchIds])).rows,
    }));
  }

  @Get(':id')
  @Perm('fleet:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.db.withTenant(a, async (c) => (await c.query(`SELECT ${COLS} FROM workforce.worker w WHERE w.id = $1`, [id])).rows[0]);
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post()
  @Perm('fleet:write')
  async create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true });
    const kind = v.oneOf(b?.kind, 'kind', WORKER_KINDS, { required: true });
    const name = v.str(b?.display_name, 'display_name', { required: true, max: 120 });
    const branch = v.uuid(b?.branch_id, 'branch_id');
    const employer = v.uuid(b?.employer_party_id, 'employer_party_id');
    const phone = b?.phone === undefined ? null : normalizePhone(b.phone);
    if (b?.phone !== undefined && !phone) throw new BadRequestException('invalid phone');
    return this.db.withTenant(a, async (c) => {
      let userId: string | null = null;
      if (phone) {
        userId = (await c.query(
          `INSERT INTO org.app_user (id, phone, display_name) VALUES ($1,$2,$3)
           ON CONFLICT (phone) DO UPDATE SET display_name = COALESCE(org.app_user.display_name, EXCLUDED.display_name) RETURNING id`,
          [randomUUID(), phone, name])).rows[0].id;
        await c.query(
          `INSERT INTO org.membership (id, tenant_id, user_id, role_id, scope_legal_entity_ids)
           VALUES ($1,$2,$3,$4,ARRAY[$5::uuid]) ON CONFLICT (tenant_id, user_id) WHERE revoked_at IS NULL DO NOTHING`,
          [randomUUID(), a.tenantId, userId, DRIVER_ROLE, le]);
      }
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO workforce.worker (id, tenant_id, legal_entity_id, branch_id, kind, display_name, phone, user_id, employer_party_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, a.tenantId, le, branch, kind, name, phone, userId, employer]);
      } catch (e) { return pgToHttp(e); }
      const row = (await c.query(`SELECT ${COLS} FROM workforce.worker w WHERE w.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'worker.created', targetType: 'worker', targetId: id, after: row });
      return row;
    });
  }

  @Patch(':id')
  @Perm('fleet:write')
  async update(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const status = v.oneOf(b?.status, 'status', WORKER_STATUSES);
    const name = v.str(b?.display_name, 'display_name', { max: 120 });
    const branch = v.uuid(b?.branch_id, 'branch_id');
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`SELECT ${COLS} FROM workforce.worker w WHERE w.id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundException();
      try {
        await c.query(
          `UPDATE workforce.worker SET status = COALESCE($2, status), display_name = COALESCE($3, display_name), branch_id = COALESCE($4, branch_id) WHERE id = $1`,
          [id, status, name, branch]);
      } catch (e) { return pgToHttp(e); }
      // A worker who left loses app access; their membership is revoked unless it is a non-driver role.
      if (status === 'left' && before.user_id) {
        await c.query(
          `UPDATE org.membership m SET revoked_at = now() FROM org.role r
            WHERE r.id = m.role_id AND r.code = 'driver' AND m.user_id = $1 AND m.revoked_at IS NULL`, [before.user_id]);
        await c.query('UPDATE org.session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [before.user_id]);
      }
      const after = (await c.query(`SELECT ${COLS} FROM workforce.worker w WHERE w.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'worker.updated', targetType: 'worker', targetId: id, before, after });
      return after;
    });
  }
}
