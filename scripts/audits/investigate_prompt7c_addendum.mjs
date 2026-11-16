import pg from 'pg';

const connectionString = 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

async function run() {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('BEGIN READ ONLY;');

  console.log('=== 1. INVESTIGATING E0000244/2627, E0000243/2627, HM000004/2627 ===');
  const piRes = await client.query(`
    SELECT pi.invoice_number, pi.total_amount, pi.status, pii.id as pii_id, p.product_name, pii.quantity, pii.unit_price, pii.line_total,
           pii.receiving_batch_number, pii.batch_id
    FROM purchase_invoices pi
    JOIN purchase_invoice_items pii ON pii.purchase_invoice_id = pi.id
    JOIN products p ON p.id = pii.product_id
    WHERE pi.invoice_number IN ('E0000244/2627', 'E0000243/2627', 'HM000004/2627')
    ORDER BY pi.invoice_number, pii.receiving_batch_number;
  `);
  console.log('Purchase Invoice Items:');
  console.table(piRes.rows.map(r => ({
    invoice: r.invoice_number,
    product: r.product_name,
    qty: r.quantity,
    unit_price: r.unit_price,
    line_total: r.line_total,
    batch_num: r.receiving_batch_number,
    batch_id: r.batch_id
  })));

  const batchesInTransit = await client.query(`
    SELECT b.id, b.batch_number, p.product_name, pi.invoice_number,
           b.import_quantity, b.landed_cost_per_unit,
           ROUND((b.import_quantity * b.landed_cost_per_unit)::numeric, 2) as calc_val,
           b.current_stock
    FROM batches b
    JOIN products p ON p.id = b.product_id
    LEFT JOIN purchase_invoices pi ON pi.id = b.purchase_invoice_id
    WHERE pi.invoice_number IN ('E0000244/2627', 'E0000243/2627', 'HM000004/2627')
    ORDER BY pi.invoice_number, b.batch_number;
  `);
  console.log('\nBatches linked to in-transit PIs:');
  console.table(batchesInTransit.rows);

  console.log('\nGrouped by PI in Batches:');
  const piGroup = await client.query(`
    SELECT pi.invoice_number, COUNT(b.id) as batch_count,
           SUM(b.import_quantity) as total_import_qty,
           SUM(ROUND((b.import_quantity * b.landed_cost_per_unit)::numeric, 2)) as total_batch_val
    FROM batches b
    LEFT JOIN purchase_invoices pi ON pi.id = b.purchase_invoice_id
    WHERE pi.invoice_number IN ('E0000244/2627', 'E0000243/2627', 'HM000004/2627')
    GROUP BY pi.invoice_number;
  `);
  console.table(piGroup.rows);

  console.log('\nGrouped by PI in Purchase Invoice Items:');
  const piiGroup = await client.query(`
    SELECT pi.invoice_number, COUNT(pii.id) as item_count,
           SUM(pii.quantity) as total_pii_qty,
           SUM(pii.line_total) as total_pii_line_total
    FROM purchase_invoices pi
    JOIN purchase_invoice_items pii ON pii.purchase_invoice_id = pi.id
    WHERE pi.invoice_number IN ('E0000244/2627', 'E0000243/2627', 'HM000004/2627')
    GROUP BY pi.invoice_number;
  `);
  console.table(piiGroup.rows);

  console.log('\n=== 2. POSITIVE CURRENT_STOCK BATCHES IN DATABASE ===');
  const posStock = await client.query(`
    SELECT b.id, b.batch_number, p.product_name, b.current_stock, b.landed_cost_per_unit,
           ROUND((b.current_stock * b.landed_cost_per_unit)::numeric, 2) as val,
           pi.invoice_number as pi_ref
    FROM batches b
    JOIN products p ON p.id = b.product_id
    LEFT JOIN purchase_invoices pi ON pi.id = b.purchase_invoice_id
    WHERE b.current_stock > 0
    ORDER BY p.product_name, b.batch_number;
  `);
  console.table(posStock.rows);
  const totalPosStockQty = posStock.rows.reduce((s, r) => s + Number(r.current_stock), 0);
  const totalPosStockVal = posStock.rows.reduce((s, r) => s + Number(r.val), 0);
  console.log(`Total Positive Stock Batches: ${posStock.rows.length}, Qty: ${totalPosStockQty}, Val: Rp ${totalPosStockVal}`);

  console.log('\n=== 3. THREE PENDING DELIVERY CHALLANS ===');
  const dcRes = await client.query(`
    SELECT dc.id as dc_id, dc.challan_number, dc.challan_date, dc.approval_status,
           dci.id as dci_id, dci.batch_id, b.batch_number, p.product_name,
           dci.quantity, b.landed_cost_per_unit,
           ROUND((dci.quantity * b.landed_cost_per_unit)::numeric, 2) as challan_cost,
           b.current_stock
    FROM delivery_challans dc
    JOIN delivery_challan_items dci ON dci.challan_id = dc.id
    JOIN batches b ON b.id = dci.batch_id
    JOIN products p ON p.id = b.product_id
    WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080', 'DO-26-0081')
    ORDER BY dc.challan_number;
  `);
  console.table(dcRes.rows);

  const dcSiLink = await client.query(`
    SELECT dc.challan_number, dci.batch_id, b.batch_number, dci.quantity as dc_qty,
           sii.id as sii_id, si.invoice_number, sii.quantity as si_qty, si.is_draft, si.document_status
    FROM delivery_challans dc
    JOIN delivery_challan_items dci ON dci.challan_id = dc.id
    JOIN batches b ON b.id = dci.batch_id
    LEFT JOIN sales_invoice_items sii ON sii.delivery_challan_item_id = dci.id
    LEFT JOIN sales_invoices si ON si.id = sii.invoice_id
    WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080', 'DO-26-0081');
  `);
  console.log('DC to SI Link:');
  console.table(dcSiLink.rows);

  // Check all delivery challans for batch of DO-26-0079, DO-26-0080, DO-26-0081
  const bOfDcs = dcRes.rows.map(r => r.batch_id);
  const allDcOfBatches = await client.query(`
    SELECT b.batch_number, dc.challan_number, dci.quantity, si.invoice_number, sii.quantity as invoiced_qty
    FROM delivery_challan_items dci
    JOIN delivery_challans dc ON dc.id = dci.challan_id
    JOIN batches b ON b.id = dci.batch_id
    LEFT JOIN sales_invoice_items sii ON sii.delivery_challan_item_id = dci.id
    LEFT JOIN sales_invoices si ON si.id = sii.invoice_id
    WHERE dci.batch_id = ANY($1::uuid[])
    ORDER BY b.batch_number, dc.challan_number;
  `, [bOfDcs]);
  console.log('\nAll Dispatches of these batches:');
  console.table(allDcOfBatches.rows);

  console.log('\n=== 4. INVESTIGATING Rp 95.03 BATCH COGS RESIDUAL ===');
  const batchCogsDiff = await client.query(`
    WITH batch_si AS (
      SELECT 
        b.id,
        b.batch_number,
        p.product_name,
        b.landed_cost_per_unit,
        COALESCE(SUM(sii.quantity), 0) as total_invoiced_qty,
        COALESCE(SUM(sii.cogs_total_cost), 0) as actual_posted_cogs,
        ROUND((COALESCE(SUM(sii.quantity), 0) * b.landed_cost_per_unit)::numeric, 2) as expected_cogs
      FROM batches b
      JOIN products p ON p.id = b.product_id
      LEFT JOIN sales_invoice_items sii ON sii.batch_id = b.id
      LEFT JOIN sales_invoices si ON si.id = sii.invoice_id AND NOT COALESCE(si.is_draft, false) AND COALESCE(si.document_status, 'issued') != 'cancelled'
      GROUP BY b.id, b.batch_number, p.product_name, b.landed_cost_per_unit
    )
    SELECT *, ROUND((expected_cogs - actual_posted_cogs)::numeric, 2) as diff
    FROM batch_si
    WHERE ABS(expected_cogs - actual_posted_cogs) > 0.001
    ORDER BY ABS(expected_cogs - actual_posted_cogs) DESC;
  `);
  console.table(batchCogsDiff.rows);

  // Check sales invoice line cogs calculation vs quantity * batch landed cost
  const siLines = await client.query(`
    SELECT si.invoice_number, sii.quantity, sii.cogs_total_cost,
           b.batch_number, b.landed_cost_per_unit,
           ROUND((sii.quantity * b.landed_cost_per_unit)::numeric, 2) as expected_line_cogs,
           ROUND((sii.quantity * b.landed_cost_per_unit)::numeric, 2) - sii.cogs_total_cost as line_diff
    FROM sales_invoice_items sii
    JOIN sales_invoices si ON si.id = sii.invoice_id
    JOIN batches b ON b.id = sii.batch_id
    WHERE NOT COALESCE(si.is_draft, false) AND COALESCE(si.document_status, 'issued') != 'cancelled'
      AND ABS(ROUND((sii.quantity * b.landed_cost_per_unit)::numeric, 2) - sii.cogs_total_cost) > 0.001
    ORDER BY ABS(ROUND((sii.quantity * b.landed_cost_per_unit)::numeric, 2) - sii.cogs_total_cost) DESC;
  `);
  console.log('\nSales Invoice Lines with COGS rounding/difference:');
  console.table(siLines.rows);

  console.log('\n=== 5. GL 1130 CURRENT BALANCE & BREAKDOWN ===');
  const gl1130 = await client.query(`
    SELECT 
      SUM(CASE WHEN jel.debit > 0 THEN jel.debit ELSE 0 END) as total_debits,
      SUM(CASE WHEN jel.credit > 0 THEN jel.credit ELSE 0 END) as total_credits,
      SUM(jel.debit - jel.credit) as net_balance
    FROM journal_entry_lines jel
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '1130';
  `);
  console.table(gl1130.rows);

  console.log('\n=== 6. TOTAL BATCH QUANTITIES & VALUES ACROSS ALL 84 BATCHES ===');
  const allBatches = await client.query(`
    SELECT 
      count(b.id) as total_batches,
      sum(b.import_quantity) as total_import_quantity,
      sum(b.current_stock) as total_current_stock,
      sum(ROUND((b.import_quantity * b.landed_cost_per_unit)::numeric, 2)) as total_batch_landed_cost,
      sum(ROUND((b.current_stock * b.landed_cost_per_unit)::numeric, 2)) as total_remaining_val
    FROM batches b;
  `);
  console.table(allBatches.rows);

  await client.query('ROLLBACK;');
  await client.end();
}

run().catch(console.error);
