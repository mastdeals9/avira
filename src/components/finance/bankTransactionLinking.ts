import { supabase } from '../../lib/supabase';
import { linkBankStatementLine, unlinkBankStatementLine } from '../../services/financeCommands';
import { fetchInBatches } from '../../utils/batchQuery';

export const FINANCE_RECONCILIATION_REFRESH_EVENT = 'finance:reconciliation-refresh';

export interface BankTransactionLine {
  id: string;
  transaction_date: string;
  description: string | null;
  reference?: string | null;
  debit_amount: number;
  credit_amount: number;
  bank_account_id: string;
  matched_expense_id?: string | null;
  matched_entry_id?: string | null;
  matched_receipt_id?: string | null;
  matched_payment_id?: string | null;
  matched_petty_cash_id?: string | null;
  matched_fund_transfer_id?: string | null;
  matched_tax_payment_id?: string | null;
  reconciliation_status?: string | null;
  matching_status?: string | null;
  manually_unlinked?: boolean | null;
  isLinked?: boolean;
  allocatedAmount?: number;
  allocationCount?: number;
  remainingAmount?: number;
  allocation_amount?: number | null;
  allocation_id?: string | null;
  bank_accounts?: {
    bank_name: string;
    account_name?: string | null;
    account_number?: string | null;
    alias?: string | null;
    currency?: string | null;
  } | null;
}

interface LoadUnmatchedDebitOptions {
  bankAccountId: string;
  direction?: 'debit' | 'credit' | 'both';
  currentExpenseId?: string | null;
  currentJournalEntryId?: string | null;
  currentPettyCashId?: string | null;
  includeLinked?: boolean;
}

interface LinkBankTransactionOptions {
  bankStatementLineId: string;
  matchedExpenseId?: string | null;
  matchedPaymentId?: string | null;
  matchedJournalEntryId?: string | null;
  note?: string | null;
  paymentKind?: 'supplier' | 'pph23';
  allocationAmount?: number;
}

/** Same decimal tolerance used by Finance cash/tax outstanding checks. */
export const BANK_ALLOCATION_EPSILON = 0.01;

export type CanonicalBankReconStatus = 'matched' | 'partially_reconciled' | 'unmatched';

export function bankStatementLineAmount(debit?: number | null, credit?: number | null): number {
  const debitAmount = Number(debit || 0);
  const creditAmount = Number(credit || 0);
  return debitAmount > 0 ? debitAmount : creditAmount;
}

/**
 * Linked / partial / unlinked from bank_statement_allocations or direct confirmed recorded entry.
 * Legacy matched_* FKs, reconciliation_status, and manually_unlinked are ignored.
 */
export function canonicalBankReconciliationStatus(
  bankAmount: number,
  allocatedAmount: number,
  epsilon: number = BANK_ALLOCATION_EPSILON,
  isDirectRecorded: boolean = false,
): CanonicalBankReconStatus {
  if (isDirectRecorded) return 'matched';
  const bank = Number(bankAmount) || 0;
  const allocated = Number(allocatedAmount) || 0;
  if (allocated <= epsilon) return 'unmatched';
  if (allocated >= bank - epsilon) return 'matched';
  return 'partially_reconciled';
}

export function isAvailableTransaction(line: BankTransactionLine) {
  if (line.manually_unlinked) {
    return false;
  }
  if (line.reconciliation_status === 'matched') {
    return false;
  }
  const bankAmount = bankStatementLineAmount(line.debit_amount, line.credit_amount);
  const allocatedAmount = Number(line.allocatedAmount || 0);
  const remainingAmount = line.remainingAmount ?? Math.max(0, bankAmount - allocatedAmount);

  // Direct recorded entry with no allocations is fully reconciled
  if (
    line.reconciliation_status === 'recorded' &&
    allocatedAmount <= BANK_ALLOCATION_EPSILON
  ) {
    return false;
  }

  // Authoritative check: if remaining amount > epsilon and not fully matched, line is available for allocation
  return (
    (line.reconciliation_status === 'partially_reconciled' ||
      canonicalBankReconciliationStatus(bankAmount, allocatedAmount) !== 'matched') &&
    Number(remainingAmount) > BANK_ALLOCATION_EPSILON
  );
}

export async function loadUnmatchedDebitBankTransactions({
  bankAccountId,
  direction = 'debit',
  currentExpenseId,
  currentJournalEntryId,
  currentPettyCashId,
  includeLinked = false,
}: LoadUnmatchedDebitOptions): Promise<BankTransactionLine[]> {
  let query = supabase
    .from('bank_statement_lines')
    .select(`
      id,
      transaction_date,
      description,
      reference,
      debit_amount,
      credit_amount,
      bank_account_id,
      matched_expense_id,
      matched_entry_id,
      matched_receipt_id,
      matched_payment_id,
      matched_petty_cash_id,
      matched_fund_transfer_id,
      matched_tax_payment_id,
      reconciliation_status,
      matching_status,
      manually_unlinked,
      bank_accounts(bank_name, account_name, account_number, alias, currency)
    `)
    .eq('bank_account_id', bankAccountId);
  if (direction === 'debit') query = query.gt('debit_amount', 0);
  else if (direction === 'credit') query = query.gt('credit_amount', 0);
  else query = query.or('debit_amount.gt.0,credit_amount.gt.0');
  const { data, error } = await query.order('transaction_date', { ascending: false });

  if (error) throw error;

  const lineIds = (data || []).map(line => line.id);
  const allocatedByLine = new Map<string, number>();
  const allocationCountByLine = new Map<string, number>();
  if (lineIds.length > 0) {
    const allocations = await fetchInBatches<any>(
      lineIds,
      batchIds => supabase
        .from('bank_statement_allocations')
        .select('bank_statement_line_id, allocation_amount, journal_entries(is_posted, is_reversed, is_cancelled)')
        .in('bank_statement_line_id', batchIds)
    );
    for (const allocation of allocations) {
      const je = Array.isArray(allocation.journal_entries) ? allocation.journal_entries[0] : allocation.journal_entries;
      if (je && (!je.is_posted || je.is_reversed || je.is_cancelled)) {
        continue;
      }
      allocatedByLine.set(
        allocation.bank_statement_line_id,
        (allocatedByLine.get(allocation.bank_statement_line_id) || 0) + Number(allocation.allocation_amount || 0),
      );
      allocationCountByLine.set(
        allocation.bank_statement_line_id,
        (allocationCountByLine.get(allocation.bank_statement_line_id) || 0) + 1,
      );
    }
  }

  return ((data || []) as unknown as BankTransactionLine[])
    .map((line) => {
      const total = bankStatementLineAmount(line.debit_amount, line.credit_amount);
      const allocatedAmount = allocatedByLine.get(line.id) || 0;
      const enriched = {
        ...line,
        allocatedAmount,
        allocationCount: allocationCountByLine.get(line.id) || 0,
        remainingAmount: Math.max(0, total - allocatedAmount),
      };
      return {
        ...enriched,
        isLinked: !isAvailableTransaction(enriched),
      };
    })
    .filter((line) => includeLinked || !line.isLinked);
}

export async function linkBankTransaction({
  bankStatementLineId,
  matchedExpenseId,
  matchedPaymentId,
  matchedJournalEntryId,
  note,
  paymentKind = 'supplier',
  allocationAmount,
}: LinkBankTransactionOptions): Promise<void> {
  if (!matchedExpenseId && !matchedPaymentId && !matchedJournalEntryId) {
    throw new Error('A bank transaction must be linked to a Finance document or journal entry.');
  }

  const docType = matchedExpenseId ? 'expense' : matchedPaymentId ? 'payment' : 'journal';
  await linkBankStatementLine(
    bankStatementLineId,
    docType,
    (matchedExpenseId || matchedPaymentId || matchedJournalEntryId) as string,
    docType === 'journal' ? 'other' : paymentKind,
    allocationAmount,
  );
  if (note) {
    const { error } = await supabase.from('bank_statement_lines').update({ notes: note }).eq('id', bankStatementLineId);
    if (error) throw error;
  }
}

export async function unlinkBankTransaction(bankStatementLineId: string): Promise<void> {
  await unlinkBankStatementLine(bankStatementLineId);
}

export function notifyFinanceReconciliationRefresh(): void {
  window.dispatchEvent(new CustomEvent(FINANCE_RECONCILIATION_REFRESH_EVENT));
}

export function rankCandidateLines(
  lines: BankTransactionLine[],
  targetAmount: number,
  targetDate?: string | null
): BankTransactionLine[] {
  return [...lines].sort((a, b) => {
    // 1. Exact balance match on remaining amount
    const aRemainingExact = Math.abs((a.remainingAmount ?? 0) - targetAmount) <= 0.01 ? 0 : 1;
    const bRemainingExact = Math.abs((b.remainingAmount ?? 0) - targetAmount) <= 0.01 ? 0 : 1;
    if (aRemainingExact !== bRemainingExact) return aRemainingExact - bRemainingExact;

    // 2. Exact balance match on total line amount
    const aTotal = Number(a.debit_amount || 0) > 0 ? Number(a.debit_amount) : Number(a.credit_amount || 0);
    const bTotal = Number(b.debit_amount || 0) > 0 ? Number(b.debit_amount) : Number(b.credit_amount || 0);
    const aTotalExact = Math.abs(aTotal - targetAmount) <= 0.01 ? 0 : 1;
    const bTotalExact = Math.abs(bTotal - targetAmount) <= 0.01 ? 0 : 1;
    if (aTotalExact !== bTotalExact) return aTotalExact - bTotalExact;

    // 3. Proximity of transaction date
    if (targetDate) {
      const targetTime = new Date(targetDate).getTime();
      const aTime = a.transaction_date ? new Date(a.transaction_date).getTime() : 0;
      const bTime = b.transaction_date ? new Date(b.transaction_date).getTime() : 0;
      const aDiff = Math.abs(aTime - targetTime);
      const bDiff = Math.abs(bTime - targetTime);
      if (aDiff !== bDiff) return aDiff - bDiff;
    }

    return 0;
  });
}
