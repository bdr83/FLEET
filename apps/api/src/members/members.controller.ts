import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { normalizePhone } from '../common/phone';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { isUuid } from '../auth/tokens';

interface MemberInput {
  phone?: string;
  display_name?: string;
  role_code?: string;
  scope_legal_entity_ids?: string[] | null;
  scope_branch_ids?: string[] | null;
  valid_until?: string | null;
  customer_id?: string;
  department_id?: string | null;
}

const SELECT = `SELECT m.id, m.user_id, u.phone, u.display_name, r.code AS role, m.scope_legal_entity_ids,
                       m.scope_branch_ids, m.customer_id, m.valid_until, m.revoked_at, m.created_at, m.department_id
                  FROM org.membership m JOIN org.app_user u ON u.id = m.user_id JOIN org.role r ON r.id = m.role_id`;

@Controller('v1/members')
@UseGuards(AuthGuard)
export class MembersController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Perm('members:read')
  list(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({ data: (await c.query(`${SELECT} WHERE m.revoked_at IS NULL ORDER BY m.created_at`)).rows }));
  }

  /** Adds a person by phone. They log in with OTP and see this company in their list. */
  @Post()
  @Perm('members:write')
  async add(@Auth() a: AuthContext, @Body() body: MemberInput) {
    const phone = normalizePhone(body?.phone);
    if (!phone) throw new BadRequestException('invalid phone');
    return this.db.withTenant(a, async (c) => {
      const role = await this.resolveRole(c, a, body.role_code);
      let scope = await this.validateScope(c, body);
      // A customer-portal user is tied to one customer and sees only that customer's legal entity.
      let customerId: string | null = null;
      if (role.code === 'customer') {
        if (!isUuid(body.customer_id)) throw new BadRequestException('customer_id required for the customer role');
        const cu = (await c.query('SELECT legal_entity_id FROM crm.customer WHERE id = $1', [body.customer_id])).rows[0];
        if (!cu) throw new BadRequestException('unknown customer_id');
        customerId = body.customer_id;
        scope = { entities: [cu.legal_entity_id], branches: null };
      } else if (body.customer_id !== undefined) {
        throw new BadRequestException('customer_id is only for the customer role');
      }
      const departmentId = await this.validateDepartment(c, body.department_id);
      const u = await c.query(
        `INSERT INTO org.app_user (id, phone, display_name) VALUES ($1,$2,$3)
         ON CONFLICT (phone) DO UPDATE SET display_name = COALESCE(org.app_user.display_name, EXCLUDED.display_name) RETURNING id`,
        [randomUUID(), phone, body.display_name ?? null]);
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO org.membership (id, tenant_id, user_id, role_id, scope_legal_entity_ids, scope_branch_ids, valid_until, customer_id, department_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, a.tenantId, u.rows[0].id, role.id, scope.entities, scope.branches, body.valid_until ?? null, customerId, departmentId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new BadRequestException('already a member');
        throw e;
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'member.added', targetType: 'membership', targetId: id,
                       after: { phone, role: role.code, ...scope, valid_until: body.valid_until ?? null, department_id: departmentId } });
      return (await c.query(`${SELECT} WHERE m.id = $1`, [id])).rows[0];
    });
  }

  @Patch(':id')
  @Perm('members:write')
  async update(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: MemberInput) {
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`${SELECT} WHERE m.id = $1 AND m.revoked_at IS NULL FOR UPDATE OF m`, [id])).rows[0];
      if (!before) throw new NotFoundException();
      if (before.role === 'owner' && a.roleCode !== 'owner') throw new ForbiddenException('only an owner can change an owner');
      const role = body.role_code ? await this.resolveRole(c, a, body.role_code) : null;
      if (before.role === 'owner' && role && role.code !== 'owner') await this.assertAnotherOwner(c, id);
      if (role && (role.code === 'customer') !== (before.role === 'customer')) throw new BadRequestException('customer portal access is a separate membership: revoke and add again');
      if (before.role === 'customer' && ('scope_legal_entity_ids' in body || 'scope_branch_ids' in body)) throw new BadRequestException('a customer user scope follows the customer');
      const scope = await this.validateScope(c, body);
      const departmentId = await this.validateDepartment(c, body.department_id);
      await c.query(
        `UPDATE org.membership SET
           role_id = COALESCE($2, role_id),
           scope_legal_entity_ids = CASE WHEN $3::boolean THEN $4::uuid[] ELSE scope_legal_entity_ids END,
           scope_branch_ids = CASE WHEN $5::boolean THEN $6::uuid[] ELSE scope_branch_ids END,
           valid_until = CASE WHEN $7::boolean THEN $8::timestamptz ELSE valid_until END,
           department_id = CASE WHEN $9::boolean THEN $10::uuid ELSE department_id END
         WHERE id = $1`,
        [id, role?.id ?? null, 'scope_legal_entity_ids' in body, scope.entities, 'scope_branch_ids' in body, scope.branches,
         'valid_until' in body, body.valid_until ?? null, 'department_id' in body, departmentId]);
      const after = (await c.query(`${SELECT} WHERE m.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'member.updated', targetType: 'membership', targetId: id, before, after });
      return after;
    });
  }

  /** Revocation applies on the caller's next request and kills their refresh sessions. */
  @Delete(':id')
  @Perm('members:write')
  @HttpCode(204)
  async revoke(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.db.withTenant(a, async (c) => {
      const before = (await c.query(`${SELECT} WHERE m.id = $1 AND m.revoked_at IS NULL FOR UPDATE OF m`, [id])).rows[0];
      if (!before) throw new NotFoundException();
      if (before.role === 'owner') {
        if (a.roleCode !== 'owner') throw new ForbiddenException('only an owner can remove an owner');
        await this.assertAnotherOwner(c, id);
      }
      await c.query('UPDATE org.membership SET revoked_at = now() WHERE id = $1', [id]);
      await c.query('UPDATE org.session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [before.user_id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'member.revoked', targetType: 'membership', targetId: id, before });
    });
  }

  /** The employee's department (in-house fleet requests are charged to it). */
  private async validateDepartment(c: PoolClient, dep: string | null | undefined): Promise<string | null> {
    if (dep === undefined || dep === null) return null;
    if (!isUuid(dep)) throw new BadRequestException('invalid department_id');
    const r = (await c.query('SELECT active FROM ops.department WHERE id = $1', [dep])).rows[0];
    if (!r) throw new BadRequestException('unknown department_id');
    if (!r.active) throw new BadRequestException('department is inactive');
    return dep;
  }

  private async resolveRole(c: PoolClient, a: AuthContext, code: unknown) {
    if (typeof code !== 'string') throw new BadRequestException('role_code required');
    const r = await c.query('SELECT id, code FROM org.role WHERE code = $1 ORDER BY tenant_id NULLS LAST LIMIT 1', [code]);
    if (!r.rows[0]) throw new BadRequestException('unknown role');
    // No privilege escalation: only an owner can grant owner.
    if (r.rows[0].code === 'owner' && a.roleCode !== 'owner') throw new ForbiddenException('only an owner can grant owner');
    return r.rows[0] as { id: string; code: string };
  }

  private async validateScope(c: PoolClient, body: MemberInput) {
    const check = async (ids: unknown, table: string) => {
      if (ids === undefined || ids === null) return null;
      if (!Array.isArray(ids) || !ids.every(isUuid)) throw new BadRequestException('scope must be a list of ids');
      if (!ids.length) return null;
      // RLS limits the count to this tenant, so a foreign id fails here.
      const n = (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = ANY($1::uuid[])`, [ids])).rows[0].n;
      if (n !== new Set(ids).size) throw new BadRequestException('unknown id in scope');
      return ids as string[];
    };
    return { entities: await check(body.scope_legal_entity_ids, 'org.legal_entity'), branches: await check(body.scope_branch_ids, 'org.branch') };
  }

  private async assertAnotherOwner(c: PoolClient, exceptId: string) {
    const n = (await c.query(
      `SELECT count(*)::int AS n FROM org.membership m JOIN org.role r ON r.id = m.role_id
        WHERE r.code = 'owner' AND m.revoked_at IS NULL AND m.id <> $1`, [exceptId])).rows[0].n;
    if (n === 0) throw new BadRequestException('a company must keep at least one owner');
  }
}
