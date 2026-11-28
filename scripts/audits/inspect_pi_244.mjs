import pg from 'pg';

const client = new pg.Client({ connectionString: (process.env.READONLY_AUDIT_DB_URL || '') });

async function run() {
  await client.connect();
  
  const piRes = await client.query(`
    SELECT id, invoice_number, total_amount, subtotal, tax_amount, exchange_rate, currency, status
    FROM public.purchase_invoices 
    WHERE invoice_number = 'E0000244/2627';
  `);
  console.log('Purchase Invoice:', piRes.rows[0]);
  const piId = piRes.rows[0].id;
  
  const piItems = await client.query(`
    SELECT pii.id, pii.product_id, p.product_name, pii.quantity, pii.unit_price, pii.line_total, pii.receiving_batch_number
    FROM public.purchase_invoice_items pii
    LEFT JOIN public.products p ON p.id = pii.product_id
    WHERE pii.purchase_invoice_id = $1
    ORDER BY pii.id;
  `, [piId]);
  console.log('\nPI Items count:', piItems.rows.length);
  let piTotQty = 0;
  let piTotAmount = 0;
  for (const it of piItems.rows) {
    piTotQty += Number(it.quantity);
    piTotAmount += Number(it.line_total);
    console.log(`PI Item: ${it.product_name} | Qty: ${it.quantity} | Unit Price: ${it.unit_price} | Line Total: ${it.line_total} | Batch: ${it.receiving_batch_number}`);
  }
  console.log(`PI Total Qty: ${piTotQty}, Total USD Amount: ${piTotAmount}`);
  const expectedIdr = piTotAmount * Number(piRes.rows[0].exchange_rate);
  console.log(`Expected IDR at exchange rate ${piRes.rows[0].exchange_rate}: Rp ${expectedIdr}`);
  
  const batchRes = await client.query(`
    SELECT b.id, b.batch_number, p.product_name, b.import_quantity, b.cost_per_unit, b.landed_cost_per_unit,
           b.total_cost, b.final_landed_cost, b.import_price, b.current_stock
    FROM public.batches b
    LEFT JOIN public.products p ON p.id = b.product_id
    WHERE b.purchase_invoice_id = $1
    ORDER BY b.batch_number;
  `, [piId]);
  console.log('\nBatches linked to PI count:', batchRes.rows.length);
  let bTotQty = 0;
  let bTotTotalCost = 0;
  let bTotCalcLanded = 0;
  for (const b of batchRes.rows) {
    bTotQty += Number(b.import_quantity);
    bTotTotalCost += Number(b.total_cost || 0);
    const calc = Number(b.import_quantity) * Number(b.landed_cost_per_unit || 0);
    bTotCalcLanded += calc;
    console.log(`Batch ${b.batch_number} (${b.id}): ${b.product_name} | import_qty: ${b.import_quantity} | landed_unit: ${b.landed_cost_per_unit} | total_cost: ${b.total_cost} | calc_val: ${calc}`);
  }
  console.log(`Batches Total Qty: ${bTotQty}, Total total_cost: ${bTotTotalCost}, Total Calc Landed: ${bTotCalcLanded}`);

  // Journal Entries
  const jeRes = await client.query(`
    SELECT je.id, je.entry_number, je.entry_date, je.total_debit, je.total_credit, je.description
    FROM public.journal_entries je
    WHERE je.reference_id = $1 OR je.reference_number = 'E0000244/2627' OR je.description ILIKE '%E0000244/2627%';
  `, [piId]);
  console.log('\nJournal Entries for PI:');
  for (const je of jeRes.rows) {
    console.log(`JE ${je.entry_number} (${je.id}) | Date: ${je.entry_date} | Debit: ${je.total_debit} | Credit: ${je.total_credit} | Desc: ${je.description}`);
    const lines = await client.query(`
      SELECT jl.account_id, ca.code, ca.name, jl.debit, jl.credit, jl.description
      FROM public.journal_lines jl
      LEFT JOIN public.chart_of_accounts ca ON ca.id = jl.account_id
      WHERE jl.journal_entry_id = $1;
    `, [je.id]);
    for (const l of lines.rows) {
      console.log(`   Line: ${l.code} (${l.name}) | Debit: ${l.debit} | Credit: ${l.credit} | ${l.description}`);
    }
  }

  await client.end();
}
run().catch(console.error);
