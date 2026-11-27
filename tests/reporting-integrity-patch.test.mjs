import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;
const connectionString =
  process.env.SUPABASE_DB_URL ||
  'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';

function getDbClient() {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}

test('Reporting Integrity Patch — AP/AR, Cash on Hand, Petty Cash Links & Historical Negative Cash', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  await t.test('1. AP categories reconcile dynamically to GL 2110 and AR reconciles to GL 1120', async () => {
    await db.query('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true)");
    const { rows } = await db.query('SELECT * FROM public.get_control_account_reconciliation(CURRENT_DATE)');
    await db.query('COMMIT');

    const byCode = Object.fromEntries(rows.map((r) => [r.control_code, r]));
    assert.ok(byCode['1120'], '1120 row must exist');
    assert.ok(byCode['2110'], '2110 row must exist');
    assert.ok(byCode['2110-SUPPLIER'], '2110-SUPPLIER category must exist');
    assert.ok(byCode['2110-PAYEE'], '2110-PAYEE category must exist');
    assert.ok(byCode['2110-STATUTORY'], '2110-STATUTORY category must exist');
    assert.ok(byCode['2110-OTHER'], '2110-OTHER category must exist');

    assert.equal(byCode['1120'].status, 'reconciled');
    assert.ok(Math.abs(Number(byCode['1120'].difference)) <= 0.01, `AR diff ${byCode['1120'].difference}`);

    assert.equal(byCode['2110'].status, 'reconciled');
    assert.ok(Math.abs(Number(byCode['2110'].difference)) <= 0.01, `AP diff ${byCode['2110'].difference}`);

    const categorySum =
      Number(byCode['2110-SUPPLIER'].subledger_balance) +
      Number(byCode['2110-PAYEE'].subledger_balance) +
      Number(byCode['2110-STATUTORY'].subledger_balance) +
      Number(byCode['2110-OTHER'].subledger_balance);

    assert.ok(
      Math.abs(categorySum - Number(byCode['2110'].gl_balance)) <= 0.01,
      `Category sum ${categorySum} must match GL 2110 ${byCode['2110'].gl_balance}`
    );
  });

  await t.test('2. Foreign-currency purchase invoices are translated into functional IDR', async () => {
    const { rows } = await db.query(`
      SELECT p.invoice_number, p.currency, p.exchange_rate, p.total_amount,
             ROUND(p.total_amount * COALESCE(NULLIF(p.exchange_rate, 0), 1), 2) AS translated_idr
      FROM public.purchase_invoices p
      JOIN public.journal_entries je ON je.id = p.journal_entry_id
      WHERE p.currency = 'USD'
        AND je.is_posted = true
        AND COALESCE(je.is_reversed, false) = false
        AND COALESCE(je.is_cancelled, false) = false
    `);

    assert.ok(rows.length > 0, 'Expected posted USD purchase invoices');
    for (const row of rows) {
      assert.ok(Number(row.exchange_rate) > 1000, `${row.invoice_number} must carry IDR/USD exchange rate`);
      assert.ok(
        Number(row.translated_idr) > Number(row.total_amount) * 1000,
        `${row.invoice_number} functional IDR (${row.translated_idr}) must be translated from USD (${row.total_amount})`
      );
    }

    await db.query('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true)");
    const { rows: reconRows } = await db.query('SELECT * FROM public.get_control_account_reconciliation(CURRENT_DATE)');
    await db.query('COMMIT');
    const supplierRow = reconRows.find((r) => r.control_code === '2110-SUPPLIER');
    assert.ok(supplierRow, '2110-SUPPLIER row must exist');
    assert.ok(Number(supplierRow.subledger_balance) > 1000000000, 'Supplier subledger must be in functional IDR');
  });

  await t.test('3. Intentional statutory customs reclassification remains outside supplier subledger', async () => {
    const { rows } = await db.query(`
      SELECT jel.supplier_id, jel.debit, jel.credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.entry_number = 'JE2611-RECLASS-PIB-SUBLEDGER'
        AND coa.code = '2110'
        AND je.is_posted = true
        AND COALESCE(je.is_reversed, false) = false
        AND COALESCE(je.is_cancelled, false) = false
    `);

    assert.equal(rows.length, 2, 'JE2611-RECLASS-PIB-SUBLEDGER must have 2 lines on 2110');
    const debitOutOfSupplier = rows.find((r) => Number(r.debit) > 0);
    const creditToStatutory = rows.find((r) => Number(r.credit) > 0);
    assert.ok(debitOutOfSupplier?.supplier_id, 'Debit line removes statutory liability from supplier subledger');
    assert.equal(creditToStatutory?.supplier_id, null, 'Credit line keeps statutory liability outside supplier subledger');
  });

  await t.test('4. Reversed and cancelled journal entries do not affect vw_cash_on_hand_balance', async () => {
    const { rows: viewRows } = await db.query('SELECT * FROM public.vw_cash_on_hand_balance');
    const { rows: directRows } = await db.query(`
      SELECT COALESCE(SUM(jel.debit - jel.credit), 0) AS active_balance
      FROM public.chart_of_accounts coa
      LEFT JOIN public.journal_entry_lines jel ON jel.account_id = coa.id
      LEFT JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE coa.code = '1101'
        AND (
          jel.id IS NULL
          OR (
            je.is_posted = true
            AND COALESCE(je.is_reversed, false) = false
            AND COALESCE(je.is_cancelled, false) = false
          )
        )
    `);

    assert.equal(viewRows.length, 1);
    assert.equal(Number(viewRows[0].balance), Number(directRows[0].active_balance));
    assert.equal(Number(viewRows[0].balance), 0);
  });

  await t.test('5. Payment-voucher-linked petty cash is not falsely reported in missing_petty_cash_links', async () => {
    const { rows: missingRows } = await db.query('SELECT * FROM public.missing_petty_cash_links');
    assert.equal(missingRows.length, 0, `Expected 0 missing_petty_cash_links, found ${missingRows.length}`);

    const { rows: pvLinked } = await db.query(`
      SELECT pct.transaction_number
      FROM public.petty_cash_transactions pct
      JOIN public.payment_vouchers pv ON pv.id = pct.payment_voucher_id
      JOIN public.journal_entries je ON je.id = pv.journal_entry_id
      WHERE pct.approval_status = 'approved'
        AND je.is_posted = true
        AND COALESCE(je.is_reversed, false) = false
        AND COALESCE(je.is_cancelled, false) = false
        AND pct.transaction_number IN ('PC-202609-060', 'PC-202609-061', 'PC-202610-031')
    `);
    assert.equal(pvLinked.length, 3, 'All 3 payment-voucher-linked petty cash rows must remain intact');
  });

  await t.test('6. Historical negative-cash diagnostics exclude cancelled/reversed JEs and are not presented as current closing deficits', async () => {
    const { rows } = await db.query(`
      SELECT n.code, n.diagnostic_scope, n.is_current_closing_deficit, n.closing_balance,
             je.is_reversed, je.is_cancelled
      FROM public.negative_cash_anomalies n
      JOIN public.journal_entries je ON je.id = n.journal_entry_id
    `);

    assert.ok(rows.length > 0, 'Historical running-balance events remain visible as historical warnings');
    for (const row of rows) {
      assert.equal(Boolean(row.is_reversed), false, 'Reversed journals must be excluded');
      assert.equal(Boolean(row.is_cancelled), false, 'Cancelled journals must be excluded');
      if (Number(row.closing_balance) >= 0) {
        assert.equal(row.is_current_closing_deficit, false);
        assert.equal(row.diagnostic_scope, 'historical_running_balance_warning');
      }
    }

    const monitorSrc = readFileSync(new URL('../src/components/finance/IntegrityMonitor.tsx', import.meta.url), 'utf8');
    assert.match(monitorSrc, /is_current_closing_deficit/);
    assert.match(monitorSrc, /Historical warning \(closing positive\)/);
  });
});
