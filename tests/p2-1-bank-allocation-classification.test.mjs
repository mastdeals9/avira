import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.READONLY_AUDIT_DB_URL;
if (!connectionString) {
  throw new Error('SUPABASE_DB_URL environment variable is required');
}

function getDbClient() {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}

test('Priority 2.1 — Bank Allocation Classification Separation & Document-Type Mappings (Rollback-Only)', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  const bankUnlinkFixSql = readFileSync(
    new URL('../supabase/migrations/20261127203000_fix_bank_unlink_matching_status_guard.sql', import.meta.url),
    'utf8'
  );
  const migrationSql = readFileSync(
    new URL('../supabase/migrations/20261127220000_p2_1_bank_allocation_classification.sql', import.meta.url),
    'utf8'
  );

  await t.test('1. Allocation changes preserve bank_statement_lines.payment_kind and enforce canonical document-type categories', async () => {
    await db.query('BEGIN');
    await db.query(bankUnlinkFixSql);
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    const adminId = adminUsers[0].id;

    const { rows: baRows } = await db.query(
      `SELECT bsl.bank_account_id AS id, bsl.upload_id, ba.currency, ba.coa_id
       FROM public.bank_statement_lines bsl
       JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
       WHERE ba.is_active = true AND ba.coa_id IS NOT NULL AND ba.currency = 'IDR'
       LIMIT 1`
    );
    const ba = baRows[0];

    const { rows: offsetAccts } = await db.query(
      `SELECT id FROM public.chart_of_accounts WHERE code = '6100' OR (id <> $1 AND is_active = true AND COALESCE(is_header, false) = false) ORDER BY (code = '6100') DESC LIMIT 1`,
      [ba.coa_id]
    );
    const offsetAcctId = offsetAccts[0].id;

    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminId]);
    await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");

    // Helper: create a posted journal touching bank COA
    const makeJournal = async (entryNum, amt, isCreditBank = true) => {
      const jeId = randomUUID();
      await db.query(
        `INSERT INTO public.journal_entries (id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, is_cancelled, posted_by, created_by)
         VALUES ($1, $2, '2026-11-27', 'journal', $1, $2, $3, $4, $4, true, false, false, $5, $5)`,
        [jeId, entryNum, `Test ${entryNum}`, amt, adminId]
      );
      await db.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
         VALUES ($1, 1, $2, $4, 0), ($1, 2, $3, 0, $4)`,
        [jeId, isCreditBank ? offsetAcctId : ba.coa_id, isCreditBank ? ba.coa_id : offsetAcctId, amt]
      );
      return jeId;
    };

    // A. Salary bank line (payment_kind='salary') linked to a journal -> payment_kind MUST stay 'salary', allocation='other'
    const salaryLineId = randomUUID();
    await db.query(
      `INSERT INTO public.bank_statement_lines (id, upload_id, bank_account_id, currency, transaction_date, description, debit_amount, credit_amount, payment_kind)
       VALUES ($1, $2, $3, $4, '2026-11-27', 'Test Salary Line', 1000, 0, 'salary')`,
      [salaryLineId, ba.upload_id, ba.id, ba.currency]
    );
    const jeSalary = await makeJournal('TST-P21-SAL', 1000, true);
    const { rows: jRes } = await db.query(
      `SELECT public.link_bank_statement_line($1::uuid, 'journal', $2::uuid, NULL, 1000) AS res`,
      [salaryLineId, jeSalary]
    );
    assert.equal(jRes[0].res.payment_kind, 'other');
    const { rows: salAfter } = await db.query(
      `SELECT payment_kind, settlement_payment_kind FROM public.bank_statement_lines WHERE id = $1`,
      [salaryLineId]
    );
    assert.equal(salAfter[0].payment_kind, 'salary', 'Bank Transaction Classification must NOT be overwritten');
    assert.equal(salAfter[0].settlement_payment_kind, 'other');

    // B. _link_native_bank_document preserves bank payment_kind and inserts 'other'
    const nativeLineId = randomUUID();
    await db.query(
      `INSERT INTO public.bank_statement_lines (id, upload_id, bank_account_id, currency, transaction_date, description, debit_amount, credit_amount, payment_kind)
       VALUES ($1, $2, $3, $4, '2026-11-27', 'Test Native Admin Line', 500, 0, 'admin_expense')`,
      [nativeLineId, ba.upload_id, ba.id, ba.currency]
    );
    const jeNative = await makeJournal('TST-P21-NAT', 500, true);
    await db.query('RESET ROLE');
    await db.query(`SELECT public._link_native_bank_document($1::uuid, $2::uuid, 'Native test')`, [nativeLineId, jeNative]);
    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminId]);
    await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");
    const { rows: natAlloc } = await db.query(
      `SELECT payment_kind FROM public.bank_statement_allocations WHERE bank_statement_line_id = $1`,
      [nativeLineId]
    );
    assert.equal(natAlloc[0].payment_kind, 'other');
    const { rows: natLine } = await db.query(
      `SELECT payment_kind FROM public.bank_statement_lines WHERE id = $1`,
      [nativeLineId]
    );
    assert.equal(natLine[0].payment_kind, 'admin_expense');

    // C. Expense supplier allocation on bank line preserves bank payment_kind='tax'
    const { rows: supForExp } = await db.query(`SELECT id FROM public.suppliers LIMIT 1`);
    const expLineId = randomUUID();
    await db.query(
      `INSERT INTO public.bank_statement_lines (id, upload_id, bank_account_id, currency, transaction_date, description, debit_amount, credit_amount, payment_kind)
       VALUES ($1, $2, $3, $4, '2026-11-27', 'Test Expense Alloc', 800, 0, 'tax')`,
      [expLineId, ba.upload_id, ba.id, ba.currency]
    );
    const expId = randomUUID();
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, supplier_id, payment_method, bank_account_id, amount, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'professional_services', $2, 'bank_transfer', $3, 800, '2026-11-27', 'Test Expense Link', 'pending_approval', 'EXP/TST/P21', $4)`,
      [expId, supForExp[0].id, ba.id, adminId]
    );
    await db.query(`SELECT public.approve_finance_expense($1::uuid, $2::uuid)`, [expId, adminId]);
    const { rows: supRes } = await db.query(
      `SELECT public.link_bank_statement_line($1::uuid, 'expense', $2::uuid, 'supplier', 800) AS res`,
      [expLineId, expId]
    );
    assert.equal(supRes[0].res.payment_kind, 'supplier');

    const { rows: expLineAfter } = await db.query(
      `SELECT payment_kind FROM public.bank_statement_lines WHERE id = $1`,
      [expLineId]
    );
    assert.equal(expLineAfter[0].payment_kind, 'tax');

    // D. Unlink and re-link still preserves bank_statement_lines.payment_kind
    await db.query(`SELECT public.unmatch_bank_line($1::uuid)`, [expLineId]);
    const { rows: afterUnlink } = await db.query(
      `SELECT payment_kind, settlement_payment_kind FROM public.bank_statement_lines WHERE id = $1`,
      [expLineId]
    );
    assert.equal(afterUnlink[0].payment_kind, 'tax');
    assert.equal(afterUnlink[0].settlement_payment_kind, null);

    // E. Canonical mapping for receipt, fund_transfer, tax_payment, petty_cash, and payment
    const { rows: docMappings } = await db.query(`
      SELECT
        pg_get_functiondef('public.link_bank_statement_line(uuid,text,uuid,text,numeric)'::regprocedure) AS link_def,
        (SELECT count(*)::int FROM public.bank_statement_allocations
          WHERE payment_kind = 'supplier'
            AND document_type IN ('fund_transfer', 'receipt', 'tax_payment', 'petty_cash', 'journal')) AS remaining_misclassified
    `);
    assert.ok(docMappings[0].link_def.includes("'customer_receipt'"));
    assert.ok(docMappings[0].link_def.includes("'fund_transfer'"));
    assert.ok(docMappings[0].link_def.includes("'tax'"));
    assert.ok(docMappings[0].link_def.includes("'petty_cash'"));
    assert.equal(docMappings[0].remaining_misclassified, 0, 'All non-expense/non-payment supplier allocations must be normalized');

    // F. Receipt voucher linking assigns customer_receipt while preserving bank_statement_lines.payment_kind
    const { rows: custRows } = await db.query(`SELECT id FROM public.customers LIMIT 1`);
    const rcptLineId = randomUUID();
    const rcptId = randomUUID();
    const jeRcpt = await makeJournal('TST-P21-RCPT', 2500, false);
    await db.query(
      `INSERT INTO public.bank_statement_lines (id, upload_id, bank_account_id, currency, transaction_date, description, debit_amount, credit_amount, payment_kind)
       VALUES ($1, $2, $3, $4, '2026-11-27', 'Test Receipt Line', 0, 2500, 'other')`,
      [rcptLineId, ba.upload_id, ba.id, ba.currency]
    );
    await db.query(
      `INSERT INTO public.receipt_vouchers (id, voucher_number, customer_id, voucher_date, bank_account_id, payment_method, amount, journal_entry_id, created_by)
       VALUES ($1, 'RV-TST-P21', $2, '2026-11-27', $3, 'bank_transfer', 2500, $4, $5)`,
      [rcptId, custRows[0].id, ba.id, jeRcpt, adminId]
    );
    const { rows: rcptRes } = await db.query(
      `SELECT public.link_bank_statement_line($1::uuid, 'receipt', $2::uuid, NULL, 2500) AS res`,
      [rcptLineId, rcptId]
    );
    assert.equal(rcptRes[0].res.payment_kind, 'customer_receipt');
    const { rows: rcptLineAfter } = await db.query(
      `SELECT payment_kind, settlement_payment_kind FROM public.bank_statement_lines WHERE id = $1`,
      [rcptLineId]
    );
    assert.equal(rcptLineAfter[0].payment_kind, 'other');
    assert.equal(rcptLineAfter[0].settlement_payment_kind, 'customer_receipt');

    // G. Payment voucher linking assigns supplier while preserving bank_statement_lines.payment_kind
    const { rows: supRows } = await db.query(`SELECT id FROM public.suppliers LIMIT 1`);
    const payLineId = randomUUID();
    const payId = randomUUID();
    const jePay = await makeJournal('TST-P21-PAY', 1500, true);
    await db.query(
      `INSERT INTO public.bank_statement_lines (id, upload_id, bank_account_id, currency, transaction_date, description, debit_amount, credit_amount, payment_kind)
       VALUES ($1, $2, $3, $4, '2026-11-27', 'Test Payment Line', 1500, 0, 'admin_expense')`,
      [payLineId, ba.upload_id, ba.id, ba.currency]
    );
    await db.query(
      `INSERT INTO public.payment_vouchers (id, voucher_number, supplier_id, voucher_date, bank_account_id, payment_method, amount, journal_entry_id, created_by)
       VALUES ($1, 'PV-TST-P21', $2, '2026-11-27', $3, 'bank_transfer', 1500, $4, $5)`,
      [payId, supRows[0].id, ba.id, jePay, adminId]
    );
    const { rows: payRes } = await db.query(
      `SELECT public.link_bank_statement_line($1::uuid, 'payment', $2::uuid, NULL, 1500) AS res`,
      [payLineId, payId]
    );
    assert.equal(payRes[0].res.payment_kind, 'supplier');
    const { rows: payLineAfter } = await db.query(
      `SELECT payment_kind, settlement_payment_kind FROM public.bank_statement_lines WHERE id = $1`,
      [payLineId]
    );
    assert.equal(payLineAfter[0].payment_kind, 'admin_expense');
    assert.equal(payLineAfter[0].settlement_payment_kind, 'supplier');

    await db.query('ROLLBACK');
  });
});
