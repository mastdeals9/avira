import pg from 'pg';

const connectionString = 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  console.log('--- 4. DOMPERIDONE & PI E0000244/2627 AUDIT ---');
  const piRes = await client.query(`
    SELECT id, invoice_number, invoice_date, total_amount, currency, exchange_rate, status, receiving_approval_status, journal_entry_id
    FROM purchase_invoices
    WHERE invoice_number ILIKE '%E0000244%' OR invoice_number ILIKE '%2627%';
  `);
  console.log('Purchase Invoices found:');
  console.table(piRes.rows);

  if (piRes.rows.length > 0) {
    const piId = piRes.rows[0].id;
    const piItemsRes = await client.query(`
      SELECT 
        pii.id, pii.item_number, pii.product_id, p.name as product_name,
        pii.quantity, pii.unit_price, pii.total_amount,
        pii.batch_id, b.batch_number, b.import_quantity as batch_import_qty, b.current_stock as batch_current_stock,
        pii.received_quantity
      FROM purchase_invoice_items pii
      LEFT JOIN products p ON p.id = pii.product_id
      LEFT JOIN batches b ON b.id = pii.batch_id
      WHERE pii.purchase_invoice_id = $1
      ORDER BY pii.item_number ASC, pii.id ASC;
    `, [piId]);
    console.log(`PI items for ${piRes.rows[0].invoice_number} (${piItemsRes.rows.length} items):`);
    for (const item of piItemsRes.rows) {
      console.log(`  Item #${item.item_number || '-'}: ${item.product_name} | Qty: ${item.quantity} | Total: ${item.total_amount} | Batch: ${item.batch_number} (batch import qty: ${item.batch_import_qty}, curr stock: ${item.batch_current_stock})`);
    }

    if (piRes.rows[0].journal_entry_id) {
      const piJeRes = await client.query(`
        SELECT 
          jl.id, a.code, a.name, jl.debit, jl.credit, jl.description
        FROM journal_entry_lines jl
        JOIN chart_of_accounts a ON a.id = jl.account_id
        WHERE jl.journal_entry_id = $1
        ORDER BY jl.debit DESC;
      `, [piRes.rows[0].journal_entry_id]);
      console.log(`  Capitalization Journal for PI (${piJeRes.rows.length} lines):`);
      for (const line of piJeRes.rows) {
        console.log(`    Account ${line.code} (${line.name}): Dr ${line.debit} | Cr ${line.credit} | ${line.description}`);
      }
    }
  }

  // Also search specifically for journal JE-2610-0005
  const je2610Res = await client.query(`
    SELECT je.id, je.entry_number, je.entry_date, je.description, je.reference_number, je.is_posted
    FROM journal_entries je
    WHERE je.entry_number ILIKE '%2610-0005%' OR je.entry_number ILIKE '%JE2610-0005%';
  `);
  console.log('\nJournal JE-2610-0005:');
  console.table(je2610Res.rows);
  if (je2610Res.rows.length > 0) {
    const jeLines = await client.query(`
      SELECT jl.id, a.code, a.name, jl.debit, jl.credit, jl.description
      FROM journal_entry_lines jl
      JOIN chart_of_accounts a ON a.id = jl.account_id
      WHERE jl.journal_entry_id = $1
      ORDER BY jl.debit DESC;
    `, [je2610Res.rows[0].id]);
    for (const l of jeLines.rows) {
      console.log(`  Account ${l.code} (${l.name}): Dr ${l.debit} | Cr ${l.credit} | ${l.description}`);
    }
  }

  // Check batch BDM/2609056 cost layers
  const bdmLayers = await client.query(`
    SELECT * FROM purchase_batch_cost_layers WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  `);
  console.log('\nCost layers for batch BDM/2609056:', bdmLayers.rows);

  // ---------------------------------------------------------------------------
  // 5. DELIVERY CHALLANS DO-26-0079 & DO-26-0080
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. DO-26-0079 & DO-26-0080 ITEMS & MOVEMENTS ---');
  const dcItemsRes = await client.query(`
    SELECT 
      dci.*, dc.challan_number, dc.challan_date, dc.approval_status,
      b.batch_number, b.current_stock, b.cost_per_unit, b.landed_cost_per_unit,
      p.name as product_name
    FROM delivery_challan_items dci
    JOIN delivery_challans dc ON dc.id = dci.delivery_challan_id
    LEFT JOIN batches b ON b.id = dci.batch_id
    LEFT JOIN products p ON p.id = b.product_id
    WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080');
  `);
  console.log(`Found ${dcItemsRes.rows.length} delivery challan items:`);
  for (const item of dcItemsRes.rows) {
    console.log(`  ${item.challan_number} | Batch: ${item.batch_number} (${item.product_name}) | Qty: ${item.quantity} | Batch Curr Stock: ${item.current_stock} | Landed Cost/Unit: ${item.landed_cost_per_unit}`);
  }

  // Check physical movements for these two batches
  const batchIds = dcItemsRes.rows.map(r => r.batch_id).filter(Boolean);
  if (batchIds.length > 0) {
    const physMoves = await client.query(`
      SELECT * FROM inventory_operational_physical_ledger
      WHERE batch_id = ANY($1)
      ORDER BY event_timestamp ASC;
    `, [batchIds]);
    console.log(`Physical ledger records for DC batches (${physMoves.rows.length} rows):`);
    for (const m of physMoves.rows) {
      console.log(`  Batch ${m.batch_id} | Type: ${m.movement_type} | Qty: ${m.quantity} | Ref: ${m.reference_number} | Time: ${m.event_timestamp}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. COGS GL 5100 RECONCILIATION
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. COGS GL 5100 RECONCILIATION ---');
  const cogsSummaryRes = await client.query(`
    SELECT 
      COUNT(*) as total_lines,
      SUM(jl.debit) as total_debits,
      SUM(jl.credit) as total_credits,
      SUM(jl.debit - jl.credit) as net_cogs
    FROM journal_entry_lines jl
    JOIN chart_of_accounts a ON a.id = jl.account_id
    WHERE a.code = '5100';
  `);
  console.log('GL 5100 Summary:');
  console.table(cogsSummaryRes.rows);

  const cogsCreditsRes = await client.query(`
    SELECT 
      je.entry_number, je.entry_date, je.reference_number, je.description as je_desc,
      jl.credit, jl.description as line_desc
    FROM journal_entry_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
    WHERE a.code = '5100' AND jl.credit > 0
    ORDER BY jl.credit DESC;
  `);
  console.log(`Credits in GL 5100 (${cogsCreditsRes.rows.length} lines):`);
  console.table(cogsCreditsRes.rows);

  // Check sales invoices COGS
  const siCogsRes = await client.query(`
    SELECT 
      COUNT(*) as count,
      SUM(total_cogs) as sum_total_cogs
    FROM sales_invoices
    WHERE is_draft = false AND document_status <> 'cancelled';
  `);
  console.log('Sales Invoices Non-draft COGS:');
  console.table(siCogsRes.rows);

  // Check credit notes COGS impact
  const cnRes = await client.query(`
    SELECT 
      COUNT(*) as count,
      SUM(total_amount) as sum_total,
      SUM(total_amount_idr) as sum_idr
    FROM credit_notes
    WHERE approval_status = 'approved';
  `).catch(err => {
    return client.query(`
      SELECT COUNT(*) as count, SUM(total_amount) as sum_total
      FROM credit_notes
      WHERE approval_status = 'approved';
    `);
  });
  console.log('Credit Notes:');
  console.table(cnRes.rows);

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
