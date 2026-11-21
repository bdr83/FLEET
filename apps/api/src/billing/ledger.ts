import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

/**
 * Chart of accounts used by the core. A starting set to be confirmed with each customer's accountant
 * and mapped to their own chart on export. [تخمين]
 */
export const ACCOUNTS = {
  CASH: '1000', BANK: '1010', COD_CUSTODY: '1050', AR: '1100',
  PAYABLE: '2000', DRIVER_REIMBURSEMENT: '2010', TAX: '2200', COD_PAYABLE: '2300',
  REVENUE: '4000',
} as const;
export const EXPENSE_ACCOUNTS: Record<string, string> = {
  fuel: '5010', maintenance: '5020', tires: '5030', insurance: '5040', registration: '5050',
  fines: '5060', tolls: '5070', parking: '5080', washing: '5090', other: '5990',
};
export const ACCOUNT_NAMES: Record<string, string> = {
  '1000': 'الصندوق', '1010': 'البنك', '1050': 'عهدة السائقين (COD)', '1100': 'ذمم العملاء',
  '2000': 'مصروفات مستحقة', '2010': 'مستحقات السائقين (مطالبات)', '2200': 'ضريبة مستحقة', '2300': 'مبالغ COD مستحقة للعملاء',
  '4000': 'إيرادات الخدمات',
  '5010': 'وقود', '5020': 'صيانة', '5030': 'إطارات', '5040': 'تأمين', '5050': 'ترخيص وتسجيل', '5060': 'مخالفات',
  '5070': 'رسوم طرق', '5080': 'مواقف', '5090': 'غسيل', '5990': 'مصروفات أخرى',
};
export const PAYMENT_ACCOUNTS: Record<string, string> = {
  cash: ACCOUNTS.CASH, bank_transfer: ACCOUNTS.BANK, knet: ACCOUNTS.BANK, card: ACCOUNTS.BANK, cheque: ACCOUNTS.BANK,
  other: ACCOUNTS.BANK, cod_offset: ACCOUNTS.COD_PAYABLE,
};

export interface JournalLine { account: string; amount: string | number; customer_id?: string | null; worker_id?: string | null }
export interface Journal {
  tenantId: string; legalEntityId: string; currency: string;
  sourceType: string; sourceId: string; memo?: string | null; lines: JournalLine[];
}

const fils = (v: string | number) => Math.round(Number(v) * 1000);

/** Posts one balanced journal (debit positive, credit negative). The database re-checks balance at commit. */
export async function postJournal(c: PoolClient, j: Journal): Promise<string> {
  const lines = j.lines.filter((l) => fils(l.amount) !== 0);
  if (lines.reduce((s, l) => s + fils(l.amount), 0) !== 0) throw new Error(`journal for ${j.sourceType} is not balanced`);
  const journalId = randomUUID();
  for (const l of lines) {
    await c.query(
      `INSERT INTO billing.ledger_entry (id, tenant_id, legal_entity_id, journal_id, account_code, amount, currency, source_type, source_id, customer_id, worker_id, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), j.tenantId, j.legalEntityId, journalId, l.account, (fils(l.amount) / 1000).toFixed(3), j.currency, j.sourceType, j.sourceId,
       l.customer_id ?? null, l.worker_id ?? null, j.memo ?? null]);
  }
  return journalId;
}

/** Reverses every journal posted for a source (used when voiding an invoice or reversing a payment). */
export async function reverseSource(c: PoolClient, tenantId: string, sourceType: string, sourceId: string, memo: string): Promise<void> {
  const rows = (await c.query(
    `SELECT journal_id, legal_entity_id, account_code, amount::text, currency, customer_id, worker_id FROM billing.ledger_entry
      WHERE source_type = $1 AND source_id = $2 ORDER BY journal_id`, [sourceType, sourceId])).rows;
  const byJournal = new Map<string, typeof rows>();
  for (const r of rows) byJournal.set(r.journal_id, [...(byJournal.get(r.journal_id) ?? []), r]);
  for (const lines of byJournal.values()) {
    await postJournal(c, {
      tenantId, legalEntityId: lines[0].legal_entity_id, currency: lines[0].currency, sourceType: `${sourceType}_reversal`, sourceId, memo,
      lines: lines.map((l) => ({ account: l.account_code, amount: -Number(l.amount), customer_id: l.customer_id, worker_id: l.worker_id })),
    });
  }
}

/**
 * Books an approved expense: debit the expense account, credit the driver (claim to reimburse)
 * or accrued expenses (entered by the office).
 */
export async function postExpense(c: PoolClient, tenantId: string, expenseId: string): Promise<void> {
  const e = (await c.query(
    'SELECT legal_entity_id, category, amount::text, currency, worker_id, client_op_id, status FROM maint.expense WHERE id = $1', [expenseId])).rows[0];
  if (!e || e.status !== 'approved') return;
  const claim = e.client_op_id !== null && e.worker_id !== null;
  await postJournal(c, {
    tenantId, legalEntityId: e.legal_entity_id, currency: e.currency, sourceType: 'expense', sourceId: expenseId, memo: e.category,
    lines: [
      { account: EXPENSE_ACCOUNTS[e.category] ?? EXPENSE_ACCOUNTS.other, amount: e.amount },
      claim ? { account: ACCOUNTS.DRIVER_REIMBURSEMENT, amount: -Number(e.amount), worker_id: e.worker_id }
            : { account: ACCOUNTS.PAYABLE, amount: -Number(e.amount) },
    ],
  });
}

/** Balance of one account for a customer or a worker (debit positive). */
export async function balance(c: PoolClient, account: string, by: { customerId?: string; workerId?: string }): Promise<number> {
  const r = await c.query(
    `SELECT COALESCE(sum(amount), 0)::text AS b FROM billing.ledger_entry
      WHERE account_code = $1 AND ($2::uuid IS NULL OR customer_id = $2) AND ($3::uuid IS NULL OR worker_id = $3)`,
    [account, by.customerId ?? null, by.workerId ?? null]);
  return fils(r.rows[0].b);
}
