/**
 * Mandatory Supplier & Payment Validation for Tax Expenses
 *
 * Statutory Rule:
 * Any expense containing PPN or PPh greater than zero (excluding statutory PIB import)
 * must have a valid Supplier, Payee, or Staff member selected from master records.
 * Manually typed names in descriptions or notes are strictly rejected.
 *
 * Payment Details:
 * If an expense is being recorded as paid (or has a payment recorded), a valid payment
 * method and payment account / voucher link is mandatory.
 * Unpaid / outstanding expenses may be saved as long as a valid supplier/payee is linked.
 */

export interface ExpenseValidationInput {
  expense_category?: string | null;
  amount?: number | null;
  ppn_amount?: number | null;
  pph_amount?: number | null;
  supplier_id?: string | null;
  payee_id?: string | null;
  staff_id?: string | null;
  payment_method?: string | null;
  bank_account_id?: string | null;
  originating_bank_statement_line_id?: string | null;
  selected_bank_transaction_id?: string | null;
  bank_statement_allocations?: Array<any> | null;
  paid_amount?: number | null;
}

export interface ExpenseValidationResult {
  isValid: boolean;
  errors: Record<string, string>;
  firstErrorField?: 'party' | 'payment_method' | 'bank_account_id';
  firstErrorMessage?: string;
}

export function validateExpenseMandatoryTaxLinkage(
  expense: ExpenseValidationInput,
): ExpenseValidationResult {
  const errors: Record<string, string> = {};

  const ppn = Number(expense.ppn_amount || 0);
  const pph = Number(expense.pph_amount || 0);
  const isPib = expense.expense_category === 'pib_import';
  const hasTax = (ppn > 0 || pph > 0) && !isPib;

  if (hasTax) {
    // 1. Mandatory Party Selection (Supplier / Payee / Staff)
    const hasParty = !!(
      (expense.supplier_id && expense.supplier_id.trim() !== '') ||
      (expense.payee_id && expense.payee_id.trim() !== '') ||
      (expense.staff_id && expense.staff_id.trim() !== '')
    );

    if (!hasParty) {
      errors.party =
        'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.';
    }

    // 2. Payment details if marked as paid
    // Check if an authoritative linked payment record already exists (e.g. bank statement allocation)
    const hasAuthoritativePaymentLink =
      !!(expense.originating_bank_statement_line_id && expense.originating_bank_statement_line_id.trim() !== '') ||
      !!(expense.selected_bank_transaction_id && expense.selected_bank_transaction_id.trim() !== '') ||
      (Array.isArray(expense.bank_statement_allocations) && expense.bank_statement_allocations.length > 0);

    const effectivePaymentMethod =
      expense.payment_method && expense.payment_method !== 'outstanding'
        ? expense.payment_method
        : (hasAuthoritativePaymentLink ? 'bank_transfer' : expense.payment_method);

    const isExplicitlyPaid =
      effectivePaymentMethod !== null &&
      effectivePaymentMethod !== undefined &&
      effectivePaymentMethod !== 'outstanding';
    const hasPaidAmount = Number(expense.paid_amount || 0) > 0.01;

    // If an authoritative linked payment record already provides payment evidence,
    // do not require duplicate payment_method / bank_account_id on the expense header.
    if ((isExplicitlyPaid || hasPaidAmount) && !hasAuthoritativePaymentLink) {
      if (!effectivePaymentMethod || effectivePaymentMethod === 'outstanding') {
        errors.payment_method =
          'Please select a valid payment method for this paid expense.';
      } else if (effectivePaymentMethod === 'bank_transfer') {
        const hasBankLink =
          !!(expense.bank_account_id && expense.bank_account_id.trim() !== '');

        if (!hasBankLink) {
          errors.bank_account_id =
            'Please select a valid payment account for this paid expense.';
        }
      }
    }
  } else {
    // For non-tax expenses, if marked as paid via bank transfer, bank_account_id is required
    const hasAuthoritativePaymentLink =
      !!(expense.originating_bank_statement_line_id && expense.originating_bank_statement_line_id.trim() !== '') ||
      !!(expense.selected_bank_transaction_id && expense.selected_bank_transaction_id.trim() !== '') ||
      (Array.isArray(expense.bank_statement_allocations) && expense.bank_statement_allocations.length > 0);

    const effectiveMethod = expense.payment_method || (hasAuthoritativePaymentLink ? 'bank_transfer' : null);
    if (effectiveMethod === 'bank_transfer') {
      const hasBankLink =
        !!(expense.bank_account_id && expense.bank_account_id.trim() !== '') ||
        hasAuthoritativePaymentLink;

      if (!hasBankLink) {
        errors.bank_account_id =
          'Please select a valid payment account for this paid expense.';
      }
    }
  }

  const errorKeys = Object.keys(errors);
  const isValid = errorKeys.length === 0;

  let firstErrorField: 'party' | 'payment_method' | 'bank_account_id' | undefined;
  if (errors.party) firstErrorField = 'party';
  else if (errors.payment_method) firstErrorField = 'payment_method';
  else if (errors.bank_account_id) firstErrorField = 'bank_account_id';

  return {
    isValid,
    errors,
    firstErrorField,
    firstErrorMessage: firstErrorField ? errors[firstErrorField] : undefined,
  };
}

