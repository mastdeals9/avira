import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const sql=fs.readFileSync('supabase/migrations/20260905210000_authoritative_sales_profitability_cogs.sql','utf8');
test('reports source company/month COGS from posted GL 5100 journals',()=>{assert.match(sql,/source_module='sales_invoice_cogs'/);assert.match(sql,/coa\.code='5100'/);assert.match(sql,/je\.is_posted AND NOT coalesce\(je\.is_reversed,false\)/);});
test('future line snapshots are authoritative and historical multi-line costs stay NULL',()=>{assert.match(sql,/sii\.cogs_total_cost/);assert.match(sql,/WHEN c\.lines=1 AND c\.je_cost>0 THEN c\.je_cost ELSE NULL/);assert.doesNotMatch(sql,/effective_sales_cogs_unit_cost\(/);assert.doesNotMatch(sql,/landed_cost_per_unit/);});
test('single-line fallback and batch revaluation cannot fabricate historical COGS',()=>{assert.match(sql,/SELECT count\(\*\) FROM sales_invoice_items z WHERE z\.invoice_id=si\.id/);assert.match(sql,/line_cost/);assert.doesNotMatch(sql,/UPDATE public\.(journal_entries|sales_invoice_items|batches)/);});
test('UI labels posted COGS and exposes unavailable/partial coverage',()=>{const ui=fs.readFileSync('src/pages/reports/CanonicalSalesProfitReport.tsx','utf8');assert.match(ui,/GL 5100/);assert.match(ui,/Cost Unresolved/);});
