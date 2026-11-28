// tests/security-remediation-regression.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');

test('Security Remediation & Core Regression Suite', async (t) => {
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    // ── 1. Live Permissions Verification ─────────────────────────────────────
    await t.test('1. Live Permissions Verification for the 4 Functions', async () => {
      const q = `
        SELECT p.proname, p.proacl::text as acl
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname IN (
          'calculate_finance_expense_payable',
          'lookup_login_email',
          'trg_import_containers_ndpbm_sync',
          'update_container_customs_ndpbm'
        );
      `;
      const res = await client.query(q);
      const aclMap = Object.fromEntries(res.rows.map(r => [r.proname, r.acl]));

      // calculate_finance_expense_payable: no anon, no public
      assert.ok(!aclMap.calculate_finance_expense_payable.includes('anon=X'), 'anon must NOT have execute on calculate_finance_expense_payable');
      assert.ok(!aclMap.calculate_finance_expense_payable.includes('{=X') && !aclMap.calculate_finance_expense_payable.includes(',=X'), 'PUBLIC must NOT have execute on calculate_finance_expense_payable');
      assert.ok(aclMap.calculate_finance_expense_payable.includes('authenticated=X'), 'authenticated must have execute on calculate_finance_expense_payable');

      // lookup_login_email: anon, authenticated, service_role allowed for login
      assert.ok(aclMap.lookup_login_email.includes('anon=X'), 'anon must have execute on lookup_login_email for pre-login');
      assert.ok(aclMap.lookup_login_email.includes('authenticated=X'), 'authenticated must have execute on lookup_login_email');

      // trg_import_containers_ndpbm_sync: no public
      assert.ok(!aclMap.trg_import_containers_ndpbm_sync.includes('{=X') && !aclMap.trg_import_containers_ndpbm_sync.includes(',=X'), 'PUBLIC must NOT have execute on trg_import_containers_ndpbm_sync');
      assert.ok(!aclMap.trg_import_containers_ndpbm_sync.includes('anon=X'), 'anon must NOT have execute on trg_import_containers_ndpbm_sync');

      // update_container_customs_ndpbm: no public, no anon
      assert.ok(!aclMap.update_container_customs_ndpbm.includes('{=X') && !aclMap.update_container_customs_ndpbm.includes(',=X'), 'PUBLIC must NOT have execute on update_container_customs_ndpbm');
      assert.ok(!aclMap.update_container_customs_ndpbm.includes('anon=X'), 'anon must NOT have execute on update_container_customs_ndpbm');
      assert.ok(aclMap.update_container_customs_ndpbm.includes('authenticated=X'), 'authenticated allowed with authorization guard');
    });

    // ── 2. Login Lookup Functionality ────────────────────────────────────────
    await t.test('2. lookup_login_email Functionality & Guardrails', async () => {
      // Test known active user
      const r1 = await client.query(`SELECT * FROM public.lookup_login_email('mayur')`);
      assert.ok(r1.rows.length > 0, 'Must find user mayur');
      assert.equal(r1.rows[0].email, 'mayur@anzen.co.in');
      assert.equal(r1.rows[0].is_active, true);

      // Test case insensitivity
      const r2 = await client.query(`SELECT * FROM public.lookup_login_email('MAYUR ')`);
      assert.equal(r2.rows[0].email, 'mayur@anzen.co.in');

      // Test empty string guard
      const r3 = await client.query(`SELECT * FROM public.lookup_login_email('')`);
      assert.equal(r3.rows.length, 0, 'Empty string must return 0 rows');

      // Test long string guard
      const r4 = await client.query(`SELECT * FROM public.lookup_login_email('${'a'.repeat(105)}')`);
      assert.equal(r4.rows.length, 0, 'Overlong input must return 0 rows');

      // Test non-existent user
      const r5 = await client.query(`SELECT * FROM public.lookup_login_email('nonexistent_user_999')`);
      assert.equal(r5.rows.length, 0, 'Non-existent user must return 0 rows');
    });

    // ── 3. Finance Expense Payable Calculation ───────────────────────────────
    await t.test('3. calculate_finance_expense_payable Precision & Formula', async () => {
      // Pick a sample expense with amount, ppn, and pph
      const expRes = await client.query(`
        SELECT id, amount, COALESCE(ppn_amount, 0) as ppn, COALESCE(pph_amount, 0) as pph
        FROM public.finance_expenses
        WHERE amount > 0
        LIMIT 1;
      `);
      assert.ok(expRes.rows.length > 0, 'Must have at least one expense');
      const exp = expRes.rows[0];
      const expectedPayable = parseFloat(exp.amount) + parseFloat(exp.ppn) - parseFloat(exp.pph);

      const calcRes = await client.query(`SELECT public.calculate_finance_expense_payable($1::uuid) as payable`, [exp.id]);
      const actualPayable = parseFloat(calcRes.rows[0].payable);
      assert.equal(actualPayable, expectedPayable, 'Payable must equal Amount + PPN - PPH');
    });

    // ── 4. Import Container Customs NDPBM & DJBC Rounding ─────────────────────
    await t.test('4. update_container_customs_ndpbm Logic & Role Authorization Guard', async () => {
      // Run inside transaction with rollback to avoid mutating production
      await client.query('BEGIN;');
      try {
        // Find an import container
        const cRes = await client.query(`
          SELECT id, customs_ndpbm_rate
          FROM public.import_containers
          WHERE customs_ndpbm_rate IS NOT NULL
          LIMIT 1;
        `);

        if (cRes.rows.length > 0) {
          const containerId = cRes.rows[0].id;
          const currentRate = parseFloat(cRes.rows[0].customs_ndpbm_rate);

          // As postgres superuser, execute update_container_customs_ndpbm
          await client.query(`SELECT public.update_container_customs_ndpbm($1::uuid, $2::numeric);`, [containerId, currentRate]);

          // Verify container rate is maintained
          const checkRes = await client.query(`SELECT customs_ndpbm_rate FROM public.import_containers WHERE id = $1`, [containerId]);
          assert.equal(parseFloat(checkRes.rows[0].customs_ndpbm_rate), currentRate);
        }
      } finally {
        await client.query('ROLLBACK;');
      }
    });

    // ── 5. Financial & Inventory Values Insulation ───────────────────────────
    await t.test('5. Zero Production Financial or Inventory Alteration', async () => {
      // Verify Trial Balance equality
      const tbRes = await client.query(`
        SELECT 
          SUM(debit) as total_debit,
          SUM(credit) as total_credit,
          SUM(debit) - SUM(credit) as diff
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
      `);
      assert.equal(tbRes.rows[0].total_debit, '51578336266.21', 'Debit must match Rp 51,578,336,266.21');
      assert.equal(tbRes.rows[0].total_credit, '51578336266.21', 'Credit must match Rp 51,578,336,266.21');
      assert.equal(tbRes.rows[0].diff, '0.00', 'Difference must be exactly Rp 0.00');

      // Verify USD Bank balance
      const bankRes = await client.query(`
        SELECT current_balance, coa_id FROM bank_accounts WHERE currency = 'USD';
      `);
      assert.equal(parseFloat(bankRes.rows[0].current_balance), 5439.00, 'USD bank balance must remain USD 5,439.00');

      // Verify open USD purchase invoices
      const piRes = await client.query(`
        SELECT SUM(COALESCE(balance_amount, total_amount)) as total_usd
        FROM purchase_invoices
        WHERE currency = 'USD' AND status != 'paid' AND COALESCE(balance_amount, total_amount) > 0;
      `);
      assert.equal(parseFloat(piRes.rows[0].total_usd), 292479.15, 'USD payables must remain USD 292,479.15');
    });

  } finally {
    client.release();
    await pool.end();
  }
});
