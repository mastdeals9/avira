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

test('1. Migration file structural and accounting contract verification for Credit Notes', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261028200000_fix_credit_note_receivables_integration.sql'
  );
  assert.ok(fs.existsSync(migrationPath), 'Migration 20261028200000 must exist');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // Must define get_invoice_credit_note_amount
  assert.match(
    sql,
    /get_invoice_credit_note_amount/,
    'Migration must define get_invoice_credit_note_amount'
  );

  // Must update get_invoice_paid_amount
  assert.match(
    sql,
    /get_invoice_paid_amount/,
    'Migration must update get_invoice_paid_amount'
  );
  assert.match(
    sql,
    /get_invoice_credit_note_amount\(p_invoice_id\)/,
    'get_invoice_paid_amount must include get_invoice_credit_note_amount'
  );

  // Must update recalculate_sales_invoice_payment_state
  assert.match(
    sql,
    /recalculate_sales_invoice_payment_state/,
    'Migration must update recalculate_sales_invoice_payment_state'
  );

  // Must update enforce_sales_invoice_write_scope
  assert.match(
    sql,
    /enforce_sales_invoice_write_scope/,
    'Migration must update enforce_sales_invoice_write_scope'
  );

  // Must define trigger on credit_notes
  assert.match(
    sql,
    /trg_sync_credit_note_invoice/,
    'Migration must create trigger trg_sync_credit_note_invoice'
  );
});

test('2. Live database function and live invoice SAPJ-26-013 state verification', async () => {
  await withDbClient(async (client) => {
    // Check get_invoice_credit_note_amount on SAPJ-26-013
    const invRes = await client.query(`
      SELECT id, invoice_number, total_amount, paid_amount, balance_amount, payment_status
      FROM public.sales_invoices
      WHERE invoice_number = 'SAPJ-26-013'
    `);
    assert.equal(invRes.rows.length, 1, 'Invoice SAPJ-26-013 must exist');
    const inv = invRes.rows[0];

    const cnAmountRes = await client.query(`
      SELECT public.get_invoice_credit_note_amount($1) as cn_amount
    `, [inv.id]);
    assert.equal(Number(cnAmountRes.rows[0].cn_amount), 1745336.25, 'Credit note amount for SAPJ-26-013 must be 1,745,336.25');

    // SAPJ-26-013 should now be fully paid with 0 balance
    assert.equal(Number(inv.total_amount), 251328420.00, 'Total amount must be 251,328,420.00');
    assert.equal(Number(inv.paid_amount), 251328420.00, 'Paid amount must be 251,328,420.00');
    assert.equal(Number(inv.balance_amount), 0.00, 'Balance amount must be 0.00');
    assert.equal(inv.payment_status, 'paid', 'Payment status must be paid');
  });
});

test('3. Dynamic credit note lifecycle and trigger verification in isolated transaction', async () => {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      // Create synthetic test invoice
      const customerRes = await client.query(`SELECT id FROM public.customers LIMIT 1`);
      const customerId = customerRes.rows[0].id;

      const invInsert = await client.query(`
        INSERT INTO public.sales_invoices (
          invoice_number,
          invoice_date,
          due_date,
          customer_id,
          subtotal,
          tax_amount,
          total_amount,
          paid_amount,
          balance_amount,
          payment_status,
          is_draft
        ) VALUES (
          'TEST-INV-CN-SYNC-01',
          CURRENT_DATE,
          CURRENT_DATE + 30,
          $1,
          1000000.00,
          110000.00,
          1110000.00,
          0.00,
          1110000.00,
          'pending',
          false
        ) RETURNING id
      `, [customerId]);
      const testInvId = invInsert.rows[0].id;

      // 1. Initially pending
      let check = await client.query(
        `SELECT paid_amount, balance_amount, payment_status FROM public.sales_invoices WHERE id = $1`,
        [testInvId]
      );
      assert.equal(Number(check.rows[0].paid_amount), 0);
      assert.equal(Number(check.rows[0].balance_amount), 1110000);
      assert.equal(check.rows[0].payment_status, 'pending');

      // 2. Insert draft credit note (status = 'pending_approval')
      const cnInsert = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number,
          credit_note_date,
          customer_id,
          original_invoice_id,
          reason,
          subtotal,
          tax_amount,
          total_amount,
          status
        ) VALUES (
          'CN-TEST-0001',
          CURRENT_DATE,
          $1,
          $2,
          'Damaged packaging test',
          1000000.00,
          110000.00,
          1110000.00,
          'pending_approval'
        ) RETURNING id
      `, [customerId, testInvId]);
      const testCnId = cnInsert.rows[0].id;

      // Draft credit note must NOT settle the invoice yet
      check = await client.query(
        `SELECT paid_amount, balance_amount, payment_status FROM public.sales_invoices WHERE id = $1`,
        [testInvId]
      );
      assert.equal(Number(check.rows[0].paid_amount), 0);
      assert.equal(check.rows[0].payment_status, 'pending');

      // 3. Approve credit note (status -> 'approved')
      await client.query(`
        UPDATE public.credit_notes
        SET status = 'approved'
        WHERE id = $1
      `, [testCnId]);

      // Trigger must automatically update sales invoice to paid
      check = await client.query(
        `SELECT paid_amount, balance_amount, payment_status FROM public.sales_invoices WHERE id = $1`,
        [testInvId]
      );
      assert.equal(Number(check.rows[0].paid_amount), 1110000.00);
      assert.equal(Number(check.rows[0].balance_amount), 0.00);
      assert.equal(check.rows[0].payment_status, 'paid');

      // 4. Deleting an approved credit note must be blocked by database guard
      await client.query('SAVEPOINT sp_del');
      await assert.rejects(
        async () => {
          await client.query(`DELETE FROM public.credit_notes WHERE id = $1`, [testCnId]);
        },
        /Approved Credit Note cannot be deleted/,
        'Database guard must block deletion of approved credit notes'
      );
      await client.query('ROLLBACK TO SAVEPOINT sp_del');

      // 5. Reject/unapprove credit note -> invoice reverts to pending
      await client.query(`
        UPDATE public.credit_notes
        SET status = 'rejected'
        WHERE id = $1
      `, [testCnId]);

      check = await client.query(
        `SELECT paid_amount, balance_amount, payment_status FROM public.sales_invoices WHERE id = $1`,
        [testInvId]
      );
      assert.equal(Number(check.rows[0].paid_amount), 0.00);
      assert.equal(Number(check.rows[0].balance_amount), 1110000.00);
      assert.equal(check.rows[0].payment_status, 'pending');

      // 6. Rejected credit note can now be deleted
      await client.query(`DELETE FROM public.credit_notes WHERE id = $1`, [testCnId]);

    } finally {
      await client.query('ROLLBACK');
    }
  });
});

test('4. ReceivablesManager frontend contract verification', () => {
  const rmPath = path.join(
    process.cwd(),
    'src/components/finance/ReceivablesManager.tsx'
  );
  assert.ok(fs.existsSync(rmPath), 'ReceivablesManager.tsx must exist');
  const code = fs.readFileSync(rmPath, 'utf8');

  // Must query credit_notes in loadData
  assert.match(
    code,
    /from\('credit_notes'\)/,
    'ReceivablesManager must query credit_notes'
  );
  assert.match(
    code,
    /\.eq\('status',\s*'approved'\)/,
    'ReceivablesManager must filter credit notes by status approved'
  );

  // Must map into paidByInvoice
  assert.match(
    code,
    /paidByInvoice\.set\(\s*cn\.original_invoice_id/,
    'ReceivablesManager must include credit note total_amount into paidByInvoice'
  );

  // Must subscribe to credit_notes realtime channel
  assert.match(
    code,
    /table:\s*'credit_notes'/,
    'ReceivablesManager must subscribe to credit_notes realtime channel'
  );
});

test('5. CreditNotes frontend contract verification (Edit, Delete, Realtime, Commercial label)', () => {
  const cnPath = path.join(
    process.cwd(),
    'src/pages/CreditNotes.tsx'
  );
  assert.ok(fs.existsSync(cnPath), 'CreditNotes.tsx must exist');
  const code = fs.readFileSync(cnPath, 'utf8');

  // Must have handleEditCreditNote
  assert.match(
    code,
    /handleEditCreditNote/,
    'CreditNotes.tsx must have handleEditCreditNote'
  );

  // Must have Edit action icon
  assert.match(
    code,
    /<Pencil\s+className="w-4 h-4"\s*\/>/,
    'CreditNotes.tsx must render Pencil icon for editing'
  );

  // Must guard deletion of approved credit notes
  assert.match(
    code,
    /Approved credit notes have posted general ledger and inventory records and cannot be deleted/,
    'CreditNotes.tsx must prevent deletion of approved credit notes'
  );

  // Must label commercial credit notes without material return
  assert.match(
    code,
    /Commercial Credit Note: Price adjustment \/ damaged packaging concession without physical goods return/,
    'CreditNotes.tsx must distinguish commercial credit notes'
  );

  // Must have realtime subscriptions
  assert.match(
    code,
    /useSupabaseRealtimeChannel/,
    'CreditNotes.tsx must use realtime subscriptions'
  );
});

test('6. CreditNoteView commercial credit label verification', () => {
  const viewPath = path.join(
    process.cwd(),
    'src/components/CreditNoteView.tsx'
  );
  assert.ok(fs.existsSync(viewPath), 'CreditNoteView.tsx must exist');
  const code = fs.readFileSync(viewPath, 'utf8');

  assert.match(
    code,
    /Commercial Credit/,
    'CreditNoteView.tsx must label commercial credit notes when material_returns is absent'
  );
});
