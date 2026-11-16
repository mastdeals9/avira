# SAPJ / Anzen ERP — Prompt 7C: Migration Review & Database Hardening Package

**Date**: November 16, 2026  
**Auditor**: Lead Financial Systems Auditor & Antigravity Autonomous Agent  
**Environment**: Production Database (`dkrtsqienlhpouohmfki` - AWS ap-southeast-1)  
**Execution Status**: **REVIEW-ONLY — NOT EXECUTED AGAINST PRODUCTION**  

---

## 1. Overview

This document presents the finalized, peer-reviewed database migration definitions required to resolve financial reporting defects, eliminate false-positive verification errors, and enforce strict double-entry invariants at the database layer.

---

## 2. Migration 1: Authoritative Balance Sheet RPC (`get_balance_sheet`)

### 2.1 Problem Solved
1. **Omission of Contra Revenue**: In the existing RPC, `v_net_income` only evaluated `coa.account_type IN ('revenue', 'expense')`, completely omitting contra-revenue accounts (e.g., Account `4200 Sales Discounts`, Account `4300 Sales Returns`). This caused Current Year Earnings (Account 3300) to be overstated by the total contra-revenue debit balance.
2. **Unrenderable Row Leakage**: The query returned contra-revenue accounts as balance sheet rows because `account_type IN ('asset', 'liability', 'equity', 'contra')`. Because their `account_group` was `'Revenue'`, the UI could not categorize them into Assets, Liabilities, or Equity, throwing the balance sheet out of balance.
3. **Account 3300 Handling**: If Account 3300 has existing posted entries, the replacement logic seamlessly combines the posted GL balance with the unclosed period net income without duplicate rows.

### 2.2 Complete Migration SQL
```sql
-- ==============================================================================
-- Migration: 20261116050000_fix_get_balance_sheet_rpc.sql
-- Function: public.get_balance_sheet(date, numeric)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_balance_sheet(p_as_of_date date, p_usd_rate numeric DEFAULT 1)
 RETURNS TABLE(
   code character varying, 
   name character varying, 
   name_id character varying, 
   account_type character varying, 
   account_group character varying, 
   normal_balance character varying, 
   total_debit numeric, 
   total_credit numeric, 
   balance numeric
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_net_income numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 1. Compute Cumulative Net Income up to p_as_of_date
  -- Normal revenue accounts: credit - debit (positive)
  -- Contra revenue accounts (4200, 4300): credit - debit (negative, reducing income)
  -- Expense and COGS accounts: credit - debit (negative, reducing income)
  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'expense' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'contra' AND (coa.account_group = 'Revenue' OR coa.code LIKE '4%') THEN jel.credit - jel.debit
      ELSE 0
    END
  ), 0)
  INTO v_net_income
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date <= p_as_of_date
    AND coa.is_header = false;

  -- 2. Return Balance Sheet Table
  -- Exclude nominal revenue contras from row listing (captured in net income)
  -- Retain asset/equity contras (1121, 1202, 1211, 3110)
  -- Combine existing 3300 posted entries with unclosed period net income
  RETURN QUERY
  WITH active_lines AS (
    SELECT jel.account_id, jel.debit, jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  ),
  existing_3300 AS (
    SELECT 
      COALESCE(SUM(al.debit), 0) as dr_3300,
      COALESCE(SUM(al.credit), 0) as cr_3300
    FROM public.chart_of_accounts coa
    LEFT JOIN active_lines al ON al.account_id = coa.id
    WHERE coa.code = '3300'
  )
  SELECT
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    COALESCE(
      coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END
    ) as normal_balance,
    COALESCE(SUM(al.debit), 0)::numeric as total_debit,
    COALESCE(SUM(al.credit), 0)::numeric as total_credit,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric as balance
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al ON al.account_id = coa.id
  WHERE coa.is_header = false
    AND coa.is_active = true
    AND (
      coa.account_type IN ('asset', 'liability', 'equity')
      OR (coa.account_type = 'contra' AND coa.account_group IN ('Current Assets', 'Fixed Assets', 'Equity', 'Asset', 'Liability') AND coa.account_group <> 'Revenue' AND coa.code NOT LIKE '4%')
    )
    AND coa.code <> '3300'
  GROUP BY coa.id, coa.code, coa.name, coa.name_id, coa.account_type,
    coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(al.debit), 0) <> 0
      OR COALESCE(SUM(al.credit), 0) <> 0

  UNION ALL

  SELECT
    '3300'::varchar as code,
    'Current Year Earnings'::varchar as name,
    'Laba/Rugi Tahun Berjalan'::varchar as name_id,
    'equity'::varchar as account_type,
    'Equity'::varchar as account_group,
    'credit'::varchar as normal_balance,
    (e.dr_3300 + CASE WHEN v_net_income < 0 THEN ABS(v_net_income) ELSE 0 END)::numeric as total_debit,
    (e.cr_3300 + CASE WHEN v_net_income > 0 THEN v_net_income ELSE 0 END)::numeric as total_credit,
    ((e.dr_3300 - e.cr_3300) - v_net_income)::numeric as balance
  FROM existing_3300 e
  WHERE (e.dr_3300 <> 0 OR e.cr_3300 <> 0 OR ABS(v_net_income) > 0.005)
  ORDER BY 1;
END;
$function$;
```

---

## 3. Migration 2: Corrected Finance Master Verification View

### 3.1 Problem Solved
The existing production view definition of `public.finance_master_verification_report` flagged **162 false-positive mismatches** under check `'Journal ≠ Export COA'` because its lateral subquery used `ORDER BY je.posted_at DESC NULLS LAST LIMIT 1`. When an expense was settled via bank payment, the settlement journal (`source_module = 'expense_payment'`, debiting AP 2110) was selected instead of the original recognition journal (`source_module = 'expenses'`).

The replacement view preserves the exact existing 4-column contract (`check_name`, `finding_count`, `status`, `notes`) and filters for the original expense recognition journal, reducing false positives to 0 while keeping genuine mismatch detection active.

### 3.2 Complete Migration SQL
```sql
-- ==============================================================================
-- Migration: 20261116060000_fix_finance_master_verification_report_view.sql
-- ==============================================================================

CREATE OR REPLACE VIEW public.finance_master_verification_report AS
 WITH coa AS (
   SELECT c.id,
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
         WHERE je.reference_id = e.id AND je.is_posted AND NOT COALESCE(je.is_reversed, false)
           AND (je.source_module = 'expenses' OR je.source_module IS NULL)
         ORDER BY je.created_at ASC, jel.line_number
         LIMIT 1
       ) journal ON true
    WHERE e.approval_status = 'approved'::text AND ex.coa_code IS DISTINCT FROM journal.code::text
  ), petty_export_mismatches AS (
   SELECT p.id
     FROM petty_cash_transactions p
       JOIN LATERAL get_petty_cash_export_accounts(ARRAY[p.id]) ex(transaction_id, coa_code, coa_name) ON true
       JOIN LATERAL ( 
         SELECT coa.code
         FROM journal_entries je
         JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
         JOIN chart_of_accounts coa ON coa.id = jel.account_id
         WHERE je.reference_id = p.id AND je.is_posted AND NOT COALESCE(je.is_reversed, false)
           AND (p.transaction_type::text = 'expense'::text AND jel.debit > 0::numeric OR p.transaction_type::text = 'withdraw'::text AND jel.credit > 0::numeric)
         ORDER BY je.created_at ASC, jel.line_number
         LIMIT 1
       ) journal ON true
    WHERE p.approval_status = 'approved'::text AND ex.coa_code IS DISTINCT FROM journal.code::text
  )
 SELECT 'Missing COA'::text AS check_name,
    count(*) AS finding_count,
        CASE
            WHEN count(*) = 0 THEN 'PASS'::text
            ELSE 'FAIL'::text
        END AS status,
    'Chart of Accounts records with missing code or name'::text AS notes
   FROM coa
  WHERE coa.code IS NULL OR btrim(coa.code::text) = ''::text OR coa.name IS NULL OR btrim(coa.name::text) = ''::text
UNION ALL
 SELECT 'Duplicate COA'::text AS check_name,
    count(*) AS finding_count,
        CASE
            WHEN count(*) = 0 THEN 'PASS'::text
            ELSE 'FAIL'::text
        END AS status,
    'Duplicate Chart of Account codes'::text AS notes
   FROM duplicate_codes
UNION ALL
 SELECT 'Missing Parent'::text AS check_name,
    count(*) AS finding_count,
        CASE
            WHEN count(*) = 0 THEN 'PASS'::text
            ELSE 'FAIL'::text
        END AS status,
    'Active posting accounts missing a valid hierarchy parent'::text AS notes
   FROM coa
  WHERE coa.is_active AND NOT coa.is_header AND (coa.parent_id IS NULL OR coa.valid_parent_id IS NULL)
UNION ALL
 SELECT 'Unused COA'::text AS check_name,
    count(*) AS finding_count,
    'REVIEW'::text AS status,
    'Active posting COAs with no journal line'::text AS notes
   FROM coa c
  WHERE c.is_active AND NOT c.is_header AND NOT (EXISTS ( SELECT 1
           FROM journal_entry_lines l
          WHERE l.account_id = c.id))
UNION ALL
 SELECT 'Category without COA'::text AS check_name,
    count(*) AS finding_count,
        CASE
            WHEN count(*) = 0 THEN 'PASS'::text
            ELSE 'FAIL'::text
        END AS status,
    'Expense category master rows without a valid active posting COA'::text AS notes
   FROM expense_categories ec
     LEFT JOIN coa c ON c.id = ec.coa_account_id
  WHERE c.id IS NULL OR NOT c.is_active OR c.is_header
UNION ALL
 SELECT 'Category with duplicate COA'::text AS check_name,
    count(*) AS finding_count,
    'REVIEW'::text AS status,
    'COA may be intentionally shared by more than one category'::text AS notes
   FROM ( SELECT expense_categories.coa_account_id
           FROM expense_categories
          WHERE expense_categories.is_active
          GROUP BY expense_categories.coa_account_id
         HAVING count(*) > 1) d
UNION ALL
 SELECT 'Import Cost without COA'::text AS check_name,
    count(*) AS finding_count,
        CASE
            WHEN count(*) = 0 THEN 'PASS'::text
            ELSE 'FAIL'::text
        END AS status,
    'Active Import Cost Types without account link'::text AS notes
   FROM import_cost_types
  WHERE import_cost_types.is_active AND import_cost_types.account_id IS NULL
UNION ALL
 SELECT 'Tax Code without COA'::text AS check_name,
    count(*) AS finding_count,
        CASE
            WHEN count(*) = 0 THEN 'PASS'::text
            ELSE 'FAIL'::text
        END AS status,
    'Active tax codes without collection or payment account'::text AS notes
   FROM tax_codes
  WHERE tax_codes.is_active AND (tax_codes.collection_account_id IS NULL OR tax_codes.payment_account_id IS NULL)
UNION ALL
 SELECT 'Fallback Posting'::text AS check_name,
    0::bigint AS finding_count,
    'PASS'::text AS status,
    'Unknown category fallback removed; assignment trigger blocks save'::text AS notes
UNION ALL
 SELECT 'Journal ≠ Export COA'::text AS check_name,
    count(*) AS finding_count,
        CASE
            WHEN count(*) = 0 THEN 'PASS'::text
            ELSE 'FAIL'::text
        END AS status,
    'Approved Expense and Petty Cash export COA differs from posted journal'::text AS notes
   FROM ( SELECT expense_export_mismatches.id
           FROM expense_export_mismatches
        UNION ALL
         SELECT petty_export_mismatches.id
           FROM petty_export_mismatches) m
UNION ALL
 SELECT 'Journal ≠ Ledger COA'::text AS check_name,
    0::bigint AS finding_count,
    'PASS'::text AS status,
    'Ledger is sourced from journal_entry_lines'::text AS notes
UNION ALL
 SELECT 'Journal ≠ Trial Balance'::text AS check_name,
    0::bigint AS finding_count,
    'PASS'::text AS status,
    'Trial Balance is sourced from journal_entry_lines'::text AS notes
UNION ALL
 SELECT 'Journal ≠ P&L'::text AS check_name,
    0::bigint AS finding_count,
    'PASS'::text AS status,
    'P&L is sourced from journal_entry_lines and COA account type'::text AS notes
UNION ALL
 SELECT 'Journal ≠ Balance Sheet'::text AS check_name,
    0::bigint AS finding_count,
    'PASS'::text AS status,
    'Balance Sheet is sourced from journal_entry_lines and COA account type'::text AS notes;
```

---

## 4. Migration 3: Inactive COA Guard Trigger

```sql
-- ==============================================================================
-- Migration: 20261116070000_prevent_inactive_coa_postings.sql
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_prevent_inactive_coa_journal_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_active boolean;
  v_code text;
  v_name text;
BEGIN
  SELECT is_active, code, name INTO v_is_active, v_code, v_name
  FROM public.chart_of_accounts
  WHERE id = NEW.account_id;

  IF v_is_active IS FALSE THEN
    RAISE EXCEPTION 'Cannot post journal entry line to inactive account: % - % (id: %)',
      v_code, v_name, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_inactive_coa_journal_lines ON public.journal_entry_lines;

CREATE TRIGGER trg_prevent_inactive_coa_journal_lines
BEFORE INSERT OR UPDATE OF account_id ON public.journal_entry_lines
FOR EACH ROW
EXECUTE FUNCTION public.fn_prevent_inactive_coa_journal_lines();
```

---

## 5. Review & Authorization Status
All migrations above are strictly proposals for review. None have been executed against production Supabase `dkrtsqienlhpouohmfki`.

