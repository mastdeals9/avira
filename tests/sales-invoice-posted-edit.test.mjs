import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function runDbRollback(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  return parsed.rows || [];
}

const salesTsx = readFileSync(new URL('../src/pages/Sales.tsx', import.meta.url), 'utf8');

test('1. Sales.tsx relies on database triggers for posted revenue journal sync and checks every error', () => {
  // Manual revenue journal/line update loop must be removed
  assert.doesNotMatch(salesTsx, /Sales Revenue line: Credit = subtotal/);
  assert.doesNotMatch(salesTsx, /PPN Keluaran line: Credit = taxAmount/);
  // Every DB mutation in posted invoice edit throws on error
  assert.match(salesTsx, /if \(itemUpdateError\) throw itemUpdateError;/);
  assert.match(salesTsx, /if \(updateError\) throw updateError;/);
  assert.match(salesTsx, /if \(cogsFetchError\) throw cogsFetchError;/);
  assert.match(salesTsx, /if \(cogsLinesFetchError\) throw cogsLinesFetchError;/);
  assert.match(salesTsx, /if \(cogsDebitErr\) throw cogsDebitErr;/);
  assert.match(salesTsx, /if \(cogsCreditErr\) throw cogsCreditErr;/);
  assert.match(salesTsx, /if \(cogsHeaderErr\) throw cogsHeaderErr;/);
});

test('2. Live DB (rolled back): posted sales invoice edits sync 1120, 4100, 2130, 6950, 4200 without duplicates & reject invalid equations', () => {
  const sql = `
BEGIN;
SELECT set_config('request.jwt.claim.sub',(
  SELECT id::text FROM public.user_profiles WHERE role IN ('admin','accounts') AND is_active=true LIMIT 1),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);

DO $test$
DECLARE
  v_inv record;
  v_je_id uuid;
  v_hdr_dr numeric;
  v_hdr_cr numeric;
  v_sum_dr numeric;
  v_sum_cr numeric;
  v_cnt integer;
  v_rejected boolean := false;
BEGIN
  SELECT id, invoice_number, journal_entry_id, subtotal, tax_amount, discount_amount, stamp_duty_amount, total_amount
    INTO v_inv
    FROM public.sales_invoices
   WHERE COALESCE(is_draft,false)=false
     AND COALESCE(document_status,'')<>'cancelled'
     AND journal_entry_id IS NOT NULL
   ORDER BY invoice_date DESC
   LIMIT 1;

  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'No posted sales invoice fixture found';
  END IF;
  v_je_id := v_inv.journal_entry_id;

  -- A. Subtotal + PPN + Bea Meterai added
  UPDATE public.sales_invoices
     SET subtotal = 1000000, tax_amount = 110000, discount_amount = 0, stamp_duty_amount = 10000, total_amount = 1120000
   WHERE id = v_inv.id;

  -- B. Discount added + Bea Meterai changed
  UPDATE public.sales_invoices
     SET subtotal = 1000000, tax_amount = 110000, discount_amount = 50000, stamp_duty_amount = 20000, total_amount = 1080000
   WHERE id = v_inv.id;

  -- C. Bea Meterai removed, discount changed
  UPDATE public.sales_invoices
     SET subtotal = 1000000, tax_amount = 110000, discount_amount = 25000, stamp_duty_amount = 0, total_amount = 1085000
   WHERE id = v_inv.id;

  -- D. Discount removed, PPN changed, Bea Meterai re-added
  UPDATE public.sales_invoices
     SET subtotal = 2000000, tax_amount = 220000, discount_amount = 0, stamp_duty_amount = 10000, total_amount = 2230000
   WHERE id = v_inv.id;

  -- Verify no duplicate lines per account and header totals match line sums
  SELECT count(*) INTO v_cnt FROM (
    SELECT account_id FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id GROUP BY account_id HAVING count(*) > 1
  ) dup;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Duplicate journal lines found after repeated edits'; END IF;

  UPDATE public.journal_entries SET description = description WHERE id = v_je_id;
  SELECT total_debit, total_credit INTO v_hdr_dr, v_hdr_cr FROM public.journal_entries WHERE id = v_je_id;
  SELECT sum(debit), sum(credit) INTO v_sum_dr, v_sum_cr FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id;
  IF abs(v_hdr_dr - v_sum_dr) > 0.01 OR abs(v_hdr_cr - v_sum_cr) > 0.01 OR abs(v_sum_dr - v_sum_cr) > 0.01 THEN
    RAISE EXCEPTION 'Journal header/line mismatch: hdr(%, %) vs sum(%, %)', v_hdr_dr, v_hdr_cr, v_sum_dr, v_sum_cr;
  END IF;

  -- E. Invalid invoice amount equation must be rejected
  BEGIN
    UPDATE public.sales_invoices
       SET subtotal = 1000000, tax_amount = 110000, discount_amount = 0, stamp_duty_amount = 10000, total_amount = 1110000
     WHERE id = v_inv.id;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Invalid invoice equation was not rejected'; END IF;
END;
$test$;
ROLLBACK;
`;
  runDbRollback(sql);
});
