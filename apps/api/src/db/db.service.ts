import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

export interface TenantContext {
  tenantId: string;
  /** Legal entities the caller may see. Empty = all entities of the tenant. */
  entityIds: string[];
}

/**
 * Every query that touches tenant data goes through withTenant().
 * It opens a transaction and sets app.tenant_id with SET LOCAL semantics,
 * so the setting dies with the transaction and a pooled connection never
 * carries one company's context into the next request (Phase E test 1.4).
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  }

  async withTenant<T>(ctx: TenantContext, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
      await client.query("SELECT set_config('app.entity_ids', $1, true)", [
        ctx.entityIds.length ? `{${ctx.entityIds.join(',')}}` : '',
      ]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Pre-login work only (OTP, user lookup): no tenant context, so RLS hides every tenant row. */
  async withoutTenant<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Health check only: no tenant data is reachable without a tenant context. */
  async ping(): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 AS ok');
    return r.rows[0]?.ok === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
