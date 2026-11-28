import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { Client } from 'pg';

const READONLY_DB_URL = process.env.READONLY_AUDIT_DB_URL || '';
const root = process.cwd();

async function loadFxCalcModule() {
  const tsSource = readFileSync(resolve(root, 'src/utils/fxReportCalculations.ts'), 'utf8');
  const { outputText } = ts.transpileModule(tsSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

test('1. Code & Security Contracts: no hardcoded DB credentials, no JE2609-0054 fallback, no hardcoded 17800, Customer FX uses journal rate, Commercial FX deduplicates & tracks unsold share', () => {
  const selfSource = readFileSync(resolve(root, 'tests/fx-final-reporting-reconciliation.test.mjs'), 'utf8');
  assert.doesNotMatch(selfSource, /postgresql:\/\/postgres\./, 'Must never hardcode production DB connection string');
  assert.doesNotMatch(selfSource, /process\.env\.DATABASE_URL/, 'Must use READONLY_AUDIT_DB_URL exclusively');

  const fxReport = readFileSync(resolve(root, 'src/components/finance/FXReport.tsx'), 'utf8');
  const fxBiz = readFileSync(resolve(root, 'src/components/finance/FXBusinessDashboard.tsx'), 'utf8');
  const fxCalc = readFileSync(resolve(root, 'src/utils/fxReportCalculations.ts'), 'utf8');

  // FXReport checks
  assert.doesNotMatch(fxReport, /41184641\.50/, 'Hardcoded JE2609-0054 amount must be removed');
  assert.doesNotMatch(fxReport, /useState<number>\(17800\)/, 'Hardcoded 17800 market rate must be removed');
  assert.doesNotMatch(fxReport, /useState\(['"]2026-11-30['"]\)/, 'Hardcoded 2026-11-30 revaluation date default must be removed');
  assert.doesNotMatch(fxReport, /useState\(['"]18200['"]\)/, 'Hardcoded 18200 revaluation rate default must be removed');
  assert.doesNotMatch(fxReport, /soObj\?\.commercial_usd_to_idr_rate/, 'Must never substitute commercial SO rate for Customer FX accounting recognition rate');
  assert.match(fxReport, /summarizePostedGlFx/);
  assert.match(fxReport, /computeSupplierSettlementBridge/);
  assert.match(fxReport, /evidence_status/);
  assert.match(fxReport, /Unresolved USD Settlement Exceptions/);
  assert.match(fxReport, /\.eq\('is_posted', true\)/);
  assert.match(fxReport, /\.eq\('is_reversed', false\)/);
  assert.match(fxReport, /\.eq\('is_cancelled', false\)/);
  assert.match(fxReport, /\.order\('id', \{ ascending: true \}\)/);

  // USD-bank settlement check in pure helper
  assert.match(fxCalc, /actualFunctionalSettlementIdr/);
  assert.match(fxCalc, /evidence_status:\s*'unresolved'/);

  // Commercial FX deduplication + unsold/unmatched exposure + deterministic pagination
  assert.match(fxBiz, /seenVaIds/);
  assert.match(fxBiz, /seenPiIds/);
  assert.match(fxBiz, /allocation_share_ratio/);
  assert.match(fxBiz, /unmatchedPiExposures/);
  assert.match(fxBiz, /\.order\('id', \{ ascending: true \}\)/);
});

test('1b. Pagination Regression (> 1,000 records): fetchAllPages returns all 2,500 records across 3 pages with zero duplicates', async () => {
  const { fetchAllPages } = await loadFxCalcModule();
  const totalRows = 2500;
  const dataset = Array.from({ length: totalRows }, (_, i) => ({
    id: `row-${String(i + 1).padStart(4, '0')}`,
    amount: i + 1,
  }));

  let queryCount = 0;
  const rows = await fetchAllPages(async (from, to) => {
    queryCount += 1;
    return { data: dataset.slice(from, to + 1), error: null };
  }, 1000);

  assert.equal(queryCount, 3);
  assert.equal(rows.length, totalRows);
  assert.equal(new Set(rows.map((r) => r.id)).size, totalRows);
  assert.equal(rows[0].id, 'row-0001');
  assert.equal(rows[totalRows - 1].id, 'row-2500');
});

test('1c. Two Successive Month-End Revaluations + Partial Supplier Payments between Revaluation Dates', async () => {
  const { computeSupplierSettlementBridge } = await loadFxCalcModule();
  const priorRevalLines = [
    { revaluation_date: '2026-10-31', status: 'posted', carrying_rate: 16000, revalued_rate: 16500 },
    { revaluation_date: '2026-11-30', status: 'posted', carrying_rate: 16500, revalued_rate: 16800 },
  ];

  // Partial payment 1 on 2026-11-10 (only Oct reval applies)
  const p1 = computeSupplierSettlementBridge({
    usdSettled: 400,
    originalPiRate: 16000,
    settlementRate: 16400,
    settlementDate: '2026-11-10',
    isUsdBankSettlement: false,
    priorRevalLines,
  });
  assert.equal(p1.evidence_status, 'resolved');
  assert.equal(p1.prior_revaluation_fx, 200000);
  assert.equal(p1.carrying_before_settlement_idr, 6600000);
  assert.equal(p1.actual_settlement_idr, 6560000);
  assert.equal(p1.realized_fx_on_settlement, -40000); // Gain
  assert.equal(p1.cumulative_historical_rate_variance, 160000);

  // Partial payment 2 on 2026-12-05 (both Oct and Nov revals apply)
  const p2 = computeSupplierSettlementBridge({
    usdSettled: 600,
    originalPiRate: 16000,
    settlementRate: 16700,
    settlementDate: '2026-12-05',
    isUsdBankSettlement: false,
    priorRevalLines,
  });
  assert.equal(p2.evidence_status, 'resolved');
  assert.equal(p2.prior_revaluation_fx, 480000);
  assert.equal(p2.carrying_before_settlement_idr, 10080000);
  assert.equal(p2.actual_settlement_idr, 10020000);
  assert.equal(p2.realized_fx_on_settlement, -60000); // Gain
  assert.equal(p2.cumulative_historical_rate_variance, 420000);
});

test('1d. USD Bank Settlement Evidence & Missing/Reversed Journal Fail-Closed + Posted GL Classification', async () => {
  const { computeSupplierSettlementBridge, summarizePostedGlFx } = await loadFxCalcModule();

  // Resolved USD bank settlement with posted bank credit minus charge
  const resolvedUsdBank = computeSupplierSettlementBridge({
    usdSettled: 40000,
    originalPiRate: 16600,
    settlementRate: 1,
    settlementDate: '2026-11-15',
    isUsdBankSettlement: true,
    priorRevalLines: [],
    actualFunctionalSettlementIdr: 663720000,
  });
  assert.equal(resolvedUsdBank.evidence_status, 'resolved');
  assert.equal(resolvedUsdBank.actual_settlement_idr, 663720000);
  assert.equal(resolvedUsdBank.realized_fx_on_settlement, -280000); // Gain of Rp 280,000

  // Missing or reversed USD bank journal must NOT default to zero FX
  const unresolvedUsdBank = computeSupplierSettlementBridge({
    usdSettled: 40000,
    originalPiRate: 16600,
    settlementRate: 1,
    settlementDate: '2026-11-15',
    isUsdBankSettlement: true,
    priorRevalLines: [],
    actualFunctionalSettlementIdr: null,
  });
  assert.equal(unresolvedUsdBank.evidence_status, 'unresolved');
  assert.equal(unresolvedUsdBank.actual_settlement_idr, null);
  assert.equal(unresolvedUsdBank.realized_fx_on_settlement, null);
  assert.equal(unresolvedUsdBank.cumulative_historical_rate_variance, null);

  // Posted GL FX classification by fx_revaluations.journal_entry_id
  const glSummary = summarizePostedGlFx(
    [
      { journal_entry_id: 'je-1', account_code: '4930', debit: 0, credit: 280000 },
      { journal_entry_id: 'je-2', account_code: '7300', debit: 150000, credit: 0 },
      { journal_entry_id: 'je-rev', account_code: '4930', debit: 0, credit: 500000 },
      { journal_entry_id: 'je-rev', account_code: '7300', debit: 120000, credit: 0 },
    ],
    new Set(['je-rev'])
  );
  assert.equal(glSummary.realizedGain, 280000);
  assert.equal(glSummary.realizedLoss, 150000);
  assert.equal(glSummary.netRealized, 130000);
  assert.equal(glSummary.unrealizedGain, 500000);
  assert.equal(glSummary.unrealizedLoss, 120000);
  assert.equal(glSummary.netUnrealized, 380000);
  assert.equal(glSummary.totalNetAccountingFx, 510000);
});

test('2. Live Read-Only DB Reconciliation (runs only when READONLY_AUDIT_DB_URL is provided)', async (t) => {
  if (!READONLY_DB_URL) {
    t.skip('Skipping live DB audit: READONLY_AUDIT_DB_URL not set');
    return;
  }

  const client = new Client({ connectionString: READONLY_DB_URL });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');

  try {
    await t.test('A. Posted GL Accounts 7300 & 4930 reconcile to exact A..G figures', async () => {
      const res = await client.query(`
        SELECT
          je.id AS journal_entry_id,
          je.entry_number,
          je.entry_date::text,
          je.reference_number,
          coa.code AS account_code,
          jel.debit::numeric,
          jel.credit::numeric,
          (rev.id IS NOT NULL AND rev.status = 'posted') AS is_revaluation
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        LEFT JOIN fx_revaluations rev ON rev.journal_entry_id = je.id
        WHERE coa.code IN ('7300', '4930')
          AND je.is_posted = true
          AND COALESCE(je.is_reversed, false) = false
          AND COALESCE(je.is_cancelled, false) = false
        ORDER BY je.entry_date, je.entry_number
      `);

      const entryNumbers = new Set(res.rows.map((r) => r.entry_number));
      for (const expectedJe of ['JE2609-0054', 'JE2611-0312', 'JE2611-0313', 'JE2611-0314', 'JE2611-0456']) {
        assert.ok(entryNumbers.has(expectedJe), `Expected posted GL entry ${expectedJe}`);
      }

      let realGain = 0, realLoss = 0, unrealGain = 0, unrealLoss = 0;
      for (const r of res.rows) {
        const dr = Number(r.debit || 0);
        const cr = Number(r.credit || 0);
        if (r.is_revaluation) {
          if (r.account_code === '4930') unrealGain += cr - dr;
          if (r.account_code === '7300') unrealLoss += dr - cr;
        } else {
          if (r.account_code === '4930') realGain += cr - dr;
          if (r.account_code === '7300') realLoss += dr - cr;
        }
      }

      const netRealized = Math.round((realGain - realLoss) * 100) / 100;
      const netUnrealized = Math.round((unrealGain - unrealLoss) * 100) / 100;
      const totalNet = Math.round((netRealized + netUnrealized) * 100) / 100;

      assert.equal(Math.round(Math.abs(netRealized)), 137341497);
      assert.equal(Math.round(Math.abs(netUnrealized)), 106796488);
      assert.equal(Math.round(Math.abs(totalNet)), 244137985);
    });

    await t.test('B. PV/25-26/003 USD-bank settlement reconciles to JE2611-0313 (Rp 280,000 FX gain)', async () => {
      const pvRes = await client.query(`
        SELECT pv.voucher_number, pv.voucher_date::date::text AS pv_date, pv.payment_currency,
               pv.exchange_rate::numeric AS pv_rate, va.allocated_amount::numeric AS usd_settled,
               pi.exchange_rate::numeric AS pi_rate, ba.currency AS bank_currency
        FROM payment_vouchers pv
        JOIN bank_accounts ba ON ba.id = pv.bank_account_id
        JOIN voucher_allocations va ON va.payment_voucher_id = pv.id
        JOIN purchase_invoices pi ON pi.id = va.purchase_invoice_id
        WHERE pv.voucher_number = 'PV/25-26/003' AND pv.is_posted = true
      `);
      assert.equal(pvRes.rows.length, 1);
      assert.equal(pvRes.rows[0].bank_currency, 'USD');
      assert.equal(Number(pvRes.rows[0].pv_rate), 1);

      const jeRes = await client.query(`
        SELECT je.entry_number, coa.code, jel.debit::numeric, jel.credit::numeric
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        WHERE je.entry_number = 'JE2611-0313' AND coa.code = '4930' AND je.is_posted = true
      `);
      assert.equal(jeRes.rows.length, 1);
      assert.equal(Number(jeRes.rows[0].credit), 280000);
    });

    await t.test('C. PV/26-26/034 (2026-11-04) Settlement Bridge recognizes Oct 2026 revaluation and matches JE2611-0456 within Rp 0.40 rounding', async () => {
      const pvRes = await client.query(`
        SELECT
          pv.voucher_number, (pv.voucher_date AT TIME ZONE 'Asia/Jakarta')::date::text AS pv_date,
          pv.exchange_rate::numeric AS pv_rate, pv.converted_amount::numeric AS pv_converted,
          va.allocated_amount::numeric AS usd_settled,
          pi.id AS pi_id, pi.invoice_number, pi.exchange_rate::numeric AS pi_rate
        FROM payment_vouchers pv
        JOIN voucher_allocations va ON va.payment_voucher_id = pv.id
        JOIN purchase_invoices pi ON pi.id = va.purchase_invoice_id
        WHERE pv.voucher_number = 'PV/26-26/034' AND pv.is_posted = true
        ORDER BY pi.invoice_number
      `);
      assert.equal(pvRes.rows.length, 2);
      assert.equal(pvRes.rows[0].pv_date, '2026-11-04');

      const piIds = pvRes.rows.map((r) => r.pi_id);
      const revRes = await client.query(
        `
        SELECT rl.purchase_invoice_id, rev.revaluation_date::date::text AS rev_date,
               rl.carrying_rate::numeric, rl.revalued_rate::numeric
        FROM fx_revaluation_lines rl
        JOIN fx_revaluations rev ON rev.id = rl.revaluation_id
        WHERE rl.purchase_invoice_id = ANY($1) AND rev.status = 'posted'
        `,
        [piIds]
      );
      assert.equal(revRes.rows.length, 2);

      let pv34RealizedGain = 0;
      for (const row of pvRes.rows) {
        const usd = Number(row.usd_settled);
        const origRate = Number(row.pi_rate);
        const settleRate = Number(row.pv_rate);
        const reval = revRes.rows.find((r) => r.purchase_invoice_id === row.pi_id && r.rev_date < row.pv_date);
        assert.ok(reval);
        const priorRevalFx = usd * (Number(reval.revalued_rate) - Number(reval.carrying_rate));
        const preSettleCarrying = usd * origRate + priorRevalFx;
        const actualSettle = usd * settleRate;
        pv34RealizedGain += preSettleCarrying - actualSettle;
      }

      // Unrounded: 111,704.80 vs JE2611-0456: 111,705.20 (exact Rp 0.40 rounding from rounded converted_amount 1,012,939,126)
      const roundingDiff = Math.abs(111705.2 - pv34RealizedGain);
      assert.ok(Math.abs(roundingDiff - 0.4) < 0.01, `Expected Rp 0.40 rounding diff, got ${roundingDiff}`);

      // Verify all 4 journal lines of JE2611-0456 (AP 2110 debit, Bank Charge 7100 debit, Bank 111101 credit, FX Gain 4930 credit)
      const je456Res = await client.query(`
        SELECT coa.code, jel.debit::numeric, jel.credit::numeric
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        WHERE je.entry_number = 'JE2611-0456' AND je.is_posted = true
      `);
      const byCode = new Map(je456Res.rows.map((r) => [r.code, { dr: Number(r.debit), cr: Number(r.credit) }]));
      assert.equal(byCode.get('2110')?.dr, 1013050831.2);
      assert.equal(byCode.get('7100')?.dr, 50000);
      assert.equal(byCode.get('111101')?.cr, 1012989126);
      assert.equal(byCode.get('4930')?.cr, 111705.2);
    });
  } finally {
    await client.end();
  }
});
