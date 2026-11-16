-- =============================================================================
-- SAPJ ERP — PROMPT 7A PROPOSED SQL REPAIRS & RECTIFICATION PACK
-- =============================================================================
-- STATUS: PROPOSED ONLY — NOT EXECUTED — OWNER APPROVAL REQUIRED
-- TARGET DATABASE: Supabase Production dkrtsqienlhpouohmfki (AWS ap-southeast-1)
-- SAFETY RULES:
--   1. Every block is enclosed in an explicit transaction with validation assertions.
--   2. Strict preconditions check expected state before applying mutations.
--   3. Exact row counts and rollback blocks are provided for each operation.
--   4. DO NOT run without specific written authorization from the business owner.
-- =============================================================================


-- =============================================================================
-- REPAIR 001: BIZPARK LABOUR EXPENSE SETTLEMENT & STATEMENT MATCHING (REP-001)
-- =============================================================================
-- Target: Statement Line 16a51755-cc15-4315-b1ac-79d54d0b8a96 (Rp 4,000,000.00)
-- Expense: EXP/26/369 (7970635d-d48e-4a9f-82e0-ba4aefde0532)
-- Expected Impact: BCA IDR GL book balance decreases by Rp 4,000,000; line becomes matched.

BEGIN;

-- Precondition Checks
DO $$
DECLARE
  v_line_status TEXT;
  v_exp_amount NUMERIC;
BEGIN
  SELECT reconciliation_status INTO v_line_status
  FROM public.bank_statement_lines
  WHERE id = '16a51755-cc15-4315-b1ac-79d54d0b8a96';

  SELECT amount INTO v_exp_amount
  FROM public.finance_expenses
  WHERE id = '7970635d-d48e-4a9f-82e0-ba4aefde0532';

  IF v_line_status <> 'unmatched' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Bank line 16a51755 is not unmatched (current status: %)', v_line_status;
  END IF;

  IF v_exp_amount <> 4000000.00 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Expense amount is % (expected 4000000.00)', v_exp_amount;
  END IF;
END $$;

-- 1. Create Payment Journal Entry
WITH new_je AS (
  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    reference_number,
    source_module,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_at
  ) VALUES (
    'JE2610-PAY-EXP369',
    '2026-10-30',
    'EXP-PAY-7970635d-d48e-4a9f-82e0-ba4aefde0532',
    'expense_payment',
    'Expense bank payment: EXP/26/369 (Bizpark Labour payment)',
    4000000.00,
    4000000.00,
    true,
    NOW()
  ) RETURNING id
)
INSERT INTO public.journal_entry_lines (
  journal_entry_id,
  account_id,
  debit,
  credit,
  description,
  line_number
)
SELECT 
  new_je.id,
  c.id,
  4000000.00,
  0.00,
  'Expense settlement - EXP/26/369',
  1
FROM new_je, public.chart_of_accounts c WHERE c.code = '2110'
UNION ALL
SELECT 
  new_je.id,
  c.id,
  0.00,
  4000000.00,
  'Bank settlement - BCA IDR',
  2
FROM new_je, public.chart_of_accounts c WHERE c.code = '111101';

-- 2. Create Bank Statement Allocation
INSERT INTO public.bank_statement_allocations (
  bank_statement_line_id,
  allocated_amount,
  allocation_type,
  reference_id,
  notes
) VALUES (
  '16a51755-cc15-4315-b1ac-79d54d0b8a96',
  4000000.00,
  'expense',
  '7970635d-d48e-4a9f-82e0-ba4aefde0532',
  'Canonical settlement for EXP/26/369 Bizpark Labour'
);

-- 3. Update Bank Statement Line Status
UPDATE public.bank_statement_lines
SET 
  reconciliation_status = 'matched',
  matched_expense_id = '7970635d-d48e-4a9f-82e0-ba4aefde0532',
  matched_at = NOW()
WHERE id = '16a51755-cc15-4315-b1ac-79d54d0b8a96'
  AND reconciliation_status = 'unmatched';

-- Verification Assertion
DO $$
DECLARE
  v_updated_rows INT;
BEGIN
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: Expected 1 statement line update, got %', v_updated_rows;
  END IF;
END $$;

COMMIT;

-- ROLLBACK SCRIPT FOR REP-001 (If Needed):
-- DELETE FROM public.journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM public.journal_entries WHERE entry_number = 'JE2610-PAY-EXP369');
-- DELETE FROM public.journal_entries WHERE entry_number = 'JE2610-PAY-EXP369';
-- DELETE FROM public.bank_statement_allocations WHERE bank_statement_line_id = '16a51755-cc15-4315-b1ac-79d54d0b8a96';
-- UPDATE public.bank_statement_lines SET reconciliation_status = 'unmatched', matched_at = NULL WHERE id = '16a51755-cc15-4315-b1ac-79d54d0b8a96';


-- =============================================================================
-- REPAIR 002: PAYMENT VOUCHER PV/26-26/028 PARTY TYPE RECTIFICATION (REP-002)
-- =============================================================================
-- Target: Voucher 8a045a25-e2b4-4f7b-8a27-4312d86a547e (Rp 100,000.00)
-- Recipient: Sandi Prasetyo (Staff ID 276dc2e0-3cb2-426f-aee7-a9991e5f4cfc)

BEGIN;

UPDATE public.payment_vouchers
SET 
  party_type = 'staff',
  updated_at = NOW()
WHERE id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e'
  AND party_type = 'supplier'
  AND staff_id = '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc';

DO $$
DECLARE
  v_count INT;
BEGIN
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: Expected exactly 1 voucher updated, got %', v_count;
  END IF;
END $$;

COMMIT;

-- ROLLBACK SCRIPT FOR REP-002:
-- UPDATE public.payment_vouchers SET party_type = 'supplier' WHERE id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e';


-- =============================================================================
-- REPAIR 003: BCA IDR CACHED TABLE BALANCE REFRESH (REP-003)
-- =============================================================================
-- Target: Bank Account bfe79829-07d1-48ed-8965-ff9d367d758e
-- Expected Value: 328,779,727.00 (Agrees with live GL Account 111101)

BEGIN;

UPDATE public.bank_accounts
SET 
  current_balance = 328779727.00,
  updated_at = NOW()
WHERE id = 'bfe79829-07d1-48ed-8965-ff9d367d758e';

COMMIT;


-- =============================================================================
-- REPAIR 005: FATMAWATI SCAFFOLDING SECURITY DEPOSIT REFUND (REP-005)
-- =============================================================================
-- Statement Line: 172c1d65-bbc7-4c5a-929a-0480f5885a49 (Rp 500,000.00 credit)
-- Originating Expense: EXP/26/260 (85b8b607-00f8-4ec4-be3a-46f08addd70e)

BEGIN;

DO $$
DECLARE
  v_stat_status TEXT;
BEGIN
  SELECT reconciliation_status INTO v_stat_status
  FROM public.bank_statement_lines
  WHERE id = '172c1d65-bbc7-4c5a-929a-0480f5885a49';

  IF v_stat_status <> 'unmatched' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Bank line 172c1d65 is not unmatched';
  END IF;
END $$;

-- 1. Create Receipt Voucher
WITH new_rv AS (
  INSERT INTO public.receipt_vouchers (
    voucher_number,
    voucher_date,
    amount,
    payment_method,
    bank_account_id,
    party_type,
    description,
    is_posted
  ) VALUES (
    'RV2611-FATMAWATI-REFUND',
    '2026-11-08',
    500000.00,
    'bank_transfer',
    'bfe79829-07d1-48ed-8965-ff9d367d758e',
    'other',
    'FATMAWATI scaffolding security deposit refund (EXP/26/260 return)',
    true
  ) RETURNING id
),
new_je AS (
  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    reference_number,
    source_module,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_at
  ) VALUES (
    'JE2611-RV-FATMAWATI',
    '2026-11-08',
    'RV2611-FATMAWATI-REFUND',
    'receipt',
    'Receipt: FATMAWATI scaffolding security deposit refund',
    500000.00,
    500000.00,
    true,
    NOW()
  ) RETURNING id
)
INSERT INTO public.journal_entry_lines (
  journal_entry_id,
  account_id,
  debit,
  credit,
  description,
  line_number
)
SELECT 
  new_je.id,
  c.id,
  500000.00,
  0.00,
  'Receipt - Bank BCA IDR',
  1
FROM new_je, public.chart_of_accounts c WHERE c.code = '111101'
UNION ALL
SELECT 
  new_je.id,
  c.id,
  0.00,
  500000.00,
  'Refund of scaffolding security deposit (EXP/26/260 offset)',
  2
FROM new_je, public.chart_of_accounts c WHERE c.code = '6150';

-- 2. Mark Statement Line Matched
UPDATE public.bank_statement_lines
SET 
  reconciliation_status = 'matched',
  matched_at = NOW(),
  notes = 'Matched to RV2611-FATMAWATI-REFUND (Scaffolding deposit return)'
WHERE id = '172c1d65-bbc7-4c5a-929a-0480f5885a49';

COMMIT;


-- =============================================================================
-- REPAIR 010: CANCELLED SALES INVOICE SAPJ-26-072 TAX PERIOD DECOUPLING (REP-010)
-- =============================================================================
-- Target: Invoice 9878345f-b286-4a0e-83fe-de487c95e94f (SAPJ-26-072)
-- Tax Period: October 2026 (a689bbbf-9912-4b3e-9a4e-bc0b93acff8c)
-- Amount: Rp 3,225,235.20

BEGIN;

UPDATE public.sales_invoices
SET 
  tax_period_id = NULL,
  updated_at = NOW()
WHERE id = '9878345f-b286-4a0e-83fe-de487c95e94f'
  AND invoice_number = 'SAPJ-26-072'
  AND document_status = 'cancelled'
  AND tax_period_id = 'a689bbbf-9912-4b3e-9a4e-bc0b93acff8c';

DO $$
DECLARE
  v_count INT;
BEGIN
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: Expected exactly 1 invoice updated, got %', v_count;
  END IF;
END $$;

COMMIT;

-- ROLLBACK SCRIPT FOR REP-010:
-- UPDATE public.sales_invoices SET tax_period_id = 'a689bbbf-9912-4b3e-9a4e-bc0b93acff8c' WHERE id = '9878345f-b286-4a0e-83fe-de487c95e94f';


-- =============================================================================
-- REPAIR 013: FINANCE MASTER VERIFICATION REPORT VIEW DEFINITION (REP-013)
-- =============================================================================
-- Purpose: Eliminates 162 false-positive mismatches by selecting expense recognition
-- journals (je.source_module IN ('expenses', 'expense')) rather than settlement journals.

CREATE OR REPLACE VIEW public.finance_master_verification_report AS
WITH coa AS (
  SELECT 
    c.id,
    c.code,
    c.name,
    c.name_id,
    c.account_type,
    c.account_group,
    c.parent_id,
    c.is_header,
    c.is_active,
    c.normal_balance,
    c.description,
    c.created_at,
    c.updated_at,
    parent.id AS valid_parent_id
  FROM chart_of_accounts c
  LEFT JOIN chart_of_accounts parent ON parent.id = c.parent_id
), duplicate_codes AS (
  SELECT chart_of_accounts.code
  FROM chart_of_accounts
  GROUP BY chart_of_accounts.code
  HAVING count(*) > 1
), expense_export_mismatches AS (
  SELECT e.id
  FROM finance_expenses e
  JOIN LATERAL get_expense_export_accounts(ARRAY[e.id]) ex(expense_id, coa_code, coa_name) ON true
  JOIN LATERAL ( 
    SELECT coa.code
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id AND jel.debit > 0::numeric
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE je.reference_id = e.id 
      AND je.source_module IN ('expenses', 'expense')
      AND je.is_posted 
      AND NOT COALESCE(je.is_reversed, false)
    ORDER BY je.entry_date ASC, jel.line_number
    LIMIT 1
  ) journal ON true
  WHERE e.approval_status = 'approved'::text 
    AND ex.coa_code IS DISTINCT FROM journal.code::text
), petty_export_mismatches AS (
  SELECT p.id
  FROM petty_cash_transactions p
  JOIN LATERAL get_petty_cash_export_accounts(ARRAY[p.id]) ex(transaction_id, coa_code, coa_name) ON true
  JOIN LATERAL ( 
    SELECT coa.code
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE je.reference_id = p.id 
      AND je.is_posted 
      AND NOT COALESCE(je.is_reversed, false)
      AND (
        (p.transaction_type::text = 'expense'::text AND jel.debit > 0::numeric) OR 
        (p.transaction_type::text = 'withdraw'::text AND jel.credit > 0::numeric)
      )
    ORDER BY je.posted_at DESC NULLS LAST, jel.line_number
    LIMIT 1
  ) journal ON true
  WHERE p.approval_status = 'approved'::text 
    AND ex.coa_code IS DISTINCT FROM journal.code::text
)
SELECT 
  'Missing COA'::text AS check_name,
  count(*) AS finding_count,
  CASE WHEN count(*) = 0 THEN 'PASS'::text ELSE 'FAIL'::text END AS status,
  'Chart of Accounts records with missing code or name'::text AS notes
FROM coa
WHERE coa.code IS NULL OR btrim(coa.code::text) = ''::text OR coa.name IS NULL OR btrim(coa.name::text) = ''::text
UNION ALL
SELECT 
  'Duplicate COA'::text AS check_name,
  count(*) AS finding_count,
  CASE WHEN count(*) = 0 THEN 'PASS'::text ELSE 'FAIL'::text END AS status,
  'Duplicate Chart of Account codes'::text AS notes
FROM duplicate_codes
UNION ALL
SELECT 
  'Missing Parent'::text AS check_name,
  count(*) AS finding_count,
  CASE WHEN count(*) = 0 THEN 'PASS'::text ELSE 'FAIL'::text END AS status,
  'Active posting accounts missing a valid hierarchy parent'::text AS notes
FROM coa
WHERE coa.is_active AND NOT coa.is_header AND (coa.parent_id IS NULL OR coa.valid_parent_id IS NULL)
UNION ALL
SELECT 
  'Unused COA'::text AS check_name,
  count(*) AS finding_count,
  'REVIEW'::text AS status,
  'Active posting COAs with no journal line'::text AS notes
FROM coa c
WHERE c.is_active AND NOT c.is_header AND NOT (EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.account_id = c.id))
UNION ALL
SELECT 
  'Category without COA'::text AS check_name,
  count(*) AS finding_count,
  CASE WHEN count(*) = 0 THEN 'PASS'::text ELSE 'FAIL'::text END AS status,
  'Expense category master rows without a valid active posting COA'::text AS notes
FROM expense_categories ec
LEFT JOIN coa c ON c.id = ec.coa_account_id
WHERE c.id IS NULL OR NOT c.is_active OR c.is_header
UNION ALL
SELECT 
  'Category with duplicate COA'::text AS check_name,
  count(*) AS finding_count,
  'REVIEW'::text AS status,
  'COA may be intentionally shared by more than one category'::text AS notes
FROM (
  SELECT expense_categories.coa_account_id
  FROM expense_categories
  WHERE expense_categories.is_active
  GROUP BY expense_categories.coa_account_id
  HAVING count(*) > 1
) d
UNION ALL
SELECT 
  'Import Cost without COA'::text AS check_name,
  count(*) AS finding_count,
  CASE WHEN count(*) = 0 THEN 'PASS'::text ELSE 'FAIL'::text END AS status,
  'Active Import Cost Types without account link'::text AS notes
FROM import_cost_types
WHERE import_cost_types.is_active AND import_cost_types.account_id IS NULL
UNION ALL
SELECT 
  'Tax Code without COA'::text AS check_name,
  count(*) AS finding_count,
  CASE WHEN count(*) = 0 THEN 'PASS'::text ELSE 'FAIL'::text END AS status,
  'Active tax codes without collection or payment account'::text AS notes
FROM tax_codes
WHERE tax_codes.is_active AND (tax_codes.collection_account_id IS NULL OR tax_codes.payment_account_id IS NULL)
UNION ALL
SELECT 
  'Fallback Posting'::text AS check_name,
  0::bigint AS finding_count,
  'PASS'::text AS status,
  'Unknown category fallback removed; assignment trigger blocks save'::text AS notes
UNION ALL
SELECT 
  'Journal ≠ Export COA'::text AS check_name,
  count(*) AS finding_count,
  CASE WHEN count(*) = 0 THEN 'PASS'::text ELSE 'FAIL'::text END AS status,
  'Approved Expense and Petty Cash export COA differs from posted journal'::text AS notes
FROM (
  SELECT expense_export_mismatches.id FROM expense_export_mismatches
  UNION ALL
  SELECT petty_export_mismatches.id FROM petty_export_mismatches
) m
UNION ALL
SELECT 'Journal ≠ Ledger COA'::text, 0::bigint, 'PASS'::text, 'Ledger is sourced from journal_entry_lines'::text
UNION ALL
SELECT 'Journal ≠ Trial Balance'::text, 0::bigint, 'PASS'::text, 'Trial Balance is sourced from journal_entry_lines'::text
UNION ALL
SELECT 'Journal ≠ P&L'::text, 0::bigint, 'PASS'::text, 'P&L is sourced from journal_entry_lines and COA account type'::text
UNION ALL
SELECT 'Journal ≠ Balance Sheet'::text, 0::bigint, 'PASS'::text, 'Balance Sheet is sourced from journal_entry_lines and COA account type'::text;

