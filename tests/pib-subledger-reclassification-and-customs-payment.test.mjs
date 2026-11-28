import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from '/Users/Kunal/Documents/anzen-main/node_modules/pg/lib/index.js';

const MIGRATION_PATH = 'supabase/migrations/20261103000000_pib_subledger_reclassification_and_customs_payment_clearing.sql';
const DB_URL = process.env.READONLY_AUDIT_DB_URL || (process.env.READONLY_AUDIT_DB_URL || '');

test('1. Category Field Rules: pib_import decouples trade supplier and shows container picker', async () => {
  const rulesFile = fs.readFileSync('src/components/finance/categoryFieldRules.ts', 'utf8');
  assert.ok(rulesFile.includes("const PIB_RULES: CategoryFieldRules = {"), 'Must define PIB_RULES');
  assert.ok(rulesFile.includes("supplier:   'hide'"), 'PIB_RULES must hide trade supplier');
  assert.ok(rulesFile.includes("container:  'show'"), 'PIB_RULES must show container picker');
  assert.ok(rulesFile.includes("payeeLabel: 'Kas Negara (Bea Cukai)'"), 'PIB_RULES must designate Kas Negara');
  assert.ok(rulesFile.includes("if (c === 'pib_import') return PIB_RULES;"), 'Must route pib_import to PIB_RULES');
});

test('2. ExpenseManager Frontend Logic: pib_import enforces supplier_id null and displays statutory badge', () => {
  const managerFile = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');
  assert.ok(
    managerFile.includes("supplier_id: (rules.supplier === 'hide' || isPib || rules.payee === 'show' || (rules.providerTypeToggle && providerType === 'individual')) ? null :"),
    'ExpenseManager payload must strictly force supplier_id to null for pib_import'
  );
  assert.ok(
    managerFile.includes("Kas Negara (Bea Cukai)"),
    'ExpenseManager UI must display Kas Negara (Bea Cukai) statutory label'
  );
  assert.ok(
    managerFile.includes("Customs liabilities do not inherit or affect commercial supplier ledgers"),
    'ExpenseManager UI must explain that customs duties are not vendor payables'
  );
});

test('3. Migration SQL Structural Audit: Idempotency, Admin Identity, and Exact Control Balances', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'Migration file must exist');
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  // Trigger function updates
  assert.ok(sql.includes("CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()"), 'Must update trigger function');
  assert.ok(sql.includes("IF NEW.expense_category='pib_import' THEN"), 'Must handle pib_import explicitly');
  assert.ok(sql.includes("VALUES(v_journal_id,v_line_num,v_payment_account_id,0,NEW.amount,'PIB - Payment ['||COALESCE(NEW.description,'')||']',NULL,NEW.payee_id);"),
    'Trigger must insert payment/AP line with supplier_id = NULL');

  // Deterministic admin identity
  assert.ok(sql.includes("SELECT id INTO v_admin_id \n  FROM public.user_profiles \n  WHERE role = 'admin' AND is_active = true \n  ORDER BY email ASC \n  LIMIT 1;"),
    'Must resolve admin user deterministically, never arbitrary LIMIT 1');

  // Idempotency guards
  assert.ok(sql.includes("IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-RECLASS-PIB-SUBLEDGER')"),
    'Correction A must have idempotency guard');
  assert.ok(sql.includes("IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-PAY-JUL26-DUTY')"),
    'Correction B must have idempotency guard');
  assert.ok(sql.includes("IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-PAY-PREGABALIN-DUTY')"),
    'Correction C must have idempotency guard');

  // Exact balance assertions on Active Trial Balance
  assert.ok(sql.includes("IF v_active_gl2110 <> 5861389183.00 THEN"), 'Must assert Active GL 2110 = 5,861,389,183.00');
  assert.ok(sql.includes("IF v_active_gl111101 <> 1080961657.11 THEN"), 'Must assert Active GL 111101 = 1,080,961,657.11');
  assert.ok(sql.includes("IF v_active_gl1150 <> 874746899.50 THEN"), 'Must assert Active GL 1150 = 874,746,899.50');
  assert.ok(sql.includes("IF v_active_gl1155 <> 194669147.00 THEN"), 'Must assert Active GL 1155 = 194,669,147.00');
  assert.ok(sql.includes("IF v_active_anzen_ap <> 5749719842.00 THEN"), 'Must assert Anzen Exports AP = 5,749,719,842.00');
  assert.ok(sql.includes("IF v_active_unassigned_ap <> 24010141.00 THEN"), 'Must assert active unassigned GL 2110 = 24,010,141.00');
  assert.ok(sql.includes("IF v_statutory_customs_ap <> 43700.00 THEN"), 'Must assert unassigned customs AP residual = 43,700.00');
});

test('4. Live Database Simulation (Transaction Rollback): Idempotency & Post-Correction Parity', async () => {
  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  try {
    await client.query('BEGIN;');

    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

    // Execute Run 1
    await client.query(migrationSql);

    const anzenId = '8df2e209-0dc3-4ce4-8359-e619dace1d5f';

    // Verify balances after Run 1 on Active Trial Balance
    const res1 = await client.query(`
      SELECT 
        (SELECT sum(credit - debit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '2110' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as gl2110,
        (SELECT sum(debit - credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '111101' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as gl111101,
        (SELECT sum(debit - credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '1150' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as gl1150,
        (SELECT sum(debit - credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '1155' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as gl1155,
        (SELECT sum(credit - debit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '2110' AND jel.supplier_id = $1 AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as anzen_ap,
        (SELECT sum(credit - debit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '2110' AND jel.supplier_id IS NULL AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as unassigned_ap
    `, [anzenId]);

    const row1 = res1.rows[0];
    assert.equal(row1.gl2110, '5861389183.00', 'Active GL 2110 must equal 5,861,389,183.00');
    assert.equal(row1.gl111101, '1080961657.11', 'Active GL 111101 must equal 1,080,961,657.11');
    assert.equal(row1.gl1150, '874746899.50', 'Active GL 1150 must equal 874,746,899.50');
    assert.equal(row1.gl1155, '194669147.00', 'Active GL 1155 must equal 194,669,147.00');
    assert.equal(row1.anzen_ap, '5749719842.00', 'Anzen Exports AP must equal 5,749,719,842.00');
    assert.equal(row1.unassigned_ap, '24010141.00', 'Active unassigned GL 2110 must equal 24,010,141.00');
    assert.equal(Number(row1.unassigned_ap) - 23966441, 43700, 'Customs AP residual on NULL must equal 43,700.00');

    // Execute Run 2 (Testing Idempotency within same transaction)
    await client.query(migrationSql);

    const res2 = await client.query(`
      SELECT 
        (SELECT sum(credit - debit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '2110' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as gl2110,
        (SELECT sum(debit - credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '111101' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as gl111101,
        (SELECT sum(debit - credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '1150' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as gl1150,
        (SELECT sum(debit - credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '1155' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as gl1155,
        (SELECT sum(credit - debit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '2110' AND jel.supplier_id = $1 AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as anzen_ap,
        (SELECT sum(credit - debit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE coa.code = '2110' AND jel.supplier_id IS NULL AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)) as unassigned_ap
    `, [anzenId]);

    const row2 = res2.rows[0];
    assert.deepEqual(row1, row2, 'Second execution must produce identical balances without double-posting');

    // Verify bank statement lines matched_entry_id linkage
    const bslCheck = await client.query(`
      SELECT bsl.id, bsl.matched_entry_id, je.entry_number
      FROM bank_statement_lines bsl
      JOIN journal_entries je ON je.id = bsl.matched_entry_id
      WHERE bsl.id IN ('00ecc051-1118-471d-b58c-b57ed5525ac7', '46d73481-2756-4ed2-8036-0f299822decd')
      ORDER BY bsl.transaction_date ASC;
    `);

    assert.equal(bslCheck.rows.length, 2, 'Both bank statement lines must be linked to payment journals');
    assert.equal(bslCheck.rows[0].entry_number, 'JE2611-PAY-PREGABALIN-DUTY');
    assert.equal(bslCheck.rows[1].entry_number, 'JE2611-PAY-JUL26-DUTY');

  } finally {
    // ALWAYS ROLLBACK TO PREVENT PRODUCTION MUTATIONS
    await client.query('ROLLBACK;');
    await client.end();
  }
});
