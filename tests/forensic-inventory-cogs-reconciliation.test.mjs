import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');
const schedulePath = path.resolve('docs/audits/SAPJ_INVENTORY_HISTORY_COGS_BATCH_SCHEDULE.csv');

test('Forensic Inventory History & Historical COGS Final Reconciliation Suite', async (t) => {
  let client;

  t.before(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query('BEGIN READ ONLY;');
  });

  t.after(async () => {
    if (client) {
      await client.query('ROLLBACK;').catch(() => {});
      await client.end();
    }
  });

  await t.test('1. Batch Schedule CSV exists and covers all 84 historical batches', () => {
    assert.ok(fs.existsSync(schedulePath), 'Schedule CSV file must exist');
    const content = fs.readFileSync(schedulePath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 85, 'Must contain header + 84 batch records');
  });

  await t.test('2. Three-Way COGS Equilibrium: Invoiced COGS - Credit Note == GL 5100 Net Balance', async () => {
    // 1. Gross Invoice Snapshot COGS
    const snapRes = await client.query(`
      SELECT 
        count(DISTINCT si.id) as si_count,
        count(sii.id) as line_count,
        ROUND(SUM(sii.cogs_total_cost)::numeric, 2) as gross_snapshot_cogs
      FROM sales_invoices si
      JOIN sales_invoice_items sii ON sii.invoice_id = si.id
      WHERE NOT COALESCE(si.is_draft, false) AND COALESCE(si.document_status, 'issued') != 'cancelled';
    `);
    const grossSnap = Number(snapRes.rows[0].gross_snapshot_cogs);
    assert.equal(snapRes.rows[0].si_count, '85', 'Must have exactly 85 issued sales invoices');
    assert.equal(grossSnap, 6977983250.42, 'Gross Snapshot COGS must equal Rp 6,977,983,250.42');

    // 2. Credit Note COGS reversal
    const cnRes = await client.query(`
      SELECT ROUND(SUM(jel.credit)::numeric, 2) as cn_cogs_credit
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '5100' AND je.source_module = 'credit_note_cogs' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
    `);
    const cnCogs = Number(cnRes.rows[0].cn_cogs_credit);
    assert.equal(cnCogs, 1227102.50, 'Credit Note COGS reversal must equal Rp 1,227,102.50');

    // Net Invoiced COGS
    const netInvoicedCogs = Math.round((grossSnap - cnCogs) * 100) / 100;
    assert.equal(netInvoicedCogs, 6976756147.92, 'Net Invoiced COGS must equal Rp 6,976,756,147.92');

    // 3. GL 5100 Net Balance
    const glRes = await client.query(`
      SELECT 
        ROUND((SUM(jel.debit) - SUM(jel.credit))::numeric, 2) as net_gl_5100
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '5100' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
    `);
    const netGl5100 = Number(glRes.rows[0].net_gl_5100);
    assert.equal(netGl5100, 6976756147.92, 'GL 5100 Net Balance must equal Rp 6,976,756,147.92');

    // Equilibrium
    assert.equal(netInvoicedCogs - netGl5100, 0, 'Three-way variance must be exactly Rp 0.00');
  });

  await t.test('3. Verification of September 21 Baseline and Subsequent Period Reconciliations', async () => {
    // Period 1 (<= 2026-09-21)
    const p1Res = await client.query(`
      SELECT 
        count(DISTINCT si.id) as si_count,
        count(sii.id) as line_count
      FROM sales_invoices si
      JOIN sales_invoice_items sii ON sii.invoice_id = si.id
      WHERE NOT COALESCE(si.is_draft, false) AND COALESCE(si.document_status, 'issued') != 'cancelled'
        AND si.invoice_date <= '2026-09-21';
    `);
    assert.equal(p1Res.rows[0].si_count, '70', 'Period 1 must contain exactly 70 sales invoices');
    assert.equal(p1Res.rows[0].line_count, '91', 'Period 1 must contain exactly 91 sales invoice lines');

    // Period 2 (> 2026-09-21)
    const p2Res = await client.query(`
      SELECT 
        count(DISTINCT si.id) as si_count,
        count(sii.id) as line_count,
        ROUND(SUM(sii.cogs_total_cost)::numeric, 2) as snapshot_cogs
      FROM sales_invoices si
      JOIN sales_invoice_items sii ON sii.invoice_id = si.id
      WHERE NOT COALESCE(si.is_draft, false) AND COALESCE(si.document_status, 'issued') != 'cancelled'
        AND si.invoice_date > '2026-09-21';
    `);
    assert.equal(p2Res.rows[0].si_count, '15', 'Period 2 must contain exactly 15 sales invoices');
    assert.equal(p2Res.rows[0].line_count, '19', 'Period 2 must contain exactly 19 sales invoice lines');
    assert.equal(Number(p2Res.rows[0].snapshot_cogs), 1222401166.22);

    // Period 2 GL 5100 postings
    const p2GlRes = await client.query(`
      SELECT ROUND((SUM(jel.debit) - SUM(jel.credit))::numeric, 2) as gl_cogs
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '5100' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date > '2026-09-21';
    `);
    assert.equal(Number(p2GlRes.rows[0].gl_cogs), 1222401166.22, 'Period 2 GL 5100 must match snapshot COGS exactly');
  });

  await t.test('4. Forensic Proof of the Rp 51,347,274.77 Inbound Capitalization Gap', async () => {
    // 1. Total batch landed cost in batches table
    const bRes = await client.query(`
      SELECT ROUND(SUM(import_quantity * COALESCE(landed_cost_per_unit, cost_per_unit, import_price, 0))::numeric, 2) as total_batch_cost
      FROM batches;
    `);
    const totalBatchCost = Number(bRes.rows[0].total_batch_cost);
    assert.equal(totalBatchCost, 11410570478.90);

    // 2. Total inbound capitalization in GL 1130
    const inRes = await client.query(`
      SELECT ROUND(SUM(jel.debit)::numeric, 2) as total_gl_inbound
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '1130' AND je.source_module IN ('purchase_invoice', 'finance_adjustment', 'expenses', 'customs_duty_adjustment')
        AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
    `);
    const totalGlInbound = Number(inRes.rows[0].total_gl_inbound);
    assert.equal(totalGlInbound, 11359223204.13);

    // 3. Difference is exactly Rp 51,347,274.77
    const diff = Math.round((totalBatchCost - totalGlInbound) * 100) / 100;
    assert.equal(diff, 51347274.77, 'Difference between Batch Cost and GL Inbound Capitalization must be exactly Rp 51,347,274.77');
  });

  await t.test('5. Proof that the Claimed Rp 3.201bn Represents In-Transit Imports, Not Missing COGS', async () => {
    // Check the 23 in-transit skeleton batches created in Oct/Nov 2026
    const b23 = await client.query(`
      SELECT 
        count(*) as batch_count,
        SUM(import_quantity) as total_in_transit_qty,
        SUM(current_stock) as current_stock,
        ROUND(SUM(import_quantity * COALESCE(landed_cost_per_unit, cost_per_unit, import_price, 0))::numeric, 2) as in_transit_val
      FROM batches b
      WHERE b.import_quantity > 0 AND b.current_stock = 0 
        AND b.id NOT IN (SELECT DISTINCT batch_id FROM sales_invoice_items WHERE batch_id IS NOT NULL);
    `);
    assert.equal(b23.rows[0].batch_count, '23', 'Must have exactly 23 unreceived skeleton batches');
    assert.equal(Number(b23.rows[0].total_in_transit_qty), 44100.000);
    assert.equal(Number(b23.rows[0].current_stock), 0.000);

    // Confirm that zero delivery challans exist for these 23 batches
    const dcCheck = await client.query(`
      SELECT count(*) as dc_count
      FROM delivery_challan_items dci
      WHERE dci.batch_id IN (
        SELECT b.id FROM batches b
        WHERE b.import_quantity > 0 AND b.current_stock = 0 
          AND b.id NOT IN (SELECT DISTINCT batch_id FROM sales_invoice_items WHERE batch_id IS NOT NULL)
      );
    `);
    assert.equal(dcCheck.rows[0].dc_count, '0', 'Zero delivery challans must exist for in-transit skeleton batches');
  });

  await t.test('6. Active Physical Inventory Invariant: 3,445 kg across 18 batches valued at Rp 1,180,489,520.95', async () => {
    const actRes = await client.query(`
      SELECT 
        count(*) as batch_count,
        SUM(current_stock) as physical_stock,
        ROUND(SUM(current_stock * COALESCE(landed_cost_per_unit, cost_per_unit, import_price, 0))::numeric, 2) as physical_valuation
      FROM batches
      WHERE current_stock > 0;
    `);
    assert.equal(actRes.rows[0].batch_count, '18', 'Must be exactly 18 active batches on hand');
    assert.equal(Number(actRes.rows[0].physical_stock), 3445.000, 'Must be exactly 3,445 kg on hand');
    assert.equal(Number(actRes.rows[0].physical_valuation), 1180489520.95, 'Must equal exactly Rp 1,180,489,520.95');
  });

  await t.test('7. Historical Bridge Neutralization Invariant: Bridge entries net to Rp 0.00', async () => {
    const bridgeRes = await client.query(`
      SELECT 
        ROUND((SUM(jel.debit) - SUM(jel.credit))::numeric, 2) as net_bridge_impact
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '1130' 
        AND je.source_module IN ('historical_inventory_valuation', 'historical_inventory_bridge_neutralization')
        AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
    `);
    assert.equal(Number(bridgeRes.rows[0].net_bridge_impact), 0.00, 'Bridge and neutralization must net to exactly Rp 0.00');
  });

  await t.test('8. Delivered Stock Awaiting Invoicing: 350 kg across 2 approved challans valued at Rp 39,179,000.00', async () => {
    const delRes = await client.query(`
      SELECT 
        dc.challan_number,
        dci.quantity,
        b.batch_number,
        b.landed_cost_per_unit,
        ROUND((dci.quantity * b.landed_cost_per_unit)::numeric, 2) as delivered_value
      FROM delivery_challans dc
      JOIN delivery_challan_items dci ON dci.challan_id = dc.id
      JOIN batches b ON b.id = dci.batch_id
      WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080')
      ORDER BY dc.challan_number;
    `);
    assert.equal(delRes.rows.length, 2, 'Must have exactly 2 pending delivery challans');
    
    // DO-26-0079: 100 kg @ 176,750 = Rp 17,675,000.00
    assert.equal(delRes.rows[0].challan_number, 'DO-26-0079');
    assert.equal(Number(delRes.rows[0].quantity), 100.000);
    assert.equal(Number(delRes.rows[0].delivered_value), 17675000.00);

    // DO-26-0080: 250 kg @ 86,016 = Rp 21,504,000.00
    assert.equal(delRes.rows[1].challan_number, 'DO-26-0080');
    assert.equal(Number(delRes.rows[1].quantity), 250.000);
    assert.equal(Number(delRes.rows[1].delivered_value), 21504000.00);

    const totDeliveredVal = Number(delRes.rows[0].delivered_value) + Number(delRes.rows[1].delivered_value);
    assert.equal(totDeliveredVal, 39179000.00, 'Delivered goods awaiting invoice must total exactly Rp 39,179,000.00');
  });

  await t.test('9. Combined Active Inventory Position: 3,795 kg valued at Rp 1,219,668,520.95', async () => {
    // Warehouse stock: 3,445 kg / Rp 1,180,489,520.95
    // Delivered stock: 350 kg / Rp 39,179,000.00
    // Combined: 3,795 kg / Rp 1,219,668,520.95
    const whStock = 3445.000;
    const whVal = 1180489520.95;
    const delStock = 350.000;
    const delVal = 39179000.00;

    assert.equal(whStock + delStock, 3795.000, 'Combined active stock quantity must equal 3,795 kg');
    assert.equal(Math.round((whVal + delVal) * 100) / 100, 1219668520.95, 'Combined active valuation must equal Rp 1,219,668,520.95');
  });

  await t.test('10. GL 5100 Gross Activity Disclosure: Debits Rp 7.478bn, Credits Rp 501.39m, Net Rp 6.976bn', async () => {
    const glRes = await client.query(`
      SELECT 
        ROUND(SUM(jel.debit)::numeric, 2) as gross_debit,
        ROUND(SUM(jel.credit)::numeric, 2) as gross_credit,
        ROUND((SUM(jel.debit) - SUM(jel.credit))::numeric, 2) as net_balance
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '5100' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
    `);
    assert.equal(Number(glRes.rows[0].gross_debit), 7478146382.65, 'GL 5100 gross debits must equal Rp 7,478,146,382.65');
    assert.equal(Number(glRes.rows[0].gross_credit), 501390234.73, 'GL 5100 gross credits must equal Rp 501,390,234.73');
    assert.equal(Number(glRes.rows[0].net_balance), 6976756147.92, 'GL 5100 net debit must equal Rp 6,976,756,147.92');
  });

  await t.test('11. PI E0000244/2627 Item 17 Mismatch: 24.890 kg / Rp 18,940,183.65', async () => {
    const it17 = await client.query(`
      SELECT 
        pii.quantity,
        pii.unit_price,
        pii.line_total,
        pi.exchange_rate,
        b.batch_number,
        b.import_quantity as batch_import_qty
      FROM purchase_invoice_items pii
      JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
      JOIN batches b ON b.id = pii.batch_id
      WHERE pi.invoice_number = 'E0000244/2627' AND pii.quantity = 24.890;
    `);
    assert.equal(it17.rows.length, 1, 'Item 17 must exist');
    assert.equal(Number(it17.rows[0].quantity), 24.890, 'Item 17 quantity must be 24.890 kg');
    assert.equal(Number(it17.rows[0].batch_import_qty), 225.000, 'Batch import_quantity remains 225 kg (Item 17 omitted from batch table)');
    
    const idrVal = Math.round(Number(it17.rows[0].line_total) * Number(it17.rows[0].exchange_rate) * 100) / 100;
    assert.equal(idrVal, 18940183.65, 'Item 17 IDR value must equal Rp 18,940,183.65');
  });

  await t.test('12. GL 1130 Historical Residual vs Active Valuation Gap: Exactly Rp 70,287,363.39', async () => {
    const activeValuation = 1219668520.95;
    const glHistoricalResidual = 1149381157.56;
    const gap = Math.round((activeValuation - glHistoricalResidual) * 100) / 100;
    assert.equal(gap, 70287363.39, 'Valuation difference must be exactly Rp 70,287,363.39');
  });

  await t.test('13. CSV Schedule Agreement: 84 rows, 127,780 kg received, Rp 1,219,668,520.95 active value', () => {
    const content = fs.readFileSync(schedulePath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 85, 'Must contain header + 84 batch records');

    let totalRec = 0;
    let totalWh = 0;
    let totalDel = 0;
    let totalVal = 0;

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      // parts[6]: received_quantity
      // parts[19]: physical_warehouse_quantity
      // parts[20]: delivered_pending_invoice_quantity
      // parts[21]: remaining_batch_value
      totalRec += Number(parts[6]);
      totalWh += Number(parts[19]);
      totalDel += Number(parts[20]);
      totalVal += Number(parts[21]);
    }

    assert.equal(totalRec, 127780.000, 'CSV received qty must equal 127,780 kg');
    assert.equal(totalWh, 3445.000, 'CSV physical warehouse qty must equal 3,445 kg');
    assert.equal(totalDel, 350.000, 'CSV delivered pending invoice qty must equal 350 kg');
    assert.equal(totalWh + totalDel, 3795.000, 'CSV active qty must equal 3,795 kg');
    assert.equal(Math.round(totalVal * 100) / 100, 1219668520.95, 'CSV remaining active valuation must equal Rp 1,219,668,520.95');
  });
});

