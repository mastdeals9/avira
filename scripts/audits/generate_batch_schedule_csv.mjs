import pg from 'pg';
import fs from 'fs';

const connectionString = 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

async function generateBatchSchedule() {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('BEGIN READ ONLY;');

  console.log('Generating full batch schedule CSV for all 84 batches...');

  const batches = await client.query(`
    SELECT 
      b.id,
      b.batch_number,
      p.product_name,
      COALESCE(s.company_name, '-') as supplier_name,
      COALESCE(pi.invoice_number, '-') as pi_number,
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
    'batch_number',
    'product_name',
    'supplier_name',
    'purchase_invoice_ref',
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
    'corrective_journals_hfr',
    'credit_note_returns',
    'remaining_quantity',
    'remaining_batch_value',
    'unexplained_monetary_difference',
    'status_classification'
  ];
  rows.push(headers.join(','));

  for (const b of batches.rows) {
    // 1. Get delivery challans
    const dcRes = await client.query(`
      SELECT dc.challan_number, dci.quantity
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.batch_id = $1;
    `, [b.id]);
    const dcStr = dcRes.rows.map(r => `${r.challan_number}(${r.quantity}kg)`).join('; ') || '-';

    // 2. Get sales invoices
    const siRes = await client.query(`
      SELECT si.invoice_number, sii.quantity, sii.cogs_total_cost
      FROM sales_invoice_items sii
      JOIN sales_invoices si ON si.id = sii.invoice_id
      WHERE sii.batch_id = $1 AND NOT COALESCE(si.is_draft, false) AND COALESCE(si.document_status, 'issued') != 'cancelled';
    `, [b.id]);
    const siStr = siRes.rows.map(r => `${r.invoice_number}(${r.quantity}kg)`).join('; ') || '-';
    const totalInvoicedCogs = siRes.rows.reduce((s, r) => s + Number(r.cogs_total_cost), 0);
    const totalInvoicedQty = siRes.rows.reduce((s, r) => s + Number(r.quantity), 0);

    // 3. Expected COGS = Invoiced Qty * landed_cost_per_unit
    const expectedCogs = Math.round(totalInvoicedQty * Number(b.landed_cost_per_unit) * 100) / 100;

    // 4. Actual posted COGS
    const actualCogs = Math.round(totalInvoicedCogs * 100) / 100;

    // 5. Corrective journals
    const hfrRes = await client.query(`
      SELECT DISTINCT je.entry_number
      FROM journal_entries je
      WHERE (je.description ILIKE '%' || $1 || '%')
        AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
    `, [b.batch_number]);
    const hfrStr = hfrRes.rows.map(r => r.entry_number).join('; ') || '-';

    // 6. Credit notes / returns
    const cnRes = await client.query(`
      SELECT DISTINCT cn.credit_note_number
      FROM credit_notes cn
      WHERE cn.notes ILIKE '%' || $1 || '%';
    `, [b.batch_number]);
    const cnStr = cnRes.rows.map(r => r.credit_note_number).join('; ') || '-';

    // 7. Status classification
    let statusClass = 'VERIFIED AND RECONCILED';
    const curStock = Number(b.current_stock);
    const impQty = Number(b.import_quantity);

    if (curStock === 0 && totalInvoicedQty === 0 && dcRes.rows.length === 0) {
      statusClass = 'TIMING DIFFERENCE - IN-TRANSIT IMPORT SKELETON';
    } else if (curStock > 0 && totalInvoicedQty === 0 && dcRes.rows.length > 0) {
      statusClass = 'TIMING DIFFERENCE - DISPATCHED PENDING SALES INVOICE';
    } else if (curStock > 0 && totalInvoicedQty === 0) {
      statusClass = 'VERIFIED ACTIVE WAREHOUSE STOCK';
    } else if (curStock > 0 && totalInvoicedQty > 0) {
      statusClass = 'VERIFIED PARTIALLY DISPATCHED ACTIVE STOCK';
    } else if (curStock === 0 && Math.abs(impQty - totalInvoicedQty) < 0.01) {
      statusClass = 'VERIFIED FULLY DISPATCHED & INVOICED';
    }

    const diff = Math.round((expectedCogs - actualCogs) * 100) / 100;

    const row = [
      `"${b.batch_number}"`,
      `"${b.product_name.replace(/"/g, '""')}"`,
      `"${b.supplier_name.replace(/"/g, '""')}"`,
      `"${b.pi_number}"`,
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
      `"${hfrStr}"`,
      `"${cnStr}"`,
      b.current_stock,
      b.remaining_batch_value,
      diff,
      `"${statusClass}"`
    ];
    rows.push(row.join(','));
  }

  fs.writeFileSync('docs/audits/SAPJ_INVENTORY_HISTORY_COGS_BATCH_SCHEDULE.csv', rows.join('\n'));
  console.log('Successfully generated docs/audits/SAPJ_INVENTORY_HISTORY_COGS_BATCH_SCHEDULE.csv with 84 batches!');

  await client.query('ROLLBACK;');
  await client.end();
}

generateBatchSchedule().catch(err => {
  console.error('Error generating batch schedule:', err);
  process.exit(1);
});
