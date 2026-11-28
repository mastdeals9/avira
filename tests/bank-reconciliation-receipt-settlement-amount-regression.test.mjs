import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;

const LIVE_DB_URL = (process.env.READONLY_AUDIT_DB_URL || '');

function getClient() {
  return new Client({
    connectionString: LIVE_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
}

test('Bank Reconciliation Customer Receipt & Generated settlement_amount Regression Suite', async (t) => {
  const client = getClient();
  await client.connect();

  // Baseline check: Snapshot production protected records
  const targetInvoiceId = '4a28c491-39a1-496a-93e1-3ccd12ebd18a'; // SAPJ-26-067
  const targetLineId = '5e179c9c-b533-431c-9c52-51ce908a3cc4';    // BCA Rp686,989,545

  const initialInv = (await client.query(
    'SELECT id, invoice_number, total_amount, balance_amount, paid_amount, payment_status FROM public.sales_invoices WHERE id = $1',
    [targetInvoiceId]
  )).rows[0];

  const initialLine = (await client.query(
    'SELECT id, transaction_date, credit_amount, currency, reconciliation_status, matched_receipt_id, matched_entry_id FROM public.bank_statement_lines WHERE id = $1',
    [targetLineId]
  )).rows[0];

  assert.ok(initialInv, 'Protected invoice SAPJ-26-067 must exist');
  assert.ok(initialLine, 'Protected statement line must exist');
  assert.equal(initialInv.invoice_number, 'SAPJ-26-067');
  assert.equal(initialLine.reconciliation_status, 'unmatched');

  // Common IDs for tests
  const bankIdr = (await client.query("SELECT id FROM public.bank_accounts WHERE is_active = true AND currency = 'IDR' LIMIT 1")).rows[0].id;
  const bankUsd = (await client.query("SELECT id FROM public.bank_accounts WHERE is_active = true AND currency = 'USD' LIMIT 1")).rows[0]?.id || bankIdr;
  const adminUser = (await client.query("SELECT id FROM auth.users LIMIT 1")).rows[0].id;
  const uploadId = (await client.query("SELECT id FROM public.bank_statement_uploads LIMIT 1")).rows[0].id;
  const customerId = (await client.query("SELECT id FROM public.customers LIMIT 1")).rows[0].id;

  await t.test('1. Customer receipt created from Bank Reconciliation (no direct settlement_amount)', async () => {
    await client.query('BEGIN');
    try {
      const payload = {
        voucher_date: '2026-11-03',
        party_type: 'customer',
        customer_id: customerId,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: 250000,
        description: 'Test Bank Recon Receipt Creation',
        currency_code: 'IDR',
        transaction_currency: 'IDR',
        exchange_rate: 1,
        payment_purpose: 'invoice_payment',
        settlement_against: 'advance',
        created_by: adminUser
      };

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify([])]
      );
      const receiptId = res.rows[0].id;
      assert.ok(receiptId, 'Receipt voucher id must be generated');

      const rvRow = (await client.query(
        'SELECT id, voucher_number, amount, settlement_amount, party_type, is_posted FROM public.receipt_vouchers WHERE id = $1',
        [receiptId]
      )).rows[0];

      assert.equal(Number(rvRow.amount), 250000);
      assert.equal(Number(rvRow.settlement_amount), 250000, 'settlement_amount must match amount via GENERATED ALWAYS');
      assert.equal(rvRow.party_type, 'customer');
      assert.equal(rvRow.is_posted, false);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('2. Customer receipt created from normal Receipt Voucher screen', async () => {
    await client.query('BEGIN');
    try {
      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: customerId,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: 500000,
        description: 'Manual Receipt Voucher entry',
        transaction_currency: 'IDR',
        exchange_rate: 1,
        payment_purpose: 'invoice_payment',
        settlement_against: 'advance',
        created_by: adminUser
      };

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify([])]
      );
      const receiptId = res.rows[0].id;

      // Post receipt
      await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);

      const check = (await client.query(
        'SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1',
        [receiptId]
      )).rows[0];
      assert.equal(check.is_posted, true);
      assert.ok(check.journal_entry_id);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('3. Full invoice allocation & status update', async () => {
    await client.query('BEGIN');
    try {
      const invRow = (await client.query(`
        SELECT id, customer_id, balance_amount, paid_amount
        FROM public.sales_invoices
        WHERE balance_amount > 0 AND id != $1
        LIMIT 1;
      `, [targetInvoiceId])).rows[0];

      const testInvId = invRow.id;
      const fullAmount = Number(invRow.balance_amount);

      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: invRow.customer_id,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: fullAmount,
        currency_code: 'IDR',
        transaction_currency: 'IDR',
        exchange_rate: 1,
        payment_purpose: 'invoice_payment',
        settlement_against: 'specific_document',
        created_by: adminUser
      };
      const allocations = [{ sales_invoice_id: testInvId, amount: fullAmount }];

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify(allocations)]
      );
      const receiptId = res.rows[0].id;

      await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);

      const invAfter = (await client.query(
        'SELECT balance_amount, paid_amount, payment_status FROM public.sales_invoices WHERE id = $1',
        [testInvId]
      )).rows[0];

      assert.equal(Number(invAfter.balance_amount), 0);
      assert.equal(Number(invAfter.paid_amount), Number(invRow.paid_amount) + fullAmount);
      assert.equal(invAfter.payment_status, 'paid');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('4. Partial invoice allocation', async () => {
    await client.query('BEGIN');
    try {
      const invRow = (await client.query(`
        SELECT id, customer_id, balance_amount, paid_amount
        FROM public.sales_invoices
        WHERE balance_amount > 200000 AND id != $1
        LIMIT 1;
      `, [targetInvoiceId])).rows[0];

      const testInvId = invRow.id;
      const initialBalance = Number(invRow.balance_amount);
      const partialAmount = 50000;

      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: invRow.customer_id,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: partialAmount,
        currency_code: 'IDR',
        transaction_currency: 'IDR',
        exchange_rate: 1,
        payment_purpose: 'invoice_payment',
        settlement_against: 'specific_document',
        created_by: adminUser
      };
      const allocations = [{ sales_invoice_id: testInvId, amount: partialAmount }];

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify(allocations)]
      );
      const receiptId = res.rows[0].id;

      await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);

      const invAfter = (await client.query(
        'SELECT balance_amount, paid_amount, payment_status FROM public.sales_invoices WHERE id = $1',
        [testInvId]
      )).rows[0];

      assert.equal(Number(invAfter.balance_amount), initialBalance - partialAmount);
      assert.equal(Number(invAfter.paid_amount), Number(invRow.paid_amount) + partialAmount);
      assert.equal(invAfter.payment_status, 'partial');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('5. Receipt with rounding adjustment', async () => {
    await client.query('BEGIN');
    try {
      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: customerId,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: 99500,
        settlement_discount: 500,
        adjustment_reason: 'invoice_rounding_tolerance',
        currency_code: 'IDR',
        transaction_currency: 'IDR',
        exchange_rate: 1,
        payment_purpose: 'invoice_payment',
        settlement_against: 'advance',
        created_by: adminUser
      };

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify([])]
      );
      const receiptId = res.rows[0].id;

      await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);

      const jeRes = await client.query('SELECT journal_entry_id FROM public.receipt_vouchers WHERE id = $1', [receiptId]);
      const jeLines = (await client.query(
        'SELECT account_id, debit, credit, description FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number',
        [jeRes.rows[0].journal_entry_id]
      )).rows;

      // Line 1: Bank (99,500 Dr)
      // Line 2: Settlement Difference (500 Dr)
      // Line 3: AR (100,000 Cr)
      assert.equal(Number(jeLines[0].debit), 99500);
      assert.equal(Number(jeLines[1].debit), 500);
      assert.equal(Number(jeLines[2].credit), 100000);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('6. Pure IDR receipt produces balanced debits and credits without erroneous FX', async () => {
    await client.query('BEGIN');
    try {
      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: customerId,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: 1500000,
        currency_code: 'IDR',
        transaction_currency: 'IDR',
        exchange_rate: 1,
        created_by: adminUser
      };

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify([])]
      );
      const receiptId = res.rows[0].id;

      await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);

      const jeRes = await client.query(
        'SELECT je.total_debit, je.total_credit, je.is_posted FROM public.receipt_vouchers rv JOIN public.journal_entries je ON je.id = rv.journal_entry_id WHERE rv.id = $1',
        [receiptId]
      );
      const je = jeRes.rows[0];
      assert.equal(Number(je.total_debit), 1500000);
      assert.equal(Number(je.total_credit), 1500000);
      assert.equal(je.is_posted, true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('7. Receipt in USD with FX realization', async () => {
    await client.query('BEGIN');
    try {
      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: customerId,
        payment_method: 'bank_transfer',
        bank_account_id: bankUsd,
        amount: 1000,
        currency_code: 'USD',
        transaction_currency: 'USD',
        exchange_rate: 16000,
        created_by: adminUser
      };

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify([])]
      );
      const receiptId = res.rows[0].id;

      await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);

      const jeRes = await client.query(
        'SELECT je.total_debit, je.total_credit, je.exchange_rate FROM public.receipt_vouchers rv JOIN public.journal_entries je ON je.id = rv.journal_entry_id WHERE rv.id = $1',
        [receiptId]
      );
      assert.equal(Number(jeRes.rows[0].total_debit), Number(jeRes.rows[0].total_credit), 'JE must be balanced in functional currency');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('8. Duplicate submission idempotency (cannot post already posted receipt)', async () => {
    await client.query('BEGIN');
    try {
      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: customerId,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: 300000,
        created_by: adminUser
      };

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify([])]
      );
      const receiptId = res.rows[0].id;

      await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);

      // Attempt second post should fail with 'already posted'
      await assert.rejects(
        async () => {
          await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);
        },
        /already posted/
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('9. Failed allocation rollback preserves atomicity', async () => {
    await client.query('BEGIN');
    try {
      // Trying to allocate to a nonexistent invoice in save_receipt_voucher_with_allocations
      await assert.rejects(
        async () => {
          const payload = {
            voucher_date: '2026-11-04',
            party_type: 'customer',
            customer_id: customerId,
            payment_method: 'bank_transfer',
            bank_account_id: bankIdr,
            amount: 50000,
            created_by: adminUser
          };
          const badAllocations = [{ sales_invoice_id: '00000000-0000-0000-0000-000000000000', amount: 50000 }];
          await client.query(
            'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb);',
            [JSON.stringify(payload), JSON.stringify(badAllocations)]
          );
        },
        /Sales invoice.*not found|violates foreign key constraint/
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('10. Bank statement line remains unmatched on receipt failure', async () => {
    await client.query('BEGIN');
    try {
      const lineRes = await client.query(`
        INSERT INTO public.bank_statement_lines (
          upload_id, bank_account_id, transaction_date, description, credit_amount, currency, reconciliation_status
        ) VALUES (
          $1, $2, CURRENT_DATE, 'TEST UNMATCHED PRESERVATION', 75000, 'IDR', 'unmatched'
        ) RETURNING id;
      `, [uploadId, bankIdr]);
      const testLineId = lineRes.rows[0].id;

      await client.query('SAVEPOINT sp_failure');
      // Simulate a failure: trying to link statement line to an unposted or nonexistent receipt
      await assert.rejects(
        async () => {
          await client.query(
            "SELECT public.link_bank_statement_line($1::uuid, 'receipt', '00000000-0000-0000-0000-000000000000'::uuid);",
            [testLineId]
          );
        }
      );
      await client.query('ROLLBACK TO SAVEPOINT sp_failure');

      const checkLine = (await client.query(
        'SELECT reconciliation_status, matched_receipt_id FROM public.bank_statement_lines WHERE id = $1',
        [testLineId]
      )).rows[0];

      assert.equal(checkLine.reconciliation_status, 'unmatched');
      assert.equal(checkLine.matched_receipt_id, null);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('11. Successful receipt links to exactly one statement line atomically', async () => {
    await client.query('BEGIN');
    try {
      const lineRes = await client.query(`
        INSERT INTO public.bank_statement_lines (
          upload_id, bank_account_id, transaction_date, description, credit_amount, currency, reconciliation_status
        ) VALUES (
          $1, $2, CURRENT_DATE, 'TEST MATCHING SUCCESS', 450000, 'IDR', 'unmatched'
        ) RETURNING id;
      `, [uploadId, bankIdr]);
      const testLineId = lineRes.rows[0].id;

      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: customerId,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: 450000,
        currency_code: 'IDR',
        transaction_currency: 'IDR',
        exchange_rate: 1,
        created_by: adminUser
      };

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify([])]
      );
      const receiptId = res.rows[0].id;

      await client.query('SELECT public.post_receipt_voucher($1::uuid, $2::uuid);', [receiptId, adminUser]);
      await client.query("SELECT public.link_bank_statement_line($1::uuid, 'receipt', $2::uuid);", [testLineId, receiptId]);

      const checkLine = (await client.query(
        'SELECT reconciliation_status, matched_receipt_id, matched_entry_id FROM public.bank_statement_lines WHERE id = $1',
        [testLineId]
      )).rows[0];

      assert.equal(checkLine.reconciliation_status, 'matched');
      assert.equal(checkLine.matched_receipt_id, receiptId);
      assert.ok(checkLine.matched_entry_id);

      const allocs = (await client.query(
        'SELECT * FROM public.bank_statement_allocations WHERE bank_statement_line_id = $1',
        [testLineId]
      )).rows;
      assert.equal(allocs.length, 1);
      assert.equal(Number(allocs[0].allocation_amount), 450000);
      assert.equal(allocs[0].document_id, receiptId);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('12. Generated settlement_amount column automatically matches amount', async () => {
    await client.query('BEGIN');
    try {
      const payload = {
        voucher_date: '2026-11-04',
        party_type: 'customer',
        customer_id: customerId,
        payment_method: 'bank_transfer',
        bank_account_id: bankIdr,
        amount: 1234567,
        currency_code: 'IDR',
        transaction_currency: 'IDR',
        exchange_rate: 1,
        created_by: adminUser
      };

      const res = await client.query(
        'SELECT public.save_receipt_voucher_with_allocations(NULL, $1::jsonb, $2::jsonb) as id;',
        [JSON.stringify(payload), JSON.stringify([])]
      );
      const receiptId = res.rows[0].id;

      const rvRow = (await client.query(
        'SELECT amount, settlement_amount FROM public.receipt_vouchers WHERE id = $1',
        [receiptId]
      )).rows[0];

      assert.equal(Number(rvRow.settlement_amount), 1234567);
      assert.equal(Number(rvRow.amount), Number(rvRow.settlement_amount));
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await t.test('13. Protection of production records: PT. Lapi invoice & bank statement line untouched', async () => {
    const finalInv = (await client.query(
      'SELECT id, invoice_number, total_amount, balance_amount, paid_amount, payment_status FROM public.sales_invoices WHERE id = $1',
      [targetInvoiceId]
    )).rows[0];

    const finalLine = (await client.query(
      'SELECT id, transaction_date, credit_amount, currency, reconciliation_status, matched_receipt_id, matched_entry_id FROM public.bank_statement_lines WHERE id = $1',
      [targetLineId]
    )).rows[0];

    assert.deepEqual(finalInv, initialInv, 'Production invoice SAPJ-26-067 must remain strictly untouched');
    assert.deepEqual(finalLine, initialLine, 'Production statement line 5e179c9c must remain strictly untouched');
  });

  await client.end();
});
