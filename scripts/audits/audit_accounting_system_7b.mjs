import pg from 'pg';

const connectionString = 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

async function runAudit() {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('BEGIN READ ONLY;');

  console.log('=== SAPJ ACCOUNTING SYSTEM INTEGRITY AUDIT (PROMPT 7B) ===\n');

  // 1. Double-entry balance check across all posted journal entries
  const unbalRes = await client.query(`
    SELECT 
      je.id,
      je.entry_number,
      je.entry_date,
      je.source_module,
      COALESCE(SUM(jel.debit), 0) as total_debit,
      COALESCE(SUM(jel.credit), 0) as total_credit,
      ROUND(ABS(COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0))::numeric, 2) as diff
    FROM public.journal_entries je
    LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    GROUP BY je.id, je.entry_number, je.entry_date, je.source_module
    HAVING ROUND(ABS(COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0))::numeric, 2) > 0.01;
  `);
  console.log('1. Unbalanced Posted Journals Count:', unbalRes.rows.length);
  if (unbalRes.rows.length > 0) console.table(unbalRes.rows);

  // 2. Total Debits vs Credits in Posted GL (Trial Balance Integrity)
  const tbSumRes = await client.query(`
    SELECT 
      COALESCE(SUM(jel.debit), 0) as gl_total_debit,
      COALESCE(SUM(jel.credit), 0) as gl_total_credit,
      ROUND((COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0))::numeric, 2) as gl_net_difference
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
  `);
  console.log('2. GL Overall Debit vs Credit Sum:');
  console.table(tbSumRes.rows);

  // 3. GL Lines with missing or inactive COA accounts
  const invalidCoaRes = await client.query(`
    SELECT jel.id, jel.journal_entry_id, je.entry_number, jel.account_id, coa.code, coa.name, coa.is_active
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    LEFT JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE jel.account_id IS NULL OR coa.id IS NULL OR coa.is_active = false;
  `);
  console.log('3. GL Lines with Missing or Inactive COA Accounts:', invalidCoaRes.rows.length);
  if (invalidCoaRes.rows.length > 0) console.table(invalidCoaRes.rows);

  // 4. Duplicate Journal Entries for same reference_id / reference_number
  const dupJeRes = await client.query(`
    SELECT 
      source_module, 
      COALESCE(reference_id::text, reference_number) as ref_doc, 
      COUNT(*) as je_count, 
      ARRAY_AGG(entry_number) as entry_numbers
    FROM public.journal_entries
    WHERE (reference_id IS NOT NULL OR reference_number IS NOT NULL)
      AND is_posted = true 
      AND NOT COALESCE(is_reversed, false)
    GROUP BY source_module, COALESCE(reference_id::text, reference_number)
    HAVING COUNT(*) > 1;
  `);
  console.log('4. Duplicate Posted Journals for same ref_doc:', dupJeRes.rows.length);
  if (dupJeRes.rows.length > 0) console.table(dupJeRes.rows);

  // 5. PPh 23 discrepancy check: Rp 63,000 vs Rp 15,000
  console.log('\n--- 5. PPh 23 DISCREPANCY INVESTIGATION ---');
  const pph23Gl = await client.query(`
    SELECT 
      coa.code, coa.name,
      jel.id as line_id, je.entry_number, je.entry_date, je.source_module,
      jel.debit, jel.credit, jel.description
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code IN ('2143', '2140', '1153', '1163') OR coa.name ILIKE '%pph 23%'
    ORDER BY je.entry_date, jel.id;
  `);
  console.log('PPh 23 GL lines count:', pph23Gl.rows.length);
  console.table(ppph23Rows(pph23Gl.rows));

  // Check all finance_expenses with pph
  const expPph = await client.query(`
    SELECT id, voucher_number, expense_date, amount, pph_code_id, pph_rate, pph_amount, tax_period_id, paid_amount, description
    FROM public.finance_expenses
    WHERE pph_amount IS NOT NULL AND pph_amount > 0
    ORDER BY expense_date;
  `);
  console.log('Expenses with PPh:', expPph.rows.length);
  console.table(expPph.rows);

  // 6. Invoices SAPJ-005 and SAPJ-26-075 missing Faktur Pajak investigation
  console.log('\n--- 6. SAPJ-005 & SAPJ-26-075 FAKTUR PAJAK INVESTIGATION ---');
  const invRes = await client.query(`
    SELECT 
      si.id, si.invoice_number, si.invoice_date, si.subtotal, si.tax_amount, si.total_amount,
      si.payment_status, si.document_status, si.faktur_pajak_number, si.journal_entry_id,
      c.company_name as customer_name, c.npwp as customer_npwp, si.customer_po_file_url
    FROM public.sales_invoices si
    LEFT JOIN public.customers c ON c.id = si.customer_id
    WHERE si.invoice_number IN ('SAPJ-005', 'SAPJ-26-075', 'SAPJ-26-072')
    ORDER BY si.invoice_number;
  `);
  console.table(invRes.rows);

  // Check universal_documents or universal_document_versions
  const docRes = await client.query(`
    SELECT ud.id, ud.title, ud.document_type, udv.original_file_name, udv.file_url, ud.notes
    FROM public.universal_documents ud
    LEFT JOIN public.universal_document_versions udv ON udv.id = ud.current_version_id
    WHERE ud.title ILIKE '%005%' OR ud.title ILIKE '%075%' 
       OR udv.original_file_name ILIKE '%005%' OR udv.original_file_name ILIKE '%075%'
       OR ud.notes ILIKE '%005%' OR ud.notes ILIKE '%075%';
  `);
  console.log('Universal Documents matches for 005 / 075:', docRes.rows.length);
  if (docRes.rows.length > 0) console.table(docRes.rows);

  // 7. Inventory Valuation vs Account 1140
  console.log('\n--- 7. INVENTORY VALUATION VS GL 1140 ---');
  const gl1140 = await client.query(`
    SELECT 
      coa.code, coa.name,
      SUM(jel.debit) as total_debit,
      SUM(jel.credit) as total_credit,
      SUM(jel.debit - jel.credit) as net_inventory_gl_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '1140' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    GROUP BY coa.code, coa.name;
  `);
  console.table(gl1140.rows);

  const batchVal = await client.query(`
    SELECT 
      COUNT(*) as total_batches,
      SUM(current_stock) as total_quantity_on_hand,
      SUM(current_stock * cost_per_unit) as total_batch_cost_valuation
    FROM public.batches
    WHERE current_stock > 0;
  `);
  console.table(batchVal.rows);

  // Check reconciliation view
  const recView = await client.query(`SELECT * FROM public.inventory_gl_valuation_reconciliation;`);
  console.log('Existing inventory_gl_valuation_reconciliation:', recView.rows);

  // 8. Trial Balance by Account Type
  console.log('\n--- 8. TRIAL BALANCE ACCOUNTS SUMMARY ---');
  const tbAccounts = await client.query(`
    SELECT 
      coa.code, coa.name, coa.account_type,
      SUM(jel.debit) as debit,
      SUM(jel.credit) as credit,
      CASE 
        WHEN coa.account_type IN ('asset', 'expense', 'cost_of_sales') THEN SUM(jel.debit - jel.credit)
        ELSE SUM(jel.credit - jel.debit)
      END as net_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    GROUP BY coa.code, coa.name, coa.account_type
    ORDER BY coa.code;
  `);
  console.log('Total accounts with activity:', tbAccounts.rows.length);
  const typeSummary = {};
  for (const r of tbAccounts.rows) {
    if (!typeSummary[r.account_type]) typeSummary[r.account_type] = { total_debit: 0, total_credit: 0, net: 0, count: 0 };
    typeSummary[r.account_type].total_debit += Number(r.debit);
    typeSummary[r.account_type].total_credit += Number(r.credit);
    typeSummary[r.account_type].net += Number(r.net_balance);
    typeSummary[r.account_type].count++;
  }
  console.table(typeSummary);

  // 9. Profit & Loss Check (Revenue vs COGS vs Expenses)
  console.log('\n--- 9. P&L REVENUE VS COGS VS EXPENSES ---');
  const pnlRes = await client.query(`
    SELECT 
      coa.account_type,
      coa.code,
      coa.name,
      SUM(jel.debit) as debit,
      SUM(jel.credit) as credit,
      CASE 
        WHEN coa.account_type IN ('expense', 'cost_of_sales') THEN SUM(jel.debit - jel.credit)
        ELSE SUM(jel.credit - jel.debit)
      END as net_pnl_impact
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
      AND coa.account_type IN ('revenue', 'cost_of_sales', 'expense')
    GROUP BY coa.account_type, coa.code, coa.name
    ORDER BY coa.code;
  `);
  console.table(pnlRes.rows);

  await client.query('COMMIT;');
  await client.end();
}

function ppph23Rows(rows) {
  return rows.map(r => ({
    code: r.code,
    name: r.name,
    entry_number: r.entry_number,
    entry_date: r.entry_date?.toISOString?.()?.substring(0, 10) || r.entry_date,
    source_module: r.source_module,
    debit: r.debit,
    credit: r.credit,
    desc: r.description
  }));
}

runAudit().catch(console.error);
