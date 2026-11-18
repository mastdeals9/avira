import { supabase } from '../lib/supabase';

export type FinanceCurrency = 'IDR' | 'USD';

export interface FinanceExpensePayload {
  expense_date: string;
  expense_category: string;
  amount: number;
  description?: string | null;
  document_urls?: string[];
  transaction_currency: FinanceCurrency;
  functional_currency?: 'IDR';
  exchange_rate: number;
  payment_method?: string | null;
  bank_account_id?: string | null;
  payment_reference?: string | null;
  approval_status?: string;
  created_by?: string;
  [key: string]: unknown;
}

export type PartyType = 'customer' | 'supplier' | 'employee' | 'director' | 'other';

export interface ReceiptPayload {
  voucher_date: string;
  party_type?: PartyType;
  customer_id?: string | null;
  supplier_id?: string | null;
  staff_id?: string | null;
  payment_purpose?: string;
  settlement_against?: 'outstanding_balance' | 'specific_document' | 'advance' | 'unallocated_credit';
  settlement_discount?: number;
  adjustment_reason?: string | null;
  adjustment_account_id?: string | null;
  adjustment_notes?: string | null;
  payment_method: string;
  bank_account_id?: string | null;
  reference_number?: string | null;
  amount: number;
  description?: string | null;
  currency_code?: FinanceCurrency;
  transaction_currency: FinanceCurrency;
  exchange_rate: number;
  created_by?: string;
}

export interface ReceiptAllocation {
  sales_invoice_id?: string | null;
  sales_order_id?: string | null;
  amount: number;
  settlement_discount?: number;
  adjustment_reason?: string | null;
  notes?: string | null;
}

export interface PaymentPayload {
  voucher_date: string;
  party_type?: PartyType;
  supplier_id?: string | null;
  customer_id?: string | null;
  staff_id?: string | null;
  payment_method: string;
  payment_purpose?: string;
  settlement_against?: 'outstanding_balance' | 'specific_document' | 'advance' | 'unallocated_credit';
  settlement_discount?: number;
  adjustment_reason?: string | null;
  adjustment_account_id?: string | null;
  adjustment_notes?: string | null;
  bank_account_id?: string | null;
  reference_number?: string | null;
  amount: number;
  invoice_currency?: FinanceCurrency;
  invoice_amount?: number;
  payment_amount?: number;
  bank_currency?: FinanceCurrency;
  converted_amount?: number;
  actual_bank_debit?: number;
  pph_amount?: number;
  pph_code_id?: string | null;
  description?: string | null;
  document_urls?: string[];
  payment_currency: FinanceCurrency;
  exchange_rate: number;
  bank_amount?: number | null;
  bank_charge?: number;
  created_by?: string;
}

export interface PartyBalanceSummary {
  party_type: string;
  party_id: string;
  total_receivable: number;
  total_payable: number;
  unallocated_credits: number;
  unallocated_advances: number;
  gl_balance: number;
  net_balance: number;
  balance_direction: 'debit' | 'credit' | 'zero';
  outstanding_amount: number;
  open_documents: Array<{
    id: string;
    document_type: string;
    document_number: string;
    document_date: string;
    total_amount: number;
    balance_amount: number;
  }>;
}

export const getPartyBalanceSummary = (
  partyType: PartyType,
  partyId: string,
  asOfDate?: string
) => rpc<PartyBalanceSummary>('get_party_balance_summary', {
  p_party_type: partyType,
  p_party_id: partyId,
  p_as_of_date: asOfDate || new Date().toISOString().split('T')[0],
});

export interface JournalLineCommand {
  account_id: string;
  description?: string | null;
  debit: number;
  credit: number;
}

export interface FinanceLoanPayload {
  loan_date: string;
  counterparty_name: string;
  counterparty_type: 'bank' | 'person' | 'staff' | 'company';
  principal_amount: number;
  bank_account_id: string;
  loan_type?: 'taken' | 'given';
  coa_id?: string;
  liability_kind?: 'bank' | 'director_owner';
  liability_account_id?: string;
  transaction_currency: FinanceCurrency;
  exchange_rate: number;
  description?: string | null;
  created_by?: string;
}

export interface FinanceLoanRepaymentPayload {
  loan_id: string;
  transaction_date: string;
  principal_amount: number;
  interest_amount: number;
  bank_account_id: string;
  transaction_currency: FinanceCurrency;
  exchange_rate: number;
  description?: string | null;
  created_by?: string;
}

export interface CapitalContributionPayload {
  voucher_date: string;
  bank_account_id: string;
  amount: number;
  transaction_currency: FinanceCurrency;
  exchange_rate: number;
  description?: string | null;
  created_by?: string;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

import { validateExpenseMandatoryTaxLinkage } from '../utils/expenseValidation';

/** Shared existing USD→IDR resolver used when a normal USD document does not
 * carry a transaction-specific conversion rate. Fund Transfers continue to
 * supply their own business rate. */
export const getReportingUsdRate = async (): Promise<number> => {
  const rate = await rpc<number>('get_reporting_usd_rate', {});
  if (!Number.isFinite(rate) || rate <= 1) throw new Error('Unable to resolve a valid USD-to-IDR rate');
  return rate;
};

export const saveFinanceExpense = (expenseId: string | null, payload: FinanceExpensePayload) => {
  const validation = validateExpenseMandatoryTaxLinkage(payload as any);
  if (!validation.isValid) {
    throw new Error(validation.firstErrorMessage || 'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.');
  }
  return rpc<string>('save_finance_expense', { p_expense_id: expenseId, p_payload: payload });
};

export const editApprovedFinanceExpense = (
  expenseId: string,
  payload: FinanceExpensePayload,
  bankStatementLineId?: string | null,
  allocationAmount?: number,
) => {
  const effectivePayload = {
    ...payload,
    selected_bank_transaction_id: bankStatementLineId || (payload as any).selected_bank_transaction_id || (payload as any).originating_bank_statement_line_id,
    originating_bank_statement_line_id: bankStatementLineId || (payload as any).originating_bank_statement_line_id,
    payment_method: payload.payment_method && payload.payment_method !== 'outstanding'
      ? payload.payment_method
      : (bankStatementLineId ? 'bank_transfer' : payload.payment_method),
    paid_amount: allocationAmount && allocationAmount > 0.01 ? allocationAmount : payload.paid_amount,
  };
  const validation = validateExpenseMandatoryTaxLinkage(effectivePayload as any);
  if (!validation.isValid) {
    throw new Error(validation.firstErrorMessage || 'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.');
  }
  return rpc<string>('edit_approved_finance_expense_atomic', {
    p_expense_id: expenseId,
    p_payload: effectivePayload,
    p_bank_statement_line_id: bankStatementLineId || null,
    p_allocation_amount: allocationAmount && allocationAmount > 0.01 ? allocationAmount : null,
  });
};

export const approveFinanceExpense = (expenseId: string, approvedBy?: string | null) =>
  rpc<string>('approve_finance_expense', { p_expense_id: expenseId, p_approved_by: approvedBy || null });

export const saveReceiptVoucher = (
  receiptId: string | null,
  payload: ReceiptPayload,
  allocations: ReceiptAllocation[],
) => rpc<string>('save_receipt_voucher_with_allocations', {
  p_receipt_id: receiptId,
  p_payload: payload,
  p_allocations: allocations,
});

export const savePaymentVoucher = (
  voucherId: string | null,
  payload: PaymentPayload,
  allocations: Record<string, unknown>[],
) => rpc<{ id: string; voucher_number: string }>('save_payment_voucher_with_purpose', {
  p_voucher_id: voucherId,
  p_payload: payload,
  p_allocations: allocations,
  p_payment_purpose: payload.payment_purpose || 'general',
});

export interface SettlementAdjustmentCommand {
  documentType: 'purchase' | 'sales' | 'sales_order';
  invoiceId: string;
  voucherId?: string | null;
  amount?: number | null;
  adjustmentType: 'rounding' | 'discount' | 'write_off';
  reason: string;
}

export const applySettlementAdjustment = (cmd: SettlementAdjustmentCommand) =>
  rpc<void>('save_invoice_settlement_adjustment', {
    p_document_type: cmd.documentType,
    p_invoice_id: cmd.invoiceId,
    p_voucher_id: cmd.voucherId || null,
    p_adjustment_amount: cmd.amount ?? null,
    p_adjustment_type: cmd.adjustmentType,
    p_reason: cmd.reason,
  });


export const saveFinanceJournal = (
  entryId: string | null,
  entryDate: string,
  description: string | null,
  lines: JournalLineCommand[],
  transactionCurrency: FinanceCurrency,
  exchangeRate: number,
) => rpc<string>('save_finance_journal', {
  p_entry_id: entryId,
  p_entry_date: entryDate,
  p_description: description,
  p_lines: lines,
  p_transaction_currency: transactionCurrency,
  p_exchange_rate: exchangeRate,
});

export const saveFinanceLoan = (payload: FinanceLoanPayload, bankStatementLineId?: string | null) =>
  rpc<{ id: string; loan_number: string; journal_entry_id: string }>('save_finance_loan', {
    p_payload: payload,
    p_bank_statement_line_id: bankStatementLineId || null,
  });

export const saveFinanceLoanRepayment = (
  payload: FinanceLoanRepaymentPayload,
  bankStatementLineId?: string | null,
) => rpc<{ id: string; transaction_number: string; journal_entry_id: string }>('save_finance_loan_repayment', {
  p_payload: payload,
  p_bank_statement_line_id: bankStatementLineId || null,
});

export const saveCapitalContribution = (
  payload: CapitalContributionPayload,
  bankStatementLineId?: string | null,
) => rpc<{ id: string; voucher_number: string; journal_entry_id: string }>('save_finance_capital_contribution', {
  p_payload: payload,
  p_bank_statement_line_id: bankStatementLineId || null,
});

export interface DirectorBalanceSummary {
  director_name: string;
  due_to_director: number;
  due_from_director: number;
  net_position: number;
  net_status: 'payable' | 'receivable' | 'settled';
  active_loans: Array<{
    id: string;
    loan_number: string;
    loan_type: string;
    principal_amount: number;
    outstanding_balance: number;
    currency: string;
    loan_date: string;
    status: string;
  }>;
  last_transaction_date: string | null;
}

export const getDirectorRelatedPartyBalanceSummary = (directorName: string = 'Vijay Lunkad') =>
  rpc<DirectorBalanceSummary>('get_director_related_party_balance_summary', {
    p_director_name: directorName,
  });

export interface RecordDirectorTransactionResult {
  success: boolean;
  bank_line_id: string;
  direction: 'received_from_director' | 'paid_to_director';
  action: 'settle_due_from' | 'increase_due_to' | 'settle_due_to' | 'increase_due_from';
  account_code: string;
  account_name: string;
  amount: number;
  director_name: string;
  loan_id: string;
  loan_number: string;
  loan_transaction_id: string;
  journal_entry_id: string;
  entry_number: string;
  bank_statement_allocation_id: string;
  previous_balances: {
    due_to_director: number;
    due_from_director: number;
    net_position: number;
    net_status: string;
  };
  new_balances: {
    due_to_director: number;
    due_from_director: number;
    net_position: number;
    net_status: string;
  };
}

export const recordDirectorRelatedPartyBankTransaction = (
  bankStatementLineId: string,
  directorName: string = 'Vijay Lunkad',
  notes?: string | null,
) =>
  rpc<RecordDirectorTransactionResult>('record_director_related_party_bank_transaction', {
    p_bank_line_id: bankStatementLineId,
    p_director_name: directorName,
    p_notes: notes || null,
  });

export const saveBankLinkedFinanceJournal = (
  bankStatementLineId: string,
  description: string,
  counterAccountCode: string,
  bankSide: 'debit' | 'credit',
  transactionCurrency: FinanceCurrency,
  exchangeRate: number,
) => rpc<{ document_id: string; journal_entry_id: string }>('save_bank_linked_finance_journal', {
  p_bank_line_id: bankStatementLineId,
  p_description: description,
  p_counter_account_code: counterAccountCode,
  p_bank_side: bankSide,
  p_transaction_currency: transactionCurrency,
  p_exchange_rate: exchangeRate,
});

export const linkBankStatementLine = (
  bankLineId: string,
  documentType: 'expense' | 'receipt' | 'payment' | 'fund_transfer' | 'petty_cash' | 'tax_payment' | 'journal',
  documentId: string,
  paymentKind: 'supplier' | 'pph23' = 'supplier',
  allocationAmount?: number,
) => {
  const payload = {
    p_bank_line_id: bankLineId,
    p_document_type: documentType,
    p_document_id: documentId,
    p_payment_kind: paymentKind,
    ...(allocationAmount === undefined ? {} : { p_allocation_amount: allocationAmount }),
  };
  return rpc<{
  allocation_amount: number;
  bank_total: number;
  bank_allocated: number;
  bank_remaining: number;
  document_total: number;
  document_allocated: number;
  document_remaining: number;
  }>('link_bank_statement_line', payload);
};

export const unlinkBankStatementAllocation = (allocationId: string) =>
  rpc<{ success: boolean; bank_line_id: string; allocation_id: string }>('unmatch_bank_statement_allocation', {
    p_allocation_id: allocationId,
  });

export const unlinkBankStatementLine = (bankLineId: string) =>
  rpc<{ success: boolean; bank_line_id: string }>('unmatch_bank_line', {
    p_bank_line_id: bankLineId,
  });

export const unlinkFinanceExpenseBankLink = (expenseId: string, reason?: string) =>
  rpc<{ success: boolean; expense_id: string; released_allocations: number }>(
    'unlink_finance_expense_bank_atomic',
    {
      p_expense_id: expenseId,
      p_reason: reason || 'Bank statement link removed by user',
    },
  );

export const recordExpenseCashPayment = (
  expenseId: string,
  paymentDate: string,
  paymentAmount: number,
  notes?: string | null,
  paymentEventId?: string | null,
) =>
  rpc<string>('record_expense_cash_payment', {
    p_expense_id: expenseId,
    p_payment_date: paymentDate,
    p_payment_amount: paymentAmount,
    p_notes: notes || null,
    p_payment_event_id: paymentEventId || null,
  });

