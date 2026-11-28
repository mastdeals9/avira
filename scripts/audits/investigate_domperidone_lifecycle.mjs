import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  const batchId = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

  // 1. Purchase invoice items
  const piiRes = await client.query(`
    SELECT 
      pii.id, pii.purchase_invoice_id, pii.product_id, pii.batch_id,
      pii.quantity, pii.unit_price, pii.line_total, pii.created_at,
      pii.purchase_order_item_id, pii.receiving_batch_number,
      pii.receiving_expiry_date, pii.receiving_make_id,
      pi.invoice_number, pi.invoice_date, pi.exchange_rate as pi_rate
    FROM purchase_invoice_items pii
    JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
    WHERE pii.batch_id = $1 OR pii.receiving_batch_number = 'BDM/2609056'
    ORDER BY pii.created_at;
  `, [batchId]);
  console.log('--- PURCHASE INVOICE ITEMS ---');
  console.table(piiRes.rows);

  // 2. PO items if any
  const poItemIds = piiRes.rows.map(r => r.purchase_order_item_id).filter(Boolean);
  if (poItemIds.length > 0) {
    const poRes = await client.query(`
      SELECT *
      FROM purchase_order_items poi
      WHERE poi.id = ANY($1);
    `, [poItemIds]);
    console.log('--- PURCHASE ORDER ITEMS ---');
    console.table(poRes.rows);
  } else {
    console.log('--- NO PO ITEMS LINKED ---');
  }

  // 3. Receiving allocations
  const raRes = await client.query(`
    SELECT *
    FROM purchase_invoice_receiving_allocations
    WHERE batch_id = $1 OR purchase_invoice_id = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca';
  `, [batchId]);
  console.log('--- RECEIVING ALLOCATIONS ---');
  console.table(raRes.rows);

  // 4. Batches record
  const bRes = await client.query(`
    SELECT *
    FROM batches
    WHERE id = $1;
  `, [batchId]);
  console.log('--- BATCH RECORD ---');
  console.table(bRes.rows);

  // 5. Cost layers
  const clRes = await client.query(`
    SELECT *
    FROM purchase_batch_cost_layers
    WHERE batch_id = $1;
  `, [batchId]);
  console.log('--- COST LAYERS ---');
  console.table(clRes.rows);

  // 6. Stock movements / inventory operational physical ledger
  const ledgRes = await client.query(`
    SELECT *
    FROM inventory_operational_physical_ledger
    WHERE batch_id = $1;
  `, [batchId]);
  console.log('--- OPERATIONAL PHYSICAL LEDGER ---');
  console.table(ledgRes.rows);

  // 7. Delivery challans / Sales invoice items
  const siRes = await client.query(`
    SELECT sii.id, sii.invoice_id, sii.product_id, sii.batch_id, sii.quantity,
           sii.unit_price, sii.cogs_unit_cost, sii.cogs_total_cost,
           si.invoice_number, si.invoice_date
    FROM sales_invoice_items sii
    JOIN sales_invoices si ON si.id = sii.invoice_id
    WHERE sii.batch_id = $1;
  `, [batchId]);
  console.log('--- SALES INVOICES FOR BATCH ---');
  console.table(siRes.rows);

  const dcRes = await client.query(`
    SELECT dci.id, dci.challan_id, dci.batch_id, dci.quantity,
           dc.challan_number, dc.challan_date, dc.approval_status
    FROM delivery_challan_items dci
    JOIN delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.batch_id = $1;
  `, [batchId]);
  console.log('--- DELIVERY CHALLANS FOR BATCH ---');
  console.table(dcRes.rows);

  // 8. Journal entries for PI E0000244/2627
  const jeRes = await client.query(`
    SELECT je.entry_number, je.entry_date, je.source_module, je.reference_number,
           jel.line_number, coa.code, coa.name as coa_name, jel.debit, jel.credit,
           jel.description, jel.batch_id
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE je.reference_id = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca'
       OR jel.batch_id = $1
    ORDER BY je.entry_date, je.entry_number, jel.line_number;
  `, [batchId]);
  console.log('--- JOURNAL ENTRIES ---');
  console.table(jeRes.rows);

  await client.end();
}

main().catch(console.error);
