import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

/** Writes one audit row in the caller's transaction, so the change and its record commit together. */
export async function audit(
  c: PoolClient,
  e: { tenantId: string; actorId: string | null; actorType?: string; action: string; targetType: string; targetId: string; before?: unknown; after?: unknown },
): Promise<void> {
  await c.query(
    `INSERT INTO core.audit_log (id, tenant_id, actor_type, actor_id, action, target_type, target_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), e.tenantId, e.actorType ?? 'user', e.actorId, e.action, e.targetType, e.targetId,
     e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after)],
  );
}
