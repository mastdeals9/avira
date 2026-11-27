-- =============================================================================
-- Priority 2.3: Accounts Payable (GL 2110) Control Reconciliation Views & RPC
-- =============================================================================
-- Preserves public.supplier_payables_view (Trade AP by Supplier) unchanged.
-- Adds deterministic line-level and category-level reconciliation accounting
-- for 100% of active posted GL 2110 balances across 7 explicit categories.
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_ap_control_reconciliation
WITH (security_invoker = true)
AS
SELECT
  jel.id AS journal_entry_line_id,
  je.id AS journal_entry_id,
  je.entry_number,
  je.entry_date,
  je.source_module,
  je.reference_id,
  je.reference_number,
  je.description AS journal_description,
  jel.description AS line_description,
  jel.supplier_id,
  s.company_name AS supplier_name,
  COALESCE(jel.staff_id, fe.staff_id) AS staff_id,
  fsm.full_name AS staff_name,
  COALESCE(jel.payee_id, fe.payee_id) AS payee_id,
  fp.full_name AS payee_name,
  fe.id AS expense_id,
  fe.voucher_number AS expense_voucher_number,
  fe.expense_category,
  jel.debit,
  jel.credit,
  (jel.credit - jel.debit) AS net_ap_balance,
  CASE
    WHEN jel.supplier_id IS NOT NULL THEN '1_trade_ap_supplier'
    WHEN je.source_module IN ('customs_duty', 'customs_duty_adjustment')
      OR fe.expense_category = 'pib_import' THEN '2_statutory_customs_pib'
    WHEN je.entry_number = 'JE2611-0516'
      OR je.reference_number ILIKE '%PIB%'
      OR jel.description ILIKE '%Bea Masuk%'
      OR jel.description ILIKE '%PIB%' THEN '3_customs_reclassification'
    WHEN jel.staff_id IS NOT NULL OR fe.staff_id IS NOT NULL THEN '4_staff_related_ap'
    WHEN jel.payee_id IS NOT NULL OR fe.payee_id IS NOT NULL THEN '5_named_payee_ap'
    WHEN je.source_module IN ('expense', 'expenses', 'expense_payment') THEN '6_expense_without_supplier'
    ELSE '7_other_unassigned_ap'
  END AS ap_category_code,
  CASE
    WHEN jel.supplier_id IS NOT NULL THEN 'Trade AP (Supplier Subledger)'
    WHEN je.source_module IN ('customs_duty', 'customs_duty_adjustment')
      OR fe.expense_category = 'pib_import' THEN 'Statutory & Customs / PIB'
    WHEN je.entry_number = 'JE2611-0516'
      OR je.reference_number ILIKE '%PIB%'
      OR jel.description ILIKE '%Bea Masuk%'
      OR jel.description ILIKE '%PIB%' THEN 'Customs Reclassification / Clearing'
    WHEN jel.staff_id IS NOT NULL OR fe.staff_id IS NOT NULL THEN 'Staff-Related AP'
    WHEN jel.payee_id IS NOT NULL OR fe.payee_id IS NOT NULL THEN 'Named Non-Supplier Payee AP'
    WHEN je.source_module IN ('expense', 'expenses', 'expense_payment') THEN 'Expense AP Without Supplier'
    ELSE 'Other / Unassigned AP'
  END AS ap_category_label,
  (jel.supplier_id IS NOT NULL) AS is_supplier_subledger
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
LEFT JOIN public.suppliers s ON s.id = jel.supplier_id
LEFT JOIN public.finance_expenses fe
  ON je.source_module IN ('expense', 'expenses', 'expense_payment')
 AND fe.id = je.reference_id
LEFT JOIN public.finance_staff_master fsm ON fsm.id = COALESCE(jel.staff_id, fe.staff_id)
LEFT JOIN public.finance_payees fp ON fp.id = COALESCE(jel.payee_id, fe.payee_id)
WHERE coa.code = '2110'
  AND COALESCE(je.is_posted, false) = true
  AND NOT COALESCE(je.is_reversed, false)
  AND NOT COALESCE(je.is_cancelled, false);

CREATE OR REPLACE VIEW public.vw_ap_control_reconciliation_summary
WITH (security_invoker = true)
AS
WITH categories(ap_category_code, ap_category_label, is_supplier_subledger, sort_order) AS (
  VALUES
    ('1_trade_ap_supplier', 'Trade AP (Supplier Subledger)', true, 1),
    ('2_statutory_customs_pib', 'Statutory & Customs / PIB', false, 2),
    ('3_customs_reclassification', 'Customs Reclassification / Clearing', false, 3),
    ('4_staff_related_ap', 'Staff-Related AP', false, 4),
    ('5_named_payee_ap', 'Named Non-Supplier Payee AP', false, 5),
    ('6_expense_without_supplier', 'Expense AP Without Supplier', false, 6),
    ('7_other_unassigned_ap', 'Other / Unassigned AP', false, 7)
)
SELECT
  c.ap_category_code,
  c.ap_category_label,
  c.is_supplier_subledger,
  c.sort_order,
  COUNT(v.journal_entry_line_id)::bigint AS line_count,
  COALESCE(SUM(v.debit), 0)::numeric(18,2) AS total_debit,
  COALESCE(SUM(v.credit), 0)::numeric(18,2) AS total_credit,
  COALESCE(SUM(v.net_ap_balance), 0)::numeric(18,2) AS net_ap_balance
FROM categories c
LEFT JOIN public.vw_ap_control_reconciliation v
  ON v.ap_category_code = c.ap_category_code
GROUP BY c.ap_category_code, c.ap_category_label, c.is_supplier_subledger, c.sort_order
ORDER BY c.sort_order;

CREATE OR REPLACE FUNCTION public.get_ap_control_reconciliation_summary(
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  ap_category_code text,
  ap_category_label text,
  is_supplier_subledger boolean,
  sort_order integer,
  line_count bigint,
  total_debit numeric,
  total_credit numeric,
  net_ap_balance numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH categories(ap_category_code, ap_category_label, is_supplier_subledger, sort_order) AS (
    VALUES
      ('1_trade_ap_supplier', 'Trade AP (Supplier Subledger)', true, 1),
      ('2_statutory_customs_pib', 'Statutory & Customs / PIB', false, 2),
      ('3_customs_reclassification', 'Customs Reclassification / Clearing', false, 3),
      ('4_staff_related_ap', 'Staff-Related AP', false, 4),
      ('5_named_payee_ap', 'Named Non-Supplier Payee AP', false, 5),
      ('6_expense_without_supplier', 'Expense AP Without Supplier', false, 6),
      ('7_other_unassigned_ap', 'Other / Unassigned AP', false, 7)
  )
  SELECT
    c.ap_category_code,
    c.ap_category_label,
    c.is_supplier_subledger,
    c.sort_order,
    COUNT(v.journal_entry_line_id)::bigint AS line_count,
    COALESCE(SUM(v.debit), 0)::numeric(18,2) AS total_debit,
    COALESCE(SUM(v.credit), 0)::numeric(18,2) AS total_credit,
    COALESCE(SUM(v.net_ap_balance), 0)::numeric(18,2) AS net_ap_balance
  FROM categories c
  LEFT JOIN public.vw_ap_control_reconciliation v
    ON v.ap_category_code = c.ap_category_code
   AND v.entry_date <= COALESCE(p_as_of_date, CURRENT_DATE)
  GROUP BY c.ap_category_code, c.ap_category_label, c.is_supplier_subledger, c.sort_order
  ORDER BY c.sort_order;
$function$;

GRANT SELECT ON public.vw_ap_control_reconciliation TO authenticated, service_role;
GRANT SELECT ON public.vw_ap_control_reconciliation_summary TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_ap_control_reconciliation_summary(date) TO authenticated, service_role;
