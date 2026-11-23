import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { pgToHttp, v } from '../common/validate';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';

/** Common document types. Sector packs may add more; the DB accepts any snake_case code. [تحقق محلي] */
export const DOC_TYPES = ['driving_license', 'vehicle_registration', 'insurance', 'civil_id', 'residency', 'work_permit', 'inspection', 'h2s', 'defensive_driving', 'site_pass', 'hazmat', 'medical', 'site_sticker', 'tpi_certificate', 'crane_operator', 'rigger_cert', 'pesticide_license', 'other'] as const;
const COLS = `id, legal_entity_id, asset_id, worker_id, doc_type, number, issued_on::text, expires_on::text, file_key, created_at`;

@Controller('v1/documents')
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Perm('fleet:read')
  list(@Auth() a: AuthContext, @Query('asset_id') asset?: string, @Query('worker_id') worker?: string) {
    const as = v.uuid(asset, 'asset_id');
    const wk = v.uuid(worker, 'worker_id');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ${COLS} FROM core.document WHERE archived_at IS NULL
           AND ($1::uuid IS NULL OR asset_id = $1) AND ($2::uuid IS NULL OR worker_id = $2)
         ORDER BY expires_on NULLS LAST LIMIT 500`, [as, wk])).rows,
    }));
  }

  /** Documents that expire within N days (default 30), or have already expired. Feeds the alerts screen. */
  @Get('expiring')
  @Perm('fleet:read')
  expiring(@Auth() a: AuthContext, @Query('days') days?: string) {
    const d = days === undefined ? 30 : Number(days);
    if (!Number.isInteger(d) || d < 0 || d > 365) throw new BadRequestException('days must be 0-365');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT d.id, d.doc_type, d.number, d.expires_on::text, (d.expires_on - current_date) AS days_left,
                d.asset_id, a.plate_no, d.worker_id, w.display_name AS worker_name,
                CASE WHEN d.expires_on < current_date THEN 'expired' ELSE 'expiring' END AS state
           FROM core.document d
           LEFT JOIN fleet.asset a ON a.id = d.asset_id
           LEFT JOIN workforce.worker w ON w.id = d.worker_id
          WHERE d.archived_at IS NULL AND d.expires_on IS NOT NULL AND d.expires_on <= current_date + $1::int
          ORDER BY d.expires_on`, [d])).rows,
    }));
  }

  @Post()
  @Perm('fleet:write')
  async create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const asset = v.uuid(b?.asset_id, 'asset_id');
    const worker = v.uuid(b?.worker_id, 'worker_id');
    if ((asset === null) === (worker === null)) throw new BadRequestException('exactly one of asset_id or worker_id');
    const type = v.oneOf(b?.doc_type, 'doc_type', DOC_TYPES, { required: true });
    const number = v.str(b?.number, 'number', { max: 60 });
    const issued = v.date(b?.issued_on, 'issued_on');
    const expires = v.date(b?.expires_on, 'expires_on');
    return this.db.withTenant(a, async (c) => {
      // The document inherits the legal entity of its owner (RLS hides owners outside the caller's scope).
      const owner = asset
        ? (await c.query('SELECT legal_entity_id FROM fleet.asset WHERE id = $1', [asset])).rows[0]
        : (await c.query('SELECT legal_entity_id FROM workforce.worker WHERE id = $1', [worker])).rows[0];
      if (!owner) throw new NotFoundException('owner not found');
      const id = randomUUID();
      try {
        const r = await c.query(
          `INSERT INTO core.document (id, tenant_id, legal_entity_id, asset_id, worker_id, doc_type, number, issued_on, expires_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
          [id, a.tenantId, owner.legal_entity_id, asset, worker, type, number, issued, expires]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'document.created', targetType: 'document', targetId: id, after: r.rows[0] });
        return r.rows[0];
      } catch (e) { return pgToHttp(e); }
    });
  }

  @Delete(':id')
  @Perm('fleet:write')
  @HttpCode(204)
  async archive(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.db.withTenant(a, async (c) => {
      const r = await c.query('UPDATE core.document SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id', [id]);
      if (!r.rowCount) throw new NotFoundException();
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'document.archived', targetType: 'document', targetId: id });
    });
  }
}
