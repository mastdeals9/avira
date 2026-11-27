-- ANZEN ERP: duplicate_postings diagnostic view correction
--
-- Scope: diagnostic view only. This migration does not modify journal entries,
-- journal lines, invoices, COGS, inventory, bank records, allocations, or ledgers.
--
-- Detection rules:
--   * Only posted, active, non-reversed, non-cancelled journals are considered.
--   * Every module is compared using the complete directed journal-line signature.
--   * Expense-payment journals are separated by actual payment/allocation provenance.
--   * FIFO COGS adjustments are eligible for signed netting only when they match
--     the exact posting shape emitted by public.propagate_batch_cost_change:
--       - source_module = sales_invoice_cogs_adjustment
--       - FIFO-ADJ reference-number format and FIFO COGS True-Up header
--       - exactly two lines: account 5100 and account 1130
--       - both lines have the same non-null batch and customer
--       - equal and opposite functional debit/credit amounts
--     The batch_id is part of the line signature, so different batches do not net.
--
-- Important schema limitation:
--   propagate_batch_cost_change does not persist a distinct propagation-run ID.
--   Accordingly, the FIFO diagnostic groups only journals with the same source
--   document, exact batch/item/account/amount signature, and generated FIFO
--   posting shape. This is a financial-effect diagnostic, not proof of a causal
--   relationship between individual function invocations.
--
-- Reversal/replacement handling:
--   Reversed/cancelled originals and journals with reversed_by_id set are
--   excluded. Active replacement journals remain eligible for duplicate
--   detection as active postings. No unused "verified replacement" flag is
--   calculated or claimed.

CREATE OR REPLACE VIEW public.duplicate_postings
WITH (security_invoker = true) AS
WITH active_jes AS (
  SELECT
    je.id,
    je.entry_number,
    je.entry_date,
    je.source_module,
    je.reference_id,
    je.reference_number,
    je.description
  FROM public.journal_entries AS je
  WHERE je.reference_id IS NOT NULL
    AND je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND COALESCE(je.is_cancelled, false) = false
    AND je.reversed_by_id IS NULL
),
line_facts AS (
  SELECT
    aj.id AS journal_entry_id,
    COUNT(jel.id)::bigint AS line_count,
    COUNT(*) FILTER (WHERE coa.code = '5100')::bigint AS cogs_line_count,
    COUNT(*) FILTER (WHERE coa.code = '1130')::bigint AS inventory_line_count,
    COUNT(*) FILTER (
      WHERE coa.code IS NULL OR coa.code NOT IN ('5100', '1130')
    )::bigint AS other_account_line_count,
    COUNT(DISTINCT jel.batch_id)::bigint AS distinct_batch_count,
    COUNT(*) FILTER (WHERE jel.batch_id IS NULL)::bigint AS null_batch_line_count,
    COUNT(DISTINCT jel.customer_id)::bigint AS distinct_customer_count,
    COUNT(*) FILTER (WHERE jel.customer_id IS NULL)::bigint AS null_customer_line_count,
    COALESCE(SUM(jel.debit) FILTER (WHERE coa.code = '5100'), 0) AS cogs_debit,
    COALESCE(SUM(jel.credit) FILTER (WHERE coa.code = '5100'), 0) AS cogs_credit,
    COALESCE(SUM(jel.debit) FILTER (WHERE coa.code = '1130'), 0) AS inventory_debit,
    COALESCE(SUM(jel.credit) FILTER (WHERE coa.code = '1130'), 0) AS inventory_credit
  FROM active_jes AS aj
  JOIN public.journal_entry_lines AS jel
    ON jel.journal_entry_id = aj.id
  LEFT JOIN public.chart_of_accounts AS coa
    ON coa.id = jel.account_id
  GROUP BY aj.id
),
je_provenance AS (
  SELECT
    aj.*,
    CASE
      WHEN aj.source_module = 'expense_payment' THEN COALESCE(
        (
          SELECT
            'bsa:' || string_agg(
              DISTINCT bsa.bank_statement_line_id::text,
              ',' ORDER BY bsa.bank_statement_line_id::text
            )
          FROM public.bank_statement_allocations AS bsa
          WHERE bsa.journal_entry_id = aj.id
        ),
        (
          SELECT
            'bsl:' || string_agg(
              DISTINCT bsl.id::text,
              ',' ORDER BY bsl.id::text
            )
          FROM public.bank_statement_lines AS bsl
          WHERE bsl.matched_entry_id = aj.id
        ),
        (
          SELECT
            'pv:' || string_agg(
              DISTINCT pv.id::text,
              ',' ORDER BY pv.id::text
            )
          FROM public.payment_vouchers AS pv
          WHERE pv.journal_entry_id = aj.id
        ),
        (
          SELECT
            'rv:' || string_agg(
              DISTINCT rv.id::text,
              ',' ORDER BY rv.id::text
            )
          FROM public.receipt_vouchers AS rv
          WHERE rv.journal_entry_id = aj.id
        ),
        'unprovenanced'
      )
      ELSE ''
    END AS payment_provenance_key,
    (
      aj.source_module = 'sales_invoice_cogs_adjustment'
      AND COALESCE(aj.reference_number, '') ~ '-FIFO-ADJ(-[0-9]+)?$'
      AND COALESCE(aj.description, '') LIKE 'FIFO COGS True-Up:%'
      AND COALESCE(lf.line_count, 0) = 2
      AND COALESCE(lf.cogs_line_count, 0) = 1
      AND COALESCE(lf.inventory_line_count, 0) = 1
      AND COALESCE(lf.other_account_line_count, 0) = 0
      AND COALESCE(lf.distinct_batch_count, 0) = 1
      AND COALESCE(lf.null_batch_line_count, 0) = 0
      AND COALESCE(lf.distinct_customer_count, 0) = 1
      AND COALESCE(lf.null_customer_line_count, 0) = 0
      AND (
        (
          lf.cogs_debit > 0
          AND lf.cogs_credit = 0
          AND lf.inventory_debit = 0
          AND lf.inventory_credit = lf.cogs_debit
        )
        OR
        (
          lf.cogs_credit > 0
          AND lf.cogs_debit = 0
          AND lf.inventory_credit = 0
          AND lf.inventory_debit = lf.cogs_credit
        )
      )
    ) AS is_verified_fifo_adj_posting
  FROM active_jes AS aj
  LEFT JOIN line_facts AS lf
    ON lf.journal_entry_id = aj.id
),
je_signatures AS (
  SELECT
    jp.id AS journal_entry_id,
    jp.entry_number,
    jp.entry_date,
    jp.source_module,
    jp.reference_id,
    jp.reference_number,
    jp.description,
    jp.payment_provenance_key,
    jp.is_verified_fifo_adj_posting,
    COUNT(jel.id)::bigint AS journal_line_count,
    COALESCE(
      string_agg(
        COALESCE(jel.account_id::text, '')
        || ':' || COALESCE(jel.sales_invoice_item_id::text, '')
        || ':' || COALESCE(jel.batch_id::text, '')
        || ':' || COALESCE(jel.customer_id::text, '')
        || ':' || COALESCE(jel.supplier_id::text, '')
        || ':' || COALESCE(jel.tax_code_id::text, '')
        || ':' || COALESCE(jel.payee_id::text, '')
        || ':' || COALESCE(jel.staff_id::text, '')
        || ':' || COALESCE(jel.transaction_currency, '')
        || ':' || COALESCE(jel.functional_currency, '')
        || ':' || ROUND(COALESCE(jel.transaction_debit, 0), 2)::text
        || ':' || ROUND(COALESCE(jel.transaction_credit, 0), 2)::text
        || ':' || ROUND(COALESCE(jel.exchange_rate, 0), 8)::text
        || ':' || ROUND(COALESCE(jel.debit, 0), 2)::text
        || ':' || ROUND(COALESCE(jel.credit, 0), 2)::text,
        '|' ORDER BY
          COALESCE(jel.account_id::text, ''),
          COALESCE(jel.sales_invoice_item_id::text, ''),
          COALESCE(jel.batch_id::text, ''),
          COALESCE(jel.customer_id::text, ''),
          COALESCE(jel.supplier_id::text, ''),
          COALESCE(jel.tax_code_id::text, ''),
          COALESCE(jel.payee_id::text, ''),
          COALESCE(jel.staff_id::text, ''),
          COALESCE(jel.transaction_currency, ''),
          COALESCE(jel.functional_currency, ''),
          ROUND(COALESCE(jel.transaction_debit, 0), 2),
          ROUND(COALESCE(jel.transaction_credit, 0), 2),
          ROUND(COALESCE(jel.exchange_rate, 0), 8),
          ROUND(COALESCE(jel.debit, 0), 2),
          ROUND(COALESCE(jel.credit, 0), 2)
      ),
      'EMPTY'
    ) AS dir_line_sig,
    COALESCE(
      string_agg(
        COALESCE(jel.account_id::text, '')
        || ':' || COALESCE(jel.sales_invoice_item_id::text, '')
        || ':' || COALESCE(jel.batch_id::text, '')
        || ':' || COALESCE(jel.customer_id::text, '')
        || ':' || COALESCE(jel.supplier_id::text, '')
        || ':' || COALESCE(jel.tax_code_id::text, '')
        || ':' || COALESCE(jel.payee_id::text, '')
        || ':' || COALESCE(jel.staff_id::text, '')
        || ':' || COALESCE(jel.transaction_currency, '')
        || ':' || COALESCE(jel.functional_currency, '')
        || ':' || ROUND(COALESCE(jel.transaction_credit, 0), 2)::text
        || ':' || ROUND(COALESCE(jel.transaction_debit, 0), 2)::text
        || ':' || ROUND(COALESCE(jel.exchange_rate, 0), 8)::text
        || ':' || ROUND(COALESCE(jel.credit, 0), 2)::text
        || ':' || ROUND(COALESCE(jel.debit, 0), 2)::text,
        '|' ORDER BY
          COALESCE(jel.account_id::text, ''),
          COALESCE(jel.sales_invoice_item_id::text, ''),
          COALESCE(jel.batch_id::text, ''),
          COALESCE(jel.customer_id::text, ''),
          COALESCE(jel.supplier_id::text, ''),
          COALESCE(jel.tax_code_id::text, ''),
          COALESCE(jel.payee_id::text, ''),
          COALESCE(jel.staff_id::text, ''),
          COALESCE(jel.transaction_currency, ''),
          COALESCE(jel.functional_currency, ''),
          ROUND(COALESCE(jel.transaction_credit, 0), 2),
          ROUND(COALESCE(jel.transaction_debit, 0), 2),
          ROUND(COALESCE(jel.exchange_rate, 0), 8),
          ROUND(COALESCE(jel.credit, 0), 2),
          ROUND(COALESCE(jel.debit, 0), 2)
      ),
      'EMPTY'
    ) AS inv_line_sig
  FROM je_provenance AS jp
  LEFT JOIN public.journal_entry_lines AS jel
    ON jel.journal_entry_id = jp.id
  GROUP BY
    jp.id,
    jp.entry_number,
    jp.entry_date,
    jp.source_module,
    jp.reference_id,
    jp.reference_number,
    jp.description,
    jp.payment_provenance_key,
    jp.is_verified_fifo_adj_posting
),
classified_jes AS (
  SELECT
    js.*,
    CASE
      WHEN js.is_verified_fifo_adj_posting THEN LEAST(js.dir_line_sig, js.inv_line_sig)
      ELSE js.dir_line_sig
    END AS match_sig,
    CASE
      WHEN js.is_verified_fifo_adj_posting AND js.dir_line_sig > js.inv_line_sig THEN -1
      ELSE 1
    END AS effect_sign
  FROM je_signatures AS js
  WHERE js.journal_line_count > 0
),
duplicate_groups AS (
  SELECT
    source_module,
    reference_id,
    is_verified_fifo_adj_posting,
    match_sig,
    payment_provenance_key,
    ABS(SUM(effect_sign))::bigint AS duplicate_count
  FROM classified_jes
  GROUP BY
    source_module,
    reference_id,
    is_verified_fifo_adj_posting,
    match_sig,
    payment_provenance_key
  HAVING ABS(SUM(effect_sign)) > 1
)
SELECT
  cj.journal_entry_id,
  cj.entry_number,
  cj.entry_date,
  cj.source_module,
  cj.reference_id,
  cj.reference_number,
  cj.description,
  dg.duplicate_count
FROM classified_jes AS cj
JOIN duplicate_groups AS dg
  ON dg.source_module IS NOT DISTINCT FROM cj.source_module
 AND dg.reference_id = cj.reference_id
 AND dg.is_verified_fifo_adj_posting = cj.is_verified_fifo_adj_posting
 AND dg.match_sig = cj.match_sig
 AND dg.payment_provenance_key = cj.payment_provenance_key;

GRANT SELECT ON public.duplicate_postings TO authenticated, service_role;
