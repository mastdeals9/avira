-- =============================================================================
-- SAPJ ERP — ACCOUNTING INTEGRITY & CONTROL FORENSIC AUDIT (READ-ONLY)
-- Production Supabase Target: dkrtsqienlhpouohmfki
-- =============================================================================
-- STRICT NON-NEGOTIABLE SAFETY:
-- 1. Explicitly sets transaction to READ ONLY.
-- 2. No DDL, DML, or data mutation.
-- =============================================================================

BEGIN TRANSACTION READ ONLY;

-- -----------------------------------------------------------------------------
-- [PILLAR 1] BANK RECONCILIATION & CASH AT BANK
-- -----------------------------------------------------------------------------

-- 1A. Bank Account Masters: Cached Balance vs Live GL Balance
SELECT 
  ba.id AS bank_account_id,
  ba.account_name,
  ba.bank_name,
  ba.account_number,
  ba.currency,
  ba.opening_balance,
  ba.current_balance AS cached_balance,
  public.calculate_bank_account_book_balance(ba.id, CURRENT_DATE) AS live_gl_book_balance,
  coa.code AS coa_code,
  coa.name AS coa_name
FROM public.bank_accounts ba
LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
WHERE ba.is_active = true
ORDER BY ba.account_name;

-- 1B. October 2026 BCA IDR Movement Discrepancy (Statement vs GL)
WITH stmt_oct AS (
  SELECT 
    count(*) AS stmt_count,
    sum(debit_amount) AS stmt_debits,
    sum(credit_amount) AS stmt_credits,
    sum(credit_amount - debit_amount) AS stmt_net_movement
  FROM public.bank_statement_lines
  WHERE bank_account_id = 'bfe79829-07d1-48ed-8965-ff9d367d758e'
    AND transaction_date >= '2026-10-01' AND transaction_date <= '2026-10-31'
),
gl_oct AS (
  SELECT 
    count(jel.id) AS gl_count,
    sum(jel.debit) AS gl_debits,
    sum(jel.credit) AS gl_credits,
    sum(jel.debit - jel.credit) AS gl_net_movement
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '111101'
    AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    AND je.entry_date >= '2026-10-01' AND je.entry_date <= '2026-10-31'
)
SELECT 
  s.stmt_net_movement,
  g.gl_net_movement,
  (s.stmt_net_movement - g.gl_net_movement) AS oct_movement_variance
FROM stmt_oct s, gl_oct g;

-- 1C. Forensic Root Cause of Rp 3,900,000 Variance
-- Line 1: Statement debit Rp 4,000,000 Bizpark without GL payment journal
SELECT 
  bsl.id AS stmt_line_id,
  bsl.transaction_date,
  bsl.description AS stmt_description,
  bsl.debit_amount AS stmt_debit,
  bsl.reconciliation_status,
  fe.voucher_number AS exp_voucher_number,
  fe.amount AS exp_amount,
  fe.paid_amount AS exp_paid_amount
FROM public.bank_statement_lines bsl
LEFT JOIN public.finance_expenses fe ON fe.id = bsl.matched_expense_id
WHERE bsl.id = '16a51755-cc15-4315-b1ac-79d54d0b8a96';

-- Line 2: GL Bank credit Rp 100,000 PV 028 without statement match
SELECT 
  pv.id AS pv_id,
  pv.voucher_number,
  pv.voucher_date,
  pv.amount AS pv_amount,
  pv.payment_method,
  pv.party_type,
  je.entry_number,
  s.full_name AS staff_name
FROM public.payment_vouchers pv
LEFT JOIN public.finance_staff_master s ON s.id = pv.staff_id
LEFT JOIN public.journal_entries je ON je.id = pv.journal_entry_id
WHERE pv.voucher_number = 'PV/26-26/028';

-- 1D. November 2026 Unmatched Special Lines
SELECT 
  id,
  transaction_date,
  description,
  debit_amount,
  credit_amount,
  reconciliation_status
FROM public.bank_statement_lines
WHERE bank_account_id = 'bfe79829-07d1-48ed-8965-ff9d367d758e'
  AND transaction_date >= '2026-11-01'
  AND reconciliation_status = 'unmatched'
  AND (debit_amount > 1000000000 OR credit_amount = 500000);


-- -----------------------------------------------------------------------------
-- [PILLAR 2] EXPENSE, PAYMENT & PARTY LEDGER INTEGRITY
-- -----------------------------------------------------------------------------

-- 2A. AP Control (2110) vs Supplier Subledger Variance (Rp 26,917,200)
WITH ap_all AS (
  SELECT 
    sum(jel.credit - jel.debit) AS net_ap_control
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '2110'
    AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
),
ap_subledger AS (
  SELECT 
    sum(jel.credit - jel.debit) AS net_supplier_subledger
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '2110'
    AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    AND jel.supplier_id IS NOT NULL
)
SELECT 
  a.net_ap_control,
  s.net_supplier_subledger,
  (a.net_ap_control - s.net_supplier_subledger) AS non_supplier_ap_variance
FROM ap_all a, ap_subledger s;

-- 2B. Composition of the 326 AP Lines without supplier_id
SELECT 
  je.source_module,
  count(jel.id) AS line_count,
  sum(jel.debit) AS debits,
  sum(jel.credit) AS credits,
  sum(jel.credit - jel.debit) AS net_ap_impact
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
WHERE coa.code = '2110'
  AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
  AND jel.supplier_id IS NULL
GROUP BY je.source_module
ORDER BY line_count DESC;

-- 2C. Sandi & Imron Multi-Part Salary Settlements
SELECT 
  fe.voucher_number,
  s.full_name AS staff_name,
  fe.amount AS salary_amount,
  fe.paid_amount,
  bsl.debit_amount AS bank_transfer_amount,
  pv.voucher_number AS advance_settlement_voucher,
  pv.amount AS advance_settlement_amount
FROM public.finance_expenses fe
JOIN public.finance_staff_master s ON s.id = fe.staff_id
LEFT JOIN public.bank_statement_lines bsl ON bsl.matched_expense_id = fe.id
LEFT JOIN public.payment_vouchers pv ON pv.staff_id = fe.staff_id 
  AND pv.voucher_date >= '2026-10-01' AND pv.payment_purpose = 'salary_advance' AND pv.voucher_number != 'PV/26-26/028'
WHERE fe.voucher_number IN ('EXP/26/365', 'EXP/26/367')
ORDER BY fe.voucher_number;


-- -----------------------------------------------------------------------------
-- [PILLAR 3] PETTY CASH & CASH ON HAND INTEGRITY
-- -----------------------------------------------------------------------------

-- 3A. Cash Accounts Status and Live Balances
SELECT 
  coa.code,
  coa.name,
  coa.is_active,
  sum(jel.debit) AS debits,
  sum(jel.credit) AS credits,
  sum(jel.debit - jel.credit) AS live_gl_balance
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
WHERE coa.code IN ('1101', '1102')
  AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
GROUP BY coa.code, coa.name, coa.is_active;

-- 3B. Cash Payment Vouchers PV 017 and PV 018
SELECT 
  pv.voucher_number,
  pv.voucher_date,
  pv.amount,
  pv.payment_method,
  pv.is_posted,
  je.entry_number,
  coa.code AS credit_account_code,
  coa.name AS credit_account_name
FROM public.payment_vouchers pv
JOIN public.journal_entries je ON je.id = pv.journal_entry_id
JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id AND jel.credit > 0
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
WHERE pv.voucher_number IN ('PV/26-26/017', 'PV/26-26/018')
  AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);


-- -----------------------------------------------------------------------------
-- [PILLAR 4] TAX (PPN, PPh) & BPJS COMPLIANCE
-- -----------------------------------------------------------------------------

-- 4A. Cancelled Sales Invoice SAPJ-26-072 Status
SELECT 
  invoice_number,
  invoice_date,
  total_amount,
  tax_amount,
  document_status,
  cancelled_at,
  cancellation_reason
FROM public.sales_invoices
WHERE invoice_number = 'SAPJ-26-072';

-- 4B. Active Sales Invoices with Missing Faktur Pajak (Excluding Cancelled)
SELECT 
  invoice_number,
  invoice_date,
  total_amount,
  tax_amount,
  document_status,
  faktur_pajak_number
FROM public.sales_invoices
WHERE tax_amount > 0
  AND document_status != 'cancelled'
  AND cancelled_at IS NULL
  AND (faktur_pajak_number IS NULL OR btrim(faktur_pajak_number) = '')
ORDER BY invoice_date DESC;

-- 4C. Tax and BPJS GL Balances
SELECT 
  coa.code,
  coa.name,
  sum(jel.debit) AS debits,
  sum(jel.credit) AS credits,
  sum(jel.credit - jel.debit) AS net_liability
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
WHERE coa.code IN ('2131', '2132', '2134')
  AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
GROUP BY coa.code, coa.name
ORDER BY coa.code;

-- 4D. BPJS Register Status
SELECT 
  period_month,
  period_year,
  status,
  payment_status,
  reconciliation_status,
  total_employee_deductions,
  total_employer_expenses,
  total_contribution_payable,
  actual_paid_amount
FROM public.bpjs_monthly_registers
ORDER BY period_year DESC, period_month DESC;


-- -----------------------------------------------------------------------------
-- [PILLAR 5] FINANCE MASTER VERIFICATION REPORT ACCURACY
-- -----------------------------------------------------------------------------

-- 5A. Expense Export Mismatches (Flawed vs Corrected)
SELECT 
  (
    SELECT count(*)
    FROM public.finance_expenses e
    JOIN LATERAL public.get_expense_export_accounts(ARRAY[e.id]) ex ON true
    JOIN LATERAL (
      SELECT coa.code
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id AND jel.debit>0
      JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
      WHERE je.reference_id=e.id AND je.is_posted AND NOT COALESCE(je.is_reversed, false)
      ORDER BY je.posted_at DESC NULLS LAST, jel.line_number LIMIT 1
    ) journal ON true
    WHERE e.approval_status='approved' AND ex.coa_code IS DISTINCT FROM journal.code
  ) AS flawed_mismatches_count,
  (
    SELECT count(*)
    FROM public.finance_expenses e
    JOIN LATERAL public.get_expense_export_accounts(ARRAY[e.id]) ex ON true
    JOIN LATERAL (
      SELECT coa.code
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id AND jel.debit>0
      JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
      WHERE je.reference_id=e.id AND je.is_posted AND NOT COALESCE(je.is_reversed, false)
        AND je.source_module IN ('expenses', 'expense')
      ORDER BY je.entry_date ASC, je.posted_at ASC, jel.line_number LIMIT 1
    ) journal ON true
    WHERE e.approval_status='approved' AND ex.coa_code IS DISTINCT FROM journal.code
  ) AS corrected_mismatches_count;

COMMIT;

