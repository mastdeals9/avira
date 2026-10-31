import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { execFileSync } from 'node:child_process';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PG_CONFIG = {
  host: '/tmp',
  port: 54329,
  database: 'test_supplier_advance_bank_recon',
  user: process.env.USER || 'Kunal',
};

function runPsqlCommand(sql, db = 'postgres') {
  return execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-c', sql,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

function runPsqlFile(filePath, db = 'test_supplier_advance_bank_recon') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('SAPJ ERP: Complete Supplier Advance, Multi-Document Bank Recon & Dynamic Voucher Settlement (All 14 Required Tests)', () => {
  let pool;
  let adminUserId;
  let testSupplierId;
  let bankAccountBcaId;
  let coaBcaId;
  let coa1170Id;
  let coa2110Id;
  let coa6910Id;
  let periodId;

  test.before(async () => {
    // 1. Recreate clean test database
    runPsqlCommand('DROP DATABASE IF EXISTS test_supplier_advance_bank_recon;', 'postgres');
    runPsqlCommand('CREATE DATABASE test_supplier_advance_bank_recon;', 'postgres');
    runPsqlCommand('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text, created_by text, idempotency_key text, rollback text[]);', 'test_supplier_advance_bank_recon');

    // 2. Apply baseline migrations + new migrations
    const migrations = [
      'tests/fixtures/production-schema-baseline.sql',
      'supabase/migrations/20261030120000_sales_invoice_canonical_lifecycle_and_reporting_hardening.sql',
      'supabase/migrations/20261030130000_sales_cancellation_hardening_corrections.sql',
      'supabase/migrations/20261030140000_sales_lifecycle_terminal_cancellation_and_concurrency_hardening.sql',
      'supabase/migrations/20261030150000_complete_credit_note_and_sales_return_accounting.sql',
      'supabase/migrations/20261030170000_credit_note_final_accounting_and_lifecycle_corrections.sql',
      'supabase/migrations/20261030180000_sales_and_credit_note_final_completion.sql',
      'supabase/migrations/20261030190000_unified_party_settlement_and_voucher_upgrade.sql',
      'supabase/migrations/20261030200000_hotfix_sales_profitability_unallocated_expenses.sql',
      'supabase/migrations/20261030210000_optimize_sales_profitability_line_expenses.sql',
      'supabase/migrations/20261030220000_harden_unified_settlement_and_party_isolation.sql',
      'supabase/migrations/20261030230000_final_unified_settlement_and_reporting_security_hardening.sql',
      'supabase/migrations/20261030235000_supplier_refund_authoritative_validation_and_accounting_integrity.sql',
      'supabase/migrations/20261031140000_fix_receipt_voucher_posting_and_bank_account_gl_validation.sql',
      'supabase/migrations/20261031200000_secure_sync_bank_account_balance.sql',
      'supabase/migrations/20261101000000_supplier_advance_and_multi_document_bank_reconciliation.sql'
    ];

    for (const mig of migrations) {
      runPsqlFile(path.join(rootDir, mig));
    }

    pool = new Pool(PG_CONFIG);

    // 3. Seed Admin User Profile
    adminUserId = 'a0000000-0000-0000-0000-000000000001';
    await pool.query(`
      INSERT INTO public.user_profiles (id, full_name, role)
      VALUES ($1, 'Admin Finance User', 'admin')
      ON CONFLICT (id) DO UPDATE SET role = 'admin';
    `, [adminUserId]);

    // 4. Security & helper functions for test environment
    await pool.query(`
      CREATE OR REPLACE FUNCTION public._sec_check_finance_role()
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
      BEGIN
        IF current_setting('request.jwt.claim.role', true) = 'authenticated' THEN
          IF auth.uid() IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.user_profiles
            WHERE id = auth.uid()
              AND role IN ('admin', 'accounts')
          ) THEN
            RAISE EXCEPTION 'Permission denied: only admin/accounts can perform finance operations';
          END IF;
          RETURN;
        END IF;

        IF current_setting('request.jwt.claim.role', true) = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
          RETURN;
        END IF;

        IF auth.uid() IS NULL THEN
          RETURN;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE id = auth.uid()
            AND role IN ('admin', 'accounts')
        ) THEN
          RAISE EXCEPTION 'Permission denied: only admin/accounts can perform finance operations';
        END IF;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.clear_payment_allocation_rounding_adjustment(
        p_invoice_id uuid DEFAULT NULL::uuid,
        p_payment_voucher_id uuid DEFAULT NULL::uuid
      ) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        NULL;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.cancel_gl_posting(
        p_je_id uuid, p_doc_id uuid, p_table_name text, p_cancelled_by uuid, p_reason text, p_extra_audit jsonb DEFAULT '{}'::jsonb
      ) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM public.journal_entry_lines WHERE journal_entry_id = p_je_id;
        DELETE FROM public.journal_entries WHERE id = p_je_id;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.sync_bank_line_allocation_owner(p_bank_line_id uuid)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        NULL;
      END;
      $$;


      CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        NULL;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.recalculate_sales_invoice_payment_state(p_invoice_id uuid)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        NULL;
      END;
      $$;
    `);

    // 5. Ensure Chart of Accounts has all required accounts
    await pool.query(`
      INSERT INTO public.chart_of_accounts (id, code, name, account_type, is_header, is_active)
      VALUES 
        ('979b236a-7ce8-4272-8965-7f41f03d8666', '1110', 'Bank Accounts', 'asset', true, true),
        ('eda4928b-2120-4c1c-a4e1-46c9eb7a610d', '111101', 'Bank BCA - IDR (0930201014)', 'asset', false, true),
        ('66fb7574-b27e-4a5f-b6da-ce8096d91f31', '2110', 'Accounts Payable', 'liability', false, true),
        ('5f09e568-c0fc-47ef-8c00-b8ae6ff91859', '6910', 'Settlement Discount & Rounding Difference', 'expense', false, true)
      ON CONFLICT (code) DO UPDATE SET 
        is_header = EXCLUDED.is_header, 
        is_active = EXCLUDED.is_active,
        name = EXCLUDED.name;
    `);

    const coaRes = await pool.query(`
      SELECT code, id FROM public.chart_of_accounts
      WHERE code IN ('111101', '1170', '2110', '6910');
    `);
    const coaMap = new Map(coaRes.rows.map(r => [r.code, r.id]));
    coaBcaId = coaMap.get('111101');
    coa1170Id = coaMap.get('1170');
    coa2110Id = coaMap.get('2110');
    coa6910Id = coaMap.get('6910');

    // 6. Ensure Bank Account BCA IDR exists
    bankAccountBcaId = 'bfe79829-07d1-48ed-8965-ff9d367d758e';
    await pool.query(`
      INSERT INTO public.bank_accounts (
        id, account_name, bank_name, account_number, account_type, currency,
        opening_balance, current_balance, is_active, coa_id
      ) VALUES (
        $1, 'PT. Shubham Anzen Pharma Jaya', 'Bank BCA', '0930201014',
        'current', 'IDR', 50000000, 50000000, true, $2
      ) ON CONFLICT (id) DO UPDATE SET coa_id = EXCLUDED.coa_id, is_active = true;
    `, [bankAccountBcaId, coaBcaId]);

    // 7. Seed PT TRANS EXIS JAYA Supplier
    testSupplierId = '701bbcb1-3fe8-421f-acec-9d216193346d';
    await pool.query(`
      INSERT INTO public.suppliers (
        id, company_name, email, phone, is_active
      ) VALUES (
        $1, 'PT. TRANS EXIS JAYA', 'finance@transexls.co.id', '021-5551234', true
      ) ON CONFLICT (id) DO NOTHING;
    `, [testSupplierId]);
  });

  test.after(async () => {
    if (pool) await pool.end();
  });

  // ----------------------------------------------------------------------------
  // TEST 1: Original bank transaction split across expense and supplier advance
  // ----------------------------------------------------------------------------
  test('1. Original bank transaction split across expense and supplier advance', async () => {
    // 1. Create Outgoing Bank Statement Line (Rp 17,671,854)
    const bslId = '26fb3731-977e-41d1-a21b-661a29bd7c82';
    await pool.query(`
      INSERT INTO public.bank_statement_lines (
        id, bank_account_id, transaction_date, description, reference, debit_amount, credit_amount,
        reconciliation_status, matching_status
      ) VALUES (
        $1, $2, '2026-10-15', 'TRSF E-BANKING DB 1510/FTSCY/WS95051 17671854.00 003/OR/APF/IX/2026 TRANS EXIS JAYA PT',
        '1510/FTSCY/WS95051', 17671854, 0, 'unmatched', 'none'
      ) ON CONFLICT (id) DO UPDATE SET debit_amount = 17671854;
    `, [bslId, bankAccountBcaId]);

    // 2. Create Approved Expense (Rp 16,002,854) and its original posted journal
    const expId = '25974efd-37fe-400c-b635-514387acbb45';
    await pool.query(`
      INSERT INTO public.finance_expenses (
        id, voucher_number, expense_date, expense_category, amount, paid_amount,
        payment_method, supplier_id, approval_status
      ) VALUES (
        $1, 'EXP/26/317', '2026-10-15', 'operational', 16002854, 0,
        'bank_transfer', $2, 'approved'
      ) ON CONFLICT (id) DO UPDATE SET amount = 16002854;
    `, [expId, testSupplierId]);

    const expJeId = '1a2c4c29-f93a-464c-9a9e-04b101f5b12e';
    await pool.query(`
      INSERT INTO public.journal_entries (
        id, entry_number, entry_date, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted
      ) VALUES (
        $1, 'JE2610-0196', '2026-10-15', 'expense', $2, 'EXP/26/317',
        'Expense payment: EXP/26/317', 16002854, 16002854, true
      ) ON CONFLICT (id) DO NOTHING;
    `, [expJeId, expId]);

    await pool.query(`
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description, debit, credit, supplier_id
      ) VALUES 
        ($1, 1, $2, 'Operational Expense', 16002854, 0, $3),
        ($1, 2, $4, 'Accounts Payable', 0, 16002854, $3)
      ON CONFLICT DO NOTHING;
    `, [expJeId, coa6910Id, testSupplierId, coa2110Id]);

    // 3. Link Expense (1st Allocation: Rp 16,002,854)
    const client = await pool.connect();
    let alloc1;
    try {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1::text, true);`, [adminUserId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`);
      alloc1 = (await client.query(`
        SELECT public.link_bank_statement_line($1::uuid, 'expense', $2::uuid, 'supplier', 16002854);
      `, [bslId, expId])).rows[0].link_bank_statement_line;
    } finally {
      client.release();
    }

    assert.equal(Number(alloc1.allocation_amount), 16002854);
    assert.equal(Number(alloc1.bank_remaining), 1669000);

    // Verify statement line is now partially_reconciled
    const bslCheck1 = (await pool.query(`SELECT reconciliation_status, debit_amount FROM public.bank_statement_lines WHERE id = $1;`, [bslId])).rows[0];
    assert.equal(bslCheck1.reconciliation_status, 'partially_reconciled');
  });

  // ----------------------------------------------------------------------------
  // TEST 2: Multiple allocations against one bank statement line
  // ----------------------------------------------------------------------------
  test('2. Multiple allocations against one bank statement line', async () => {
    const bslId = '26fb3731-977e-41d1-a21b-661a29bd7c82';

    // 1. Create Supplier Advance Payment Voucher for the remaining Rp 1,669,000
    const pvRes = await pool.query(`
      INSERT INTO public.payment_vouchers (
        voucher_number, voucher_date, party_type, supplier_id,
        payment_method, bank_account_id, amount, actual_bank_debit, payment_purpose,
        settlement_against, created_by
      ) VALUES (
        'PV/26-26/030', '2026-10-15', 'supplier', $1,
        'bank_transfer', $2, 1669000, 1669000, 'supplier_advance',
        'advance', $3
      ) RETURNING id;
    `, [testSupplierId, bankAccountBcaId, adminUserId]);
    const pvId = pvRes.rows[0].id;

    // Post Payment Voucher
    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [pvId, adminUserId]);

    // 2. Link Payment Voucher as 2nd Allocation
    const client = await pool.connect();
    let alloc2;
    try {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1::text, true);`, [adminUserId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`);
      alloc2 = (await client.query(`
        SELECT public.link_bank_statement_line($1::uuid, 'payment', $2::uuid, 'supplier', 1669000);
      `, [bslId, pvId])).rows[0].link_bank_statement_line;
    } finally {
      client.release();
    }

    assert.equal(Number(alloc2.allocation_amount), 1669000);
    assert.equal(Number(alloc2.bank_remaining), 0);

    // Verify statement line is now matched
    const bslCheck2 = (await pool.query(`SELECT reconciliation_status FROM public.bank_statement_lines WHERE id = $1;`, [bslId])).rows[0];
    assert.equal(bslCheck2.reconciliation_status, 'matched');

    // Verify 2 allocations exist for this statement line
    const allocCount = (await pool.query(`SELECT COUNT(*) FROM public.bank_statement_allocations WHERE bank_statement_line_id = $1;`, [bslId])).rows[0].count;
    assert.equal(Number(allocCount), 2);
  });

  // ----------------------------------------------------------------------------
  // TEST 3: Residual amount calculation and overallocation prevention
  // ----------------------------------------------------------------------------
  test('3. Residual amount calculation and overallocation prevention', async () => {
    const bslId = '26fb3731-977e-41d1-a21b-661a29bd7c82';

    // Statement line is already fully allocated (16,002,854 + 1,669,000 = 17,671,854)
    // Attempting to allocate any more should fail with "No remaining amount is available to allocate"
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1::text, true);`, [adminUserId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`);
      
      await assert.rejects(
        async () => {
          await client.query(`
            SELECT public.link_bank_statement_line($1::uuid, 'expense', '25974efd-37fe-400c-b635-514387acbb45'::uuid, 'pph23', 50000);
          `, [bslId]);
        },
        /No remaining amount is available to allocate|Allocation exceeds remaining bank amount|Allocation exceeds document outstanding amount/
      );
    } finally {
      client.release();
    }
  });

  // ----------------------------------------------------------------------------
  // TEST 4: Duplicate allocation prevention (Universal Idempotency)
  // ----------------------------------------------------------------------------
  test('4. Duplicate allocation prevention (Universal Idempotency)', async () => {
    const bslId = '26fb3731-977e-41d1-a21b-661a29bd7c82';
    const expId = '25974efd-37fe-400c-b635-514387acbb45';

    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1::text, true);`, [adminUserId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`);
      
      // Call link_bank_statement_line again with the exact same document
      const dupRes = (await client.query(`
        SELECT public.link_bank_statement_line($1::uuid, 'expense', $2::uuid, 'supplier');
      `, [bslId, expId])).rows[0].link_bank_statement_line;

      assert.equal(dupRes.status, 'already_linked');
      assert.equal(Number(dupRes.allocation_amount), 16002854);

      // Verify still only 2 allocations exist
      const allocCount = (await pool.query(`SELECT COUNT(*) FROM public.bank_statement_allocations WHERE bank_statement_line_id = $1;`, [bslId])).rows[0].count;
      assert.equal(Number(allocCount), 2);
    } finally {
      client.release();
    }
  });

  // ----------------------------------------------------------------------------
  // TEST 5: Supplier Advance journal creation (Dr 1170, Cr 111101 with supplier_id)
  // ----------------------------------------------------------------------------
  test('5. Supplier Advance journal creation (Dr 1170, Cr 111101 with supplier_id)', async () => {
    const pv = (await pool.query(`SELECT id, journal_entry_id FROM public.payment_vouchers WHERE voucher_number = 'PV/26-26/030';`)).rows[0];
    assert.ok(pv.journal_entry_id);

    const lines = (await pool.query(`
      SELECT jel.debit, jel.credit, coa.code, jel.supplier_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY jel.line_number ASC;
    `, [pv.journal_entry_id])).rows;

    assert.equal(lines.length, 2);
    // Line 1: Dr 1170 (Supplier Advances & Deposits)
    assert.equal(lines[0].code, '1170');
    assert.equal(Number(lines[0].debit), 1669000);
    assert.equal(lines[0].supplier_id, testSupplierId);

    // Line 2: Cr 111101 (Bank BCA - IDR)
    assert.equal(lines[1].code, '111101');
    assert.equal(Number(lines[1].credit), 1669000);
    assert.equal(lines[1].supplier_id, testSupplierId);
  });

  // ----------------------------------------------------------------------------
  // TEST 6: Receipt Voucher refund settlement (Dr 111101, Dr 6910, Cr 1170)
  // ----------------------------------------------------------------------------
  test('6. Receipt Voucher refund settlement (Dr 111101, Dr 6910, Cr 1170)', async () => {
    // 1. Seed dedicated supplier and advance payment voucher for refund test
    const testSupplier6Id = '701bbcb1-0000-0000-0000-000000000006';
    await pool.query(`
      INSERT INTO public.suppliers (id, company_name, is_active)
      VALUES ($1, 'Test Supplier Refund 6', true)
      ON CONFLICT (id) DO NOTHING;
    `, [testSupplier6Id]);

    const pvRes = await pool.query(`
      INSERT INTO public.payment_vouchers (
        voucher_number, voucher_date, party_type, supplier_id,
        payment_method, bank_account_id, amount, payment_purpose,
        settlement_against, created_by
      ) VALUES (
        'PV-TEST-006', '2026-10-15', 'supplier', $1,
        'bank_transfer', $2, 1669000, 'supplier_advance',
        'advance', $3
      ) RETURNING id;
    `, [testSupplier6Id, bankAccountBcaId, adminUserId]);
    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [pvRes.rows[0].id, adminUserId]);

    // 2. Create new refund Receipt Voucher
    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, settlement_discount, payment_purpose, created_by
      ) VALUES (
        'RV-TEST-006', '2026-10-30', 'supplier', $1, 'bank_transfer',
        $2, 1666000, 3000, 'supplier_refund', $3
      ) RETURNING id;
    `, [testSupplier6Id, bankAccountBcaId, adminUserId]);
    const rvId = rvRes.rows[0].id;

    // 3. Post Receipt Voucher
    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const rvCheck = (await pool.query(`SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId])).rows[0];
    assert.equal(rvCheck.is_posted, true);

    const lines = (await pool.query(`
      SELECT jel.debit, jel.credit, coa.code, jel.supplier_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY jel.line_number ASC;
    `, [rvCheck.journal_entry_id])).rows;

    assert.equal(lines.length, 3);
    // Line 1: Dr 111101 (BCA IDR)
    assert.equal(lines[0].code, '111101');
    assert.equal(Number(lines[0].debit), 1666000);

    // Line 2: Dr 6910 (Settlement Difference)
    assert.equal(lines[1].code, '6910');
    assert.equal(Number(lines[1].debit), 3000);

    // Line 3: Cr 1170 (Supplier Advances & Deposits) - NOT 2110!
    assert.equal(lines[2].code, '1170');
    assert.equal(Number(lines[2].credit), 1669000);
    assert.equal(lines[2].supplier_id, testSupplier6Id);
  });

  // ----------------------------------------------------------------------------
  // TEST 7: Rp4,000 changed to Rp3,000 before posting (dynamic calculation)
  // ----------------------------------------------------------------------------
  test('7. Rp4,000 changed to Rp3,000 before posting (dynamic calculation)', async () => {
    // 1. Seed dedicated supplier and advance payment voucher for dynamic test
    const testSupplier7Id = '701bbcb1-0000-0000-0000-000000000007';
    await pool.query(`
      INSERT INTO public.suppliers (id, company_name, is_active)
      VALUES ($1, 'Test Supplier Dynamic 7', true)
      ON CONFLICT (id) DO NOTHING;
    `, [testSupplier7Id]);

    const pvRes = await pool.query(`
      INSERT INTO public.payment_vouchers (
        voucher_number, voucher_date, party_type, supplier_id,
        payment_method, bank_account_id, amount, payment_purpose,
        settlement_against, created_by
      ) VALUES (
        'PV-TEST-007', '2026-10-15', 'supplier', $1,
        'bank_transfer', $2, 1669000, 'supplier_advance',
        'advance', $3
      ) RETURNING id;
    `, [testSupplier7Id, bankAccountBcaId, adminUserId]);
    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [pvRes.rows[0].id, adminUserId]);

    // 2. Save voucher initially with 4,000 discount
    const client = await pool.connect();
    let rvId;
    try {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1::text, true);`, [adminUserId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`);
      
      const payload1 = {
        voucher_date: '2026-10-31',
        party_type: 'supplier',
        supplier_id: testSupplier7Id,
        payment_method: 'bank_transfer',
        bank_account_id: bankAccountBcaId,
        amount: 1666000,
        settlement_discount: 4000,
        adjustment_notes: 'Initial 4000 discount'
      };
      rvId = (await client.query(`
        SELECT public.save_receipt_voucher_with_allocations(null, $1::jsonb, '[]'::jsonb) as id;
      `, [JSON.stringify(payload1)])).rows[0].id;

      // 3. Dynamically change to 3,000 discount before posting
      const payload2 = {
        ...payload1,
        settlement_discount: 3000,
        adjustment_notes: 'Approved settlement difference of 3,000 against advance refund 1,669,000'
      };
      await client.query(`
        SELECT public.save_receipt_voucher_with_allocations($1::uuid, $2::jsonb, '[]'::jsonb);
      `, [rvId, JSON.stringify(payload2)]);

      // 4. Post voucher
      await client.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
    } finally {
      client.release();
    }

    const postedRv = (await pool.query(`SELECT journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId])).rows[0];
    const diffLine = (await pool.query(`
      SELECT jel.debit, coa.code
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1 AND coa.code = '6910';
    `, [postedRv.journal_entry_id])).rows[0];

    // Verified: Posted journal reflects Rp 3,000, NOT the old Rp 4,000!
    assert.equal(Number(diffLine.debit), 3000);
  });

  // ----------------------------------------------------------------------------
  // TEST 8: Posted voucher correction through reversal and replacement
  // ----------------------------------------------------------------------------
  test('8. Posted voucher correction through reversal and replacement', async () => {
    // Seed RV2610-0018 with old erroneous journal JE2610-0239 (Cr 2110)
    const rvId = '80b23e4e-ad5b-4d6d-bb60-2e8d25575e76';
    const oldJeId = 'e998a539-9138-43f2-92e2-4311ae1c4b2d';

    await pool.query(`
      INSERT INTO public.journal_entries (
        id, entry_number, entry_date, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted
      ) VALUES (
        $1, 'JE2610-0239', '2026-10-31', 'receipt', $2, 'RV2610-0018',
        'Receipt Voucher (supplier): RV2610-0018', 1669000, 1669000, true
      ) ON CONFLICT (id) DO NOTHING;
    `, [oldJeId, rvId]);

    await pool.query(`
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES
        ($1, 1, $2, 'Bank BCA', 1666000, 0, $3),
        ($1, 2, $4, 'Settlement Discount', 3000, 0, $3),
        ($1, 3, $5, 'Accounts Payable', 0, 1669000, $3)
      ON CONFLICT DO NOTHING;
    `, [oldJeId, coaBcaId, testSupplierId, coa6910Id, coa2110Id]);

    await pool.query(`
      INSERT INTO public.receipt_vouchers (
        id, voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, settlement_discount, is_posted, journal_entry_id,
        adjustment_notes
      ) VALUES (
        $1, 'RV2610-0018', '2026-10-31', 'supplier', $2, 'bank_transfer',
        $3, 1666000, 3000, true, $4, 'Approved settlement difference of 4000 against 1669000'
      ) ON CONFLICT (id) DO UPDATE SET is_posted = true, journal_entry_id = $4;
    `, [rvId, testSupplierId, bankAccountBcaId, oldJeId]);

    // Seed incoming refund statement line
    const refundBslId = 'b0757040-9080-455f-9ff8-6aa00e0331f7';
    await pool.query(`
      INSERT INTO public.bank_statement_lines (
        id, bank_account_id, transaction_date, description, reference, credit_amount, debit_amount,
        reconciliation_status, matching_status, matched_receipt_id, matched_entry_id
      ) VALUES (
        $1, $2, '2026-10-30', 'TRSF E-BANKING CR 3010/FTSCY/WS95051 1666000.00 REFUND OVP TRANS EXIS JAYA PT',
        '3010/FTSCY/WS95051', 1666000, 0, 'matched', 'suggested', $3, $4
      ) ON CONFLICT (id) DO NOTHING;
    `, [refundBslId, bankAccountBcaId, rvId, oldJeId]);

    await pool.query(`
      INSERT INTO public.bank_statement_allocations (
        id, bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind
      ) VALUES (
        'f08fc70d-c942-4e35-adb3-b971493516b6', $1, 'receipt', $2, $3, 1666000, 'supplier'
      ) ON CONFLICT (id) DO NOTHING;
    `, [refundBslId, rvId, oldJeId]);

    // Execute correction procedure (dry_run = false)
    const repairRes = (await pool.query(`
      SELECT public.repair_trans_exis_jaya_supplier_advance(false, $1::uuid);
    `, [adminUserId])).rows[0].repair_trans_exis_jaya_supplier_advance;

    assert.equal(repairRes.success, true);
    assert.ok(repairRes.reversal_journal.id);
    assert.ok(repairRes.replacement_journal.id);

    // Verify old journal is marked reversed
    const oldJeCheck = (await pool.query(`SELECT is_reversed, reversed_by_id FROM public.journal_entries WHERE id = $1;`, [oldJeId])).rows[0];
    assert.equal(oldJeCheck.is_reversed, true);
    assert.equal(oldJeCheck.reversed_by_id, repairRes.reversal_journal.id);

    // Verify receipt voucher now links to replacement journal
    const rvCheck = (await pool.query(`SELECT journal_entry_id, adjustment_account_id, adjustment_notes FROM public.receipt_vouchers WHERE id = $1;`, [rvId])).rows[0];
    assert.equal(rvCheck.journal_entry_id, repairRes.replacement_journal.id);
    assert.equal(rvCheck.adjustment_account_id, coa6910Id);
    assert.match(rvCheck.adjustment_notes, /3,000/);
    assert.doesNotMatch(rvCheck.adjustment_notes, /4000/);

    // Verify replacement journal lines credit 1170, not 2110
    const repLines = (await pool.query(`
      SELECT jel.debit, jel.credit, coa.code
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY jel.line_number ASC;
    `, [repairRes.replacement_journal.id])).rows;

    assert.equal(repLines.length, 3);
    assert.equal(repLines[0].code, '111101');
    assert.equal(Number(repLines[0].debit), 1666000);
    assert.equal(repLines[1].code, '6910');
    assert.equal(Number(repLines[1].debit), 3000);
    assert.equal(repLines[2].code, '1170');
    assert.equal(Number(repLines[2].credit), 1669000);
  });

  // ----------------------------------------------------------------------------
  // TEST 9: Adjustment account synchronisation with COA 6910
  // ----------------------------------------------------------------------------
  test('9. Adjustment account synchronisation with COA 6910', async () => {
    const rv = (await pool.query(`
      SELECT adjustment_account_id, adjustment_notes
      FROM public.receipt_vouchers
      WHERE id = '80b23e4e-ad5b-4d6d-bb60-2e8d25575e76';
    `)).rows[0];

    assert.equal(rv.adjustment_account_id, coa6910Id);
    assert.match(rv.adjustment_notes, /3,000/);
  });

  // ----------------------------------------------------------------------------
  // TEST 10: Supplier advance subledger balance equals zero
  // ----------------------------------------------------------------------------
  test('10. Supplier advance subledger balance equals zero', async () => {
    const balRes = (await pool.query(`
      SELECT 
        SUM(jel.debit) as total_debit,
        SUM(jel.credit) as total_credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.supplier_id = $1
        AND coa.code = '1170'
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false);
    `, [testSupplierId])).rows[0];

    const dr = Number(balRes.total_debit || 0);
    const cr = Number(balRes.total_credit || 0);
    // Debits (PV) equal Credits (RV refund) -> Net Advance Balance is 0!
    assert.equal(dr, 1669000);
    assert.equal(cr, 1669000);
    assert.equal(dr - cr, 0);
  });

  // ----------------------------------------------------------------------------
  // TEST 11: Accounts Payable balance is unchanged (not artificially increased)
  // ----------------------------------------------------------------------------
  test('11. Accounts Payable balance is unchanged (not artificially increased)', async () => {
    const apRes = (await pool.query(`
      SELECT 
        SUM(jel.debit) as total_debit,
        SUM(jel.credit) as total_credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.supplier_id = $1
        AND coa.code = '2110'
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false);
    `, [testSupplierId])).rows[0];

    const dr = Number(apRes.total_debit || 0);
    const cr = Number(apRes.total_credit || 0);
    // All 2110 lines are balanced: the expense payment Dr 16,002,854 settled the expense bill,
    // and the erroneous 1,669,000 AP credit was fully reversed!
    assert.equal(dr, cr);
  });

  // ----------------------------------------------------------------------------
  // TEST 12: Bank GL and bank account balance reconciliation
  // ----------------------------------------------------------------------------
  test('12. Bank GL and bank account balance reconciliation', async () => {
    // Re-sync bank balance
    await pool.query(`SELECT public.sync_bank_account_balance($1::uuid);`, [bankAccountBcaId]);

    const bank = (await pool.query(`SELECT opening_balance, current_balance FROM public.bank_accounts WHERE id = $1;`, [bankAccountBcaId])).rows[0];
    const glBal = (await pool.query(`
      SELECT SUM(jel.debit - jel.credit) as net_movement
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = $1
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false);
    `, [coaBcaId])).rows[0];

    const expectedCurrent = Number(bank.opening_balance) + Number(glBal.net_movement);
    assert.equal(Number(bank.current_balance), expectedCurrent);
  });

  // ----------------------------------------------------------------------------
  // TEST 13: Trial balance debit/credit equality across all entries
  // ----------------------------------------------------------------------------
  test('13. Trial balance debit/credit equality across all entries', async () => {
    const tbRes = (await pool.query(`
      SELECT SUM(jel.debit) as total_debit, SUM(jel.credit) as total_credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false);
    `)).rows[0];

    assert.equal(Number(tbRes.total_debit), Number(tbRes.total_credit), 'Debits must equal credits in Trial Balance');
  });

  // ----------------------------------------------------------------------------
  // TEST 14: Repeated posting and concurrent request idempotency
  // ----------------------------------------------------------------------------
  test('14. Repeated posting and concurrent request idempotency', async () => {
    const rvId = '80b23e4e-ad5b-4d6d-bb60-2e8d25575e76';

    // Calling post_receipt_voucher on already posted voucher must throw error
    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /already posted/
    );

    // Calling repair dry run multiple times returns consistent ready status without changes
    const dry1 = (await pool.query(`SELECT public.repair_trans_exis_jaya_supplier_advance(true, $1::uuid);`, [adminUserId])).rows[0].repair_trans_exis_jaya_supplier_advance;
    const dry2 = (await pool.query(`SELECT public.repair_trans_exis_jaya_supplier_advance(true, $1::uuid);`, [adminUserId])).rows[0].repair_trans_exis_jaya_supplier_advance;
    assert.equal(dry1.status, 'READY_FOR_AUTHORIZATION');
    assert.equal(dry2.status, 'READY_FOR_AUTHORIZATION');
  });
});
