import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthContext, AuthGuard, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { v } from '../../common/validate';
import { ACCOUNT_NAMES, ACCOUNTS, EXPENSE_ACCOUNTS } from '../../billing/ledger';
import { assertSafeUrl, OdooClient, OdooError } from './odoo.client';
import { connFor, loadLink, OdooSyncService, resolveAccounts } from './odoo.sync';
import { sealSecret } from './secret';

/** Every account our ledger can post to, so the office maps each one to an Odoo account. */
const OUR_ACCOUNTS = [...new Set([...Object.values(ACCOUNTS), ...Object.values(EXPENSE_ACCOUNTS)])].sort();

/**
 * The Odoo accounting link of a legal entity: settings, a connection test, a sync now button and the sync status.
 * Settings need org:write; status needs billing:read. The API key is write-only.
 */
@Controller('v1/integrations/odoo')
@UseGuards(AuthGuard)
export class OdooController {
  constructor(private readonly db: DbService, private readonly sync: OdooSyncService) {}

  private entity(a: AuthContext, raw: unknown): string {
    const id = v.uuid(raw, 'legal_entity_id', { required: true })!;
    if (a.entityIds.length && !a.entityIds.includes(id)) throw new NotFoundException();
    return id;
  }

  @Get()
  @Perm('billing:read')
  get(@Auth() a: AuthContext, @Query('legal_entity_id') le: string) {
    const entityId = this.entity(a, le);
    return this.db.withTenant(a, async (c) => {
      const ent = (await c.query('SELECT timezone FROM org.legal_entity WHERE id = $1', [entityId])).rows[0];
      if (!ent) throw new NotFoundException();
      const link = (await c.query(
        `SELECT protocol, base_url, database, login, journal_id, account_map, sync_from::text, enabled, last_ok_at, last_error, updated_at
           FROM billing.odoo_link WHERE legal_entity_id = $1`, [entityId])).rows[0] ?? null;
      const accounts = OUR_ACCOUNTS.map((code) => ({ code, name: ACCOUNT_NAMES[code] ?? code }));
      if (!link) return { link: null, accounts, counts: null, failures: [] };
      const counts = (await c.query(
        `SELECT count(*) FILTER (WHERE s.status = 'sent')::int AS sent,
                count(*) FILTER (WHERE s.status = 'failed')::int AS failed,
                count(*) FILTER (WHERE s.status IS NULL)::int AS waiting
           FROM (SELECT DISTINCT journal_id FROM billing.ledger_entry
                  WHERE legal_entity_id = $1 AND (posted_at AT TIME ZONE $2)::date >= $3::date) j
           LEFT JOIN billing.odoo_sync s ON s.journal_id = j.journal_id`, [entityId, ent.timezone, link.sync_from])).rows[0];
      const failures = (await c.query(
        `SELECT s.journal_id, min(e.source_type) AS source_type, min(e.posted_at) AS posted_at, s.attempts, s.last_error, s.next_attempt_at
           FROM billing.odoo_sync s JOIN billing.ledger_entry e ON e.journal_id = s.journal_id
          WHERE s.legal_entity_id = $1 AND s.status = 'failed'
          GROUP BY s.journal_id, s.attempts, s.last_error, s.next_attempt_at ORDER BY min(e.posted_at) LIMIT 20`, [entityId])).rows;
      return { link: { ...link, has_key: true }, accounts, counts, failures };
    });
  }

  @Put()
  @Perm('org:write')
  async save(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const entityId = this.entity(a, b?.legal_entity_id);
    const protocol = v.oneOf(b?.protocol, 'protocol', ['json2', 'jsonrpc'] as const) ?? 'json2';
    const baseUrl = v.str(b?.base_url, 'base_url', { required: true, max: 200 })!.replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(baseUrl)) throw new BadRequestException('base_url must be a web address');
    try { await assertSafeUrl(baseUrl); } catch (e) { throw new BadRequestException((e as Error).message); }
    const database = v.str(b?.database, 'database', { max: 100 });
    const login = v.str(b?.login, 'login', { max: 200 });
    if (protocol === 'jsonrpc' && (!database || !login)) throw new BadRequestException('database and login are required for jsonrpc');
    const apiKey = v.str(b?.api_key, 'api_key', { max: 200 });
    const journalId = v.int(b?.journal_id, 'journal_id', 1, 2_147_483_647);
    if (!journalId) throw new BadRequestException('journal_id required');
    const mapIn = v.obj(b?.account_map, 'account_map') ?? {};
    const accountMap: Record<string, string> = {};
    for (const [k, val] of Object.entries(mapIn)) {
      if (!OUR_ACCOUNTS.includes(k as never)) throw new BadRequestException(`account_map: unknown account ${k}`);
      const code = v.str(val, `account_map.${k}`, { max: 64 });
      if (code) accountMap[k] = code;
    }
    const syncFrom = v.date(b?.sync_from, 'sync_from');
    if (!syncFrom) throw new BadRequestException('sync_from required');
    const enabled = b?.enabled === undefined ? true : b.enabled === true;
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [entityId])).rowCount) throw new NotFoundException();
      const before = (await c.query('SELECT api_key_enc FROM billing.odoo_link WHERE legal_entity_id = $1 FOR UPDATE', [entityId])).rows[0];
      if (!before && !apiKey) throw new BadRequestException('api_key required');
      const sealed = apiKey ? sealSecret(apiKey) : before.api_key_enc;
      await c.query(
        `INSERT INTO billing.odoo_link (tenant_id, legal_entity_id, protocol, base_url, database, login, api_key_enc, journal_id, account_map, sync_from, enabled, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET protocol = $3, base_url = $4, database = $5, login = $6, api_key_enc = $7,
           journal_id = $8, account_map = $9, sync_from = $10, enabled = $11, updated_by = $12, updated_at = now(), last_error = NULL`,
        [a.tenantId, entityId, protocol, baseUrl, database, login, sealed, journalId, JSON.stringify(accountMap), syncFrom, enabled, a.userId]);
      const after = { protocol, base_url: baseUrl, database, login, journal_id: journalId, account_map: accountMap, sync_from: syncFrom, enabled, api_key_changed: !!apiKey };
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: before ? 'odoo_link.updated' : 'odoo_link.created', targetType: 'legal_entity', targetId: entityId, after });
      return { ...after, has_key: true };
    });
  }

  /** Connects with the saved settings and checks the journal, the company currency and every mapped account. */
  @Post('test')
  @HttpCode(200)
  @Perm('org:write')
  async test(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const entityId = this.entity(a, b?.legal_entity_id);
    const link = await this.db.withTenant(a, (c) => loadLink(c, entityId));
    if (!link) throw new NotFoundException('no Odoo link for this legal entity');
    const unmapped = OUR_ACCOUNTS.filter((code) => !link.account_map[code]);
    try {
      const odoo = new OdooClient(connFor(link));
      const j = await odoo.searchRead<{ id: number; name: string; company_id: [number, string] | false }>(
        'account.journal', [['id', '=', link.journal_id]], ['id', 'name', 'company_id'], 1);
      if (!j.length) return { ok: false, error: `دفتر اليومية رقم ${link.journal_id} غير موجود في Odoo` };
      let currency: string | null = null;
      if (j[0].company_id) {
        const co = await odoo.searchRead<{ currency_id: [number, string] | false }>('res.company', [['id', '=', j[0].company_id[0]]], ['currency_id'], 1);
        currency = co[0]?.currency_id ? co[0].currency_id[1] : null;
      }
      const { missing } = await resolveAccounts(odoo, link.account_map);
      const currencyOk = !currency || currency === link.currency;
      return {
        ok: missing.length === 0 && currencyOk,
        journal: j[0].name, company: j[0].company_id ? j[0].company_id[1] : null, company_currency: currency,
        currency_matches: currencyOk, missing_accounts: missing, unmapped_accounts: unmapped,
      };
    } catch (e) {
      if (e instanceof OdooError) return { ok: false, error: e.message };
      throw e;
    }
  }

  @Post('sync')
  @HttpCode(200)
  @Perm('billing:write')
  async syncNow(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const entityId = this.entity(a, b?.legal_entity_id);
    return this.sync.syncLink(a.tenantId, entityId);
  }

  /** Puts failed journals back in the queue now instead of waiting for their next attempt. */
  @Post('retry')
  @HttpCode(200)
  @Perm('billing:write')
  retry(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const entityId = this.entity(a, b?.legal_entity_id);
    return this.db.withTenant(a, async (c) => ({
      requeued: (await c.query(
        `UPDATE billing.odoo_sync SET next_attempt_at = now() WHERE legal_entity_id = $1 AND status = 'failed'`, [entityId])).rowCount,
    }));
  }
}
