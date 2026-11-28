import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  console.log('================================================================');
  console.log('PROMPT 7C — DEEP FORENSIC INVESTIGATION');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // 1. INVESTIGATE SPECIFIC VOUCHERS & LANDED COSTS (EXPENSES)
  // ---------------------------------------------------------------------------
  console.log('--- 1. SPECIFIC EXPENSE VOUCHERS AUDIT ---');
  const targetVouchers = [
    'EXP/26/102', 'EXP/26/103', 'EXP/26-26/115', 'EXP/26-26/139', 'EXP/26/178',
    'EXP/25/292', 'EXP/26/183', 'EXP/26/185', 'EXP/26/196', 'EXP/26/197'
  ];

  const expRes = await client.query(`
    SELECT 
      fe.id, fe.voucher_number, fe.expense_date, fe.approval_status,
      fe.supplier_id, fe.invoice_number, fe.description, fe.expense_category,
      fe.amount, fe.transaction_currency, fe.exchange_rate,
      fe.include_in_landed_cost, fe.import_container_id, fe.batch_id,
      fe.broker_items,
      je.id as journal_entry_id, je.entry_number, je.entry_date, je.is_posted
    FROM finance_expenses fe
    LEFT JOIN journal_entries je ON je.reference_id = fe.id AND je.source_module = 'expenses'
    WHERE fe.voucher_number = ANY($1)
    ORDER BY fe.voucher_number;
  `, [targetVouchers]);

  console.log(`Found ${expRes.rows.length} expense vouchers:`);
  for (const row of expRes.rows) {
    console.log(`\n[Voucher ${row.voucher_number}] Date: ${row.expense_date?.toISOString?.().slice(0, 10)} | Amount: ${row.transaction_currency} ${row.amount} @ rate ${row.exchange_rate}`);
    console.log(`  Description: ${row.description} | Category: ${row.expense_category}`);
    console.log(`  include_in_landed_cost: ${row.include_in_landed_cost} | container: ${row.import_container_id} | batch: ${row.batch_id}`);
    console.log(`  Journal: ${row.entry_number} (posted: ${row.is_posted})`);
    if (row.broker_items) {
      console.log(`  Broker items:`, JSON.stringify(row.broker_items));
    }

    if (row.journal_entry_id) {
      const jlRes = await client.query(`
        SELECT 
          jl.id, jl.account_id, a.code, a.name,
          jl.debit, jl.credit, jl.description
        FROM journal_entry_lines jl
        JOIN chart_of_accounts a ON a.id = jl.account_id
        WHERE jl.journal_entry_id = $1
        ORDER BY jl.debit DESC, jl.credit DESC;
      `, [row.journal_entry_id]);
      console.log(`  Journal lines (${jlRes.rows.length}):`);
      for (const line of jlRes.rows) {
        console.log(`    Account ${line.code} (${line.name}): Dr ${line.debit} | Cr ${line.credit} | ${line.description}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. GL 5300 (FREIGHT IN) & GL 1130 (INVENTORY) LANDED COST DEBITS
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. GL 5300 (FREIGHT IN) COMPLETE ACTIVITY ---');
  const gl5300Res = await client.query(`
    SELECT 
      jl.id, je.entry_number, je.entry_date, je.description as je_desc,
      jl.debit, jl.credit, jl.description as line_desc,
      fe.voucher_number as exp_voucher, fe.include_in_landed_cost
    FROM journal_entry_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
    LEFT JOIN finance_expenses fe ON fe.id = je.reference_id AND je.source_module = 'expenses'
    WHERE a.code = '5300'
    ORDER BY je.entry_date ASC, je.entry_number ASC;
  `);
  console.log(`Found ${gl5300Res.rows.length} lines in Account 5300:`);
  let total5300Dr = 0;
  let total5300Cr = 0;
  for (const r of gl5300Res.rows) {
    const dr = parseFloat(r.debit || 0);
    const cr = parseFloat(r.credit || 0);
    total5300Dr += dr;
    total5300Cr += cr;
    console.log(`  ${r.entry_date?.toISOString?.().slice(0, 10)} | ${r.entry_number} | Dr ${dr.toLocaleString()} | Cr ${cr.toLocaleString()} | Voucher: ${r.exp_voucher || '-'} | LandedCost: ${r.include_in_landed_cost} | ${r.line_desc || r.je_desc}`);
  }
  console.log(`GL 5300 Totals: Total Dr = ${total5300Dr.toLocaleString()}, Total Cr = ${total5300Cr.toLocaleString()}, Net Dr = ${(total5300Dr - total5300Cr).toLocaleString()}`);

  // ---------------------------------------------------------------------------
  // 3. PURCHASE BATCH COST LAYERS AUDIT
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. PURCHASE BATCH COST LAYERS SUMMARY ---');
  const layerRes = await client.query(`
    SELECT 
      layer_type, 
      COUNT(*) as count,
      SUM(allocated_amount) as total_allocated
    FROM purchase_batch_cost_layers
    GROUP BY layer_type;
  `).catch(err => {
    console.log('Error querying purchase_batch_cost_layers:', err.message);
    return { rows: [] };
  });
  console.table(layerRes.rows);

  // Check columns of purchase_batch_cost_layers
  const layerCols = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'purchase_batch_cost_layers';
  `).catch(() => ({ rows: [] }));
  console.log('Layer table columns:', layerCols.rows.map(r => r.column_name));

  // Check all distinct cost layers
  const allLayers = await client.query(`
    SELECT pbcl.*, b.batch_number
    FROM purchase_batch_cost_layers pbcl
    LEFT JOIN batches b ON b.id = pbcl.batch_id
    ORDER BY pbcl.created_at ASC;
  `).catch(err => ({ rows: [] }));
  console.log(`Total cost layers: ${allLayers.rows.length}`);
  let sumCostLayers = 0;
  for (const l of allLayers.rows) {
    sumCostLayers += parseFloat(l.allocated_amount || l.amount || 0);
  }
  console.log(`Sum of all cost layers: ${sumCostLayers.toLocaleString()}`);

  // ---------------------------------------------------------------------------
  // 4. DOMPERIDONE (PI E0000244/2627) DEEP AUDIT
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. DOMPERIDONE & PI E0000244/2627 AUDIT ---');
  const piRes = await client.query(`
    SELECT id, invoice_number, invoice_date, total_amount, currency, exchange_rate, total_amount_idr, approval_status, journal_entry_id
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
    SELECT je.id, je.entry_number, je.entry_date, je.description, je.reference, je.is_posted
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

  // ---------------------------------------------------------------------------
  // 5. DELIVERY CHALLANS DO-26-0079 & DO-26-0080 ITEMS & MOVEMENTS
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

  // Check sales invoice items linked to these DCs
  const invLinksRes = await client.query(`
    SELECT sii.id, sii.sales_invoice_id, si.invoice_number, si.is_draft, si.document_status, sii.batch_id, sii.quantity
    FROM sales_invoice_items sii
    JOIN sales_invoices si ON si.id = sii.sales_invoice_id
    WHERE sii.delivery_challan_item_id IN (
      SELECT dci.id FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.delivery_challan_id
      WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080')
    ) OR sii.batch_id IN (
      SELECT dci.batch_id FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.delivery_challan_id
      WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080')
    );
  `);
  console.log(`Sales invoice items linked to DO-26-0079 / DO-26-0080 batches: ${invLinksRes.rows.length}`);
  for (const r of invLinksRes.rows) {
    console.log(`  Invoice ${r.invoice_number} (draft: ${r.is_draft}, status: ${r.document_status}) | Batch: ${r.batch_id} | Qty: ${r.quantity}`);
  }

  // ---------------------------------------------------------------------------
  // 6. COGS GL 5100 GROSS BREAKDOWN (DEBITS vs CREDITS)
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. COGS GL 5100 GROSS BREAKDOWN ---');
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

  // Group by journal entry source / type
  const cogsBySourceRes = await client.query(`
    SELECT 
      CASE 
        WHEN je.reference ILIKE 'INV-%' OR je.reference ILIKE 'SI-%' OR je.entry_number ILIKE 'JE-SI-%' THEN 'Sales Invoice'
        WHEN je.reference ILIKE 'CN-%' OR je.entry_number ILIKE 'JE-CN-%' THEN 'Credit Note'
        ELSE 'Other'
      END as source_type,
      COUNT(*) as line_count,
      SUM(jl.debit) as total_debit,
      SUM(jl.credit) as total_credit,
      SUM(jl.debit - jl.credit) as net_amount
    FROM journal_entry_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
    WHERE a.code = '5100'
    GROUP BY 1;
  `);
  console.log('GL 5100 By Source Type:');
  console.table(cogsBySourceRes.rows);

  // Inspect the credits in GL 5100 (why are there Rp 501M credits?)
  const cogsCreditsRes = await client.query(`
    SELECT 
      je.entry_number, je.entry_date, je.reference, je.description as je_desc,
      jl.credit, jl.description as line_desc
    FROM journal_entry_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
    WHERE a.code = '5100' AND jl.credit > 0
    ORDER BY jl.credit DESC
    LIMIT 20;
  `);
  console.log('Top Credits in GL 5100:');
  console.table(cogsCreditsRes.rows);

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
