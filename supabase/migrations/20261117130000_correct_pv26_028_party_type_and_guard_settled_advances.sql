-- Migration: 20261117130000_correct_pv26_028_party_type_and_guard_settled_advances.sql
-- Description:
-- 1. Strictly asserts preconditions and idempotently corrects party_type for PV/26-26/028 to 'employee'.
-- 2. Implements a database-level protection trigger to prevent ordinary edits or generic RPC updates
--    from altering accounting fields or wiping settlement statuses on settled/applied salary advances.

-- ── 1. Invariant Assertions and Scoped Metadata Correction for PV/26-26/028 ─
DO $$
DECLARE
  v_voucher RECORD;
  v_app RECORD;
  v_settlement RECORD;
BEGIN
  -- Assert target voucher existence and core attributes
  SELECT *
  INTO v_voucher
  FROM public.payment_vouchers
  WHERE id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e'::uuid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assertion failed: Payment voucher ID 8a045a25-e2b4-4f7b-8a27-4312d86a547e not found.';
  END IF;

  IF v_voucher.voucher_number <> 'PV/26-26/028' THEN
    RAISE EXCEPTION 'Assertion failed: Voucher number mismatch (expected PV/26-26/028, found %).', v_voucher.voucher_number;
  END IF;

  IF v_voucher.payment_purpose <> 'salary_advance' THEN
    RAISE EXCEPTION 'Assertion failed: Payment purpose mismatch (expected salary_advance, found %).', v_voucher.payment_purpose;
  END IF;

  IF v_voucher.staff_id <> '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'::uuid THEN
    RAISE EXCEPTION 'Assertion failed: Staff ID mismatch (expected Sandi Prasetyo 276dc2e0-3cb2-426f-aee7-a9991e5f4cfc, found %).', v_voucher.staff_id;
  END IF;

  IF v_voucher.supplier_id IS NOT NULL THEN
    RAISE EXCEPTION 'Assertion failed: Supplier ID must be NULL on PV/26-26/028, found %.', v_voucher.supplier_id;
  END IF;

  -- Assert settlement application to EXP/26/365 exists
  SELECT saa.*, fe.voucher_number AS expense_number
  INTO v_app
  FROM public.salary_advance_applications saa
  JOIN public.finance_expenses fe ON fe.id = saa.salary_expense_id
  WHERE saa.advance_payment_voucher_id = v_voucher.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assertion failed: No salary_advance_applications record found for PV/26-26/028.';
  END IF;

  IF v_app.expense_number <> 'EXP/26/365' THEN
    RAISE EXCEPTION 'Assertion failed: Advance applied to unexpected expense % (expected EXP/26/365).', v_app.expense_number;
  END IF;

  -- Assert settlement voucher PV/26-26/032 exists and is posted
  SELECT *
  INTO v_settlement
  FROM public.payment_vouchers
  WHERE voucher_number = 'PV/26-26/032';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assertion failed: Settlement voucher PV/26-26/032 not found.';
  END IF;

  IF v_settlement.is_posted IS NOT TRUE THEN
    RAISE EXCEPTION 'Assertion failed: Settlement voucher PV/26-26/032 must be posted (found is_posted=%).', v_settlement.is_posted;
  END IF;

  -- Apply narrow metadata correction: party_type -> 'employee'
  -- Preserves amount, payment_method, bank_account_id, salary_advance_status,
  -- salary_advance_applied_amount, is_posted, journal_entry_id, and settlement applications.
  IF v_voucher.party_type = 'supplier' THEN
    UPDATE public.payment_vouchers
    SET party_type = 'employee',
        updated_at = NOW()
    WHERE id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e'::uuid
      AND party_type = 'supplier';
    RAISE NOTICE 'PV/26-26/028 party_type successfully corrected from supplier to employee.';
  ELSIF v_voucher.party_type = 'employee' THEN
    RAISE NOTICE 'PV/26-26/028 party_type is already employee (idempotent).';
  ELSE
    RAISE EXCEPTION 'Assertion failed: Unexpected party_type % for PV/26-26/028.', v_voucher.party_type;
  END IF;
END $$;


-- ── 2. Trigger Guard: Prevent Accounting Modifications on Settled Advances ─
CREATE OR REPLACE FUNCTION public.guard_settled_salary_advance_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only guard vouchers with salary_advance purpose that have active payroll applications or settled status
  IF OLD.payment_purpose = 'salary_advance' AND (
    OLD.salary_advance_status IN ('settled', 'partially_settled')
    OR COALESCE(OLD.salary_advance_applied_amount, 0) > 0
    OR EXISTS (
      SELECT 1 FROM public.salary_advance_applications saa
      WHERE saa.advance_payment_voucher_id = OLD.id
    )
  ) THEN
    -- Lock accounting fields from being changed via ordinary updates
    IF NEW.amount IS DISTINCT FROM OLD.amount OR
       NEW.staff_id IS DISTINCT FROM OLD.staff_id OR
       NEW.payment_method IS DISTINCT FROM OLD.payment_method OR
       NEW.payment_purpose IS DISTINCT FROM OLD.payment_purpose OR
       NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id OR
       NEW.voucher_date IS DISTINCT FROM OLD.voucher_date OR
       NEW.pph_amount IS DISTINCT FROM OLD.pph_amount OR
       NEW.pph_code_id IS DISTINCT FROM OLD.pph_code_id OR
       NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate OR
       NEW.payment_currency IS DISTINCT FROM OLD.payment_currency
    THEN
      RAISE EXCEPTION 'Cannot edit accounting fields on salary advance %: advance is already applied to payroll (status: %, applied: Rp %). Reverse or unapply the payroll settlement first.',
        OLD.voucher_number, OLD.salary_advance_status, OLD.salary_advance_applied_amount;
    END IF;

    -- Prevent accidental reset of salary_advance_status while applications exist
    IF (OLD.salary_advance_status IN ('settled', 'partially_settled') AND NEW.salary_advance_status = 'outstanding')
       AND EXISTS (SELECT 1 FROM public.salary_advance_applications saa WHERE saa.advance_payment_voucher_id = OLD.id)
    THEN
      RAISE EXCEPTION 'Cannot reset salary advance % status to outstanding while active payroll applications exist.', OLD.voucher_number;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_settled_salary_advance_edit ON public.payment_vouchers;
CREATE TRIGGER trg_guard_settled_salary_advance_edit
  BEFORE UPDATE ON public.payment_vouchers
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_settled_salary_advance_edit();
