// Interactive Bank Reconciliation Matching Utility
// Handles candidate discovery, ranking, normalization, and validation
// for user-controlled Bank Reconciliation matching.

import { calculateCanonicalCashPayable } from '../../utils/taxCalculations.ts';

export interface CandidateExpense {
  expense: any;
  id: string;
  voucherNumber: string;
  expenseDate: string;
  description: string;
  category: string;
  supplierPayee: string;
  amount: number;
  outstandingAmount: number;
  approvalStatus: 'approved' | 'pending_approval' | 'rejected' | 'cancelled' | string;
  matchReason: string;
  rank: number;
}

export interface BankStatementLineLike {
  id: string;
  date: string;
  description?: string | null;
  reference?: string | null;
  debit?: number | null;
  credit?: number | null;
  amount?: number | null;
  currency?: string | null;
  bank_account_id?: string | null;
  manually_unlinked?: boolean | null;
  reconciliation_status?: string | null;
  matching_status?: string | null;
  remainingAmount?: number;
}

/**
 * Calculates remaining payable balance for an expense.
 */
export function getExpenseOutstandingAmount(
  expense: any,
  paymentKind: 'supplier' | 'pph23' = 'supplier'
): number {
  if (paymentKind === 'pph23') {
    return Math.max(0, Number(expense.pph_amount || 0) - Number(expense.pph_paid_amount || 0));
  }
  const payable = calculateCanonicalCashPayable(expense);
  return Math.max(0, payable - Number(expense.paid_amount || 0));
}

/**
 * Normalizes payment_kind to ensure operational expenses default to 'supplier'
 * while genuine PPh23 allocations remain distinct, and other document types
 * (fund transfers, receipts, etc.) preserve their document-specific kinds.
 */
export function normalizePaymentKind(
  documentTypeOrKind?: string | null,
  paymentKind?: string | null
): string {
  let docType = 'expense';
  let kind = paymentKind;

  if (paymentKind === undefined) {
    // Single argument passed: could be paymentKind for an expense, or documentType
    if (
      documentTypeOrKind === 'fund_transfer' ||
      documentTypeOrKind === 'receipt' ||
      documentTypeOrKind === 'tax_payment' ||
      documentTypeOrKind === 'petty_cash'
    ) {
      docType = documentTypeOrKind;
      kind = undefined;
    } else {
      docType = 'expense';
      kind = documentTypeOrKind;
    }
  } else {
    docType = documentTypeOrKind || 'expense';
    kind = paymentKind;
  }

  if (docType === 'expense') {
    if (kind === 'pph23') {
      return 'pph23';
    }
    return 'supplier';
  }

  if (kind && kind.trim() !== '') {
    return kind;
  }

  switch (docType) {
    case 'fund_transfer':
      return 'fund_transfer';
    case 'receipt':
      return 'customer_receipt';
    case 'payment':
      return 'supplier';
    case 'tax_payment':
      return 'tax';
    case 'petty_cash':
      return 'petty_cash';
    case 'journal':
      return 'journal';
    default:
      return 'supplier';
  }
}

/**
 * Filters statement lines strictly to the selected bank account and date range.
 * Preserves manually unlinked protection.
 */
export function filterLinesByScope<T extends BankStatementLineLike>(
  lines: T[],
  bankAccountId: string,
  dateFrom: string,
  dateTo: string
): T[] {
  if (!bankAccountId || !dateFrom || !dateTo) return [];
  return lines.filter((line) => {
    if (line.manually_unlinked) return false;
    if (line.bank_account_id && line.bank_account_id !== bankAccountId) return false;
    if (line.date < dateFrom || line.date > dateTo) return false;
    return true;
  });
}

/**
 * Discovers and ranks candidate expenses for a given bank statement line.
 */
export function findExpenseCandidatesForBankLine(
  line: BankStatementLineLike,
  expenseList: any[],
  bankAccountId?: string
): CandidateExpense[] {
  const lineAmount = Number(line.debit || line.amount || 0);
  if (lineAmount <= 0.01) return [];

  // Outgoing money from bank statement represents expense payments
  if ((line.debit ?? 0) <= 0 && (line.credit ?? 0) > 0) {
    return [];
  }

  const lineDate = new Date(line.date).getTime();
  const lineText = `${line.description || ''} ${line.reference || ''}`.toLowerCase();
  const bankAcc = bankAccountId || line.bank_account_id;

  const candidates: CandidateExpense[] = [];

  for (const exp of expenseList) {
    // 1. Approval status: must be approved or pending_approval (never rejected or cancelled)
    if (exp.approval_status !== 'approved' && exp.approval_status !== 'pending_approval') {
      continue;
    }

    // 2. Bank account compatibility (if expense has a designated bank account)
    if (exp.bank_account_id && bankAcc && exp.bank_account_id !== bankAcc) {
      continue;
    }

    // 3. Date window: maximum 7 days tolerance (abs <= 7 days)
    const expDate = new Date(exp.expense_date).getTime();
    const daysDiff = Math.round(Math.abs(lineDate - expDate) / 86400000);
    if (daysDiff > 7) {
      continue;
    }

    // 4. Outstanding amount: must have remaining balance to pay
    const outstanding = getExpenseOutstandingAmount(exp, 'supplier');
    if (outstanding <= 0.01) {
      continue;
    }

    // 5. Amount check: exact or near-exact (within Rp 1) OR partial payment where lineAmount <= outstanding
    const amountDiff = Math.abs(outstanding - lineAmount);
    const isExactAmount = amountDiff <= 0.01;
    const isNearAmount = amountDiff <= 1.0;
    const isPartial = lineAmount <= outstanding + 0.01;

    if (!isNearAmount && !isPartial) {
      continue;
    }

    // 6. Match Reason and Ranking
    const voucher = (exp.voucher_number || '').trim();
    const cleanVoucher = voucher.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanLineText = lineText.replace(/[^a-z0-9]/g, '');
    const hasVoucherMatch = cleanVoucher.length >= 5 && cleanLineText.includes(cleanVoucher);

    const supplierName = (exp.suppliers?.company_name || '').trim();
    const staffName = (exp.finance_staff_master?.full_name || exp.staff_name || '').trim();

    const matchesEntityName = (name: string) => {
      const lower = name.toLowerCase().trim();
      if (!lower) return false;
      if (lower.length >= 3 && lineText.includes(lower)) return true;
      const tokens = lower.split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !['pt', 'cv', 'tbk', 'ltd', 'inc', 'co'].includes(t));
      return tokens.length > 0 && tokens.some(t => lineText.includes(t));
    };

    const hasSupplierMatch = matchesEntityName(supplierName);
    const hasStaffMatch = matchesEntityName(staffName);

    const isExactDate = daysDiff === 0;

    let reason = '';
    let rank = 5;

    if (hasVoucherMatch) {
      reason = `Voucher reference (${voucher}) match in statement`;
      rank = 1;
    } else if (hasSupplierMatch) {
      reason = `Payee match: ${supplierName}`;
      rank = 2;
    } else if (hasStaffMatch) {
      reason = `Staff match: ${staffName}`;
      rank = 2;
    } else if (isExactAmount && isExactDate) {
      reason = 'Exact amount and transaction date match';
      rank = 3;
    } else if (isExactAmount) {
      reason = `Exact amount match (${daysDiff} day${daysDiff === 1 ? '' : 's'} date difference)`;
      rank = 4;
    } else {
      reason = `Amount within tolerance (Outstanding: Rp ${outstanding.toLocaleString('id-ID')}, diff: Rp ${amountDiff.toLocaleString('id-ID')})`;
      rank = 5;
    }

    candidates.push({
      expense: exp,
      id: exp.id,
      voucherNumber: exp.voucher_number || 'Expense',
      expenseDate: exp.expense_date,
      description: exp.description || '',
      category: exp.expense_category || 'general',
      supplierPayee: supplierName || staffName || 'General / Operational',
      amount: Number(exp.amount || 0),
      outstandingAmount: outstanding,
      approvalStatus: exp.approval_status,
      matchReason: reason,
      rank,
    });
  }

  // Sort candidates: lowest rank number first (best quality), then lowest date diff, then lowest amount diff
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aDateDiff = Math.abs(new Date(a.expenseDate).getTime() - lineDate);
    const bDateDiff = Math.abs(new Date(b.expenseDate).getTime() - lineDate);
    if (aDateDiff !== bDateDiff) return aDateDiff - bDateDiff;
    const aAmtDiff = Math.abs(a.outstandingAmount - lineAmount);
    const bAmtDiff = Math.abs(b.outstandingAmount - lineAmount);
    return aAmtDiff - bAmtDiff;
  });

  return candidates;
}

/**
 * Determines whether candidate set requires user decision in interactive popup.
 */
export function isCandidateAmbiguous(candidates: CandidateExpense[]): boolean {
  return candidates.length >= 2;
}

/**
 * Validates match prerequisites before allocating.
 */
export function validateMatchPrerequisites(
  line: BankStatementLineLike,
  expense: any,
  requestedAmount?: number
): { valid: boolean; error?: string; allocAmount: number } {
  const lineTotal = Number(line.debit || line.amount || 0);
  if (lineTotal <= 0.01) {
    return { valid: false, error: 'Bank statement line has no debit amount to allocate', allocAmount: 0 };
  }

  const outstanding = getExpenseOutstandingAmount(expense, 'supplier');
  if (outstanding <= 0.01) {
    return { valid: false, error: 'Expense is already fully settled', allocAmount: 0 };
  }

  const allocAmount = Math.min(
    line.remainingAmount !== undefined && line.remainingAmount > 0 ? line.remainingAmount : lineTotal,
    requestedAmount && requestedAmount > 0 ? requestedAmount : outstanding
  );

  if (allocAmount <= 0.01) {
    return { valid: false, error: 'Calculated allocation amount is zero', allocAmount: 0 };
  }

  if (allocAmount > outstanding + 0.01) {
    return { valid: false, error: 'Allocation exceeds expense outstanding balance', allocAmount: 0 };
  }

  return { valid: true, allocAmount };
}
