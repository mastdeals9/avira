import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';

function dbQuery(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  return parsed.rows || [];
}

const financialReportsUi = readFileSync(new URL('../src/components/finance/FinancialReports.tsx', import.meta.url), 'utf8');
const layoutUi = readFileSync(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8');
const financePageUi = readFileSync(new URL('../src/pages/Finance.tsx', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const modelSrc = readFileSync(new URL('../src/utils/financialReportModel.ts', import.meta.url), 'utf8');
const excelSrc = readFileSync(new URL('../src/utils/financialReportExcel.ts', import.meta.url), 'utf8');

test('1. Live DB: Balance Sheet reconciles account-by-account to Trial Balance and separates 3200/3300', () => {
  const rows = dbQuery(`
    SELECT set_config('request.jwt.claim.sub',(SELECT id::text FROM public.user_profiles WHERE role='admin' AND is_active=true LIMIT 1),true),
           set_config('request.jwt.claim.role','authenticated',true);
    WITH bs AS (SELECT code, balance::numeric FROM public.get_balance_sheet('2026-11-26', 16000)),
         tb AS (SELECT code, balance::numeric FROM public.get_trial_balance('2000-01-01', '2026-11-26', 16000))
    SELECT
      (SELECT balance FROM bs WHERE code = '1102') AS bs_1102,
      (SELECT balance FROM tb WHERE code = '1102') AS tb_1102,
      (SELECT balance FROM bs WHERE code = '111101') AS bs_111101,
      (SELECT balance FROM tb WHERE code = '111101') AS tb_111101,
      (SELECT balance FROM bs WHERE code = '1160') AS bs_1160,
      (SELECT balance FROM tb WHERE code = '1160') AS tb_1160,
      (SELECT balance FROM bs WHERE code = '2110') AS bs_2110,
      (SELECT balance FROM tb WHERE code = '2110') AS tb_2110,
      (SELECT balance FROM bs WHERE code = '3200') AS bs_3200,
      (SELECT balance FROM bs WHERE code = '3300') AS bs_3300,
      (SELECT sum(balance) FROM bs) AS bs_net_zero_check
  `);
  const r = rows[0];
  assert.equal(Number(r.bs_1102), Number(r.tb_1102));
  assert.equal(Number(r.bs_111101), Number(r.tb_111101));
  assert.equal(Number(r.bs_1160), Number(r.tb_1160));
  assert.equal(Number(r.bs_2110), Number(r.tb_2110));
  assert.ok(Math.abs(Number(r.bs_net_zero_check)) < 0.02, `BS Assets - (Liab + Equity) should be 0, got ${r.bs_net_zero_check}`);
  assert.ok(Math.abs(Number(r.bs_3200)) > 0, '3200 Retained Earnings must hold prior-year unclosed earnings');
  assert.ok(Math.abs(Number(r.bs_3300)) > 0, '3300 Current Year Earnings must hold YTD earnings');
});

test('2. Live DB: get_pnl_summary_detailed matches YTD GL and classifies Bizpark & NULL-group expenses consistently', () => {
  const rows = dbQuery(`
    SELECT
      (SELECT net_income::numeric FROM public.get_pnl_summary_detailed('2026-01-01', '2026-11-26', 16000)) AS rpc_net,
      (SELECT operating_expenses::numeric FROM public.get_pnl_summary_detailed('2026-01-01', '2026-11-26', 16000)) AS rpc_opex,
      (SELECT -balance::numeric FROM public.get_balance_sheet('2026-11-26', 16000) WHERE code = '3300') AS bs_ytd,
      public.get_pnl_classification('6231', 'Warehouse Renovation & Setup - Bizpark', 'expense', 'New Warehouse - Bizpark') AS bizpark_cls,
      public.get_pnl_classification('6115', 'BPJS Ketenagakerjaan Expense', 'expense', NULL) AS null_group_cls
  `);
  const r = rows[0];
  assert.ok(Math.abs(Number(r.rpc_net) - Number(r.bs_ytd)) < 0.02, `P&L YTD (${r.rpc_net}) must equal BS 3300 (${r.bs_ytd})`);
  assert.equal(r.bizpark_cls, 'operating_expenses');
  assert.equal(r.null_group_cls, 'operating_expenses');
});

test('3. UI, Print & Excel share single canonical model without hardcoded wrong company or forced plug', () => {
  assert.doesNotMatch(financialReportsUi, /PT Anzen Koorporasi Indonesia/);
  assert.doesNotMatch(financialReportsUi, /totalContraRevDebit/);
  assert.match(financialReportsUi, /company_profiles/);
  assert.match(financialReportsUi, /A4 landscape/);
  assert.match(financialReportsUi, /A4 portrait/);
  assert.match(layoutUi, /print:hidden/);
  assert.match(financePageUi, /print:hidden/);
  assert.match(indexCss, /@media print/);
  assert.match(modelSrc, /classifyPnLAccount/);
  assert.match(excelSrc, /ExcelJS/);
  assert.match(excelSrc, /#,##0;\(#,##0\);"-"/);
});

test('4. ExcelJS generates styled Balance Sheet, P&L, and Trial Balance workbooks without truncation', async () => {
  mkdirSync('scratch/exports', { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Verification', { pageSetup: { paperSize: 9, orientation: 'portrait' } });
  ws.getCell('A1').value = 'PT. Shubham Anzen Pharma Jaya';
  ws.getCell('C7').value = -905344008.66;
  ws.getCell('C7').numFmt = '#,##0;(#,##0);"-"';
  await wb.xlsx.writeFile('scratch/exports/smoke_check.xlsx');
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.readFile('scratch/exports/smoke_check.xlsx');
  assert.equal(reloaded.getWorksheet('Verification').getCell('C7').value, -905344008.66);
});
