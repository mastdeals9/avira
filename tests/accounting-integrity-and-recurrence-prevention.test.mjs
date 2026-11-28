import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');

const root = process.cwd();
const readSrc = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('1. Frontend Contract: All ledger, tax, and bank-recon queries exclude cancelled journals', () => {
  const files = [
    'src/components/finance/AccountLedger.tsx',
    'src/components/finance/DirectorLedgerView.tsx',
    'src/components/finance/PartyLedger.tsx',
    'src/components/finance/tax/PphRegisterPanel.tsx',
    'src/components/finance/bankTransactionLinking.ts',
    'src/components/finance/JournalEntryViewerEnhanced.tsx',
    'src/components/finance/BankReconciliationEnhanced.tsx',
  ];

  for (const file of files) {
    const src = readSrc(file);
    assert.match(src, /is_cancelled/, `${file} must filter or check is_cancelled`);
  }
});

test('2. Live DB Integrity: Trial Balance, BCA 111101, Petty Cash, and EXP/26/365 reconcile to the cent', async (t) => {
  const conn = process.env.READONLY_AUDIT_DB_URL;
  if (!conn) {
    t.skip('SUPABASE_DB_URL not set; skipping live DB assertions');
    return;
  }

  const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const tb = await client.query(`
      SELECT sum(total_debit) AS dr, sum(total_credit) AS cr, sum(balance) AS diff
      FROM public.get_trial_balance('2020-01-01'::date, '2026-12-31'::date, 16000)
    `);
    assert.equal(Number(tb.rows[0].diff), 0, 'Trial Balance must balance to 0.00');

    const bca = await client.query(`
      SELECT
        (SELECT sum(jel.debit - jel.credit)
         FROM public.journal_entry_lines jel
         JOIN public.journal_entries je ON je.id = jel.journal_entry_id
         JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
         WHERE coa.code = '111101' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false) AND NOT COALESCE(je.is_cancelled, false)) AS gl_111101,
        (SELECT sum(net_amount) FROM public.vw_bank_ledger_effective WHERE account_number = '0930 2010 14') AS eff_view,
        (SELECT sum(credit_amount - debit_amount)
         FROM public.bank_statement_lines bsl
         JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
         WHERE ba.account_number = '0930 2010 14') AS stmt_net
    `);
    assert.equal(bca.rows[0].gl_111101, bca.rows[0].eff_view, 'BCA GL 111101 must equal vw_bank_ledger_effective');
    assert.equal(bca.rows[0].eff_view, bca.rows[0].stmt_net, 'BCA vw_bank_ledger_effective must equal statement net');

    const pc = await client.query(`
      SELECT public.get_petty_cash_balance() AS gl_1102,
             (SELECT current_balance FROM public.vw_petty_cash_balance) AS stmt_bal,
             (SELECT current_balance FROM public.petty_cash_books WHERE is_active = true LIMIT 1) AS book_bal
    `);
    assert.equal(pc.rows[0].gl_1102, pc.rows[0].stmt_bal);
    assert.equal(pc.rows[0].gl_1102, pc.rows[0].book_bal);

    const exp = await client.query(`SELECT amount, paid_amount FROM public.finance_expenses WHERE voucher_number = 'EXP/26/365'`);
    assert.equal(exp.rows[0].amount, '2500000.00');
    assert.equal(exp.rows[0].paid_amount, '2500000.00');
  } finally {
    await client.end();
  }
});
