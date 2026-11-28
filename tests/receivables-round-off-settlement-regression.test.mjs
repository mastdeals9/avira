import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

async function withDbClient(callback) {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database test: DATABASE_URL environment variable is not set.');
    return;
  }
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

test('1. Migration file structural and accounting contract verification for Receivables round-off', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261028190000_fix_receivables_rounding_and_write_scope.sql'
  );
  assert.ok(fs.existsSync(migrationPath), 'Migration 20261028190000 must exist');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // Must update enforce_sales_invoice_write_scope to account for rounding adjustments
  assert.match(
    sql,
    /enforce_sales_invoice_write_scope/,
    'Migration must update enforce_sales_invoice_write_scope'
  );
  assert.match(
    sql,
    /get_invoice_rounding_adjustment_amount\(NEW\.id\)/,
    'enforce_sales_invoice_write_scope must include get_invoice_rounding_adjustment_amount'
  );

  // Must update recalculate_sales_invoice_payment_state to update balance_amount
  assert.match(
    sql,
    /recalculate_sales_invoice_payment_state/,
    'Migration must update recalculate_sales_invoice_payment_state'
  );
  assert.match(
    sql,
    /balance_amount\s*=\s*GREATEST\(COALESCE\(v_invoice\.total_amount,\s*0\)\s*-\s*v_paid,\s*0\)/,
    'recalculate_sales_invoice_payment_state must set balance_amount'
  );
});

test('2. ReceivablesManager.tsx frontend integration with invoice_rounding_adjustments', () => {
  const rmPath = path.join(process.cwd(), 'src/components/finance/ReceivablesManager.tsx');
  const code = fs.readFileSync(rmPath, 'utf8');

  // Must import applySettlementAdjustment
  assert.match(code, /import.*applySettlementAdjustment.*from.*financeCommands/);

  // Must query invoice_rounding_adjustments in bulk loadData
  assert.match(code, /from\(['"]invoice_rounding_adjustments['"]\)/);

  // Must include adjustment amount in paidByInvoice map
  assert.match(code, /adjustment_amount/);

  // Must provide Settle Round-Off action
  assert.match(code, /handleSettleResidualRoundOff/);
  assert.match(code, /Settle Round-Off/);

  // Must subscribe to invoice_rounding_adjustments realtime updates
  assert.match(code, /table:\s*['"]invoice_rounding_adjustments['"]/);
});

test('3. Simulated Case: Invoice Rp 6,501,131.25 settled by Rp 6,501,131.00 receipt + Rp 0.25 round-off in isolated transaction', async () => {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      // Apply the migration functions in the transaction
      const migrationSql = fs.readFileSync(
        path.join(process.cwd(), 'supabase/migrations/20261028190000_fix_receivables_rounding_and_write_scope.sql'),
        'utf8'
      );
      await client.query(migrationSql);

      // Verify customer exists
      const custRes = await client.query('SELECT id FROM customers LIMIT 1');
      assert.ok(custRes.rows.length > 0, 'Customer required');
      const customerId = custRes.rows[0].id;

      // 1. Create test sales invoice: Rp 6,501,131.25
      const invoiceTotal = 6501131.25;
      const invRes = await client.query(
        `INSERT INTO sales_invoices (
          invoice_number, customer_id, invoice_date, due_date,
          subtotal, tax_amount, total_amount, paid_amount, balance_amount, payment_status
        ) VALUES (
          'TEST-INV-ROUND-001', $1, CURRENT_DATE, CURRENT_DATE + 30,
          5856875.00, 644256.25, $2, 0, $2, 'pending'
        ) RETURNING id`,
        [customerId, invoiceTotal]
      );
      const testInvoiceId = invRes.rows[0].id;

      // 2. Create receipt voucher: Rp 6,501,131.00 (Rp 0.25 underpayment / round-down)
      const receiptAmount = 6501131.00;
      const rvRes = await client.query(
        `INSERT INTO receipt_vouchers (
          voucher_number, voucher_date, customer_id, payment_method, amount, is_posted
        ) VALUES (
          'TEST-RV-ROUND-001', CURRENT_DATE, $1, 'bank_transfer', $2, true
        ) RETURNING id`,
        [customerId, receiptAmount]
      );
      const testRvId = rvRes.rows[0].id;

      // 3. Allocate receipt to invoice: Rp 6,501,131.00
      await client.query(
        `INSERT INTO voucher_allocations (
          voucher_type, receipt_voucher_id, sales_invoice_id, allocated_amount
        ) VALUES (
          'receipt', $1, $2, $3
        )`,
        [testRvId, testInvoiceId, receiptAmount]
      );

      // 4. Apply rounding adjustment for the Rp 0.25 residual
      await client.query(
        `SELECT public.apply_receipt_allocation_rounding_adjustment($1, $2, 'rounding', 'invoice_rounding_tolerance', 0.25)`,
        [testInvoiceId, testRvId]
      );

      // 5. Verify invoice status in database
      const updatedInv = await client.query(
        `SELECT id, invoice_number, total_amount, paid_amount, balance_amount, payment_status,
                public.get_invoice_paid_amount(id) as rpc_paid,
                public.get_invoice_rounding_adjustment_amount(id) as rpc_adj
         FROM sales_invoices WHERE id = $1`,
        [testInvoiceId]
      );
      const row = updatedInv.rows[0];

      assert.equal(Number(row.total_amount), 6501131.25);
      assert.equal(Number(row.paid_amount), 6501131.25, 'paid_amount must equal total_amount (6,501,131.25)');
      assert.equal(Number(row.balance_amount), 0, 'balance_amount must be 0');
      assert.equal(row.payment_status, 'paid', 'payment_status must be paid');
      assert.equal(Number(row.rpc_paid), 6501131.25, 'get_invoice_paid_amount RPC must return 6,501,131.25');
      assert.equal(Number(row.rpc_adj), 0.25, 'get_invoice_rounding_adjustment_amount RPC must return 0.25');

      // 6. Verify adjustment record in invoice_rounding_adjustments
      const adjRes = await client.query(
        `SELECT id, sales_invoice_id, receipt_voucher_id, adjustment_amount, adjustment_type, reason, journal_entry_id
         FROM invoice_rounding_adjustments WHERE sales_invoice_id = $1`,
        [testInvoiceId]
      );
      assert.equal(adjRes.rows.length, 1, 'Exactly one rounding adjustment record must exist');
      assert.equal(Number(adjRes.rows[0].adjustment_amount), 0.25);
      assert.equal(adjRes.rows[0].adjustment_type, 'rounding');
      assert.equal(adjRes.rows[0].receipt_voucher_id, testRvId);

      // 7. Verify balancing journal entry
      const jeId = adjRes.rows[0].journal_entry_id;
      assert.ok(jeId, 'Journal entry ID must be populated');

      const linesRes = await client.query(
        `SELECT jel.line_number, jel.debit, jel.credit, coa.code, coa.name
         FROM journal_entry_lines jel
         JOIN chart_of_accounts coa ON coa.id = jel.account_id
         WHERE jel.journal_entry_id = $1
         ORDER BY jel.line_number`,
        [jeId]
      );
      assert.equal(linesRes.rows.length, 2, 'Journal entry must have exactly 2 lines');

      const debitLine = linesRes.rows.find((l) => Number(l.debit) > 0);
      const creditLine = linesRes.rows.find((l) => Number(l.credit) > 0);
      assert.ok(debitLine, 'Debit line must exist');
      assert.ok(creditLine, 'Credit line must exist');

      assert.equal(Number(debitLine.debit), 0.25, 'Debit amount must be 0.25');
      assert.equal(Number(creditLine.credit), 0.25, 'Credit amount must be 0.25');
      assert.equal(creditLine.code, '1120', 'Credit must be to Accounts Receivable (1120)');

      // 8. Verify actual receipt voucher and bank transaction amounts remain untouched
      const rvCheck = await client.query(
        'SELECT amount FROM receipt_vouchers WHERE id = $1',
        [testRvId]
      );
      assert.equal(Number(rvCheck.rows[0].amount), 6501131.00, 'Bank receipt amount must remain 6,501,131.00');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

test('4. Material difference (> tolerance) is NOT written off and remains partial/unpaid', async () => {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const migrationSql = fs.readFileSync(
        path.join(process.cwd(), 'supabase/migrations/20261028190000_fix_receivables_rounding_and_write_scope.sql'),
        'utf8'
      );
      await client.query(migrationSql);

      const custRes = await client.query('SELECT id FROM customers LIMIT 1');
      const customerId = custRes.rows[0].id;

      // Invoice: Rp 1,000,000. Receipt: Rp 990,000 (Difference: Rp 10,000 > tolerance of 100)
      const invRes = await client.query(
        `INSERT INTO sales_invoices (
          invoice_number, customer_id, invoice_date, due_date,
          subtotal, tax_amount, total_amount, paid_amount, balance_amount, payment_status
        ) VALUES (
          'TEST-INV-MATERIAL-001', $1, CURRENT_DATE, CURRENT_DATE + 30,
          900000, 100000, 1000000, 0, 1000000, 'pending'
        ) RETURNING id`,
        [customerId]
      );
      const testInvoiceId = invRes.rows[0].id;

      const rvRes = await client.query(
        `INSERT INTO receipt_vouchers (
          voucher_number, voucher_date, customer_id, payment_method, amount, is_posted
        ) VALUES (
          'TEST-RV-MATERIAL-001', CURRENT_DATE, $1, 'bank_transfer', 990000, true
        ) RETURNING id`,
        [customerId]
      );
      const testRvId = rvRes.rows[0].id;

      await client.query(
        `INSERT INTO voucher_allocations (
          voucher_type, receipt_voucher_id, sales_invoice_id, allocated_amount
        ) VALUES (
          'receipt', $1, $2, 990000
        )`,
        [testRvId, testInvoiceId]
      );

      // Attempt rounding adjustment using savepoint so transaction remains valid
      await client.query('SAVEPOINT sp_material_check');
      let rejected = false;
      try {
        await client.query(
          `SELECT public.apply_receipt_allocation_rounding_adjustment($1, $2, 'rounding', 'invoice_rounding_tolerance', 10000)`,
          [testInvoiceId, testRvId]
        );
      } catch (err) {
        rejected = true;
        assert.match(err.message, /Rounding adjustment 10000(\.00)? exceeds configured tolerance/);
        await client.query('ROLLBACK TO SAVEPOINT sp_material_check');
      }
      assert.ok(rejected, 'Material difference must be rejected');

      // Invoice status must remain partial and balance 10,000
      const invCheck = await client.query(
        'SELECT total_amount, paid_amount, balance_amount, payment_status FROM sales_invoices WHERE id = $1',
        [testInvoiceId]
      );
      assert.equal(Number(invCheck.rows[0].paid_amount), 990000);
      assert.equal(Number(invCheck.rows[0].balance_amount), 10000);
      assert.equal(invCheck.rows[0].payment_status, 'partial');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

test('5. Idempotency and duplicate prevention: repeatedly applying adjustment does not duplicate journals', async () => {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const migrationSql = fs.readFileSync(
        path.join(process.cwd(), 'supabase/migrations/20261028190000_fix_receivables_rounding_and_write_scope.sql'),
        'utf8'
      );
      await client.query(migrationSql);

      const custRes = await client.query('SELECT id FROM customers LIMIT 1');
      const customerId = custRes.rows[0].id;

      // Subtotal 900.00 + tax 99.50 = total 999.50
      const invRes = await client.query(
        `INSERT INTO sales_invoices (
          invoice_number, customer_id, invoice_date, due_date,
          subtotal, tax_amount, total_amount, paid_amount, balance_amount, payment_status
        ) VALUES (
          'TEST-INV-IDEM-001', $1, CURRENT_DATE, CURRENT_DATE + 30,
          900.00, 99.50, 999.50, 0, 999.50, 'pending'
        ) RETURNING id`,
        [customerId]
      );
      const testInvoiceId = invRes.rows[0].id;

      const rvRes = await client.query(
        `INSERT INTO receipt_vouchers (
          voucher_number, voucher_date, customer_id, payment_method, amount, is_posted
        ) VALUES (
          'TEST-RV-IDEM-001', CURRENT_DATE, $1, 'bank_transfer', 999.00, true
        ) RETURNING id`,
        [customerId]
      );
      const testRvId = rvRes.rows[0].id;

      await client.query(
        `INSERT INTO voucher_allocations (
          voucher_type, receipt_voucher_id, sales_invoice_id, allocated_amount
        ) VALUES (
          'receipt', $1, $2, 999.00
        )`,
        [testRvId, testInvoiceId]
      );

      // Call 3 times consecutively
      await client.query(
        `SELECT public.apply_receipt_allocation_rounding_adjustment($1, $2, 'rounding', 'invoice_rounding_tolerance', 0.50)`,
        [testInvoiceId, testRvId]
      );
      await client.query(
        `SELECT public.apply_receipt_allocation_rounding_adjustment($1, $2, 'rounding', 'invoice_rounding_tolerance', 0.50)`,
        [testInvoiceId, testRvId]
      );
      await client.query(
        `SELECT public.apply_receipt_allocation_rounding_adjustment($1, $2, 'rounding', 'invoice_rounding_tolerance', 0.50)`,
        [testInvoiceId, testRvId]
      );

      const adjCount = await client.query(
        'SELECT count(*) FROM invoice_rounding_adjustments WHERE sales_invoice_id = $1',
        [testInvoiceId]
      );
      assert.equal(Number(adjCount.rows[0].count), 1, 'Must have exactly 1 adjustment row');

      const jeCount = await client.query(
        `SELECT count(*) FROM journal_entries WHERE reference_id = $1 AND source_module = 'sales_invoice_rounding'`,
        [testInvoiceId]
      );
      assert.equal(Number(jeCount.rows[0].count), 1, 'Must have exactly 1 journal entry');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
