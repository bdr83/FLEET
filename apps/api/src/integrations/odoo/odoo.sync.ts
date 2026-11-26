import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../db/db.service';
import { ACCOUNT_NAMES } from '../../billing/ledger';
import { OdooClient, OdooConn, OdooError, OdooProtocol } from './odoo.client';
import { openSecret } from './secret';

const EVERY_MS = Number(process.env.ODOO_SYNC_EVERY_MS ?? 5 * 60_000);
const BATCH = 100;

const SOURCE_LABELS: Record<string, string> = {
  invoice: 'فاتورة', invoice_reversal: 'إلغاء فاتورة', payment: 'دفعة عميل', payment_reversal: 'عكس دفعة',
  expense: 'مصروف', expense_reversal: 'عكس مصروف', cod_collection: 'تحصيل عند الاستلام', cod_deposit: 'إيداع عهدة COD',
  cod_payout: 'تسوية COD للعميل',
};

export interface LinkRow {
  legal_entity_id: string; protocol: OdooProtocol; base_url: string; database: string | null; login: string | null;
  api_key_enc: string; journal_id: number; account_map: Record<string, string>; sync_from: string; enabled: boolean;
  currency: string; timezone: string;
}

interface Line {
  journal_id: string; account_code: string; amount: string; source_type: string; memo: string | null; day: string;
  customer_id: string | null; customer_name: string | null; customer_kind: string | null; email: string | null; phone: string | null;
  worker_name: string | null;
}

export interface SyncResult { sent: number; failed: number; error: string | null }

export function connFor(link: LinkRow): OdooConn {
  return { protocol: link.protocol, baseUrl: link.base_url, database: link.database, login: link.login, apiKey: openSecret(link.api_key_enc) };
}

export async function loadLink(c: PoolClient, entityId: string): Promise<LinkRow | null> {
  return (await c.query(
    `SELECT l.legal_entity_id, l.protocol, l.base_url, l.database, l.login, l.api_key_enc, l.journal_id, l.account_map,
            l.sync_from::text, l.enabled, le.currency, le.timezone
       FROM billing.odoo_link l JOIN org.legal_entity le ON le.id = l.legal_entity_id WHERE l.legal_entity_id = $1`, [entityId])).rows[0] ?? null;
}

/** Resolves the Odoo account codes in the map to Odoo ids. Returns the codes Odoo does not have. */
export async function resolveAccounts(odoo: OdooClient, map: Record<string, string>): Promise<{ ids: Map<string, number>; missing: string[] }> {
  const codes = [...new Set(Object.values(map).filter(Boolean))];
  const found = codes.length ? await odoo.searchRead<{ id: number; code: string }>('account.account', [['code', 'in', codes]], ['id', 'code']) : [];
  const byCode = new Map(found.map((a) => [a.code, a.id]));
  const ids = new Map<string, number>();
  for (const [ours, theirs] of Object.entries(map)) if (byCode.has(theirs)) ids.set(ours, byCode.get(theirs)!);
  return { ids, missing: codes.filter((c) => !byCode.has(c)) };
}

/**
 * Sends every ledger journal of a legal entity to Odoo as a posted journal entry (account.move), oldest first.
 * Our ledger stays the source: Odoo receives a copy keyed by ref "fleet:<journal id>", so a retry after a crash
 * finds the entry it already made instead of booking it twice. A failed journal is retried with growing delays
 * (2, 4, 8 ... up to 360 minutes). Runs every 5 minutes; ODOO_SYNC_DISABLED=1 turns the timer off.
 */
@Injectable()
export class OdooSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OdooSync');
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly busy = new Set<string>();

  constructor(private readonly db: DbService) {}

  onModuleInit() {
    if (process.env.ODOO_SYNC_DISABLED === '1') return;
    this.timer = setInterval(() => void this.runAll(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const links = await this.db.withoutTenant(async (c) => (await c.query('SELECT tenant_id, legal_entity_id FROM billing.odoo_enabled_links()')).rows);
      for (const l of links) {
        const r = await this.syncLink(l.tenant_id, l.legal_entity_id).catch((e) => ({ sent: 0, failed: 0, error: (e as Error).message }));
        if (r.error) this.log.warn(`odoo sync ${l.tenant_id}/${l.legal_entity_id}: ${r.error}`);
      }
    } catch (e) {
      this.log.error(`odoo sync run failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async syncLink(tenantId: string, entityId: string, max = BATCH): Promise<SyncResult> {
    const key = `${tenantId}:${entityId}`;
    if (this.busy.has(key)) return { sent: 0, failed: 0, error: 'المزامنة جارية الآن' };
    this.busy.add(key);
    try {
      return await this.sync(tenantId, entityId, max);
    } finally {
      this.busy.delete(key);
    }
  }

  private tx<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant({ tenantId, entityIds: [] }, fn);
  }

  private async sync(tenantId: string, entityId: string, max: number): Promise<SyncResult> {
    const prep = await this.tx(tenantId, async (c) => {
      const link = await loadLink(c, entityId);
      if (!link || !link.enabled) return null;
      const lines = (await c.query(
        `WITH j AS (
           SELECT e.journal_id, min(e.posted_at) AS posted_at FROM billing.ledger_entry e
            WHERE e.legal_entity_id = $1 AND (e.posted_at AT TIME ZONE $2)::date >= $3::date
              AND NOT EXISTS (SELECT 1 FROM billing.odoo_sync s WHERE s.journal_id = e.journal_id
                               AND (s.status = 'sent' OR s.next_attempt_at > now()))
            GROUP BY e.journal_id ORDER BY min(e.posted_at), e.journal_id LIMIT $4)
         SELECT e.journal_id, e.account_code, e.amount::text, e.source_type, e.memo, (j.posted_at AT TIME ZONE $2)::date::text AS day,
                e.customer_id, cu.name AS customer_name, cu.kind AS customer_kind, cu.email, cu.phone, w.display_name AS worker_name
           FROM j JOIN billing.ledger_entry e ON e.journal_id = j.journal_id
           LEFT JOIN crm.customer cu ON cu.id = e.customer_id
           LEFT JOIN workforce.worker w ON w.id = e.worker_id
          ORDER BY j.posted_at, e.journal_id, e.account_code, e.amount DESC`,
        [entityId, link.timezone, link.sync_from, max])).rows as Line[];
      const partners = new Map<string, number>((await c.query(
        'SELECT customer_id, odoo_partner_id FROM billing.odoo_partner WHERE legal_entity_id = $1', [entityId])).rows
        .map((r) => [r.customer_id as string, r.odoo_partner_id as number]));
      return { link, lines, partners };
    });
    if (!prep) return { sent: 0, failed: 0, error: 'الربط غير مفعّل' };
    const { link, lines, partners } = prep;
    const journals = new Map<string, Line[]>();
    for (const l of lines) journals.set(l.journal_id, [...(journals.get(l.journal_id) ?? []), l]);

    let sent = 0, failed = 0;
    let stop: string | null = null;
    try {
      const odoo = new OdooClient(connFor(link));
      const { ids: accounts } = journals.size ? await resolveAccounts(odoo, link.account_map) : { ids: new Map<string, number>() };
      for (const [journalId, jl] of journals) {
        try {
          const moveId = await this.sendJournal(odoo, tenantId, link, journalId, jl, accounts, partners);
          await this.tx(tenantId, (c) => c.query(
            `INSERT INTO billing.odoo_sync (tenant_id, journal_id, legal_entity_id, status, odoo_move_id, attempts, last_error, next_attempt_at, updated_at)
             VALUES ($1,$2,$3,'sent',$4,1,NULL,NULL,now())
             ON CONFLICT (tenant_id, journal_id) DO UPDATE SET status = 'sent', odoo_move_id = $4, last_error = NULL, next_attempt_at = NULL,
               attempts = billing.odoo_sync.attempts + 1, updated_at = now()`,
            [tenantId, journalId, entityId, moveId]));
          sent++;
        } catch (e) {
          const err = e instanceof OdooError ? e : new OdooError((e as Error).message);
          await this.tx(tenantId, (c) => c.query(
            `INSERT INTO billing.odoo_sync (tenant_id, journal_id, legal_entity_id, status, attempts, last_error, next_attempt_at, updated_at)
             VALUES ($1,$2,$3,'failed',1,$4, now() + interval '2 minutes', now())
             ON CONFLICT (tenant_id, journal_id) DO UPDATE SET status = 'failed', last_error = $4, attempts = billing.odoo_sync.attempts + 1,
               next_attempt_at = now() + least(power(2, billing.odoo_sync.attempts + 1), 360) * interval '1 minute', updated_at = now()`,
            [tenantId, journalId, entityId, err.message.slice(0, 500)]));
          failed++;
          if (err.kind === 'auth' || err.kind === 'network' || err.kind === 'config') { stop = err.message; break; }
        }
      }
    } catch (e) {
      stop = (e as Error).message;
    }
    await this.tx(tenantId, (c) => c.query(
      stop ? 'UPDATE billing.odoo_link SET last_error = $2 WHERE legal_entity_id = $1'
           : 'UPDATE billing.odoo_link SET last_error = NULL, last_ok_at = now() WHERE legal_entity_id = $1',
      stop ? [entityId, stop.slice(0, 500)] : [entityId]));
    return { sent, failed, error: stop };
  }

  private async sendJournal(odoo: OdooClient, tenantId: string, link: LinkRow, journalId: string, jl: Line[],
                            accounts: Map<string, number>, partners: Map<string, number>): Promise<number> {
    const unmapped = [...new Set(jl.map((l) => l.account_code).filter((a) => !accounts.has(a)))];
    if (unmapped.length) {
      throw new OdooError(`حسابات غير مربوطة بحساب في Odoo: ${unmapped.map((a) => `${a} ${ACCOUNT_NAMES[a] ?? ''}`.trim()).join('، ')}`);
    }
    const ref = `fleet:${journalId}`;
    const existing = await odoo.searchRead<{ id: number; state: string }>('account.move',
      [['ref', '=', ref], ['journal_id', '=', link.journal_id]], ['id', 'state'], 1);
    if (existing.length) {
      if (existing[0].state === 'draft') await odoo.call('account.move', 'action_post', [existing[0].id]);
      return existing[0].id;
    }
    for (const l of jl) {
      if (l.customer_id && !partners.has(l.customer_id)) partners.set(l.customer_id, await this.partnerFor(odoo, tenantId, link.legal_entity_id, l));
    }
    const label = SOURCE_LABELS[jl[0].source_type] ?? jl[0].source_type;
    const lineVals = jl.map((l) => {
      const fils = Math.round(Number(l.amount) * 1000);
      return [0, 0, {
        account_id: accounts.get(l.account_code),
        partner_id: l.customer_id ? partners.get(l.customer_id) : false,
        name: [label, l.memo, l.worker_name].filter(Boolean).join(' · ').slice(0, 250),
        debit: fils > 0 ? fils / 1000 : 0,
        credit: fils < 0 ? -fils / 1000 : 0,
      }];
    });
    const moveId = await odoo.create('account.move', {
      move_type: 'entry', journal_id: link.journal_id, date: jl[0].day, ref, line_ids: lineVals,
    });
    await odoo.call('account.move', 'action_post', [moveId]);
    return moveId;
  }

  /** Finds the customer in Odoo by ref "fleet:<customer id>", or creates it, and remembers the link. */
  private async partnerFor(odoo: OdooClient, tenantId: string, entityId: string, l: Line): Promise<number> {
    const ref = `fleet:${l.customer_id}`;
    const found = await odoo.searchRead<{ id: number }>('res.partner', [['ref', '=', ref]], ['id'], 1);
    const id = found.length ? found[0].id : await odoo.create('res.partner', {
      name: l.customer_name, ref, email: l.email || false, phone: l.phone || false, is_company: l.customer_kind !== 'individual',
    });
    await this.tx(tenantId, (c) => c.query(
      `INSERT INTO billing.odoo_partner (tenant_id, legal_entity_id, customer_id, odoo_partner_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, legal_entity_id, customer_id) DO UPDATE SET odoo_partner_id = $4`,
      [tenantId, entityId, l.customer_id, id]));
    return id;
  }
}
