import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { v } from '../common/validate';
import { priceTask, Rate, Unit, UNITS } from '../crm/pricing';
import { ACCOUNTS, postJournal, reverseSource } from './ledger';

const COLS = `i.id, i.legal_entity_id, i.customer_id, cu.name AS customer_name, i.number, i.status, i.currency,
  i.period_from::text, i.period_to::text, i.issue_date::text, i.due_date::text,
  i.subtotal::text, i.tax_rate::float, i.tax_amount::text, i.total::text, i.paid_amount::text, (i.total - i.paid_amount)::text AS balance,
  i.notes, i.void_reason, i.created_at`;
const FROM = `billing.invoice i JOIN crm.customer cu ON cu.id = i.customer_id`;
const UNIT_NAMES: Record<string, string> = { task: 'مهمة', km: 'كم', hour: 'ساعة', trip: 'رحلة', m3: 'م³', ton: 'طن', day: 'يوم', month: 'شهر' };

/** Quantities a task carries for pricing, e.g. attributes.quantities = { km: 12.5, m3: 8 }. Defaults to one task. */
function quantitiesOf(attrs: Record<string, unknown>): Partial<Record<Unit, number>> | null {
  const q = attrs?.quantities as Record<string, unknown> | undefined;
  if (q === undefined) return { task: 1 };
  if (!q || typeof q !== 'object') return null;
  const out: Partial<Record<Unit, number>> = {};
  for (const [k, n] of Object.entries(q)) {
    if (!(UNITS as readonly string[]).includes(k) || typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    out[k as Unit] = n;
  }
  return Object.keys(out).length ? out : { task: 1 };
}

/**
 * Invoices: generated from reviewed tasks priced by each task's contract, edited as a draft,
 * then issued with a gapless number and posted to the ledger. Issued invoices are never edited, only voided.
 */
@Controller('v1')
@UseGuards(AuthGuard)
export class InvoicesController {
  constructor(private readonly db: DbService) {}

  @Patch('legal-entities/:id/billing')
  @Perm('org:write')
  settings(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const rate = b?.tax_rate === undefined ? null : typeof b.tax_rate === 'number' && b.tax_rate >= 0 && b.tax_rate <= 100 ? b.tax_rate : (() => { throw new BadRequestException('tax_rate must be 0-100'); })();
    const taxNo = v.str(b?.tax_number, 'tax_number', { max: 40 });
    const prefix = v.str(b?.invoice_prefix, 'invoice_prefix', { max: 8 });
    if (prefix && !/^[A-Z0-9]{1,8}$/.test(prefix)) throw new BadRequestException('invoice_prefix must be A-Z/0-9, up to 8');
    return this.db.withTenant(a, async (c) => {
      const r = await c.query(
        `UPDATE org.legal_entity SET tax_rate = COALESCE($2, tax_rate), tax_number = COALESCE($3, tax_number), invoice_prefix = COALESCE($4, invoice_prefix)
          WHERE id = $1 RETURNING id, name, currency, tax_rate::float, tax_number, invoice_prefix`, [id, rate, taxNo, prefix]);
      if (!r.rowCount) throw new NotFoundException();
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'legal_entity.billing_updated', targetType: 'legal_entity', targetId: id, after: r.rows[0] });
      return r.rows[0];
    });
  }

  @Get('invoices')
  @Perm('billing:read')
  list(@Auth() a: AuthContext, @Query('customer_id') customer?: string, @Query('status') status?: string) {
    const cu = v.uuid(customer, 'customer_id');
    const st = v.oneOf(status, 'status', ['draft', 'issued', 'partially_paid', 'paid', 'void'] as const);
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE ($1::uuid IS NULL OR i.customer_id = $1) AND ($2::text IS NULL OR i.status = $2)
        ORDER BY i.created_at DESC LIMIT 500`, [cu, st])).rows,
    }));
  }

  @Get('invoices/:id')
  @Perm('billing:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.db.withTenant(a, (c) => this.load(c, id));
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * Builds a draft from the customer's reviewed, not yet invoiced tasks completed in the period.
   * Tasks without a contract, or with a quantity the contract does not price, are listed in `skipped`.
   */
  @Post('invoices')
  @Perm('billing:write')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const customerId = v.uuid(b?.customer_id, 'customer_id', { required: true });
    const from = v.date(b?.period_from, 'period_from');
    const to = v.date(b?.period_to, 'period_to');
    if (!from || !to) throw new BadRequestException('period_from and period_to required');
    if (to < from) throw new BadRequestException('period_to is before period_from');
    const notes = v.str(b?.notes, 'notes', { max: 2000 });
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query(
        `SELECT cu.legal_entity_id, le.currency, le.tax_rate, le.timezone FROM crm.customer cu JOIN org.legal_entity le ON le.id = cu.legal_entity_id WHERE cu.id = $1`,
        [customerId])).rows[0];
      if (!cu) throw new BadRequestException('unknown customer_id');
      const tasks = (await c.query(
        `SELECT t.id, t.ref, t.sector_pack, t.contract_id, t.attributes, done.at AS completed_at
           FROM ops.task t
           JOIN LATERAL (SELECT max(occurred_at) AS at FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'completed') done ON true
          WHERE t.customer_id = $1 AND t.status = 'reviewed'
            AND (done.at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
            AND NOT EXISTS (SELECT 1 FROM billing.invoice_line l WHERE l.task_id = t.id AND l.active)
          ORDER BY done.at FOR UPDATE OF t`, [customerId, from, to, cu.timezone])).rows;
      const rates = new Map<string, Rate[]>();
      const skipped: { task_id: string; reason: string }[] = [];
      const lines: { task_id: string; rate_id?: string; description: string; unit: string; qty: number; unit_price: string; amount: string }[] = [];
      for (const t of tasks) {
        if (!t.contract_id) { skipped.push({ task_id: t.id, reason: 'no_contract' }); continue; }
        if (!rates.has(t.contract_id)) {
          rates.set(t.contract_id, (await c.query('SELECT id, sector_pack, unit, price::text, included_qty::text, min_charge::text, description FROM crm.rate WHERE contract_id = $1', [t.contract_id])).rows);
        }
        const qty = quantitiesOf(t.attributes);
        if (!qty) { skipped.push({ task_id: t.id, reason: 'invalid_quantities' }); continue; }
        const quote = priceTask(rates.get(t.contract_id)!, t.sector_pack, qty);
        if (quote.unpriced.length || !quote.lines.length) { skipped.push({ task_id: t.id, reason: `unpriced:${quote.unpriced.join(',') || 'task'}` }); continue; }
        for (const l of quote.lines) {
          lines.push({ task_id: t.id, rate_id: l.rate_id, unit: l.unit, qty: l.qty, unit_price: l.unit_price, amount: l.amount,
            description: `${l.description ?? t.sector_pack.split('@')[0]}${t.ref ? ` (${t.ref})` : ''} · ${UNIT_NAMES[l.unit]}` });
        }
      }
      const id = randomUUID();
      await c.query(
        `INSERT INTO billing.invoice (id, tenant_id, legal_entity_id, customer_id, currency, period_from, period_to, tax_rate, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, a.tenantId, cu.legal_entity_id, customerId, cu.currency, from, to, cu.tax_rate, notes, a.userId]);
      try {
        for (const l of lines) {
          await c.query(
            `INSERT INTO billing.invoice_line (id, tenant_id, invoice_id, task_id, rate_id, description, unit, qty, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [randomUUID(), a.tenantId, id, l.task_id, l.rate_id ?? null, l.description.slice(0, 300), l.unit, l.qty, l.unit_price, l.amount]);
        }
      } catch (e) {
        // another draft took the same tasks at the same moment
        if ((e as { constraint?: string }).constraint === 'invoice_line_task_once') throw new ConflictException('these tasks were just added to another invoice: try again');
        throw e;
      }
      await this.recompute(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'invoice.drafted', targetType: 'invoice', targetId: id, after: { tasks: lines.length, skipped: skipped.length } });
      return { ...(await this.load(c, id)), skipped };
    });
  }

  /** A manual line on a draft (e.g. waiting time, a one-off charge or a discount line at price 0 with a note). */
  @Post('invoices/:id/lines')
  @Perm('billing:write')
  addLine(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const desc = v.str(b?.description, 'description', { required: true, max: 300 })!;
    const qty = typeof b?.qty === 'number' && b.qty > 0 && b.qty <= 1e6 ? b.qty : b?.qty === undefined ? 1 : (() => { throw new BadRequestException('qty must be more than 0'); })();
    const price = v.money(b?.unit_price, 'unit_price', { required: true })!;
    const unit = v.oneOf(b?.unit, 'unit', [...UNITS, 'item'] as const) ?? 'item';
    return this.db.withTenant(a, async (c) => {
      await this.lockDraft(c, id);
      const amount = (Math.round(qty * Math.round(Number(price) * 1000)) / 1000).toFixed(3);
      await c.query(
        `INSERT INTO billing.invoice_line (id, tenant_id, invoice_id, description, unit, qty, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), a.tenantId, id, desc, unit, qty, price, amount]);
      await this.recompute(c, id);
      return this.load(c, id);
    });
  }

  /** Removing a task line from a draft returns the task to the invoicing queue. */
  @Post('invoices/:id/lines/:lineId/remove')
  @HttpCode(200)
  @Perm('billing:write')
  removeLine(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('lineId', new ParseUUIDPipe()) lineId: string) {
    return this.db.withTenant(a, async (c) => {
      await this.lockDraft(c, id);
      const l = (await c.query('SELECT task_id FROM billing.invoice_line WHERE id = $1 AND invoice_id = $2 AND active', [lineId, id])).rows[0];
      if (!l) throw new NotFoundException();
      // all lines of the same task go together, so a task is never half-invoiced
      await c.query('UPDATE billing.invoice_line SET active = false WHERE invoice_id = $1 AND (id = $2 OR (task_id IS NOT NULL AND task_id = $3))', [id, lineId, l.task_id]);
      await this.recompute(c, id);
      return this.load(c, id);
    });
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  @Perm('billing:write')
  issue(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const inv = await this.lockDraft(c, id);
      await this.recompute(c, id);
      const t = (await c.query(
        `SELECT i.subtotal, i.tax_amount, i.total, i.currency, i.legal_entity_id, i.customer_id, le.invoice_prefix, le.timezone, cu.payment_terms_days,
                (SELECT CASE WHEN count(DISTINCT tk.contract_id) = 1 THEN max(k.payment_terms_days) END
                   FROM billing.invoice_line l JOIN ops.task tk ON tk.id = l.task_id JOIN crm.contract k ON k.id = tk.contract_id
                  WHERE l.invoice_id = i.id AND l.active) AS contract_terms
           FROM billing.invoice i JOIN org.legal_entity le ON le.id = i.legal_entity_id JOIN crm.customer cu ON cu.id = i.customer_id WHERE i.id = $1`, [id])).rows[0];
      if (Number(t.total) <= 0) throw new ConflictException('nothing to invoice: add lines first');
      const issueDate = (await c.query('SELECT (now() AT TIME ZONE $1)::date::text AS d', [t.timezone])).rows[0].d as string;
      const year = Number(issueDate.slice(0, 4));
      await c.query(
        `INSERT INTO billing.number_sequence (tenant_id, legal_entity_id, kind, year) VALUES ($1,$2,'invoice',$3) ON CONFLICT DO NOTHING`, [a.tenantId, t.legal_entity_id, year]);
      const seq = (await c.query(
        `UPDATE billing.number_sequence SET last = last + 1 WHERE legal_entity_id = $1 AND kind = 'invoice' AND year = $2 RETURNING last`, [t.legal_entity_id, year])).rows[0].last;
      const number = `${t.invoice_prefix}-${year}-${String(seq).padStart(5, '0')}`;
      const terms = t.contract_terms ?? t.payment_terms_days;
      await c.query(
        `UPDATE billing.invoice SET status = 'issued', number = $2, issue_date = $3, due_date = $3::date + $4::int, issued_by = $5 WHERE id = $1`,
        [id, number, issueDate, terms, a.userId]);
      // the tasks are now invoiced
      const tasks = (await c.query('SELECT DISTINCT task_id FROM billing.invoice_line WHERE invoice_id = $1 AND active AND task_id IS NOT NULL', [id])).rows.map((r) => r.task_id);
      for (const taskId of tasks) {
        await c.query(`UPDATE ops.task SET status = 'invoiced', version = version + 1, updated_at = now() WHERE id = $1 AND status = 'reviewed'`, [taskId]);
        await c.query(
          `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note)
           VALUES ($1,$2,$3,'reviewed','invoiced',now(),$4,'system',$5,$6)`, [randomUUID(), a.tenantId, taskId, a.userId, randomUUID(), number]);
      }
      await postJournal(c, {
        tenantId: a.tenantId, legalEntityId: t.legal_entity_id, currency: t.currency, sourceType: 'invoice', sourceId: id, memo: number,
        lines: [
          { account: ACCOUNTS.AR, amount: t.total, customer_id: t.customer_id },
          { account: ACCOUNTS.REVENUE, amount: -Number(t.subtotal) },
          { account: ACCOUNTS.TAX, amount: -Number(t.tax_amount) },
        ],
      });
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'invoice.issued', targetType: 'invoice', targetId: id, before: inv, after: { number, total: t.total } });
      return this.load(c, id);
    });
  }

  /** Voids a draft, or an issued invoice with no payments (reversing its journal and returning its tasks to "reviewed"). */
  @Post('invoices/:id/void')
  @HttpCode(200)
  @Perm('billing:write')
  voidInvoice(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 });
    return this.db.withTenant(a, async (c) => {
      const inv = (await c.query('SELECT status, number, paid_amount FROM billing.invoice WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw new NotFoundException();
      if (inv.status === 'void') throw new ConflictException('already void');
      if (Number(inv.paid_amount) > 0) throw new ConflictException('reverse the payments on this invoice first');
      const tasks = (await c.query('SELECT DISTINCT task_id FROM billing.invoice_line WHERE invoice_id = $1 AND active AND task_id IS NOT NULL', [id])).rows.map((r) => r.task_id);
      await c.query('UPDATE billing.invoice_line SET active = false WHERE invoice_id = $1', [id]);
      await c.query(`UPDATE billing.invoice SET status = 'void', void_reason = $2 WHERE id = $1`, [id, reason]);
      if (inv.status !== 'draft') {
        await reverseSource(c, a.tenantId, 'invoice', id, `void ${inv.number}`);
        for (const taskId of tasks) {
          await c.query(`UPDATE ops.task SET status = 'reviewed', version = version + 1, updated_at = now() WHERE id = $1 AND status = 'invoiced'`, [taskId]);
          await c.query(
            `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note)
             VALUES ($1,$2,$3,'invoiced','reviewed',now(),$4,'system',$5,$6)`, [randomUUID(), a.tenantId, taskId, a.userId, randomUUID(), `void ${inv.number}`]);
        }
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'invoice.voided', targetType: 'invoice', targetId: id, after: { reason } });
      return this.load(c, id);
    });
  }

  private async lockDraft(c: PoolClient, id: string) {
    const inv = (await c.query('SELECT id, status FROM billing.invoice WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!inv) throw new NotFoundException();
    if (inv.status !== 'draft') throw new ConflictException(`invoice is ${inv.status}: only drafts can change`);
    return inv;
  }

  /** Totals from the active lines. Tax is rounded once, on the subtotal, to 3 decimals. */
  private async recompute(c: PoolClient, id: string) {
    await c.query(
      `UPDATE billing.invoice i SET subtotal = s.sub, tax_amount = round(s.sub * i.tax_rate / 100, 3), total = s.sub + round(s.sub * i.tax_rate / 100, 3)
         FROM (SELECT COALESCE(sum(amount), 0) AS sub FROM billing.invoice_line WHERE invoice_id = $1 AND active) s WHERE i.id = $1`, [id]);
  }

  private async load(c: PoolClient, id: string) {
    const inv = (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE i.id = $1`, [id])).rows[0];
    if (!inv) return null;
    inv.lines = (await c.query(
      `SELECT id, task_id, description, unit, qty::float, unit_price::text, amount::text FROM billing.invoice_line
        WHERE invoice_id = $1 AND (active OR $2) ORDER BY task_id NULLS LAST, unit`, [id, inv.status === 'void'])).rows;
    inv.payments = (await c.query(
      `SELECT p.id, p.received_on::text, p.method, p.reference, al.amount::text FROM billing.payment_allocation al JOIN billing.payment p ON p.id = al.payment_id
        WHERE al.invoice_id = $1 AND al.active ORDER BY p.received_on`, [id])).rows;
    return inv;
  }
}
