-- Align payment_vouchers.payment_purpose CHECK with the payment purposes
-- already supported by PaymentVoucherManager and save_payment_voucher_with_purpose.
-- This changes validation only; existing voucher rows are not modified.

BEGIN;

ALTER TABLE public.payment_vouchers
  DROP CONSTRAINT IF EXISTS payment_vouchers_payment_purpose_check;

ALTER TABLE public.payment_vouchers
  ADD CONSTRAINT payment_vouchers_payment_purpose_check
  CHECK (
    payment_purpose = ANY (
      ARRAY[
        'general',
        'salary_advance',
        'salary_advance_settlement',
        'supplier_invoice_payment',
        'supplier_advance',
        'supplier_overpayment_settlement',
        'supplier_other_payment',
        'customer_refund',
        'customer_excess_payment_refund',
        'customer_advance_refund',
        'customer_other_payment',
        'salary_payroll',
        'employee_reimbursement',
        'employee_advance',
        'other_employee_payment',
        'director_loan_repayment',
        'director_withdrawal',
        'other_related_party_payment',
        'other_payment'
      ]::text[]
    )
  );

COMMENT ON CONSTRAINT payment_vouchers_payment_purpose_check
ON public.payment_vouchers IS
'Permits the complete payment-purpose vocabulary supported by PaymentVoucherManager and save_payment_voucher_with_purpose.';

COMMIT;
