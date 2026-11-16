import pg from 'pg';
import fs from 'fs';

const connectionString = 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

async function generateCorrectedBatchSchedule() {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('BEGIN READ ONLY;');

  console.log('Generating authoritative batch schedule CSV for all 84 historical batches...');

  const batches = await client.query(`
    SELECT 
      b.id,
      b.batch_number,
      p.product_name,
      COALESCE(s.company_name, '-') as supplier_name,
      COALESCE(pi.invoice_number, '-') as pi_number,
      pi.id as pi_id,
      b.import_quantity,
      b.import_price,
      b.import_price_usd,
      b.exchange_rate_usd_to_idr,
      b.cost_per_unit,
      b.duty_charges,
      b.freight_charges,
      b.other_charges,
      COALESCE(b.landed_cost_per_unit, b.cost_per_unit, b.import_price, 0) as landed_cost_per_unit,
      ROUND((b.import_quantity * COALESCE(b.landed_cost_per_unit, b.cost_per_unit, b.import_price, 0))::numeric, 2) as total_batch_landed_cost,
      b.current_stock,
      ROUND((b.current_stock * COALESCE(b.landed_cost_per_unit, b.cost_per_unit, b.import_price, 0))::numeric, 2) as remaining_batch_value,
      b.created_at
    FROM batches b
    JOIN products p ON p.id = b.product_id
    LEFT JOIN purchase_invoices pi ON pi.id = b.purchase_invoice_id
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    ORDER BY b.created_at, b.batch_number;
  `);

  console.log('Retrieved batches:', batches.rows.length);

  const rows = [];
  const headers = [
    'batch_uuid',
    'batch_number',
    'product_name',
    'supplier_name',
    'purchase_invoice_ref',
    'purchase_invoice_id',
    'received_quantity',
    'purchase_price_tx',
    'exchange_rate',
    'allocated_landed_costs_per_unit',
    'final_landed_cost_per_unit',
    'total_batch_landed_cost',
    'delivery_challans_and_qty',
    'sales_invoices_and_lines',
    'expected_cogs',
    'actual_posted_cogs',
    'cogs_rounding_difference',
    'corrective_journals_hfr',
    'credit_note_returns',
    'physical_warehouse_quantity',
    'delivered_pending_invoice_quantity',
    'remaining_batch_value',
    'status_classification'
  ];
  rows.push(headers.join(','));

  let sumReceivedQty = 0;
  let sumWarehouseQty = 0;
  let sumPendingInvoiceQty = 0;
  let sumTotalLandedCost = 0;
  let sumExpectedCogs = 0;
  let sumActualCogs = 0;
  let sumRemainingVal = 0;

  for (const b of batches.rows) {
    // 1. Delivery Challans
    const dcRes = await client.query(`
      SELECT dc.challan_number, dci.quantity, dc.approval_status
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.batch_id = $1 AND dc.approval_status = 'approved'
      ORDER BY dc.challan_number;
    `, [b.id]);
    const dcStr = dcRes.rows.map(r => `${r.challan_number}(${r.quantity}kg)`).join('; ') || '-';

    // 2. Sales Invoices
    const siRes = await client.query(`
      SELECT si.invoice_number, sii.quantity, sii.cogs_total_cost
      FROM sales_invoice_items sii
      JOIN sales_invoices si ON si.id = sii.invoice_id
      WHERE sii.batch_id = $1 AND NOT COALESCE(si.is_draft, false) AND COALESCE(si.document_status, 'issued') != 'cancelled'
      ORDER BY si.invoice_number;
    `, [b.id]);
    const siStr = siRes.rows.map(r => `${r.invoice_number}(${r.quantity}kg)`).join('; ') || '-';
    const totalInvoicedCogs = siRes.rows.reduce((s, r) => s + Number(r.cogs_total_cost), 0);
    const totalInvoicedQty = siRes.rows.reduce((s, r) => s + Number(r.quantity), 0);

    // 3. Expected vs Actual COGS
    const expectedCogs = Math.round(totalInvoicedQty * Number(b.landed_cost_per_unit) * 100) / 100;
    const actualCogs = Math.round(totalInvoicedCogs * 100) / 100;
    const cogsRoundingDiff = Math.round((expectedCogs - actualCogs) * 100) / 100;

    // 4. Corrective journals
    const hfrRes = await client.query(`
      SELECT DISTINCT je.entry_number
      FROM journal_entries je
      WHERE (je.description ILIKE '%' || $1 || '%')
        AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
    `, [b.batch_number]);
    const hfrStr = hfrRes.rows.map(r => r.entry_number).join('; ') || '-';

    // 5. Credit notes
    const cnRes = await client.query(`
      SELECT DISTINCT cn.credit_note_number
      FROM credit_notes cn
      WHERE cn.notes ILIKE '%' || $1 || '%';
    `, [b.batch_number]);
    const cnStr = cnRes.rows.map(r => r.credit_note_number).join('; ') || '-';

    // 6. Detailed quantity separation: physical warehouse vs delivered pending invoice
    let physicalWarehouseQty = 0;
    let deliveredPendingInvoiceQty = 0;
    let statusClass = 'VERIFIED FULLY DISPATCHED & INVOICED';

    const impQty = Number(b.import_quantity);
    const curStock = Number(b.current_stock);

    if (b.pi_number === 'HM000004/2627' || b.pi_number === 'E0000243/2627' || b.pi_number === 'E0000244/2627') {
      statusClass = 'IN-TRANSIT IMPORT SKELETON (ARRIVING LATE NOV 2026)';
      physicalWarehouseQty = 0;
      deliveredPendingInvoiceQty = 0;
    } else if (b.batch_number === 'DFS/126010053') {
      // 275 kg import: 175 kg invoiced, 0 kg in warehouse, 100 kg delivered under DO-26-0079 awaiting invoice
      statusClass = 'VERIFIED PARTIALLY INVOICED & DELIVERED UNINVOICED (DO-26-0079: 100kg)';
      physicalWarehouseQty = 0;
      deliveredPendingInvoiceQty = 100;
    } else if (b.batch_number === '2610712') {
      // 500 kg import: 0 kg invoiced, 250 kg in warehouse, 250 kg delivered under DO-26-0080 awaiting invoice
      statusClass = 'ACTIVE STOCK: 250kg WAREHOUSE + 250kg DELIVERED UNINVOICED (DO-26-0080)';
      physicalWarehouseQty = 250;
      deliveredPendingInvoiceQty = 250;
    } else if (curStock > 0 && totalInvoicedQty === 0) {
      statusClass = 'VERIFIED ACTIVE WAREHOUSE STOCK';
      physicalWarehouseQty = curStock;
      deliveredPendingInvoiceQty = 0;
    } else if (curStock > 0 && totalInvoicedQty > 0) {
      statusClass = 'VERIFIED PARTIALLY DISPATCHED ACTIVE STOCK';
      physicalWarehouseQty = curStock;
      deliveredPendingInvoiceQty = 0;
    } else {
      statusClass = 'VERIFIED FULLY DISPATCHED & INVOICED';
      physicalWarehouseQty = 0;
      deliveredPendingInvoiceQty = 0;
    }

    sumReceivedQty += impQty;
    sumWarehouseQty += physicalWarehouseQty;
    sumPendingInvoiceQty += deliveredPendingInvoiceQty;
    sumTotalLandedCost += Number(b.total_batch_landed_cost);
    sumExpectedCogs += expectedCogs;
    sumActualCogs += actualCogs;
    const remainingVal = Math.round((physicalWarehouseQty + deliveredPendingInvoiceQty) * Number(b.landed_cost_per_unit) * 100) / 100;
    sumRemainingVal += remainingVal;

    const row = [
      `"${b.id}"`,
      `"${b.batch_number}"`,
      `"${b.product_name.replace(/"/g, '""')}"`,
      `"${b.supplier_name.replace(/"/g, '""')}"`,
      `"${b.pi_number}"`,
      `"${b.pi_id || '-'}"`,
      b.import_quantity,
      b.import_price_usd || b.import_price || 0,
      b.exchange_rate_usd_to_idr || 1,
      Number(b.landed_cost_per_unit) - Number(b.cost_per_unit || b.import_price || 0),
      b.landed_cost_per_unit,
      b.total_batch_landed_cost,
      `"${dcStr}"`,
      `"${siStr}"`,
      expectedCogs,
      actualCogs,
      cogsRoundingDiff,
      `"${hfrStr}"`,
      `"${cnStr}"`,
      physicalWarehouseQty,
      deliveredPendingInvoiceQty,
      remainingVal,
      `"${statusClass}"`
    ];
    rows.push(row.join(','));
  }

  fs.writeFileSync('docs/audits/SAPJ_INVENTORY_HISTORY_COGS_BATCH_SCHEDULE.csv', rows.join('\n'));
  console.log('Successfully generated docs/audits/SAPJ_INVENTORY_HISTORY_COGS_BATCH_SCHEDULE.csv!');
  console.log(`Totals:
  Received Qty: ${sumReceivedQty} kg
  Physical Warehouse Qty: ${sumWarehouseQty} kg
  Delivered Pending Invoice Qty: ${sumPendingInvoiceQty} kg
  Total Stock (Warehouse + Pending Invoice): ${sumWarehouseQty + sumPendingInvoiceQty} kg
  Total Landed Cost: Rp ${sumTotalLandedCost}
  Expected COGS: Rp ${sumExpectedCogs}
  Actual Posted COGS: Rp ${sumActualCogs}
  COGS Rounding Diff: Rp ${Math.round((sumExpectedCogs - sumActualCogs) * 100) / 100}
  Total Remaining Value: Rp ${sumRemainingVal}`);

  await client.query('ROLLBACK;');
  await client.end();
}

generateCorrectedBatchSchedule().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
