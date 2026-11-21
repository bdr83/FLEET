import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { v } from '../common/validate';
import { MAX_AGE_MS, MAX_AHEAD_MS } from '../driver/driver.controller';
import { ACCOUNT_NAMES, ACCOUNTS, balance, PAYMENT_ACCOUNTS, postJournal, reverseSource } from './ledger';

const METHODS = ['cash', 'bank_transfer', 'knet', 'card', 'cheque', 'cod_offset', 'other'] as const;
const fils = (s: string | number) => Math.round(Number(s) * 1000);
const amt = (f: number) => (f / 1000).toFixed(3);

/** Payments and receivables, the cash-on-delivery cycle, and the trial balance. */
@Controller('v1')
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(private readonly db: DbService) {}

  /**
   * Records a customer payment. Allocated to the given invoices, or to the oldest due invoices first.
   * Any remainder stays as customer credit. method=cod_offset pays from COD money held for the customer.
   */
  @Post('payments')
  @Perm('billing:write')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const customerId = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const amount = fils(v.money(b?.amount, 'amount', { required: true, positive: true })!);
    const method = v.oneOf(b?.method, 'method', METHODS, { required: true })!;
    const receivedOn = v.date(b?.received_on, 'received_on');
    const reference = v.str(b?.reference, 'reference', { max: 100 });
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    const alloc = b?.allocations === undefined ? null : Array.isArray(b.allocations) && b.allocations.length <= 100
      ? b.allocations.map((x: Record<string, unknown>, i: number) => ({
          invoice_id: v.uuid(x?.invoice_id, `allocations[${i}].invoice_id`, { required: true })!,
          amount: fils(v.money(x?.amount, `allocations[${i}].amount`, { required: true, positive: true })!),
        }))
      : (() => { throw new BadRequestException('allocations must be a list'); })();
    if (alloc && alloc.reduce((s, x) => s + x.amount, 0) > amount) throw new BadRequestException('allocations exceed the payment');
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query(
        `SELECT cu.legal_entity_id, le.currency, le.timezone FROM crm.customer cu JOIN org.legal_entity le ON le.id = cu.legal_entity_id WHERE cu.id = $1 FOR UPDATE OF cu`,
        [customerId])).rows[0];
      if (!cu) throw new BadRequestException('unknown customer_id');
      if (method === 'cod_offset') {
        const held = -(await balance(c, ACCOUNTS.COD_PAYABLE, { customerId }));
        if (amount > held) throw new ConflictException(`only ${amt(held)} of COD money is held for this customer`);
      }
      const open = (await c.query(
        `SELECT id, (total - paid_amount) AS due FROM billing.invoice
          WHERE customer_id = $1 AND status IN ('issued','partially_paid') ORDER BY due_date, issue_date, number FOR UPDATE`, [customerId])).rows;
      const dueById = new Map(open.map((r) => [r.id as string, fils(r.due)]));
      const plan: { invoice_id: string; amount: number }[] = [];
      if (alloc) {
        for (const x of alloc) {
          const due = dueById.get(x.invoice_id);
          if (due === undefined) throw new BadRequestException(`invoice ${x.invoice_id} is not open for this customer`);
          if (x.amount > due) throw new BadRequestException(`allocation exceeds the balance of invoice ${x.invoice_id}`);
          dueById.set(x.invoice_id, due - x.amount);
          plan.push(x);
        }
      } else {
        let left = amount;
        for (const r of open) {
          if (left <= 0) break;
          const take = Math.min(left, dueById.get(r.id)!);
          if (take > 0) { plan.push({ invoice_id: r.id, amount: take }); left -= take; }
        }
      }
      const id = randomUUID();
      const day = receivedOn ?? (await c.query('SELECT (now() AT TIME ZONE $1)::date::text AS d', [cu.timezone])).rows[0].d;
      await c.query(
        `INSERT INTO billing.payment (id, tenant_id, legal_entity_id, customer_id, amount, currency, received_on, method, reference, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, a.tenantId, cu.legal_entity_id, customerId, amt(amount), cu.currency, day, method, reference, notes, a.userId]);
      for (const p of plan) {
        await c.query('INSERT INTO billing.payment_allocation (id, tenant_id, payment_id, invoice_id, amount) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), a.tenantId, id, p.invoice_id, amt(p.amount)]);
        await this.refreshInvoice(c, p.invoice_id);
      }
      await postJournal(c, {
        tenantId: a.tenantId, legalEntityId: cu.legal_entity_id, currency: cu.currency, sourceType: 'payment', sourceId: id, memo: reference ?? method,
        lines: [
          { account: PAYMENT_ACCOUNTS[method], amount: amt(amount), customer_id: method === 'cod_offset' ? customerId : null },
          { account: ACCOUNTS.AR, amount: -amount / 1000, customer_id: customerId },
        ],
      });
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'payment.posted', targetType: 'payment', targetId: id, after: { amount: amt(amount), method, plan } });
      return this.loadPayment(c, id);
    });
  }

  @Get('payments')
  @Perm('billing:read')
  list(@Auth() a: AuthContext, @Query('customer_id') customer?: string) {
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT p.id, p.customer_id, cu.name AS customer_name, p.amount::text, p.currency, p.received_on::text, p.method, p.reference, p.status,
                (p.amount - COALESCE((SELECT sum(amount) FROM billing.payment_allocation al WHERE al.payment_id = p.id AND al.active), 0))::text AS unallocated
           FROM billing.payment p JOIN crm.customer cu ON cu.id = p.customer_id
          WHERE ($1::uuid IS NULL OR p.customer_id = $1) ORDER BY p.received_on DESC, p.created_at DESC LIMIT 500`, [cu])).rows,
    }));
  }

  /** Reverses a payment (bounced cheque, wrong entry): its journal is reversed and the invoices reopen. */
  @Post('payments/:id/reverse')
  @HttpCode(200)
  @Perm('billing:write')
  reverse(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 });
    return this.db.withTenant(a, async (c) => {
      const p = (await c.query('SELECT status FROM billing.payment WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new NotFoundException();
      if (p.status === 'reversed') throw new ConflictException('already reversed');
      const invoices = (await c.query('UPDATE billing.payment_allocation SET active = false WHERE payment_id = $1 AND active RETURNING invoice_id', [id])).rows;
      await c.query(`UPDATE billing.payment SET status = 'reversed', reverse_reason = $2 WHERE id = $1`, [id, reason]);
      for (const r of invoices) await this.refreshInvoice(c, r.invoice_id);
      await reverseSource(c, a.tenantId, 'payment', id, `reverse: ${reason}`);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'payment.reversed', targetType: 'payment', targetId: id, after: { reason } });
      return this.loadPayment(c, id);
    });
  }

  /** Open balances per customer by days past due, plus unapplied credit. */
  @Get('receivables/aging')
  @Perm('billing:read')
  aging(@Auth() a: AuthContext, @Query('as_of') asOf?: string) {
    const day = v.date(asOf, 'as_of');
    return this.db.withTenant(a, async (c) => ({
      as_of: day ?? (await c.query("SELECT (now() AT TIME ZONE 'Asia/Kuwait')::date::text AS d")).rows[0].d,
      data: (await c.query(
        `WITH d AS (SELECT COALESCE($1::date, (now() AT TIME ZONE 'Asia/Kuwait')::date) AS as_of),
         inv AS (
           SELECT i.customer_id, i.currency, (i.total - i.paid_amount) AS due, (SELECT as_of FROM d) - i.due_date AS late
             FROM billing.invoice i WHERE i.status IN ('issued','partially_paid')
         ), credit AS (
           SELECT p.customer_id, sum(p.amount - COALESCE((SELECT sum(amount) FROM billing.payment_allocation al WHERE al.payment_id = p.id AND al.active), 0)) AS credit
             FROM billing.payment p WHERE p.status = 'posted' GROUP BY p.customer_id
         )
         SELECT cu.id AS customer_id, cu.name, COALESCE(inv.currency, le.currency) AS currency,
                COALESCE(sum(inv.due) FILTER (WHERE inv.late <= 0), 0)::text AS current,
                COALESCE(sum(inv.due) FILTER (WHERE inv.late BETWEEN 1 AND 30), 0)::text AS d1_30,
                COALESCE(sum(inv.due) FILTER (WHERE inv.late BETWEEN 31 AND 60), 0)::text AS d31_60,
                COALESCE(sum(inv.due) FILTER (WHERE inv.late BETWEEN 61 AND 90), 0)::text AS d61_90,
                COALESCE(sum(inv.due) FILTER (WHERE inv.late > 90), 0)::text AS d90_plus,
                COALESCE(sum(inv.due), 0)::text AS total_due,
                COALESCE(max(credit.credit), 0)::text AS credit,
                cu.credit_limit::text, (cu.credit_limit IS NOT NULL AND COALESCE(sum(inv.due), 0) > cu.credit_limit) AS over_limit
           FROM crm.customer cu JOIN org.legal_entity le ON le.id = cu.legal_entity_id
           LEFT JOIN inv ON inv.customer_id = cu.id
           LEFT JOIN credit ON credit.customer_id = cu.id
          GROUP BY cu.id, cu.name, inv.currency, le.currency
         HAVING COALESCE(sum(inv.due), 0) > 0 OR COALESCE(max(credit.credit), 0) > 0
          ORDER BY sum(inv.due) DESC NULLS LAST`, [day])).rows,
    }));
  }

  /** Customer statement from the receivables ledger: opening balance, movements with running balance, closing balance. */
  @Get('customers/:id/statement')
  @Perm('billing:read')
  statement(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from');
    const t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required (YYYY-MM-DD)');
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query('SELECT cu.id, cu.name, le.timezone, le.currency FROM crm.customer cu JOIN org.legal_entity le ON le.id = cu.legal_entity_id WHERE cu.id = $1', [id])).rows[0];
      if (!cu) throw new NotFoundException();
      const opening = (await c.query(
        `SELECT COALESCE(sum(amount), 0)::text AS b FROM billing.ledger_entry WHERE account_code = $1 AND customer_id = $2 AND (posted_at AT TIME ZONE $4)::date < $3::date`,
        [ACCOUNTS.AR, id, f, cu.timezone])).rows[0].b;
      const rows = (await c.query(
        `SELECT (posted_at AT TIME ZONE $5)::date::text AS date, source_type, source_id, memo, amount::text FROM billing.ledger_entry
          WHERE account_code = $1 AND customer_id = $2 AND (posted_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date ORDER BY posted_at, id`,
        [ACCOUNTS.AR, id, f, t, cu.timezone])).rows;
      let run = fils(opening);
      const lines = rows.map((r) => {
        const n = fils(r.amount);
        run += n;
        return { date: r.date, type: r.source_type, source_id: r.source_id, memo: r.memo, debit: n > 0 ? amt(n) : null, credit: n < 0 ? amt(-n) : null, balance: amt(run) };
      });
      return { customer: { id: cu.id, name: cu.name }, currency: cu.currency, from: f, to: t, opening: amt(fils(opening)), lines, closing: amt(run) };
    });
  }

  /**
   * A driver records cash collected from the recipient for the customer (merchant).
   * Booked as driver custody owed to the customer; idempotent on client_op_id.
   */
  @Post('driver/cod')
  @Perm('tasks:update_own')
  collect(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const op = v.uuid(b?.client_op_id, 'client_op_id', { required: true });
    const taskId = v.uuid(b?.task_id, 'task_id', { required: true });
    const amount = v.money(b?.amount, 'amount', { required: true, positive: true })!;
    const at = v.ts(b?.collected_at, 'collected_at') ?? new Date();
    if (at.getTime() < Date.now() - MAX_AGE_MS || at.getTime() > Date.now() + MAX_AHEAD_MS) throw new BadRequestException('collected_at out of range');
    return this.db.withTenant(a, async (c) => {
      const w = (await c.query('SELECT id FROM workforce.worker WHERE user_id = $1', [a.userId])).rows[0];
      if (!w) throw new ForbiddenException('not a field worker in this company');
      const prior = (await c.query('SELECT id, task_id, worker_id, amount::text, currency, collected_at FROM billing.cod_collection WHERE client_op_id = $1', [op])).rows[0];
      if (prior) {
        if (prior.worker_id !== w.id) throw new ConflictException('client_op_id already used');
        return prior;
      }
      const t = (await c.query(
        `SELECT t.status, t.customer_id, t.legal_entity_id, le.currency FROM ops.task t JOIN org.legal_entity le ON le.id = t.legal_entity_id
          WHERE t.id = $1 AND EXISTS (SELECT 1 FROM ops.assignment x WHERE x.task_id = t.id AND x.active AND x.worker_id = $2) FOR UPDATE OF t`,
        [taskId, w.id])).rows[0];
      if (!t) throw new NotFoundException('task not assigned to you');
      if (!t.customer_id) throw new ConflictException('task has no customer to collect for');
      if (!['accepted', 'in_progress', 'completed'].includes(t.status)) throw new ConflictException(`task is ${t.status}`);
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO billing.cod_collection (id, tenant_id, legal_entity_id, task_id, worker_id, customer_id, amount, currency, collected_at, client_op_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, a.tenantId, t.legal_entity_id, taskId, w.id, t.customer_id, amount, t.currency, at, op]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('cash was already recorded for this task');
        throw e;
      }
      await postJournal(c, {
        tenantId: a.tenantId, legalEntityId: t.legal_entity_id, currency: t.currency, sourceType: 'cod_collection', sourceId: id, memo: taskId,
        lines: [
          { account: ACCOUNTS.COD_CUSTODY, amount, worker_id: w.id },
          { account: ACCOUNTS.COD_PAYABLE, amount: -Number(amount), customer_id: t.customer_id },
        ],
      });
      return (await c.query('SELECT id, task_id, worker_id, amount::text, currency, collected_at FROM billing.cod_collection WHERE id = $1', [id])).rows[0];
    });
  }

  /** Cash each driver holds from COD collections and has not yet handed in. */
  @Get('cod/custody')
  @Perm('billing:read')
  custody(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT l.worker_id, w.display_name, l.currency, sum(l.amount)::text AS held FROM billing.ledger_entry l JOIN workforce.worker w ON w.id = l.worker_id
          WHERE l.account_code = $1 GROUP BY l.worker_id, w.display_name, l.currency HAVING sum(l.amount) <> 0 ORDER BY sum(l.amount) DESC`,
        [ACCOUNTS.COD_CUSTODY])).rows,
    }));
  }

  /** A driver hands in COD cash at the office. */
  @Post('cod/deposits')
  @Perm('billing:write')
  deposit(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const workerId = v.uuid(b?.worker_id, 'worker_id', { required: true })!;
    const amount = fils(v.money(b?.amount, 'amount', { required: true, positive: true })!);
    const reference = v.str(b?.reference, 'reference', { max: 100 });
    return this.db.withTenant(a, async (c) => {
      const w = (await c.query('SELECT w.legal_entity_id, le.currency FROM workforce.worker w JOIN org.legal_entity le ON le.id = w.legal_entity_id WHERE w.id = $1 FOR UPDATE OF w', [workerId])).rows[0];
      if (!w) throw new BadRequestException('unknown worker_id');
      const held = await balance(c, ACCOUNTS.COD_CUSTODY, { workerId });
      if (amount > held) throw new ConflictException(`the driver holds only ${amt(held)}`);
      const id = randomUUID();
      await postJournal(c, {
        tenantId: a.tenantId, legalEntityId: w.legal_entity_id, currency: w.currency, sourceType: 'cod_deposit', sourceId: id, memo: reference,
        lines: [{ account: ACCOUNTS.CASH, amount: amt(amount) }, { account: ACCOUNTS.COD_CUSTODY, amount: -amount / 1000, worker_id: workerId }],
      });
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'cod.deposited', targetType: 'worker', targetId: workerId, after: { amount: amt(amount), reference } });
      return { id, worker_id: workerId, amount: amt(amount), held_after: amt(held - amount) };
    });
  }

  /** COD money held for each customer (owed to them until paid out or offset against invoices). */
  @Get('cod/payable')
  @Perm('billing:read')
  payable(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT l.customer_id, cu.name, l.currency, (-sum(l.amount))::text AS owed FROM billing.ledger_entry l JOIN crm.customer cu ON cu.id = l.customer_id
          WHERE l.account_code = $1 GROUP BY l.customer_id, cu.name, l.currency HAVING sum(l.amount) <> 0 ORDER BY sum(l.amount)`,
        [ACCOUNTS.COD_PAYABLE])).rows,
    }));
  }

  /** Pays COD money out to the customer (bank transfer). */
  @Post('cod/payouts')
  @Perm('billing:write')
  payout(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const customerId = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const amount = fils(v.money(b?.amount, 'amount', { required: true, positive: true })!);
    const reference = v.str(b?.reference, 'reference', { max: 100 });
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query('SELECT cu.legal_entity_id, le.currency FROM crm.customer cu JOIN org.legal_entity le ON le.id = cu.legal_entity_id WHERE cu.id = $1 FOR UPDATE OF cu', [customerId])).rows[0];
      if (!cu) throw new BadRequestException('unknown customer_id');
      const owed = -(await balance(c, ACCOUNTS.COD_PAYABLE, { customerId }));
      if (amount > owed) throw new ConflictException(`only ${amt(owed)} is owed to this customer`);
      const id = randomUUID();
      await postJournal(c, {
        tenantId: a.tenantId, legalEntityId: cu.legal_entity_id, currency: cu.currency, sourceType: 'cod_payout', sourceId: id, memo: reference,
        lines: [{ account: ACCOUNTS.COD_PAYABLE, amount: amt(amount), customer_id: customerId }, { account: ACCOUNTS.BANK, amount: -amount / 1000 }],
      });
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'cod.paid_out', targetType: 'customer', targetId: customerId, after: { amount: amt(amount), reference } });
      return { id, customer_id: customerId, amount: amt(amount), owed_after: amt(owed - amount) };
    });
  }

  /** Balance per account for one legal entity (debit positive). Debits and credits always total the same. */
  @Get('ledger/trial-balance')
  @Perm('billing:read')
  trialBalance(@Auth() a: AuthContext, @Query('legal_entity_id') le?: string, @Query('as_of') asOf?: string) {
    const entity = v.uuid(le, 'legal_entity_id', { required: true });
    const day = v.date(asOf, 'as_of');
    return this.db.withTenant(a, async (c) => {
      const e = (await c.query('SELECT currency, timezone FROM org.legal_entity WHERE id = $1', [entity])).rows[0];
      if (!e) throw new NotFoundException();
      const rows = (await c.query(
        `SELECT account_code, sum(amount)::text AS balance FROM billing.ledger_entry
          WHERE legal_entity_id = $1 AND ($2::date IS NULL OR (posted_at AT TIME ZONE $3)::date <= $2::date)
          GROUP BY account_code HAVING sum(amount) <> 0 ORDER BY account_code`, [entity, day, e.timezone])).rows;
      const accounts = rows.map((r) => {
        const n = fils(r.balance);
        return { account: r.account_code, name: ACCOUNT_NAMES[r.account_code] ?? r.account_code, debit: n > 0 ? amt(n) : null, credit: n < 0 ? amt(-n) : null };
      });
      const debit = rows.reduce((s, r) => s + Math.max(0, fils(r.balance)), 0);
      const credit = rows.reduce((s, r) => s + Math.max(0, -fils(r.balance)), 0);
      return { currency: e.currency, as_of: day, accounts, total_debit: amt(debit), total_credit: amt(credit) };
    });
  }

  private async refreshInvoice(c: PoolClient, invoiceId: string) {
    await c.query(
      `UPDATE billing.invoice i SET paid_amount = s.paid,
              status = CASE WHEN s.paid = 0 THEN 'issued' WHEN s.paid >= i.total THEN 'paid' ELSE 'partially_paid' END
         FROM (SELECT COALESCE(sum(amount), 0) AS paid FROM billing.payment_allocation WHERE invoice_id = $1 AND active) s
        WHERE i.id = $1 AND i.status <> 'void'`, [invoiceId]);
  }

  private async loadPayment(c: PoolClient, id: string) {
    const p = (await c.query(
      `SELECT p.id, p.customer_id, p.amount::text, p.currency, p.received_on::text, p.method, p.reference, p.status, p.reverse_reason,
              (p.amount - COALESCE((SELECT sum(amount) FROM billing.payment_allocation al WHERE al.payment_id = p.id AND al.active), 0))::text AS unallocated
         FROM billing.payment p WHERE p.id = $1`, [id])).rows[0];
    p.allocations = (await c.query(
      `SELECT al.invoice_id, i.number, al.amount::text FROM billing.payment_allocation al JOIN billing.invoice i ON i.id = al.invoice_id
        WHERE al.payment_id = $1 AND al.active ORDER BY i.number`, [id])).rows;
    return p;
  }
}
