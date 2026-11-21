import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthGuard, AuthContext, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';

const COLUMNS = 'id, legal_entity_id, branch_id, sector_pack, status, service_window, version, attributes';

/** Minimal task endpoints (full dispatch arrives in P4). */
@Controller('v1/tasks')
@UseGuards(AuthGuard)
export class TasksController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Perm('tasks:read')
  async list(@Auth() auth: AuthContext) {
    return this.db.withTenant(auth, async (c) => {
      const r = await c.query(`SELECT ${COLUMNS} FROM ops.task ORDER BY id LIMIT 200`);
      return { data: r.rows };
    });
  }

  @Get(':id')
  @Perm('tasks:read')
  async get(@Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.db.withTenant(auth, async (c) => {
      const r = await c.query(`SELECT ${COLUMNS} FROM ops.task WHERE id = $1`, [id]);
      return r.rows[0];
    });
    // 404, not 403: a caller must not learn that another company's task exists.
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post()
  @Perm('tasks:write')
  async create(@Auth() auth: AuthContext, @Body() body: { legal_entity_id?: string; sector_pack?: string }) {
    if (typeof body?.legal_entity_id !== 'string' || typeof body?.sector_pack !== 'string') {
      throw new BadRequestException('legal_entity_id and sector_pack are required');
    }
    return this.db.withTenant(auth, async (c) => {
      // The legal entity must belong to the caller's tenant (RLS hides others).
      const le = await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [body.legal_entity_id]);
      if (!le.rowCount) throw new BadRequestException('unknown legal_entity_id');
      const r = await c.query(
        `INSERT INTO ops.task (id, tenant_id, legal_entity_id, sector_pack, status)
         VALUES ($1, $2, $3, $4, 'draft') RETURNING ${COLUMNS}`,
        [randomUUID(), auth.tenantId, body.legal_entity_id, body.sector_pack],
      );
      return r.rows[0];
    });
  }
}
