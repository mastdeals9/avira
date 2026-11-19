CREATE OR REPLACE FUNCTION public.validate_expense_category_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_category public.expense_categories%ROWTYPE;
  v_row jsonb := to_jsonb(NEW);
  v_old_row jsonb;
BEGIN
  IF TG_TABLE_NAME = 'petty_cash_transactions' AND (
    NULLIF(v_row ->> 'payment_voucher_id', '') IS NOT NULL
    OR (v_row ->> 'transaction_type') = 'withdraw'
    OR (
      NULLIF(btrim(COALESCE(v_row ->> 'expense_category', '')), '') IS NULL
      AND COALESCE(v_row ->> 'description', '') ILIKE '%advance%'
    )
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_row := to_jsonb(OLD);
    IF v_old_row ->> 'expense_category' = 'utilities'
       AND v_row ->> 'expense_category' = 'utilities' THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NULLIF(btrim(COALESCE(v_row ->> 'expense_category', '')), '') IS NULL THEN
    RAISE EXCEPTION 'Expense category is required.' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_category
    FROM public.expense_categories
   WHERE category_key = v_row ->> 'expense_category';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense category "%" does not exist in Expense Category Master.',
      v_row ->> 'expense_category' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
