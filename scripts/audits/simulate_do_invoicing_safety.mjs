import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  console.log('--- NON-PRODUCTION INVOICING SAFETY SIMULATION (PURE ROLLBACK) ---');

  await client.query('BEGIN;');

  try {
    // 1. Inspect existing delivery challans
    const dcRes = await client.query(`
      SELECT 
        dc.id as challan_id, dc.challan_number, dc.customer_id,
        dci.id as challan_item_id, dci.batch_id, dci.quantity,
        b.batch_number, b.current_stock, b.cost_per_unit, b.landed_cost_per_unit,
        p.id as product_id, p.product_name
      FROM delivery_challans dc
      JOIN delivery_challan_items dci ON dci.challan_id = dc.id
      JOIN batches b ON b.id = dci.batch_id
      JOIN products p ON p.id = b.product_id
      WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080')
      ORDER BY dc.challan_number;
    `);

    console.log('Delivery Challans to invoice:');
    console.table(dcRes.rows.map(r => ({
      dc: r.challan_number,
      batch: r.batch_number,
      qty: r.quantity,
      current_stock: r.current_stock,
      landed_cost: r.landed_cost_per_unit,
      expected_cogs: (parseFloat(r.quantity) * parseFloat(r.landed_cost_per_unit)).toLocaleString()
    })));

    const stockBefore = {};
    for (const r of dcRes.rows) {
      stockBefore[r.batch_number] = parseFloat(r.current_stock);
    }

    // 2. Create simulated sales invoices in transaction
    const simInvoices = [];
    for (const r of dcRes.rows) {
      const landedCost = parseFloat(r.landed_cost_per_unit);
      const qty = parseFloat(r.quantity);
      const cogsTotal = Math.round(qty * landedCost * 100) / 100;

      // Insert Sales Invoice
      const invRes = await client.query(`
        INSERT INTO sales_invoices (
          invoice_number, customer_id, invoice_date, due_date,
          payment_status, is_draft, document_status, subtotal, tax_amount, total_amount,
          created_by
        ) VALUES (
          $1, $2, CURRENT_DATE, CURRENT_DATE + 30,
          'pending', false, 'posted', $3, 0, $3,
          'cd7b9d5f-d45c-4b5f-b113-68505a8cae27'
        ) RETURNING id, invoice_number;
      `, [`SIM-INV-${r.challan_number}`, r.customer_id, cogsTotal * 1.2]); // 20% margin

      const invoiceId = invRes.rows[0].id;

      // Insert Sales Invoice Item linked to delivery_challan_item
      await client.query(`
        INSERT INTO sales_invoice_items (
          invoice_id, product_id, batch_id, quantity, unit_price,
          cogs_unit_cost, cogs_total_cost, delivery_challan_item_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8
        );
      `, [
        invoiceId, r.product_id, r.batch_id, qty, landedCost * 1.2,
        landedCost, cogsTotal, r.challan_item_id
      ]);

      // Check FIFO layer cost vs batch scalar cost:
      // For DO-26-0079 (DFS/126010053):
      // - First layer (017/KTT/IX/2026, 175 kg @ 176,750) was fully consumed by SAPJ-26-060.
      // - Second layer (FJ1-2611001, 100 kg @ 190,575) has 100 kg available.
      // - Therefore FIFO COGS = 100 kg * 190,575 = 19,057,500.00.
      // (If using outdated batch scalar 176,750, it would be 17,675,000; prompt anticipated 17,675,000 based on scalar).
      // For DO-26-0080 (2610712):
      // - Layer (80103232, 500 kg @ 86,016) has 500 kg available.
      // - Therefore FIFO COGS = 250 kg * 86,016 = 21,504,000.00.
      const expectedFifoCogs = r.challan_number === 'DO-26-0079' ? 19057500.00 : 21504000.00;
      const expectedScalarCogs = r.challan_number === 'DO-26-0079' ? 17675000.00 : 21504000.00;

      simInvoices.push({
        challan_number: r.challan_number,
        batch_number: r.batch_number,
        invoice_id: invoiceId,
        invoice_number: invRes.rows[0].invoice_number,
        expected_fifo_cogs: expectedFifoCogs,
        expected_scalar_cogs: expectedScalarCogs
      });
    }

    console.log('\nSimulated Invoices Created. Forcing trg_post_sales_invoice_cogs constraint trigger and verifying COGS triggers & stock levels...');
    await client.query('SET CONSTRAINTS trg_post_sales_invoice_cogs IMMEDIATE;');

    // 3. Check stock after invoice creation
    const stockAfterRes = await client.query(`
      SELECT batch_number, current_stock
      FROM batches
      WHERE batch_number IN ('DFS/126010053', '2610712');
    `);
    console.log('\nStock after invoice creation:');
    for (const r of stockAfterRes.rows) {
      const before = stockBefore[r.batch_number];
      const after = parseFloat(r.current_stock);
      console.log(`  Batch ${r.batch_number}: Before = ${before}, After = ${after}, Delta = ${after - before}`);
      if (before !== after) {
        throw new Error(`FAIL: Batch ${r.batch_number} stock changed during invoice creation!`);
      }
    }
    console.log('✔ VERIFIED: Zero duplicate stock deduction.');

    // 4. Verify COGS Journal Entries created
    let totalSimFifoCogs = 0;
    let totalSimScalarCogs = 0;
    for (const inv of simInvoices) {
      const jeRes = await client.query(`
        SELECT je.id, je.entry_number, je.entry_date, je.source_module, je.reference_id, je.total_debit, je.total_credit
        FROM journal_entries je
        WHERE je.source_module = 'sales_invoice_cogs' AND je.reference_id = $1;
      `, [inv.invoice_id]);

      console.log(`\nCOGS Journal for Invoice ${inv.invoice_number} (Challan ${inv.challan_number}):`);
      if (jeRes.rows.length !== 1) {
        throw new Error(`Expected exactly 1 COGS journal for invoice ${inv.invoice_number}, got ${jeRes.rows.length}`);
      }
      const je = jeRes.rows[0];
      console.log(`  Entry: ${je.entry_number} | Dr ${parseFloat(je.total_debit).toLocaleString()} | Cr ${parseFloat(je.total_credit).toLocaleString()}`);

      // Inspect lines: exactly 1 Dr 5100 and 1 Cr 1130
      const linesRes = await client.query(`
        SELECT coa.code, coa.name, jel.debit, jel.credit, jel.description
        FROM journal_entry_lines jel
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        WHERE jel.journal_entry_id = $1
        ORDER BY jel.debit DESC;
      `, [je.id]);

      for (const l of linesRes.rows) {
        console.log(`    Account ${l.code} (${l.name}): Dr ${parseFloat(l.debit).toLocaleString()} | Cr ${parseFloat(l.credit).toLocaleString()}`);
      }

      const dr5100 = linesRes.rows.find(l => l.code === '5100');
      const cr1130 = linesRes.rows.find(l => l.code === '1130');
      if (!dr5100 || parseFloat(dr5100.debit) !== inv.expected_fifo_cogs) {
        throw new Error(`COGS debit mismatch for ${inv.invoice_number}: expected ${inv.expected_fifo_cogs}, got ${dr5100?.debit}`);
      }
      if (!cr1130 || parseFloat(cr1130.credit) !== inv.expected_fifo_cogs) {
        throw new Error(`Inventory credit mismatch for ${inv.invoice_number}: expected ${inv.expected_fifo_cogs}, got ${cr1130?.credit}`);
      }
      totalSimFifoCogs += inv.expected_fifo_cogs;
      totalSimScalarCogs += inv.expected_scalar_cogs;
    }

    console.log(`\n✔ VERIFIED: Exactly one COGS posting per invoice.`);
    console.log(`✔ VERIFIED: Exactly one GL 1130 credit per invoice.`);
    console.log(`✔ Combined FIFO COGS: Rp ${totalSimFifoCogs.toLocaleString()} (DO-26-0079: Rp 19,057,500.00 @ Rp 190,575 FIFO layer from FJ1-2611001; DO-26-0080: Rp 21,504,000.00 @ Rp 86,016 layer from 80103232)`);
    console.log(`ℹ Note on Prompt Estimate: Rp 39,179,000.00 was based on historical batch scalar (Rp 176,750/kg). Actual FIFO layer reflects PI FJ1-2611001 (Rp 190,575/kg), yielding Rp 40,561,500.00.`);

    // 5. Test Retry Idempotency: Triggering update again on sales_invoices
    console.log('\nTesting Retry Idempotency...');
    for (const inv of simInvoices) {
      await client.query(`
        UPDATE sales_invoices SET updated_at = NOW() WHERE id = $1;
      `, [inv.invoice_id]);

      const jeCountRes = await client.query(`
        SELECT count(*) as cnt FROM journal_entries 
        WHERE source_module = 'sales_invoice_cogs' AND reference_id = $1;
      `, [inv.invoice_id]);

      if (parseInt(jeCountRes.rows[0].cnt) !== 1) {
        throw new Error(`FAIL: Duplicate COGS journal created on retry for ${inv.invoice_number}!`);
      }
    }
    console.log('✔ VERIFIED: Retry idempotency confirmed (zero duplicate journals created on update).');

  } finally {
    await client.query('ROLLBACK;');
    console.log('\n--- TRANSACTION ROLLED BACK CLEANLY (ZERO PRODUCTION WRITES) ---');
    await client.end();
  }
}

main().catch(err => {
  console.error('SIMULATION ERROR:', err);
  process.exit(1);
});
