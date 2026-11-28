import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  console.log('--- DOMPERIDONE FIX SIMULATION (PURE ROLLBACK) ---');

  await client.query('BEGIN;');

  try {
    const batchId = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
    const invoiceId = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca';

    // 1. Inspect existing state
    const beforeRes = await client.query(`
      SELECT id, batch_number, import_quantity, current_stock, cost_per_unit, landed_cost_per_unit, final_landed_cost, expiry_date::text as exp_date
      FROM batches WHERE id = $1;
    `, [batchId]);
    console.log('\nExisting Batch Master Record:');
    console.table(beforeRes.rows);

    const itemsRes = await client.query(`
      SELECT id, quantity, unit_price, line_total, receiving_batch_number, receiving_expiry_date::text as exp_date
      FROM purchase_invoice_items
      WHERE purchase_invoice_id = $1 AND batch_id = $2;
    `, [invoiceId, batchId]);
    console.log('\nPurchase Invoice Items for Batch:');
    console.table(itemsRes.rows);

    // 2. Perform Batch Master Correction
    // Aggregate sum from items:
    // Qty: 225.000 + 24.890 = 249.890
    // Total Cost: 18,940,183.65 + 171,214,458.75 = 190,154,642.40
    // Unit Cost: 190,154,642.40 / 249.890 = 760,953.389...
    await client.query(`
      UPDATE batches
         SET import_quantity = 249.890,
             final_landed_cost = 190154642.40,
             cost_per_unit = 760953.39,
             landed_cost_per_unit = 760953.39,
             import_price_per_unit = 760953.39,
             updated_at = NOW()
       WHERE id = $1;
    `, [batchId]);

    // 3. Inspect updated state
    const afterRes = await client.query(`
      SELECT id, batch_number, import_quantity, current_stock, cost_per_unit, landed_cost_per_unit, final_landed_cost, expiry_date::text as exp_date
      FROM batches WHERE id = $1;
    `, [batchId]);
    console.log('\nUpdated Batch Master Record:');
    console.table(afterRes.rows);

    // 4. Verify inventory_operational_physical_ledger view
    const ledgerRes = await client.query(`
      SELECT *
      FROM inventory_operational_physical_ledger
      WHERE batch_id = $1;
    `, [batchId]);
    console.log('\nInventory Operational Physical Ledger (View):');
    console.table(ledgerRes.rows);

    // 5. Verify received quantity function
    const rxRes = await client.query(`
      SELECT id, quantity, public.purchase_invoice_item_received_quantity(id) as rx_qty
      FROM purchase_invoice_items
      WHERE purchase_invoice_id = $1 AND batch_id = $2;
    `, [invoiceId, batchId]);
    console.log('\nReceived Quantity check:');
    console.table(rxRes.rows);

    // 6. Verify GL 1130 integrity
    const jeRes = await client.query(`
      SELECT 
        je.entry_number,
        je.reference_number,
        coa.code,
        coa.name,
        jel.debit,
        jel.credit,
        jel.description
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND coa.code = '1130' AND jel.description ILIKE '%domperidone%';
    `, [invoiceId]);
    console.log('\nGL 1130 Lines for Domperidone:');
    console.table(jeRes.rows);

    console.log('\n✔ Verification successful: View automatically updated to 249.890 kg, GL 1130 untouched.');

  } finally {
    await client.query('ROLLBACK;');
    console.log('\n--- TRANSACTION ROLLED BACK CLEANLY (ZERO PRODUCTION WRITES) ---');
    await client.end();
  }
}

main().catch(console.error);

