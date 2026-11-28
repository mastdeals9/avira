import pg from 'pg';

const client = new pg.Client({ connectionString: (process.env.READONLY_AUDIT_DB_URL || '') });

async function run() {
  await client.connect();
  
  const dcRes = await client.query(`
    SELECT 
      dc.id, dc.challan_number, dc.challan_date, dc.customer_id,
      dc.approval_status,
      dci.id as item_id, dci.batch_id, dci.quantity,
      b.batch_number, p.product_name, b.current_stock, b.landed_cost_per_unit, b.cost_per_unit,
      b.purchase_invoice_id, pi.invoice_number as pi_number
    FROM public.delivery_challans dc
    JOIN public.delivery_challan_items dci ON dci.challan_id = dc.id
    LEFT JOIN public.batches b ON b.id = dci.batch_id
    LEFT JOIN public.products p ON p.id = b.product_id
    LEFT JOIN public.purchase_invoices pi ON pi.id = b.purchase_invoice_id
    WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080', 'DO-26-0081')
    ORDER BY dc.challan_number;
  `);
  
  console.log('--- DELIVERY CHALLAN DETAILS ---');
  for (const r of dcRes.rows) {
    const landedUnit = Number(r.landed_cost_per_unit || r.cost_per_unit || 0);
    const itemVal = Number(r.quantity) * landedUnit;
    console.log(JSON.stringify({
      challan_number: r.challan_number,
      date: r.challan_date,
      batch_id: r.batch_id,
      batch_number: r.batch_number,
      product: r.product_name,
      qty_delivered: r.quantity,
      batch_current_stock: r.current_stock,
      landed_cost_per_unit: landedUnit,
      item_valuation: itemVal,
      pi_number: r.pi_number
    }, null, 2));
  }

  // Check sales_invoices linking to these delivery challans
  const siRes = await client.query(`
    SELECT si.id, si.invoice_number, si.linked_challan_ids, sii.quantity, sii.batch_id
    FROM public.sales_invoices si
    LEFT JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
    WHERE si.linked_challan_ids && $1::uuid[];
  `, [dcRes.rows.map(r => r.id)]);
  console.log('\nSales invoices linked to these challans:', siRes.rows.length);

  // Check batch 1084 in batches table
  const b1084 = await client.query(`
    SELECT b.id, b.batch_number, p.product_name, b.import_quantity, b.current_stock, b.landed_cost_per_unit, b.cost_per_unit
    FROM public.batches b
    LEFT JOIN public.products p ON p.id = b.product_id
    WHERE b.batch_number ILIKE '%1084%';
  `);
  console.log('\n--- BATCH 1084 QUERY ---');
  console.log(b1084.rows);

  // Also check which batch DO-26-0081 actually points to:
  const do81 = dcRes.rows.find(r => r.challan_number === 'DO-26-0081');
  console.log('\nDO-26-0081 row:', do81);

  await client.end();
}
run().catch(console.error);
