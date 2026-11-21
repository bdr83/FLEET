/**
 * P8: invoices from reviewed tasks, payments and allocation, receivables, COD cycle and the ledger.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10); // Kuwait date (UTC+3)

(hasDb ? describe : describe.skip)('P8 invoices, receivables and ledger', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let customer: string;
  let driver: { token: string; id: string };
  let invoice: { id: string; number: string };
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = A.access_token) => request(http).get(path).set(auth(token));
  const sync = (task_id: string, to_status: string) =>
    post('/v1/driver/sync', { ops: [{ type: 'task_status', client_op_id: randomUUID(), task_id, to_status, occurred_at: new Date().toISOString() }] }, driver.token).expect(200);

  /** Creates a customer task and takes it to the given stage. */
  async function task(stage: 'assigned' | 'accepted' | 'completed' | 'reviewed', attributes: Record<string, unknown> = {}) {
    const t = (await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1', customer_id: customer, attributes }).expect(201)).body;
    await post(`/v1/tasks/${t.id}/assign`, { version: 1, worker_id: driver.id }).expect(200);
    if (stage === 'assigned') return t.id as string;
    await sync(t.id, 'accepted');
    if (stage === 'accepted') return t.id as string;
    await sync(t.id, 'in_progress');
    await sync(t.id, 'completed');
    if (stage === 'reviewed') {
      const cur = (await get(`/v1/tasks/${t.id}`).expect(200)).body;
      await post(`/v1/tasks/${t.id}/review`, { version: cur.version }).expect(200);
    }
    return t.id as string;
  }
  async function trial() {
    return (await get(`/v1/ledger/trial-balance?legal_entity_id=${A.legal_entity_id}`).expect(200)).body;
  }
  const acct = (tb: { accounts: { account: string; debit: string | null; credit: string | null }[] }, code: string) => tb.accounts.find((x) => x.account === code);

  let t1: string, t2: string, t3: string, notReviewed: string;
  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'فوترة أ');
    B = await onboard(app, 'فوترة ب');
    await request(http).patch(`/v1/legal-entities/${A.legal_entity_id}/billing`).set(auth(A.access_token)).send({ tax_rate: 5, invoice_prefix: 'FA' }).expect(200);
    customer = (await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'متجر الورد', payment_terms_days: 30 }).expect(201)).body.id;
    const k = (await post('/v1/contracts', { customer_id: customer, starts_on: '2026-01-01', payment_terms_days: 15, rates: [
      { unit: 'task', price: '1.250', sector_pack: 'delivery@1' }, { unit: 'km', price: '0.100', included_qty: 5 }] }).expect(201)).body;
    await post(`/v1/contracts/${k.id}/activate`, {}).expect(200);
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'سعد', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, A.tenant.id, phone)).access_token, id: w.id };
    t1 = await task('reviewed');
    t2 = await task('reviewed', { quantities: { task: 1, km: 12 } });
    t3 = await task('reviewed', { quantities: { hour: 2 } });   // the contract has no hourly price
    notReviewed = await task('completed');
  });
  afterAll(async () => app?.close());

  describe('invoices', () => {
    it('drafts from reviewed tasks priced by the contract, and lists what it skipped', async () => {
      const r = await post('/v1/invoices', { customer_id: customer, period_from: today(), period_to: today() }).expect(201);
      expect(r.body).toMatchObject({ status: 'draft', number: null, currency: 'KWD', subtotal: '3.200', tax_rate: 5 });
      expect(r.body.lines.map((l: { task_id: string; amount: string }) => [l.task_id, l.amount]).sort()).toEqual([[t1, '1.250'], [t2, '0.700'], [t2, '1.250']].sort());
      expect(r.body.skipped).toEqual([{ task_id: t3, reason: 'unpriced:hour' }]);
      expect(r.body.lines.map((l: { task_id: string }) => l.task_id)).not.toContain(notReviewed);
      invoice = r.body;
    });
    it('a task is never on two invoices', async () => {
      const r = await post('/v1/invoices', { customer_id: customer, period_from: today(), period_to: today() }).expect(201);
      expect(r.body.lines).toEqual([]);
      await post(`/v1/invoices/${r.body.id}/issue`, {}).expect(409); // nothing to invoice
      await post(`/v1/invoices/${r.body.id}/void`, { reason: 'فارغة' }).expect(200);
    });
    it('manual lines and tax on the subtotal', async () => {
      const r = await post(`/v1/invoices/${invoice.id}/lines`, { description: 'وقت انتظار', qty: 2, unit_price: '0.500' }).expect(201);
      expect(r.body).toMatchObject({ subtotal: '4.200', tax_amount: '0.210', total: '4.410' });
    });
    it('issues with a gapless number, marks tasks invoiced and posts the journal', async () => {
      const r = await post(`/v1/invoices/${invoice.id}/issue`, {}).expect(200);
      expect(r.body).toMatchObject({ status: 'issued', number: `FA-${today().slice(0, 4)}-00001`, issue_date: today(), balance: '4.410' });
      const due = new Date(Date.parse(today()) + 15 * 86_400_000).toISOString().slice(0, 10);
      expect(r.body.due_date).toBe(due); // contract terms (15) win over customer terms (30)
      invoice = r.body;
      expect((await get(`/v1/tasks/${t1}`).expect(200)).body.status).toBe('invoiced');
      await post(`/v1/invoices/${invoice.id}/lines`, { description: 'x', unit_price: '1' }).expect(409);
      const tb = await trial();
      expect(acct(tb, '1100')).toMatchObject({ debit: '4.410' });
      expect(acct(tb, '4000')).toMatchObject({ credit: '4.200' });
      expect(acct(tb, '2200')).toMatchObject({ credit: '0.210' });
      expect(tb.total_debit).toBe(tb.total_credit);
    });
    it('isolation and permissions', async () => {
      await get(`/v1/invoices/${invoice.id}`, B.access_token).expect(404);
      const p = newPhone();
      await post('/v1/members', { phone: p, role_code: 'dispatcher' }).expect(201);
      const disp = (await joinAs(app, A.tenant.id, p)).access_token;
      await get('/v1/invoices', disp).expect(403);
      const q = newPhone();
      await post('/v1/members', { phone: q, role_code: 'accountant' }).expect(201);
      const acc = (await joinAs(app, A.tenant.id, q)).access_token;
      await get('/v1/invoices', acc).expect(200);
    });
  });

  describe('payments and receivables', () => {
    let second: string;
    it('allocates to the oldest invoice and keeps the rest as credit', async () => {
      const p1 = await post('/v1/payments', { customer_id: customer, amount: '3.000', method: 'knet', reference: 'K-1' }).expect(201);
      expect(p1.body.allocations).toEqual([{ invoice_id: invoice.id, number: invoice.number, amount: '3.000' }]);
      expect((await get(`/v1/invoices/${invoice.id}`).expect(200)).body).toMatchObject({ status: 'partially_paid', balance: '1.410' });
      const p2 = await post('/v1/payments', { customer_id: customer, amount: 2, method: 'cash' }).expect(201);
      expect(p2.body).toMatchObject({ unallocated: '0.590' });
      second = p2.body.id;
      expect((await get(`/v1/invoices/${invoice.id}`).expect(200)).body.status).toBe('paid');
      const aging = await get('/v1/receivables/aging').expect(200);
      expect(aging.body.data.find((x: { customer_id: string }) => x.customer_id === customer)).toMatchObject({ total_due: '0', credit: '0.590' });
    });
    it('validates allocations', async () => {
      await post('/v1/payments', { customer_id: customer, amount: '1', method: 'cash', allocations: [{ invoice_id: invoice.id, amount: '0.5' }] }).expect(400); // already paid
      await post('/v1/payments', { customer_id: customer, amount: '1', method: 'bitcoin' }).expect(400);
      await post('/v1/payments', { customer_id: customer, amount: '1', method: 'cod_offset' }).expect(409); // no COD held yet
    });
    it('a paid invoice cannot be voided; reversing a payment reopens it', async () => {
      await post(`/v1/invoices/${invoice.id}/void`, { reason: 'x' }).expect(409);
      const r = await post(`/v1/payments/${second}/reverse`, { reason: 'شيك مرتجع' }).expect(200);
      expect(r.body.status).toBe('reversed');
      expect((await get(`/v1/invoices/${invoice.id}`).expect(200)).body).toMatchObject({ status: 'partially_paid', balance: '1.410' });
      await post(`/v1/payments/${second}/reverse`, { reason: 'x' }).expect(409);
      const aging = await get('/v1/receivables/aging').expect(200);
      expect(aging.body.data.find((x: { customer_id: string }) => x.customer_id === customer)).toMatchObject({ current: '1.410', total_due: '1.410', credit: '0.000' });
    });
    it('the statement shows every movement with a running balance', async () => {
      const r = await get(`/v1/customers/${customer}/statement?from=${today()}&to=${today()}`).expect(200);
      expect(r.body.opening).toBe('0.000');
      expect(r.body.lines.map((l: { type: string; debit: string | null; credit: string | null; balance: string }) => [l.type, l.debit ?? `-${l.credit}`, l.balance])).toEqual([
        ['invoice', '4.410', '4.410'], ['payment', '-3.000', '1.410'], ['payment', '-2.000', '-0.590'], ['payment_reversal', '2.000', '1.410'],
      ]);
      expect(r.body.closing).toBe('1.410');
    });
  });

  describe('cash on delivery', () => {
    let codTask: string;
    it('the driver records cash collected; it is held by the driver and owed to the customer', async () => {
      codTask = await task('accepted');
      const op = randomUUID();
      const r = await post('/v1/driver/cod', { client_op_id: op, task_id: codTask, amount: '10.000' }, driver.token).expect(201);
      const again = await post('/v1/driver/cod', { client_op_id: op, task_id: codTask, amount: '10.000' }, driver.token).expect(201);
      expect(again.body.id).toBe(r.body.id);
      await post('/v1/driver/cod', { client_op_id: randomUUID(), task_id: codTask, amount: '1' }, driver.token).expect(409);
      await post('/v1/driver/cod', { client_op_id: randomUUID(), task_id: t1, amount: '1' }, driver.token).expect(409); // invoiced task
      const custody = await get('/v1/cod/custody').expect(200);
      expect(custody.body.data).toEqual([expect.objectContaining({ worker_id: driver.id, held: '10.000' })]);
      const payable = await get('/v1/cod/payable').expect(200);
      expect(payable.body.data).toEqual([expect.objectContaining({ customer_id: customer, owed: '10.000' })]);
    });
    it('the driver hands in cash at the office, never more than held', async () => {
      const r = await post('/v1/cod/deposits', { worker_id: driver.id, amount: '4.000', reference: 'إيصال 12' }).expect(201);
      expect(r.body.held_after).toBe('6.000');
      await post('/v1/cod/deposits', { worker_id: driver.id, amount: '7' }).expect(409);
    });
    it('COD money can settle the customer invoice, and the rest is paid out', async () => {
      const off = await post('/v1/payments', { customer_id: customer, amount: '1.410', method: 'cod_offset' }).expect(201);
      expect(off.body.allocations[0]).toMatchObject({ invoice_id: invoice.id, amount: '1.410' });
      expect((await get(`/v1/invoices/${invoice.id}`).expect(200)).body.status).toBe('paid');
      await post('/v1/cod/payouts', { customer_id: customer, amount: '9' }).expect(409);
      const p = await post('/v1/cod/payouts', { customer_id: customer, amount: '8.590', reference: 'TRF-9' }).expect(201);
      expect(p.body.owed_after).toBe('0.000');
      expect((await get('/v1/cod/payable').expect(200)).body.data).toEqual([]);
    });
  });

  describe('voiding and the books', () => {
    it('voiding an issued unpaid invoice reverses it and frees its tasks', async () => {
      const t4 = await task('reviewed');
      const d = (await post('/v1/invoices', { customer_id: customer, period_from: today(), period_to: today() }).expect(201)).body;
      expect(d.lines.map((l: { task_id: string }) => l.task_id)).toEqual([t4]);
      const issued = (await post(`/v1/invoices/${d.id}/issue`, {}).expect(200)).body;
      expect(issued.number).toBe(`FA-${today().slice(0, 4)}-00002`);
      await post(`/v1/invoices/${d.id}/void`, {}).expect(400);
      const v = await post(`/v1/invoices/${d.id}/void`, { reason: 'خطأ في الكمية' }).expect(200);
      expect(v.body.status).toBe('void');
      expect((await get(`/v1/tasks/${t4}`).expect(200)).body.status).toBe('reviewed');
      const again = (await post('/v1/invoices', { customer_id: customer, period_from: today(), period_to: today() }).expect(201)).body;
      expect(again.lines.map((l: { task_id: string }) => l.task_id)).toEqual([t4]);
    });
    it('approved expenses are booked and the trial balance stays balanced', async () => {
      await post('/v1/expenses', { category: 'fuel', amount: '5.000', legal_entity_id: A.legal_entity_id }).expect(201);
      const tb = await trial();
      expect(acct(tb, '5010')).toMatchObject({ debit: '5.000' });
      expect(acct(tb, '2000')).toMatchObject({ credit: '5.000' });
      expect(acct(tb, '1100')).toBeUndefined();          // the customer owes nothing now
      expect(acct(tb, '1050')).toMatchObject({ debit: '6.000' }); // cash still with the driver
      expect(tb.total_debit).toBe(tb.total_credit);
    });
  });
});
