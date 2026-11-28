// tests/payment-voucher-staff-foreign-key-regression.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');

test('Payment Voucher Staff Foreign Key & Payee Separation Regression Suite', async (t) => {
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  // ── 1. Target Voucher State Verification (Strictly Preserved) ───────────────
  await t.test('1. Verify target voucher PV/26-26/031 is untouched and ready for posting', async () => {
    const res = await pool.query(`
      SELECT id, voucher_number, status, is_posted, journal_entry_id, staff_id, payment_purpose, payment_amount
      FROM public.payment_vouchers
      WHERE voucher_number = 'PV/26-26/031'
    `);
    assert.equal(res.rows.length, 1, 'PV/26-26/031 must exist in database');
    const voucher = res.rows[0];
    assert.equal(voucher.status, 'approved', 'PV/26-26/031 must remain in approved status');
    assert.equal(voucher.is_posted, false, 'PV/26-26/031 must NOT be posted automatically');
    assert.equal(voucher.journal_entry_id, null, 'PV/26-26/031 journal_entry_id must remain null');
    assert.equal(voucher.staff_id, '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc', 'PV/26-26/031 must reference Sandi Prasetyo');
    assert.equal(voucher.payment_purpose, 'salary_advance', 'PV/26-26/031 payment_purpose must be salary_advance');
    assert.equal(Number(voucher.payment_amount), 1000000, 'PV/26-26/031 payment_amount must be 1,000,000 IDR');
  });

  // ── 2. Database Schema & Constraint Verification ───────────────────────────
  await t.test('2. Verify journal_entry_lines columns, foreign keys, and indexes', async () => {
    // Check columns
    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'journal_entry_lines'
        AND column_name IN ('staff_id', 'payee_id', 'supplier_id', 'customer_id')
    `);
    const colMap = Object.fromEntries(cols.rows.map(c => [c.column_name, c]));
    assert.ok(colMap.staff_id, 'staff_id column must exist on journal_entry_lines');
    assert.equal(colMap.staff_id.data_type, 'uuid', 'staff_id must be uuid');
    assert.equal(colMap.staff_id.is_nullable, 'YES', 'staff_id must be nullable');
    assert.ok(colMap.payee_id, 'payee_id column must exist on journal_entry_lines');

    // Check FKs
    const fks = await pool.query(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      WHERE conrelid = 'public.journal_entry_lines'::regclass
        AND conname IN ('journal_entry_lines_staff_id_fkey', 'journal_entry_lines_payee_id_fkey')
    `);
    const fkMap = Object.fromEntries(fks.rows.map(f => [f.conname, f.def]));
    assert.ok(fkMap.journal_entry_lines_staff_id_fkey.includes('finance_staff_master(id)'),
      'journal_entry_lines_staff_id_fkey must reference finance_staff_master(id)');
    assert.ok(fkMap.journal_entry_lines_payee_id_fkey.includes('finance_payees(id)'),
      'journal_entry_lines_payee_id_fkey must reference finance_payees(id)');

    // Check Index
    const idx = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'journal_entry_lines'
        AND indexname = 'idx_journal_entry_lines_staff_id'
    `);
    assert.equal(idx.rows.length, 1, 'idx_journal_entry_lines_staff_id index must exist');
  });

  // ── 3. Payee vs Staff Entity Separation ────────────────────────────────────
  await t.test('3. Verify no staff IDs are stored in payee_id on journal_entry_lines', async () => {
    const invalidPayees = await pool.query(`
      SELECT jel.id, jel.payee_id, fsm.full_name, fsm.employee_code
      FROM public.journal_entry_lines jel
      JOIN public.finance_staff_master fsm ON fsm.id = jel.payee_id
      WHERE jel.payee_id IS NOT NULL
    `);
    assert.equal(invalidPayees.rows.length, 0, 'No journal_entry_lines.payee_id can reference finance_staff_master');

    const invalidFks = await pool.query(`
      SELECT count(*) as count
      FROM public.journal_entry_lines jel
      LEFT JOIN public.finance_payees fp ON fp.id = jel.payee_id
      WHERE jel.payee_id IS NOT NULL AND fp.id IS NULL
    `);
    assert.equal(Number(invalidFks.rows[0].count), 0, 'All non-null payee_id values must reference finance_payees');
  });

  // ── 4. Transactional Posting: Employee Salary Advance ──────────────────────
  await t.test('4. Test posting employee salary advance (matching Sandi Prasetyo structure)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const staffId = '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'; // Sandi Prasetyo
      const bankId = 'bfe79829-07d1-48ed-8965-ff9d367d758e'; // IDR bank

      // Insert test payment voucher
      const pvRes = await client.query(`
        INSERT INTO public.payment_vouchers (
          voucher_number, voucher_date, payment_method, bank_account_id,
          amount, payment_amount, party_type, staff_id, payment_purpose,
          status, is_posted, currency_code, transaction_currency, functional_currency, exchange_rate
        ) VALUES (
          'PV/TEST/STAFF-ADV', CURRENT_DATE, 'bank_transfer', $1,
          1000000, 1000000, 'employee', $2, 'salary_advance',
          'approved', false, 'IDR', 'IDR', 'IDR', 1
        ) RETURNING id, voucher_number
      `, [bankId, staffId]);

      const testPvId = pvRes.rows[0].id;

      // Call post_payment_voucher
      await client.query('SELECT public.post_payment_voucher($1)', [testPvId]);

      // Inspect updated voucher
      const checkPv = await client.query('SELECT is_posted, journal_entry_id FROM public.payment_vouchers WHERE id = $1', [testPvId]);
      assert.equal(checkPv.rows[0].is_posted, true, 'Test voucher must be posted');
      assert.ok(checkPv.rows[0].journal_entry_id, 'Test voucher must have journal_entry_id');

      // Inspect journal lines
      const linesRes = await client.query(`
        SELECT jel.line_number, jel.debit, jel.credit, jel.staff_id, jel.payee_id, jel.supplier_id, jel.customer_id, coa.code as coa_code, coa.name as coa_name
        FROM public.journal_entry_lines jel
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE jel.journal_entry_id = $1
        ORDER BY jel.line_number
      `, [checkPv.rows[0].journal_entry_id]);

      assert.equal(linesRes.rows.length, 2, 'Should have exactly 2 journal lines');

      // Line 1: Debit to Staff Advances & Loans (1160)
      const debitLine = linesRes.rows[0];
      assert.equal(debitLine.coa_code, '1160', 'Salary advance must debit COA 1160 (Staff Advances & Loans)');
      assert.equal(Number(debitLine.debit), 1000000, 'Debit amount must be 1,000,000');
      assert.equal(Number(debitLine.credit), 0, 'Credit amount must be 0');
      assert.equal(debitLine.staff_id, staffId, 'Debit line staff_id must match employee');
      assert.equal(debitLine.payee_id, null, 'Debit line payee_id must be null');
      assert.equal(debitLine.supplier_id, null, 'Debit line supplier_id must be null');
      assert.equal(debitLine.customer_id, null, 'Debit line customer_id must be null');

      // Line 2: Credit to Bank Account
      const creditLine = linesRes.rows[1];
      assert.equal(Number(creditLine.credit), 1000000, 'Bank credit must be 1,000,000');
      assert.equal(creditLine.staff_id, null, 'Bank credit line staff_id must be null');
      assert.equal(creditLine.payee_id, null, 'Bank credit line payee_id must be null');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── 5. Transactional Posting: Employee Regular Salary ──────────────────────
  await t.test('5. Test posting employee regular salary (resolves to staff default_gl_account_id / 6100)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const staffId = '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'; // Sandi Prasetyo (has default_gl_account_id -> 6100)
      const bankId = 'bfe79829-07d1-48ed-8965-ff9d367d758e'; // IDR bank

      const pvRes = await client.query(`
        INSERT INTO public.payment_vouchers (
          voucher_number, voucher_date, payment_method, bank_account_id,
          amount, payment_amount, party_type, staff_id, payment_purpose,
          status, is_posted, currency_code, transaction_currency, functional_currency, exchange_rate
        ) VALUES (
          'PV/TEST/STAFF-SAL', CURRENT_DATE, 'bank_transfer', $1,
          2500000, 2500000, 'employee', $2, 'general',
          'approved', false, 'IDR', 'IDR', 'IDR', 1
        ) RETURNING id
      `, [bankId, staffId]);

      const testPvId = pvRes.rows[0].id;
      await client.query('SELECT public.post_payment_voucher($1)', [testPvId]);

      const checkPv = await client.query('SELECT journal_entry_id FROM public.payment_vouchers WHERE id = $1', [testPvId]);
      const linesRes = await client.query(`
        SELECT jel.line_number, jel.debit, jel.credit, jel.staff_id, jel.payee_id, coa.code as coa_code
        FROM public.journal_entry_lines jel
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE jel.journal_entry_id = $1
        ORDER BY jel.line_number
      `, [checkPv.rows[0].journal_entry_id]);

      const debitLine = linesRes.rows[0];
      assert.equal(debitLine.coa_code, '6100', 'Regular salary must resolve to staff default GL / 6100');
      assert.equal(Number(debitLine.debit), 2500000, 'Debit amount must be 2,500,000');
      assert.equal(debitLine.staff_id, staffId, 'staff_id must be assigned to staff');
      assert.equal(debitLine.payee_id, null, 'payee_id must remain null');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── 6. Transactional Posting: Employee Cash Payment ────────────────────────
  await t.test('6. Test posting employee cash payment', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const staffId = '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc';

      const pvRes = await client.query(`
        INSERT INTO public.payment_vouchers (
          voucher_number, voucher_date, payment_method,
          amount, payment_amount, party_type, staff_id, payment_purpose,
          status, is_posted, currency_code, transaction_currency, functional_currency, exchange_rate
        ) VALUES (
          'PV/TEST/STAFF-CASH', CURRENT_DATE, 'cash',
          500000, 500000, 'employee', $1, 'salary_advance',
          'approved', false, 'IDR', 'IDR', 'IDR', 1
        ) RETURNING id
      `, [staffId]);

      const testPvId = pvRes.rows[0].id;
      await client.query('SELECT public.post_payment_voucher($1)', [testPvId]);

      const checkPv = await client.query('SELECT journal_entry_id FROM public.payment_vouchers WHERE id = $1', [testPvId]);
      const linesRes = await client.query(`
        SELECT jel.line_number, jel.debit, jel.credit, jel.staff_id, jel.payee_id, coa.code as coa_code
        FROM public.journal_entry_lines jel
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE jel.journal_entry_id = $1
        ORDER BY jel.line_number
      `, [checkPv.rows[0].journal_entry_id]);

      assert.equal(linesRes.rows[0].staff_id, staffId);
      assert.equal(linesRes.rows[0].payee_id, null);
      assert.ok(['1101', '1102'].includes(linesRes.rows[1].coa_code), 'Credit line must be Cash account');
      assert.equal(Number(linesRes.rows[1].credit), 500000);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── 7. Transactional Posting: Supplier Payment (Party Separation) ───────────
  await t.test('7. Test posting supplier payment retains supplier_id and keeps staff_id null', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const supplierId = '8df2e209-0dc3-4ce4-8359-e619dace1d5f';
      const bankId = 'bfe79829-07d1-48ed-8965-ff9d367d758e';

      const pvRes = await client.query(`
        INSERT INTO public.payment_vouchers (
          voucher_number, voucher_date, payment_method, bank_account_id,
          amount, payment_amount, party_type, supplier_id, payment_purpose,
          status, is_posted, currency_code, transaction_currency, functional_currency, exchange_rate
        ) VALUES (
          'PV/TEST/SUPP-PAY', CURRENT_DATE, 'bank_transfer', $1,
          5000000, 5000000, 'supplier', $2, 'general',
          'approved', false, 'IDR', 'IDR', 'IDR', 1
        ) RETURNING id
      `, [bankId, supplierId]);

      const testPvId = pvRes.rows[0].id;
      await client.query('SELECT public.post_payment_voucher($1)', [testPvId]);

      const checkPv = await client.query('SELECT journal_entry_id FROM public.payment_vouchers WHERE id = $1', [testPvId]);
      const linesRes = await client.query(`
        SELECT jel.line_number, jel.debit, jel.credit, jel.staff_id, jel.payee_id, jel.supplier_id, jel.customer_id
        FROM public.journal_entry_lines jel
        WHERE jel.journal_entry_id = $1
        ORDER BY jel.line_number
      `, [checkPv.rows[0].journal_entry_id]);

      const line1 = linesRes.rows[0];
      assert.equal(line1.supplier_id, supplierId, 'Line 1 must have supplier_id');
      assert.equal(line1.staff_id, null, 'Line 1 staff_id must be null');
      assert.equal(line1.payee_id, null, 'Line 1 payee_id must be null');
      assert.equal(line1.customer_id, null, 'Line 1 customer_id must be null');

      const line2 = linesRes.rows[1];
      assert.equal(line2.supplier_id, null, 'Line 2 party fields must be null');
      assert.equal(line2.staff_id, null, 'Line 2 staff_id must be null');
      assert.equal(line2.payee_id, null, 'Line 2 payee_id must be null');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── 8. Transactional Posting: Customer Refund (Party Separation) ───────────
  await t.test('8. Test posting customer refund retains customer_id and keeps staff_id null', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const customerId = '33bab483-e4b0-4a3a-a0cc-e5309c170ce1';
      const bankId = 'bfe79829-07d1-48ed-8965-ff9d367d758e';

      // Find active 1120 account for customer refund (satisfies pv_supplier_or_account_required)
      const coaRes = await client.query(`SELECT id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true LIMIT 1`);
      const coaId = coaRes.rows[0]?.id;
      assert.ok(coaId, 'COA 1120 must exist for customer refund');

      const pvRes = await client.query(`
        INSERT INTO public.payment_vouchers (
          voucher_number, voucher_date, payment_method, bank_account_id, coa_account_id,
          amount, payment_amount, party_type, customer_id, payment_purpose,
          status, is_posted, currency_code, transaction_currency, functional_currency, exchange_rate
        ) VALUES (
          'PV/TEST/CUST-REF', CURRENT_DATE, 'bank_transfer', $1, $2,
          3000000, 3000000, 'customer', $3, 'general',
          'approved', false, 'IDR', 'IDR', 'IDR', 1
        ) RETURNING id
      `, [bankId, coaId, customerId]);

      const testPvId = pvRes.rows[0].id;
      await client.query('SELECT public.post_payment_voucher($1)', [testPvId]);

      const checkPv = await client.query('SELECT journal_entry_id FROM public.payment_vouchers WHERE id = $1', [testPvId]);
      const linesRes = await client.query(`
        SELECT jel.line_number, jel.debit, jel.credit, jel.staff_id, jel.payee_id, jel.supplier_id, jel.customer_id
        FROM public.journal_entry_lines jel
        WHERE jel.journal_entry_id = $1
        ORDER BY jel.line_number
      `, [checkPv.rows[0].journal_entry_id]);

      const line1 = linesRes.rows[0];
      assert.equal(line1.customer_id, customerId, 'Line 1 must have customer_id');
      assert.equal(line1.staff_id, null, 'Line 1 staff_id must be null');
      assert.equal(line1.payee_id, null, 'Line 1 payee_id must be null');
      assert.equal(line1.supplier_id, null, 'Line 1 supplier_id must be null');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── 9. Transactional Posting: Receipt Voucher Employee Advance Return ───────
  await t.test('9. Test posting receipt voucher with party_type = employee populates staff_id', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const staffId = '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc';
      const bankId = 'bfe79829-07d1-48ed-8965-ff9d367d758e';

      const rvRes = await client.query(`
        INSERT INTO public.receipt_vouchers (
          voucher_number, voucher_date, payment_method, bank_account_id,
          amount, party_type, staff_id,
          is_posted, currency_code, transaction_currency, functional_currency, exchange_rate
        ) VALUES (
          'RV/TEST/STAFF-RET', CURRENT_DATE, 'bank_transfer', $1,
          500000, 'employee', $2,
          false, 'IDR', 'IDR', 'IDR', 1
        ) RETURNING id
      `, [bankId, staffId]);

      const testRvId = rvRes.rows[0].id;
      await client.query('SELECT public.post_receipt_voucher($1)', [testRvId]);

      const checkRv = await client.query('SELECT journal_entry_id FROM public.receipt_vouchers WHERE id = $1', [testRvId]);
      const linesRes = await client.query(`
        SELECT jel.line_number, jel.debit, jel.credit, jel.staff_id, jel.payee_id, coa.code as coa_code
        FROM public.journal_entry_lines jel
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE jel.journal_entry_id = $1
        ORDER BY jel.line_number
      `, [checkRv.rows[0].journal_entry_id]);

      // Credit line is Line 2 (Dr Bank, Cr Advance)
      const creditLine = linesRes.rows[1];
      assert.equal(creditLine.coa_code, '1160', 'Advance return must credit 1160');
      assert.equal(Number(creditLine.credit), 500000);
      assert.equal(creditLine.staff_id, staffId, 'Credit line must carry staff_id');
      assert.equal(creditLine.payee_id, null, 'Credit line payee_id must be null');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── 10. Petty Cash Module Integrity ─────────────────────────────────────────
  await t.test('10. Verify Petty Cash transactions and journals are isolated from payment voucher logic', async () => {
    // Verify that payment vouchers have zero intersection with petty cash transactions
    const crossCheck = await pool.query(`
      SELECT count(*) as count
      FROM public.petty_cash_transactions pct
      JOIN public.payment_vouchers pv ON pct.transaction_number = pv.voucher_number
    `);
    assert.equal(Number(crossCheck.rows[0].count), 0, 'No payment vouchers may cross-link with petty cash transactions');

    // Verify all petty cash journal entries have source_module = 'petty_cash'
    const jeCheck = await pool.query(`
      SELECT count(*) as invalid_count
      FROM public.journal_entries
      WHERE source_module = 'petty_cash' AND reference_number LIKE 'PV/%'
    `);
    assert.equal(Number(jeCheck.rows[0].invalid_count), 0, 'Petty cash journal entries must not reference payment vouchers');
  });

  // ── 11. Final Invariant: PV/26-26/031 Intact ────────────────────────────────
  await t.test('11. Final check that target voucher PV/26-26/031 was never modified', async () => {
    const res = await pool.query(`
      SELECT id, voucher_number, status, is_posted, journal_entry_id, staff_id, payment_purpose, payment_amount
      FROM public.payment_vouchers
      WHERE voucher_number = 'PV/26-26/031'
    `);
    const voucher = res.rows[0];
    assert.equal(voucher.status, 'approved');
    assert.equal(voucher.is_posted, false);
    assert.equal(voucher.journal_entry_id, null);
    assert.equal(voucher.staff_id, '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc');
  });

  await pool.end();
});
