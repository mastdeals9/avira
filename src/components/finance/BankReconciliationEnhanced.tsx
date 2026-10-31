import { Fragment, useEffect, useState, useRef, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { Upload, RefreshCw, CheckCircle2, AlertCircle, XCircle, Plus, Calendar, Landmark, FileText, Pencil as Edit, ChevronDown, ChevronRight, ChevronLeft, Clock, Info, X, Sparkles, Link2, Search, RotateCcw } from 'lucide-react';
import * as XLSX from 'xlsx';
import { FinanceModal as Modal } from './FinanceModal';
import { SearchableSelect } from '../SearchableSelect';
import { MoneyInput } from '../MoneyInput';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from './FloatingField';
import { SapRow } from './SapLayout';
import { useFinance } from '../../contexts/FinanceContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { normalizeDateToIso, toInputFormat, formatDate } from '../../utils/dateFormat';
import { useSupabaseRealtimeChannel } from '../../hooks/useSupabaseRealtimeChannel';
import { useExpenseCategories } from './useExpenseCategories';
import { groupExpenseCategories } from './ExpenseCategorySelect';
import { calculateCanonicalCashPayable, calculateCanonicalExpenseTotal, paymentDateGapWarning } from '../../utils/taxCalculations';
import { ExpenseManager, BankReconciliationExpensePrefill } from './ExpenseManager';
import { ReceiptVoucherManager, BankReconciliationReceiptPrefill } from './ReceiptVoucherManager';
import { PaymentVoucherManager } from './PaymentVoucherManager';
import {
  BANK_ALLOCATION_EPSILON,
  FINANCE_RECONCILIATION_REFRESH_EVENT,
  canonicalBankReconciliationStatus,
  bankStatementLineAmount,
  notifyFinanceReconciliationRefresh,
} from './bankTransactionLinking';
import { useErpSyncListener, emitErpSync } from '../../utils/erpSyncBus';
import { formatCurrency, parseIndonesianNumber } from '../../utils/currency';
import { FinanceActionButton } from './FinanceUI';
import {
  approveFinanceExpense,
  getDirectorRelatedPartyBalanceSummary,
  linkBankStatementLine,
  recordDirectorRelatedPartyBankTransaction,
  saveCapitalContribution,
  saveBankLinkedFinanceJournal,
  saveFinanceExpense,
  saveFinanceLoan,
  saveFinanceLoanRepayment,
  savePaymentVoucher,
  saveReceiptVoucher,
  unlinkBankStatementLine,
  unlinkBankStatementAllocation,
} from '../../services/financeCommands';
import {
  getEffectiveExpensePostingState,
  getEffectiveExpensePostingStates,
  isEffectiveExpensePosting,
} from '../../services/expensePostingLifecycle';

interface OutstandingBill {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  staff_id?: string | null;
  staff_name?: string | null;
  invoice_number: string | null;
  invoice_date: string;
  due_date: string | null;
  expense_category: string;
  description: string | null;
  amount: number;
  paid_amount: number;
  balance_amount: number;
  days_overdue: number;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  account_number: string;
  currency: string;
  alias: string | null;
  opening_balance?: number;
  opening_balance_date?: string | null;
}

interface DirectorLoanLedgerAccount {
  id: string;
  code: string;
  name: string;
}

interface DirectorOwnerLoanOption {
  account: DirectorLoanLedgerAccount;
}

interface StatementLine {
  id: string;
  date: string;
  description: string;
  reference: string;
  debit: number;
  credit: number;
  balance: number;
  currency: string;
  status: 'matched' | 'partially_reconciled' | 'suggested' | 'unmatched' | 'recorded';
  allocatedAmount: number;
  remainingAmount: number;
  allocations: Array<{
    id: string;
    document_type: string;
    document_id: string;
    journal_entry_id?: string;
    allocation_amount: number;
    payment_kind: string;
    label?: string;
    counterparty?: string;
    document_total?: number;
    document_remaining?: number;
    journal_status?: string;
  }>;
  matchedEntry?: string;
  matchedExpenseId?: string;
  matchedReceiptId?: string;
  matchedPaymentId?: string;
  matchedFundTransferId?: string;
  matchedPettyCashId?: string;
  matchedExpense?: {
    id: string;
    expense_category: string;
    amount: number;
    paid_amount?: number;
    description: string;
    expense_date: string;
    voucher_number?: string;
    approval_status?: string;
    invoice_number?: string | null;
    payment_reference?: string | null;
    payment_method?: string | null;
    currency_code?: string | null;
    transaction_currency?: string | null;
    exchange_rate?: number | null;
    document_urls?: string[] | null;
    suppliers?: { company_name: string } | null;
    finance_staff_master?: { full_name: string } | null;
    finance_payees?: { full_name: string } | null;
    import_containers?: { container_ref: string } | null;
    bank_accounts?: { account_name: string; account_number: string } | null;
    created_by_profile?: { full_name: string } | null;
    ppn_amount?: number | null;
    ppn_rate?: number | null;
    pph_amount?: number | null;
    pph_rate?: number | null;
    stamp_duty_amount?: number | null;
    bank_charges_amount?: number | null;
    broker_items?: import('../../utils/taxCalculations').BrokerItem[] | null;
  } | null;
  matchedReceipt?: {
    id: string;
    amount: number;
    payment_date: string;
    payment_number: string;
    customer_name?: string;
  } | null;
  matchedPayment?: {
    id: string;
    amount: number;
    voucher_date: string;
    voucher_number: string;
    supplier_name?: string;
    staff_name?: string;
  } | null;
  matchedFundTransfer?: {
    id: string;
    transfer_number: string;
    amount: number;
    description: string;
    transfer_date: string;
    from_account_type: string;
    to_account_type: string;
  } | null;
  matchedPettyCash?: {
    id: string;
    description: string;
    amount: number;
    transaction_date: string;
    transaction_type?: string;
  } | null;
  matchedTaxPaymentId?: string;
  matchedTaxPayment?: {
    id: string;
    tax_type: string;
    amount: number;
    payment_date: string;
    billing_code?: string | null;
    ntpn?: string | null;
  } | null;
  matchedEntryRecord?: {
    id: string;
    entry_number: string;
    entry_date: string;
    description: string;
    source_module?: string;
    reference_id?: string;
    reference_number?: string;
    is_posted?: boolean;
    is_reversed?: boolean;
  } | null;
  notes?: string;
}

interface BankReconciliationEnhancedProps {
  canManage: boolean;
  initialBankAccountId?: string | null;
  initialStatementLineId?: string | null;
  onInitialFocusHandled?: () => void;
  onRecordContra?: (line: { bankAccountId: string; statementLineId: string; date: string; amount: number; description: string; direction: 'from' | 'to' }) => void;
  onRecordPayment?: (line: { bankAccountId: string; statementLineId: string; date: string; amount: number; currency: 'IDR' | 'USD'; reference: string; description: string; partyType?: any; partyId?: string; paymentPurpose?: string; settlementAgainst?: string }) => void;
  onRecordExpense?: (line: BankReconciliationExpensePrefill) => void;
  onRecordReceipt?: (line: BankReconciliationReceiptPrefill) => void;
  onOpenJournal?: (journalEntryId: string) => void;
}

type PickerCandidate = Record<string, any> & { _linked?: boolean; _linkedReason?: string };

// Keep PostgREST URLs bounded. UUID filters become query-string parameters,
// so an unbounded `.in()` can fail before Postgres ever receives the query.
// This remains a batch read (not an N+1 read) and works for any statement range.
export const BANK_RECONCILIATION_IN_BATCH_SIZE = 75;
export const BANK_RECONCILIATION_PAGE_SIZE = 1000;

async function loadBankReconciliationRowsInBatches<T>(
  ids: Array<string | null | undefined>,
  queryBatch: (batchIds: string[]) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const rows: T[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += BANK_RECONCILIATION_IN_BATCH_SIZE) {
    const batchIds = uniqueIds.slice(offset, offset + BANK_RECONCILIATION_IN_BATCH_SIZE);
    const { data, error } = await queryBatch(batchIds);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

function rankBankCandidates<T extends PickerCandidate>(
  candidates: T[],
  line: StatementLine,
  amountOf: (candidate: T) => number,
  dateOf: (candidate: T) => string | null | undefined,
  partyOf: (candidate: T) => string | null | undefined = () => null,
): T[] {
  const bankAmount = Number(line.debit || line.credit || 0);
  const bankText = `${line.description} ${line.reference}`.toLocaleLowerCase();
  const bankDate = new Date(line.date).getTime();

  return [...candidates].sort((a, b) => {
    const aAmountDiff = Math.abs(amountOf(a) - bankAmount);
    const bAmountDiff = Math.abs(amountOf(b) - bankAmount);
    const aExact = aAmountDiff < 0.01 ? 0 : 1;
    const bExact = bAmountDiff < 0.01 ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    const matchesParty = (candidate: T) => {
      const party = (partyOf(candidate) || '').trim().toLocaleLowerCase();
      return party.length > 2 && bankText.includes(party) ? 0 : 1;
    };
    const aParty = matchesParty(a);
    const bParty = matchesParty(b);
    if (aParty !== bParty) return aParty - bParty;

    const aDateDiff = Math.abs(new Date(dateOf(a) || 0).getTime() - bankDate);
    const bDateDiff = Math.abs(new Date(dateOf(b) || 0).getTime() - bankDate);
    if (aDateDiff !== bDateDiff) return aDateDiff - bDateDiff;
    return aAmountDiff - bAmountDiff;
  });
}

const NON_CUSTOMER_JOURNAL_TYPES = new Set([
  'bank_interest',
  'other_income',
  'misc_income',
  'refund',
]);

function directorOwnerName(option: DirectorOwnerLoanOption): string {
  return option.account.name.replace(/^director\s+loan\s*[-–—:]\s*/i, '').trim() || option.account.name;
}

export function BankReconciliationEnhanced({
  canManage,
  initialBankAccountId,
  initialStatementLineId,
  onInitialFocusHandled,
  onRecordContra,
  onRecordPayment,
  onRecordExpense,
  onRecordReceipt,
  onOpenJournal,
}: BankReconciliationEnhancedProps) {
  const { t } = useLanguage();
  const { categories: expenseCategories } = useExpenseCategories();
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>(() => {
    try { return localStorage.getItem('bank_recon_selected_bank') || ''; } catch { return ''; }
  });
  const [selectedAccount, setSelectedAccount] = useState<BankAccount | null>(null);
  const [accountBalances, setAccountBalances] = useState<{
    statementBalance: number;
    bookBalance: number;
    difference: number;
  } | null>(null);
  const [statementLines, setStatementLines] = useState<StatementLine[]>([]);
  const [loading, setLoading] = useState(false);
  // Keep a failed read distinct from a successful empty result.  Collapsing
  // both states into `statementLines=[]` made RLS/runtime failures look like
  // an empty bank account.
  const [statementLoadError, setStatementLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'all' | 'matched' | 'suggested' | 'unmatched'>('unmatched');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [highlightedLineId, setHighlightedLineId] = useState<string | null>(null);
  const [expandedLineIds, setExpandedLineIds] = useState<Set<string>>(new Set());

  // Use master date range from Finance context, backed by local controls for high visibility & control
  const { dateRange: financeDateRange, setDateRange } = useFinance();
  const [localStartDate, setLocalStartDate] = useState(financeDateRange.startDate);
  const [localEndDate, setLocalEndDate] = useState(financeDateRange.endDate);

  // Search & Pagination controls
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number | 'all'>(50);

  // Sync local controls if master dateRange changes externally
  useEffect(() => {
    setLocalStartDate(financeDateRange.startDate);
    setLocalEndDate(financeDateRange.endDate);
  }, [financeDateRange.startDate, financeDateRange.endDate]);

  const dateRange = useMemo(() => ({
    start: normalizeDateToIso(localStartDate) || financeDateRange.startDate,
    end: normalizeDateToIso(localEndDate) || financeDateRange.endDate,
  }), [localStartDate, localEndDate, financeDateRange.startDate, financeDateRange.endDate]);

  const handleDateChange = (newStart: string, newEnd: string) => {
    const s = normalizeDateToIso(newStart) || newStart;
    const e = normalizeDateToIso(newEnd) || newEnd;
    setLocalStartDate(s);
    setLocalEndDate(e);
    if (s && e) {
      setDateRange({ startDate: s, endDate: e });
    }
  };

  const handleClearFilters = () => {
    setSearchTerm('');
    setActiveFilter('all');
    setCurrentPage(1);
    setSortConfig(null);
  };
  const [recordingLine, setRecordingLine] = useState<StatementLine | null>(null);
  const [recordModal, setRecordModal] = useState(false);
  const [embeddedExpensePrefill, setEmbeddedExpensePrefill] = useState<BankReconciliationExpensePrefill | null>(null);
  const [embeddedReceiptPrefill, setEmbeddedReceiptPrefill] = useState<BankReconciliationReceiptPrefill | null>(null);
  const [embeddedPaymentPrefill, setEmbeddedPaymentPrefill] = useState<{
    bankAccountId: string; statementLineId: string; date: string; amount: number; currency: 'IDR' | 'USD'; reference: string; description: string; partyType?: any; partyId?: string; paymentPurpose?: string; settlementAgainst?: string;
  } | null>(null);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [linkToExpense, setLinkToExpense] = useState(false);
  const [linkPaymentKind, setLinkPaymentKind] = useState<'supplier' | 'pph23'>('supplier');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ocrError, setOcrError] = useState<{message: string; canUseOCR: boolean; suggestions: string[]} | null>(null);
  const [ocrPreview, setOcrPreview] = useState<any | null>(null);
  const [lastUploadedFile, setLastUploadedFile] = useState<File | null>(null);
  const [editingLine, setEditingLine] = useState<StatementLine | null>(null);
  const [editModal, setEditModal] = useState(false);
  const [editFormData, setEditFormData] = useState({
    debit: 0,
    credit: 0,
    description: '',
  });
  const [deletePreview, setDeletePreview] = useState<any>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [customers, setCustomers] = useState<Array<{ id: string; company_name: string }>>([]);
  const [receiptType, setReceiptType] = useState('');
  const [receiptCustomerId, setReceiptCustomerId] = useState('');
  const [receiptInvoices, setReceiptInvoices] = useState<any[]>([]);
  const [receiptAllocations, setReceiptAllocations] = useState<{[invoiceId: string]: number}>({});
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [recordingReceipt, setRecordingReceipt] = useState(false);
  const [recordExchangeRate, setRecordExchangeRate] = useState(1);
  const [loanCounterparty, setLoanCounterparty] = useState('');
  const [directorLoanAccounts, setDirectorLoanAccounts] = useState<DirectorOwnerLoanOption[]>([]);
  const [directorLoanAccountId, setDirectorLoanAccountId] = useState('');
  const [recordDirectorLoanWithdrawal, setRecordDirectorLoanWithdrawal] = useState(false);
  const [recordDirectorRelatedParty, setRecordDirectorRelatedParty] = useState(false);
  const [directorSummary, setDirectorSummary] = useState<any>(null);
  const [loadingDirectorSummary, setLoadingDirectorSummary] = useState(false);
  const [selectedDirectorName, setSelectedDirectorName] = useState('Vijay Lunkad');
  const [directorNotes, setDirectorNotes] = useState('');
  const [recordLoanDebit, setRecordLoanDebit] = useState(false);
  const [recordLoanRepayment, setRecordLoanRepayment] = useState(false);
  const [loanDirection, setLoanDirection] = useState<'given' | 'taken'>('given');
  const [loanCoaId, setLoanCoaId] = useState('');
  const [loanAccounts, setLoanAccounts] = useState<Array<{ id: string; code: string; name: string; account_type: string }>>([]);
  const [activeLoans, setActiveLoans] = useState<Array<{
    id: string; loan_number: string; counterparty_name: string; loan_type?: string; outstanding_balance: number; currency: string;
  }>>([]);
  const [repaymentLoanId, setRepaymentLoanId] = useState('');
  const [repaymentPrincipal, setRepaymentPrincipal] = useState(0);
  const [repaymentInterest, setRepaymentInterest] = useState(0);
  const recordingReceiptRef = useRef(false);
  const [existingReceipts, setExistingReceipts] = useState<any[]>([]);
  const [linkExistingReceipt, setLinkExistingReceipt] = useState(false);
  const [linkJournalEntry, setLinkJournalEntry] = useState(false);
  const [availableJournals, setAvailableJournals] = useState<any[]>([]);
  const [linkToSupplierPayment, setLinkToSupplierPayment] = useState(false);
  const [supplierPayments, setSupplierPayments] = useState<any[]>([]);
  const [loadingSupplierPayments, setLoadingSupplierPayments] = useState(false);
  const [linkToTaxPayment, setLinkToTaxPayment] = useState(false);
  const [availableTaxPayments, setAvailableTaxPayments] = useState<any[]>([]);
  const [linkSettleBills, setLinkSettleBills] = useState(false);
  const [outstandingBills, setOutstandingBills] = useState<OutstandingBill[]>([]);
  const [loadingBills, setLoadingBills] = useState(false);
  const [billAllocations, setBillAllocations] = useState<{ expenseId: string; amount: number }[]>([]);
  const [settleSubmitting, setSettleSubmitting] = useState(false);
  const [showImportResultModal, setShowImportResultModal] = useState(false);
  const [importResult, setImportResult] = useState<{
    totalInFile: number;
    importedCount: number;
    skippedEntries: any[];
  } | null>(null);
  const [forceImporting, setForceImporting] = useState(false);
  const [pendingExpenseAllocation, setPendingExpenseAllocation] = useState<{
    line: StatementLine;
    expense: any;
    amount: number;
    bankAfter: number;
    documentAfter: number;
  } | null>(null);
  const [selectedSuggestedLine, setSelectedSuggestedLine] = useState<StatementLine | null>(null);

  // Persistent user feedback banner state
  interface ActionFeedback {
    type: 'success' | 'error' | 'info';
    title: string;
    details?: Array<{ label: string; value: string }>;
    message?: string;
    timestamp: number;
  }
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const [autoMatching, setAutoMatching] = useState(false);

  // Guard against duplicate / self-triggered reloads
  const selfActionTimestampRef = useRef(0);
  const loadingRequestIdRef = useRef(0);
  const isLoadingRef = useRef(false);
  const pendingReloadRef = useRef(false);

  // Auto-dismiss persistent feedback after 12 seconds
  useEffect(() => {
    if (!actionFeedback) return;
    const timer = setTimeout(() => {
      setActionFeedback(null);
    }, 12000);
    return () => clearTimeout(timer);
  }, [actionFeedback]);

  // Refs let the stable-deps realtime effect below read latest state/loaders
  // without resubscribing on every render.
  const selectedBankRef = useRef(selectedBank);
  const noopAsync = useRef<() => Promise<void> | void>(() => {});
  const loadStatementLinesRef = useRef<() => Promise<void> | void>(noopAsync.current);
  const loadExpensesRef = useRef<() => Promise<void> | void>(noopAsync.current);
  useEffect(() => { selectedBankRef.current = selectedBank; }, [selectedBank]);
  useEffect(() => { loadStatementLinesRef.current = loadStatementLines; });
  useEffect(() => { loadExpensesRef.current = loadExpenses; });

  useEffect(() => {
    const refresh = () => {
      // Avoid reacting to refresh events self-triggered by in-flight user actions
      if (Date.now() - selfActionTimestampRef.current < 2000) return;
      loadExpensesRef.current();
      if (selectedBankRef.current) loadStatementLinesRef.current();
    };
    window.addEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, refresh);
  }, []);

  useErpSyncListener(
    ['bank_transactions', 'vouchers', 'expenses', 'sales_invoices'],
    () => {
      loadExpensesRef.current();
      if (selectedBankRef.current) loadStatementLinesRef.current();
    }
  );

  useEffect(() => {
    loadBankAccounts();
    loadExpenses();
    loadCustomers();
    loadDirectorLoanAccounts();
  }, []);

  useEffect(() => {
    if (!initialBankAccountId || !initialStatementLineId) return;
    setSelectedBank(initialBankAccountId);
    setActiveFilter('all');
    setHighlightedLineId(initialStatementLineId);
    try { localStorage.setItem('bank_recon_selected_bank', initialBankAccountId); } catch {
      // Reconciliation still works when browser storage is unavailable.
    }
  }, [initialBankAccountId, initialStatementLineId]);

  useEffect(() => {
    if (!highlightedLineId || !statementLines.some(line => line.id === highlightedLineId)) return;

    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`bank-statement-line-${highlightedLineId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const timer = window.setTimeout(() => setHighlightedLineId(null), 5000);
    onInitialFocusHandled?.();

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [highlightedLineId, statementLines, onInitialFocusHandled]);

  // Shared "coalesce statement refresh" scheduler across the two realtime hooks below.
  const statementScheduledRef = useRef(false);
  const scheduleStatement = () => {
    if (statementScheduledRef.current) return;
    statementScheduledRef.current = true;
    setTimeout(() => {
      statementScheduledRef.current = false;
      if (selectedBankRef.current) loadStatementLinesRef.current();
    }, 400);
  };

  const patchBankLine = (payload: any) => {
    const bankId = selectedBankRef.current;
    if (!bankId) return;
    const row = payload.new || payload.old;
    // Only react to lines relevant to the active bank account.
    if (row?.bank_account_id && row.bank_account_id !== bankId) return;
    // Ignore realtime events triggered by our own in-flight actions
    if (Date.now() - selfActionTimestampRef.current < 2000) return;
    scheduleStatement();
  };

  const patchExpense = () => {
    loadExpensesRef.current();
    scheduleStatement();
  };

  useSupabaseRealtimeChannel({
    channelName: 'bank_lines_recon',
    table: 'bank_statement_lines',
    onEvent: patchBankLine,
  });
  useSupabaseRealtimeChannel({
    channelName: 'expense_recon',
    table: 'finance_expenses',
    onEvent: patchExpense,
  });

  const loadCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, company_name')
      .eq('is_active', true)
      .order('company_name');
    if (data) setCustomers(data);
  };

  const loadLinkedDocumentIds = async (exceptBankLineId?: string) => {
    let query = supabase
      .from('bank_statement_allocations')
      .select('document_type, document_id, bank_statement_line_id');
    if (exceptBankLineId) query = query.neq('bank_statement_line_id', exceptBankLineId);
    const { data, error } = await query;
    if (error) throw error;
    const ids = (documentType: string) => new Set(
      (data || [])
        .filter((row: { document_type: string }) => row.document_type === documentType)
        .map((row: { document_id: string }) => row.document_id)
        .filter(Boolean),
    );
    return {
      expenseIds: ids('expense'),
      receiptIds: ids('receipt'),
      paymentIds: ids('payment'),
      pettyCashIds: ids('petty_cash'),
      fundTransferIds: ids('fund_transfer'),
      taxPaymentIds: ids('tax_payment'),
      journalIds: ids('journal'),
    };
  };

  const visiblePickerCandidates = <T extends PickerCandidate>(candidates: T[]) =>
    candidates.filter((candidate) => !candidate._linked);

  const expenseCanAcceptLink = (expense: any) => {
    if (linkPaymentKind === 'pph23') {
      return Number(expense.pph_amount || 0) - Number(expense.pph_paid_amount || 0) > 0.01;
    }
    return calculateCanonicalCashPayable(expense) - Number(expense.paid_amount || 0) > 0.01;
  };

  const visibleExpenseCandidates = (candidates: any[]) => rankBankCandidates(
    candidates.filter(expenseCanAcceptLink),
    recordingLine!,
    (expense) => linkPaymentKind === 'pph23'
      ? Number(expense.pph_amount || 0)
      : calculateCanonicalCashPayable(expense),
    (expense) => expense.expense_date,
    (expense) => expense.suppliers?.company_name,
  );

  const loadActiveLoans = async () => {
    const { data, error } = await supabase
      .from('loans')
      .select('id, loan_number, counterparty_name, loan_type, outstanding_balance, currency')
      .eq('status', 'active')
      .gt('outstanding_balance', 0)
      .order('loan_date', { ascending: false });
    if (error) {
      console.error('Error loading active loans:', error);
      setActiveLoans([]);
      return;
    }
    setActiveLoans((data || []) as any[]);
  };

  const loadLoanAccounts = async (direction: 'given' | 'taken', currentCounterparty?: string) => {
    try {
      let query = supabase.from('chart_of_accounts')
        .select('id, code, name, account_type')
        .eq('is_active', true)
        .eq('is_header', false);

      if (direction === 'given') {
        query = query.eq('account_type', 'asset')
          .or('code.ilike.131%,code.ilike.116%,name.ilike.%loan%,name.ilike.%advance%');
      } else {
        query = query.eq('account_type', 'liability')
          .or('code.ilike.2105%,code.ilike.221%,name.ilike.%loan%,name.ilike.%director%');
      }

      const { data, error } = await query.order('code');
      if (error) throw error;
      const accounts = data || [];
      setLoanAccounts(accounts);

      if (direction === 'given') {
        const default1310 = accounts.find(a => a.code === '1310') || accounts[0];
        if (default1310) setLoanCoaId(default1310.id);
      } else {
        const cp = (currentCounterparty ?? loanCounterparty).toLowerCase();
        if (cp.includes('vijay') || cp.includes('lunkad') || cp.includes('director')) {
          const default2105 = accounts.find(a => a.code === '2105') || accounts[0];
          if (default2105) setLoanCoaId(default2105.id);
        } else if (cp.match(/bank|bca|mandiri|bni|bri|cimb|danamon|permata|uob/)) {
          const default2210 = accounts.find(a => a.code === '2210') || accounts[0];
          if (default2210) setLoanCoaId(default2210.id);
        } else {
          const defaultAcc = accounts.find(a => a.code === '2105') || accounts.find(a => a.code === '2210') || accounts[0];
          if (defaultAcc) setLoanCoaId(defaultAcc.id);
        }
      }
    } catch (err) {
      console.error('Error loading loan accounts:', err);
      setLoanAccounts([]);
    }
  };

  useEffect(() => {
    if (selectedBank) {
      const account = bankAccounts.find(b => b.id === selectedBank);
      setSelectedAccount(account || null);
      void loadAccountBalances();
    }
  }, [selectedBank, bankAccounts]);

  useEffect(() => {
    if (selectedBank) {
      loadStatementLines();
    }
  }, [selectedBank, financeDateRange]);

  const loadAccountBalances = async () => {
    if (!selectedBank) return;
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data, error } = await supabase
        .rpc('get_bank_account_balances', { p_as_of_date: today });
      if (!error && data) {
        const row = (data as any[]).find((b: any) => b.bank_account_id === selectedBank);
        if (row) {
          const stmtBal = Number(row.statement_balance ?? 0);
          const bookBal = Number(row.book_balance ?? 0);
          setAccountBalances({
            statementBalance: stmtBal,
            bookBalance: bookBal,
            difference: stmtBal - bookBal,
          });
          return;
        }
      }
    } catch (err) {
      console.error('Error fetching bank account balances:', err);
    }
  };

  const loadBankAccounts = async () => {
    setStatementLoadError(null);
    try {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, account_name, bank_name, account_number, currency, alias, opening_balance, opening_balance_date')
        .eq('is_active', true)
        .order('account_name');
      if (error) throw error;
      setBankAccounts(data || []);
      if (data && data.length > 0 && !selectedBank) {
        const savedBank = localStorage.getItem('bank_recon_selected_bank');
        const savedExists = savedBank && data.some(a => a.id === savedBank);
        if (!savedExists) {
          const bcaAccount = data.find(
            acc => acc.bank_name === 'BCA Bank' &&
                   acc.account_number === '0930 2010 14' &&
                   acc.currency === 'IDR'
          );
          const defaultId = bcaAccount?.id || data[0].id;
          setSelectedBank(defaultId);
          try { localStorage.setItem('bank_recon_selected_bank', defaultId); } catch { /* Storage may be unavailable. */ }
        }
      }
    } catch (err) {
      console.error('Error loading bank accounts:', err);
      setStatementLoadError(err instanceof Error ? err.message : 'Unable to load bank accounts.');
    }
  };

  const loadExpenses = async () => {
    try {
      // First, get all expenses (removed limit to show all expenses)
      const { data: allExpenses, error } = await supabase
        .from('finance_expenses')
        .select(`
          id,
          expense_date,
          description,
          amount,
          expense_category,
          voucher_number,
          paid_amount,
          pph_amount,
          pph_paid_amount,
          ppn_amount,
          stamp_duty_amount,
          bank_charges_amount,
          broker_items,
          suppliers(company_name)
        `)
        .order('expense_date', { ascending: false });

      if (error) throw error;

      const linked = await loadLinkedDocumentIds();
      const postingStates = await getEffectiveExpensePostingStates((allExpenses || []).map(expense => expense.id));
      // Expenses can receive legal partial payments. A prior bank link is only
      // unavailable once the relevant supplier/PPh balance is fully settled.
      setExpenses((allExpenses || [])
        .filter(expense => isEffectiveExpensePosting(postingStates.get(expense.id)?.effective_posting_state))
        .map((expense: any) => ({
        ...expense,
        _linked: linked.expenseIds.has(expense.id),
      })));
    } catch (err) {
      console.error('Error loading expenses:', err);
    }
  };

  const loadStatementLines = async () => {
    if (!selectedBank) return;

    if (isLoadingRef.current) {
      pendingReloadRef.current = true;
      return;
    }

    isLoadingRef.current = true;
    setLoading(true);
    setStatementLoadError(null);
    loadingRequestIdRef.current += 1;
    const currentRequestId = loadingRequestIdRef.current;
    try {
      // Exact inclusive date boundary filtering normalized to YYYY-MM-DD
      const startIso = normalizeDateToIso(dateRange.start) || dateRange.start;
      const endIso = normalizeDateToIso(dateRange.end) || dateRange.end;

      const rangeData: any[] = [];
      for (let offset = 0; ; offset += BANK_RECONCILIATION_PAGE_SIZE) {
        const { data: page, error } = await supabase
          .from('bank_statement_lines')
          // perf: projected columns (was select('*'))
          .select('id, bank_account_id, transaction_date, description, reference, currency, debit_amount, credit_amount, running_balance, reconciliation_status, matching_status, manually_unlinked, notes, matched_expense_id, matched_receipt_id, matched_payment_id, matched_fund_transfer_id, matched_entry_id, matched_petty_cash_id, matched_tax_payment_id')
          .eq('bank_account_id', selectedBank)
          .gte('transaction_date', startIso)
          .lte('transaction_date', endIso)
          .order('transaction_date', { ascending: false })
          .order('id', { ascending: true })
          .range(offset, offset + BANK_RECONCILIATION_PAGE_SIZE - 1);
        if (error) throw error;
        rangeData.push(...(page || []));
        if (!page || page.length < BANK_RECONCILIATION_PAGE_SIZE) break;
      }

      let data = rangeData;
      if (
        initialStatementLineId
        && initialBankAccountId === selectedBank
        && !data.some(row => row.id === initialStatementLineId)
      ) {
        const { data: focusedLine, error: focusedLineError } = await supabase
          .from('bank_statement_lines')
          .select('id, bank_account_id, transaction_date, description, reference, currency, debit_amount, credit_amount, running_balance, reconciliation_status, matching_status, manually_unlinked, notes, matched_expense_id, matched_receipt_id, matched_payment_id, matched_fund_transfer_id, matched_entry_id, matched_petty_cash_id, matched_tax_payment_id')
          .eq('id', initialStatementLineId)
          .eq('bank_account_id', selectedBank)
          .maybeSingle();

        if (focusedLineError) throw focusedLineError;
        if (focusedLine) data = [focusedLine, ...data];
      }

      const lineIds = data.map(row => row.id);
      const allocationMap = new Map<string, StatementLine['allocations']>();
      if (lineIds.length > 0) {
        const allocations = await loadBankReconciliationRowsInBatches<any>(lineIds, batchIds => supabase
          .from('bank_statement_allocations')
          .select('id, bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind')
          .in('bank_statement_line_id', batchIds));
        for (const allocation of allocations) {
          const list = allocationMap.get(allocation.bank_statement_line_id) || [];
          list.push({
            id: allocation.id,
            document_type: allocation.document_type,
            document_id: allocation.document_id,
            journal_entry_id: allocation.journal_entry_id,
            allocation_amount: Number(allocation.allocation_amount || 0),
            payment_kind: allocation.payment_kind,
          });
          allocationMap.set(allocation.bank_statement_line_id, list);
        }
      }

      const allAllocations = [...allocationMap.values()].flat();
      const idsFor = (documentType: string, legacy: Array<string | null | undefined>) =>
        [...new Set([
          ...legacy.filter((id): id is string => Boolean(id)),
          ...allAllocations.filter(a => a.document_type === documentType).map(a => a.document_id),
        ])];

      // Display lookups use allocation document ids. Legacy matched_* columns
      // are only extra keys so a leftover FK can still render a name; they do
      // not decide linked/unlinked status.
      const expenseIds = idsFor('expense', data.map(r => r.matched_expense_id));
      const receiptIds = idsFor('receipt', data.map(r => r.matched_receipt_id));
      const paymentIds = idsFor('payment', data.map(r => r.matched_payment_id));
      const fundTransferIds = idsFor('fund_transfer', data.map(r => r.matched_fund_transfer_id));
      const pettyCashIds = idsFor('petty_cash', data.map(r => r.matched_petty_cash_id));
      const entryIds = [...new Set([
        ...idsFor('journal', data.map(r => r.matched_entry_id)),
        ...allAllocations.map(a => a.journal_entry_id).filter((id): id is string => Boolean(id)),
      ])];
      const taxPaymentIds = idsFor('tax_payment', data.map(r => r.matched_tax_payment_id));

      // Batch load all expenses with optimized projections: loadBankReconciliationRowsInBatches<any>(expenseIds
      // Rich relations are only loaded for suggested matches (for review modal),
      // while bulk historical matches load lightweight fields.
      const expenseMap = new Map();
      if (expenseIds.length > 0) {
        const suggestedSet = new Set(
          data.filter(r => r.matching_status === 'suggested' && r.matched_expense_id).map(r => r.matched_expense_id)
        );
        const suggestedExpenseIds = expenseIds.filter(id => suggestedSet.has(id));
        const historicalExpenseIds = expenseIds.filter(id => !suggestedSet.has(id));

        // 1. Bulk historical expenses: lightweight select without heavy joins
        if (historicalExpenseIds.length > 0) {
          const histExpenses = await loadBankReconciliationRowsInBatches<any>(historicalExpenseIds, batchIds => supabase
            .from('finance_expenses')
            .select('id, expense_category, amount, paid_amount, description, expense_date, voucher_number, invoice_number, payment_reference, payment_method, currency_code, transaction_currency, exchange_rate, approval_status')
            .in('id', batchIds));
          histExpenses.forEach(e => expenseMap.set(e.id, e));
        }

        // 2. Suggested expenses: full detail select for side-by-side review
        if (suggestedExpenseIds.length > 0) {
          const suggestedExpenses = await loadBankReconciliationRowsInBatches<any>(suggestedExpenseIds, batchIds => supabase
            .from('finance_expenses')
            .select('id, expense_category, amount, paid_amount, description, expense_date, voucher_number, invoice_number, payment_reference, payment_method, currency_code, transaction_currency, exchange_rate, document_urls, ppn_amount, ppn_rate, pph_amount, pph_rate, stamp_duty_amount, bank_charges_amount, broker_items, approval_status, suppliers(company_name), finance_staff_master(full_name), finance_payees(full_name), import_containers(container_ref), bank_accounts(account_name, account_number), created_by_profile:user_profiles!finance_expenses_created_by_fkey(full_name)')
            .in('id', batchIds));
          suggestedExpenses.forEach(e => expenseMap.set(e.id, e));
        }
      }

      const paymentMap = new Map();
      if (paymentIds.length > 0) {
        const payments = await loadBankReconciliationRowsInBatches<any>(paymentIds, batchIds => supabase
          .from('payment_vouchers')
          .select('id, amount, actual_bank_debit, bank_amount, payment_currency, voucher_date, voucher_number, supplier_id, staff_id, suppliers(company_name), finance_staff_master(full_name)')
          .in('id', batchIds));
        payments.forEach(payment => {
          paymentMap.set(payment.id, {
            id: payment.id,
            amount: payment.actual_bank_debit && Number(payment.actual_bank_debit) > 0
              ? payment.actual_bank_debit
              : payment.bank_amount && Number(payment.bank_amount) > 0 ? payment.bank_amount : payment.amount,
            voucher_date: payment.voucher_date,
            voucher_number: payment.voucher_number,
            supplier_name: (payment.suppliers as any)?.company_name,
            staff_name: (payment.finance_staff_master as any)?.full_name,
          });
        });
      }

      // Batch load all receipts with customers
      const receiptMap = new Map();
      if (receiptIds.length > 0) {
        const receipts = await loadBankReconciliationRowsInBatches<any>(receiptIds, batchIds => supabase
          .from('receipt_vouchers')
          .select('id, amount, voucher_date, voucher_number, customer_id, customers(company_name)')
          .in('id', batchIds));
        receipts.forEach(r => {
          receiptMap.set(r.id, {
            id: r.id,
            amount: r.amount,
            payment_date: r.voucher_date,
            payment_number: r.voucher_number,
            customer_name: (r.customers as any)?.company_name
          });
        });
      }

      // Batch load all fund transfers
      const fundTransferMap = new Map();
      if (fundTransferIds.length > 0) {
        const fundTransfers = await loadBankReconciliationRowsInBatches<any>(fundTransferIds, batchIds => supabase
          .from('fund_transfers')
          .select('id, transfer_number, amount, description, transfer_date, from_account_type, to_account_type')
          .in('id', batchIds));
        fundTransfers.forEach(f => fundTransferMap.set(f.id, f));
      }

      // Batch load matched petty cash by id. Do not exclude fund-transfer-backed
      // rows here — that filter hid valid matches and left the UI unresolved.
      const pettyCashMap = new Map();
      if (pettyCashIds.length > 0) {
        const pettyCash = await loadBankReconciliationRowsInBatches<any>(pettyCashIds, batchIds => supabase
          .from('petty_cash_transactions')
          .select('id, description, amount, transaction_date, transaction_type')
          .in('id', batchIds));
        pettyCash.forEach(p => pettyCashMap.set(p.id, p));
      }

      // Batch load all journal entries (canonical link fallback for display)
      const entryMap = new Map();
      if (entryIds.length > 0) {
        const entries = await loadBankReconciliationRowsInBatches<any>(entryIds, batchIds => supabase
          .from('journal_entries')
          .select('id, source_module, reference_id, reference_number, description, entry_date, entry_number, is_posted, is_reversed')
          .in('id', batchIds));
        entries.forEach(e => entryMap.set(e.id, e));
      }

      // Batch load all tax payments
      const taxPaymentMap = new Map();
      if (taxPaymentIds.length > 0) {
        const taxPayments = await loadBankReconciliationRowsInBatches<any>(taxPaymentIds, batchIds => supabase
          .from('tax_payments')
          .select('id, tax_type, amount, payment_date, billing_code, ntpn')
          .in('id', batchIds));
        taxPayments.forEach(t => taxPaymentMap.set(t.id, t));
      }

      // Map lines with pre-loaded data (NO MORE QUERIES!)
      const lines: StatementLine[] = data.map(row => {
        const allocations = allocationMap.get(row.id) || [];
        const bankAmount = bankStatementLineAmount(row.debit_amount, row.credit_amount);
        const isDirectRecorded =
          !row.manually_unlinked &&
          Boolean(row.matched_entry_id) &&
          (row.matching_status === 'confirmed' || row.reconciliation_status === 'recorded');
        const validAllocations = allocations.filter(allocation => {
          if (!allocation.journal_entry_id) return false;
          const journal = entryMap.get(allocation.journal_entry_id);
          if (!journal || !journal.is_posted || journal.is_reversed) return false;
          return true;
        });
        const allocatedAmount = validAllocations.reduce((sum, allocation) => sum + allocation.allocation_amount, 0) + (isDirectRecorded && allocations.length === 0 ? bankAmount : 0);
        const remainingAmount = Math.max(0, bankAmount - allocatedAmount);
        const isSuggested =
          (row.matching_status === 'suggested' ||
            row.reconciliation_status === 'needs_review' ||
            row.reconciliation_status === 'suggested') &&
          allocatedAmount <= BANK_ALLOCATION_EPSILON;
        const status = isSuggested
          ? 'suggested'
          : isDirectRecorded
            ? 'recorded'
            : (() => {
                const status = canonicalBankReconciliationStatus(bankAmount, allocatedAmount);
                return status;
              })();
        const firstExpense = allocations.find(a => a.document_type === 'expense');
        const firstReceipt = allocations.find(a => a.document_type === 'receipt');
        const firstPayment = allocations.find(a => a.document_type === 'payment');
        const firstFund = allocations.find(a => a.document_type === 'fund_transfer');
        const firstPetty = allocations.find(a => a.document_type === 'petty_cash');
        const firstTax = allocations.find(a => a.document_type === 'tax_payment');
        const firstJournal = allocations.find(a => a.document_type === 'journal');
        const labeledAllocations = allocations.map(allocation => {
          let label = allocation.document_type;
          let counterparty: string | undefined;
          let documentTotal: number | undefined;
          let documentRemaining: number | undefined;
          if (allocation.document_type === 'expense') {
            const expense = expenseMap.get(allocation.document_id);
            label = expense?.voucher_number
              || expense?.expense_category
              || 'Expense';
            counterparty = expense?.suppliers?.company_name;
            documentTotal = expense ? calculateCanonicalCashPayable(expense) : 0;
            documentRemaining = Math.max(0, documentTotal - Number(expense?.paid_amount || 0));
          } else if (allocation.document_type === 'receipt') {
            const receipt = receiptMap.get(allocation.document_id);
            label = receipt?.payment_number
              || receipt?.customer_name
              || 'Receipt';
            counterparty = receipt?.customer_name;
            documentTotal = Number(receipt?.amount || 0);
          } else if (allocation.document_type === 'payment') {
            const payment = paymentMap.get(allocation.document_id);
            label = payment?.voucher_number || 'Payment';
            counterparty = payment?.supplier_name || payment?.staff_name;
            documentTotal = Number(payment?.amount || 0);
          } else if (allocation.document_type === 'fund_transfer') {
            const ft = fundTransferMap.get(allocation.document_id);
            label = ft?.transfer_number || 'Fund Transfer';
          } else if (allocation.document_type === 'petty_cash') {
            label = pettyCashMap.get(allocation.document_id)?.description || 'Petty Cash';
          } else if (allocation.document_type === 'tax_payment') {
            const tax = taxPaymentMap.get(allocation.document_id);
            label = tax ? `${tax.tax_type} ${tax.payment_date}` : 'Tax Payment';
          } else if (allocation.document_type === 'journal') {
            label = entryMap.get(allocation.document_id)?.entry_number || 'Journal';
          }
          const journal = allocation.journal_entry_id ? entryMap.get(allocation.journal_entry_id) : undefined;
          return {
            ...allocation,
            label,
            counterparty,
            document_total: documentTotal,
            document_remaining: documentRemaining,
            journal_status: journal
              ? (journal.is_reversed ? 'Reversed' : journal.is_posted ? 'Posted' : 'Unposted')
              : undefined,
          };
        });

        if (labeledAllocations.length === 0 && isDirectRecorded && row.matched_entry_id) {
          const directJournal = entryMap.get(row.matched_entry_id);
          labeledAllocations.push({
            id: `journal-${row.matched_entry_id}`,
            document_type: 'journal',
            document_id: row.matched_entry_id,
            journal_entry_id: row.matched_entry_id,
            allocation_amount: bankAmount,
            payment_kind: 'journal',
            label: directJournal?.entry_number
              ? (row.notes ? `${directJournal.entry_number} · ${row.notes}` : directJournal.entry_number)
              : (row.notes || 'Journal Entry'),
            counterparty: undefined,
            document_total: bankAmount,
            document_remaining: 0,
            journal_status: directJournal
              ? (directJournal.is_reversed ? 'Reversed' : directJournal.is_posted ? 'Posted' : 'Unposted')
              : 'Posted',
          });
        }

        const expenseId = firstExpense?.document_id || row.matched_expense_id || null;
        const receiptId = firstReceipt?.document_id || null;
        const paymentId = firstPayment?.document_id || null;
        const fundId = firstFund?.document_id || null;
        const pettyId = firstPetty?.document_id || null;
        const taxId = firstTax?.document_id || null;
        const journalId = firstJournal?.document_id || (isDirectRecorded ? row.matched_entry_id : null);
        return {
          id: row.id,
          date: row.transaction_date,
          description: row.description || '',
          reference: row.reference || '',
          debit: row.debit_amount || 0,
          credit: row.credit_amount || 0,
          balance: row.running_balance || 0,
          currency: row.currency || 'IDR',
          status,
          allocatedAmount,
          remainingAmount,
          allocations: labeledAllocations,
          matchedEntry: journalId || undefined,
          matchedExpenseId: expenseId || undefined,
          matchedReceiptId: receiptId || undefined,
          matchedPaymentId: paymentId || undefined,
          matchedFundTransferId: fundId || undefined,
          matchedPettyCashId: pettyId || undefined,
          matchedExpense: expenseId ? expenseMap.get(expenseId) : null,
          matchedReceipt: receiptId ? receiptMap.get(receiptId) : null,
          matchedPayment: paymentId ? paymentMap.get(paymentId) : null,
          matchedFundTransfer: fundId ? fundTransferMap.get(fundId) : null,
          matchedPettyCash: pettyId ? pettyCashMap.get(pettyId) : null,
          matchedTaxPaymentId: taxId || undefined,
          matchedTaxPayment: taxId ? taxPaymentMap.get(taxId) : null,
          matchedEntryRecord: journalId ? entryMap.get(journalId) : null,
          notes: row.notes,
        };
      });

      if (currentRequestId === loadingRequestIdRef.current) {
        setStatementLines(lines);
        void loadAccountBalances();
      }
    } catch (err: any) {
      if (currentRequestId === loadingRequestIdRef.current) {
        if (err?.name !== 'AbortError' && !err?.message?.includes('aborted')) {
          console.error('Error loading statement lines:', err);
          setStatementLoadError(err instanceof Error ? err.message : 'Unable to load bank transactions.');
        }
      }
    } finally {
      if (currentRequestId === loadingRequestIdRef.current) {
        isLoadingRef.current = false;
        setLoading(false);
      }
      if (pendingReloadRef.current) {
        pendingReloadRef.current = false;
        loadStatementLines();
      }
    }
  };

  const normalizeHeader = (s: string) => s.toLowerCase().trim().replace(/[\s_-]+/g, ' ');

  const isDateHeader = (s: string) =>
    ['tanggal', 'tgl', 'date', 'transaction date', 'trn date', 'tx date'].includes(normalizeHeader(s));

  const isDescHeader = (s: string) =>
    ['keterangan', 'uraian', 'description', 'desc', 'transaction description'].includes(normalizeHeader(s));

  const isBranchHeader = (s: string) =>
    ['cabang', 'branch', 'branch code'].includes(normalizeHeader(s));

  const isAmountHeader = (s: string) =>
    ['mutasi', 'amount', 'total amount', 'nominal'].includes(normalizeHeader(s));

  const isDebitHeader = (s: string) =>
    ['debet', 'debit', 'db', 'mutasi debet', 'mutasi debit'].includes(normalizeHeader(s));

  const isCreditHeader = (s: string) =>
    ['kredit', 'credit', 'cr', 'mutasi kredit', 'mutasi credit'].includes(normalizeHeader(s));

  const isBalanceHeader = (s: string) =>
    ['saldo', 'balance', 'running balance', 'saldo akhir'].includes(normalizeHeader(s));

  const detectNeedsYearPrompt = (rows: any[][]): boolean => {
    // 1. Check if period metadata exists with year
    for (let i = 0; i < Math.min(20, rows.length); i++) {
      const row = rows[i];
      if (!row) continue;
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j] || '');
        if (/Period(?:e)?\s*:\s*\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/i.test(cell)) {
          return false;
        }
      }
    }

    // 2. Identify date column
    let dateCol = -1;
    for (let i = 0; i < Math.min(25, rows.length); i++) {
      const row = rows[i];
      if (!row) continue;
      const colIdx = row.findIndex(c => isDateHeader(String(c || '')));
      if (colIdx !== -1) {
        dateCol = colIdx;
        break;
      }
    }

    if (dateCol === -1) return false;

    let hasDateWithoutYear = false;
    let hasDateWithYear = false;

    for (let i = 0; i < rows.length; i++) {
      const val = rows[i]?.[dateCol];
      if (typeof val === 'number') {
        hasDateWithYear = true;
        break;
      }
      const cell = String(val || '').trim();
      if (/^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}$/.test(cell)) {
        hasDateWithYear = true;
        break;
      } else if (/^\d{1,2}[.\/-]\d{1,2}$/.test(cell)) {
        hasDateWithoutYear = true;
      }
    }

    return hasDateWithoutYear && !hasDateWithYear;
  };

  const parseCSVLine = (line: string, delimiter: string = ';'): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  };

  const handleCSVUpload = async (file: File) => {
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const text = event.target?.result as string;

          // Auto-detect delimiter by checking first few lines
          const firstLines = text.split('\n').slice(0, 5).join('\n');
          const commaCount = (firstLines.match(/,/g) || []).length;
          const semicolonCount = (firstLines.match(/;/g) || []).length;
          const detectedDelimiter = commaCount > semicolonCount ? ',' : ';';


          const rows: any[][] = [];
          let currentLine = '';
          let inQuotes = false;

          for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (char === '"') {
              inQuotes = !inQuotes;
              currentLine += char;
            } else if (char === '\n' && !inQuotes) {
              if (currentLine.trim()) {
                const cells = parseCSVLine(currentLine, detectedDelimiter);
                rows.push(cells);
              }
              currentLine = '';
            } else if (char !== '\r') {
              currentLine += char;
            }
          }

          if (currentLine.trim()) {
            const cells = parseCSVLine(currentLine, detectedDelimiter);
            rows.push(cells);
          }

          // Only ask user for year when CSV genuinely contains dates without a year
          let statementYear: number | undefined = undefined;
          if (detectNeedsYearPrompt(rows)) {
            const currentYear = new Date().getFullYear();
            const userYear = prompt(`CSV contains dates without year (e.g., 01/12).\nWhich year is this statement for?`, String(currentYear));
            if (!userYear) {
              alert('❌ Year is required to process the CSV');
              return;
            }
            statementYear = parseInt(userYear);
            if (isNaN(statementYear) || statementYear < 2000 || statementYear > 2100) {
              alert('❌ Invalid year provided');
              return;
            }
          }

          // Stage 1: Parse and validate CSV data
          let parsedLines: StatementLine[] = [];
          let metadata: any = {};
          try {
            const parsed = parseStatementDataWithMetadata(rows, statementYear);
            parsedLines = parsed.lines;
            metadata = parsed.metadata;
          } catch (parseErr: any) {
            console.error('CSV parse/validation error:', parseErr);
            alert(`❌ CSV Validation Error: ${parseErr.message}`);
            return;
          }

          if (parsedLines.length === 0) {
            alert('No transactions found in the CSV file. Check that the file has date and amount columns.');
            return;
          }

          const stmtCurrency = metadata.currency || selectedAccount?.currency || 'IDR';
          if (selectedAccount?.currency && stmtCurrency !== selectedAccount.currency) {
            alert(`❌ Statement currency (${stmtCurrency}) does not match bank account currency (${selectedAccount.currency})`);
            return;
          }

          const totalDebits = parsedLines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
          const totalCredits = parsedLines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
          const openingBal = Number(metadata.openingBalance || 0);
          const computedClosing = openingBal + totalCredits - totalDebits;
          const finalLineBal = parsedLines[parsedLines.length - 1]?.balance;
          const closingBal = metadata.closingBalance && metadata.closingBalance !== 0
            ? Number(metadata.closingBalance)
            : (finalLineBal !== undefined && finalLineBal !== null ? Number(finalLineBal) : computedClosing);

          const dates = parsedLines.map(l => l.date).filter(Boolean).sort();
          const startDate = metadata.startDate || dates[0] || dateRange.start;
          const endDate = metadata.endDate || dates[dates.length - 1] || dateRange.end;

          if (startDate > endDate) {
            alert(`❌ Invalid statement date range: start date (${startDate}) is after end date (${endDate})`);
            return;
          }

          // Stage 2: Create statement upload record
          let uploadRecord: any = null;
          try {
            const { data, error: uploadError } = await supabase
              .from('bank_statement_uploads')
              .insert({
                bank_account_id: selectedBank,
                statement_period: metadata.period || `${new Date().toLocaleString('default', { month: 'long' })} ${new Date().getFullYear()}`,
                statement_start_date: startDate,
                statement_end_date: endDate,
                currency: stmtCurrency,
                opening_balance: openingBal,
                closing_balance: closingBal,
                total_debits: metadata.totalDebits || totalDebits,
                total_credits: metadata.totalCredits || totalCredits,
                transaction_count: parsedLines.length,
                status: 'completed',
              })
              .select()
              .single();

            if (uploadError) throw uploadError;
            uploadRecord = data;
          } catch (uploadErr: any) {
            console.error('Error creating statement upload record:', uploadErr);
            alert(`❌ Error creating statement upload record: ${uploadErr.message}`);
            return;
          }

          const { data: { user } } = await supabase.auth.getUser();

          const insertData = parsedLines.map(line => ({
            upload_id: uploadRecord.id,
            bank_account_id: selectedBank,
            transaction_date: line.date,
            description: line.description,
            reference: line.reference,
            debit_amount: line.debit,
            credit_amount: line.credit,
            running_balance: line.balance,
            statement_balance: line.balance,
            currency: stmtCurrency,
            reconciliation_status: 'unmatched',
            payment_kind: 'unclassified',
            created_by: user?.id,
          }));

          // Check for existing transactions using hash-equivalent matching (date + amounts + normalized full description + reference)
          const normalizeDesc = (desc: string) =>
            desc.toLowerCase().replace(/\s+/g, ' ').trim();

          const { data: existingLines } = await supabase
            .from('bank_statement_lines')
            .select('transaction_date, description, reference, debit_amount, credit_amount')
            .eq('bank_account_id', selectedBank);

          // Build keys with occurrence count to detect which exact occurrence already exists in DB
          // e.g. if "BIF BIAYA TXN 2500" appears 3x in DB, we skip the first 3 from CSV
          const dbKeyCounts = new Map<string, number>();
          (existingLines || []).forEach(e => {
            const k = `${e.transaction_date}|${Number(e.debit_amount)||0}|${Number(e.credit_amount)||0}|${(e.reference || '').trim().toLowerCase()}|${normalizeDesc(e.description||'')}`;
            dbKeyCounts.set(k, (dbKeyCounts.get(k) || 0) + 1);
          });

          const csvKeyCounts = new Map<string, number>();
          const skippedEntries: typeof insertData = [];
          const finalInsertData = insertData.filter(line => {
            const key = `${line.transaction_date}|${Number(line.debit_amount)||0}|${Number(line.credit_amount)||0}|${(line.reference || '').trim().toLowerCase()}|${normalizeDesc(line.description||'')}`;
            const csvOccurrence = csvKeyCounts.get(key) || 0;
            csvKeyCounts.set(key, csvOccurrence + 1);
            const dbCount = dbKeyCounts.get(key) || 0;
            if (csvOccurrence < dbCount) {
              skippedEntries.push(line);
              return false;
            }
            return true;
          });

          if (finalInsertData.length === 0) {
            setImportResult({
              totalInFile: insertData.length,
              importedCount: 0,
              skippedEntries,
            });
            setShowImportResultModal(true);
            return;
          }

          // Stage 3: Insert statement lines directly to preserve all legitimate lines
          let insertedCount = 0;
          try {
            const { data: inserted, error: insertError } = await supabase
              .from('bank_statement_lines')
              .insert(finalInsertData)
              .select();

            if (insertError) throw insertError;
            insertedCount = inserted?.length || 0;
          } catch (insertErr: any) {
            console.error('Error inserting statement lines:', insertErr);
            alert(`❌ Error importing statement lines: ${insertErr.message}`);
            return;
          }

          setImportResult({
            totalInFile: insertData.length,
            importedCount: insertedCount,
            skippedEntries,
          });
          setShowImportResultModal(true);

          // Stage 4: Reload statement lines and auto-match
          try {
            await loadStatementLines();
          } catch (loadError: any) {
            if (loadError?.name === 'AbortError' || loadError?.message?.includes('aborted')) {
              console.warn('loadStatementLines request was aborted (expected during fast refresh).');
            } else {
              console.error('Load statement lines error:', loadError);
            }
          }

          if (insertedCount > 0) {
            try {
              await autoMatchTransactions();
            } catch (matchError: any) {
              if (matchError?.name === 'AbortError' || matchError?.message?.includes('aborted')) {
                console.warn('autoMatchTransactions request was aborted.');
              } else {
                console.error('Auto-match error:', matchError);
              }
            }
          }
        } catch (err: any) {
          console.error('File upload workflow error:', err);
          if (err?.name !== 'AbortError' && !err?.message?.includes('aborted')) {
            alert(`❌ Error processing file: ${err.message}`);
          }
        }
      };
      reader.onerror = () => {
        console.error('FileReader error');
        alert('❌ Failed to read CSV file');
      };
      reader.readAsText(file);
    } catch (error: any) {
      console.error('CSV upload error:', error);
      alert(`❌ Failed to read CSV: ${error.message}`);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      alert('❌ No file selected');
      return;
    }
    if (!selectedBank) {
      alert('❌ Please select a bank account first');
      return;
    }
    if (!selectedAccount) {
      alert('❌ Bank account not loaded. Please refresh the page.');
      return;
    }

    setUploading(true);
    try {
      const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const isImage = file.type.startsWith('image/') || file.name.match(/\.(png|jpg|jpeg)$/i);
      const isCSV = file.name.toLowerCase().endsWith('.csv');

      if (isPDF) {
        await handlePDFUpload(file);
      } else if (isImage) {
        await handlePDFUpload(file, true);
      } else if (isCSV) {
        await handleCSVUpload(file);
      } else {
        await handleExcelUpload(file);
      }
    } catch (uploadError) {
      console.error('File upload error:', uploadError);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handlePDFUpload = async (file: File, useOCR = false, previewOnly = false) => {
    try {
      setUploading(true);
      setOcrError(null);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('bankAccountId', selectedBank);
      if (useOCR) {
        formData.append('useOCR', 'true');
      }
      if (previewOnly) {
        formData.append('previewOnly', 'true');
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-bca-statement`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: formData,
        }
      );

      const result = await response.json();

      if (!response.ok) {
        if (result.canUseOCR) {
          setOcrError({
            message: result.error,
            canUseOCR: true,
            suggestions: result.suggestions
          });
          setLastUploadedFile(file);
        } else {
          throw new Error(result.error || 'Failed to parse PDF');
        }
        return;
      }

      if (result.preview) {
        setOcrPreview(result);
        return;
      }

      const ocrUsed = result.usedOCR ? ' (via OCR)' : '';
      let message = `✅ Import complete from ${result.period}${ocrUsed}\n`;
      message += `   Imported: ${result.insertedCount || result.transactionCount} transaction(s)`;
      if (result.duplicateCount > 0) {
        message += `\n   Skipped (duplicates): ${result.duplicateCount} transaction(s)`;
      }
      alert(message);
      setOcrError(null);
      setLastUploadedFile(null);

      try {
        await loadStatementLines();
      } catch (loadError) {
        console.error('Load statement lines error:', loadError);
      }

      const insertedCount = result.insertedCount || result.transactionCount || 0;
      if (insertedCount > 0) {
        try {
          await autoMatchTransactions();
        } catch (matchError) {
          console.error('Auto-match error:', matchError);
        }
      }
    } catch (error: any) {
      console.error('PDF upload error:', error);
      alert(`❌ Failed to parse PDF: ${error.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleRunOCR = async () => {
    if (!lastUploadedFile) return;
    setUploading(true);
    setOcrError(null);
    try {
      await handlePDFUpload(lastUploadedFile, true, true);
    } catch (error: any) {
      alert(`❌ OCR failed: ${error.message}`);
      setUploading(false);
    }
  };

  const handleConfirmOCRPreview = async () => {
    if (!lastUploadedFile) return;
    setOcrPreview(null);
    setUploading(true);
    try {
      await handlePDFUpload(lastUploadedFile, true, false);
    } catch (error: any) {
      alert(`❌ Failed to save: ${error.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleExcelUpload = async (file: File) => {
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const data = event.target?.result;
          const workbook = XLSX.read(data, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

          const { lines, metadata } = parseStatementDataWithMetadata(jsonData);

          if (lines.length === 0) {
            alert('No valid transactions found in the file. Confirm the statement has a date column and transaction rows.');
            return;
          }

          const stmtCurrency = metadata.currency || selectedAccount?.currency || 'IDR';
          if (selectedAccount?.currency && stmtCurrency !== selectedAccount.currency) {
            alert(`❌ Statement currency (${stmtCurrency}) does not match bank account currency (${selectedAccount.currency})`);
            return;
          }

          const totalDebits = lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
          const totalCredits = lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
          const openingBal = Number(metadata.openingBalance || 0);
          const computedClosing = openingBal + totalCredits - totalDebits;
          const finalLineBal = lines[lines.length - 1]?.balance;
          const closingBal = metadata.closingBalance && metadata.closingBalance !== 0
            ? Number(metadata.closingBalance)
            : (finalLineBal !== undefined && finalLineBal !== null ? Number(finalLineBal) : computedClosing);

          const dates = lines.map(l => l.date).filter(Boolean).sort();
          const startDate = metadata.startDate || dates[0] || dateRange.start;
          const endDate = metadata.endDate || dates[dates.length - 1] || dateRange.end;

          if (startDate > endDate) {
            alert(`❌ Invalid statement date range: start date (${startDate}) is after end date (${endDate})`);
            return;
          }

          const { data: uploadRecord, error: uploadError } = await supabase
            .from('bank_statement_uploads')
            .insert({
              bank_account_id: selectedBank,
              statement_period: metadata.period || `${new Date().toLocaleString('default', { month: 'long' })} ${new Date().getFullYear()}`,
              statement_start_date: startDate,
              statement_end_date: endDate,
              currency: stmtCurrency,
              opening_balance: openingBal,
              closing_balance: closingBal,
              total_debits: metadata.totalDebits || totalDebits,
              total_credits: metadata.totalCredits || totalCredits,
              transaction_count: lines.length,
              status: 'completed',
            })
            .select()
            .single();

          if (uploadError) throw uploadError;

          const { data: { user } } = await supabase.auth.getUser();

          const insertData = lines.map(line => ({
            upload_id: uploadRecord.id,
            bank_account_id: selectedBank,
            transaction_date: line.date,
            description: line.description,
            reference: line.reference,
            debit_amount: line.debit,
            credit_amount: line.credit,
            running_balance: line.balance,
            statement_balance: line.balance,
            currency: stmtCurrency,
            reconciliation_status: 'unmatched',
            payment_kind: 'unclassified',
            created_by: user?.id,
          }));

          // Check for potential duplicates first
          const { data: existingLines } = await supabase
            .from('bank_statement_lines')
            .select('transaction_date, description, debit_amount, credit_amount, running_balance')
            .eq('bank_account_id', selectedBank);

          // Find duplicates by matching date, amounts, and description
          const duplicates = insertData.filter(newLine =>
            existingLines?.some(existing =>
              existing.transaction_date === newLine.transaction_date &&
              existing.description === newLine.description &&
              existing.debit_amount === newLine.debit_amount &&
              existing.credit_amount === newLine.credit_amount &&
              existing.running_balance === newLine.running_balance
            )
          );

          let finalInsertData = insertData;

          if (duplicates.length > 0) {
            // Show duplicates to user
            let dupMessage = `⚠️ Found ${duplicates.length} potential duplicate transaction(s):\n\n`;
            duplicates.slice(0, 5).forEach((dup, idx) => {
              const date = new Date(dup.transaction_date).toLocaleDateString('en-GB');
              const amt = dup.debit_amount || dup.credit_amount;
              dupMessage += `${idx + 1}. ${date} - ${dup.description.substring(0, 40)} - ${formatCurrency(amt, selectedAccount?.currency)}\n`;
            });
            if (duplicates.length > 5) {
              dupMessage += `... and ${duplicates.length - 5} more\n`;
            }
            dupMessage += `\nDo you want to ADD them anyway?\n(Click OK to add, Cancel to skip duplicates)`;

            const userWantsToAdd = confirm(dupMessage);

            if (!userWantsToAdd) {
              // Filter out duplicates
              finalInsertData = insertData.filter(newLine =>
                !existingLines?.some(existing =>
                  existing.transaction_date === newLine.transaction_date &&
                  existing.description === newLine.description &&
                  existing.debit_amount === newLine.debit_amount &&
                  existing.credit_amount === newLine.credit_amount &&
                  existing.running_balance === newLine.running_balance
                )
              );
            }
          }

          if (finalInsertData.length === 0) {
            alert('ℹ️ No new transactions to import (all were duplicates and skipped)');
            return;
          }

          const { data: inserted, error: insertError } = await supabase
            .from('bank_statement_lines')
            .insert(finalInsertData)
            .select();

          if (insertError) {
            console.error('Insert error:', insertError);
            throw insertError;
          }

          const insertedCount = inserted?.length || 0;
          const skippedCount = insertData.length - finalInsertData.length;

          let message = `✅ Excel Import complete!\n`;
          message += `   Total processed: ${insertData.length} transaction(s)\n`;
          message += `   New transactions added: ${insertedCount}\n`;
          if (skippedCount > 0) {
            message += `   Duplicates skipped: ${skippedCount}`;
          }
          alert(message);

          try {
            await loadStatementLines();
          } catch (loadError) {
            console.error('Load statement lines error:', loadError);
          }

          if (insertedCount > 0) {
            try {
              await autoMatchTransactions();
            } catch (matchError) {
              console.error('Auto-match error:', matchError);
            }
          }
        } catch (err: any) {
          console.error('Error parsing file:', err);
          alert('❌ Failed to parse file: ' + err.message);
        }
      };
      reader.readAsBinaryString(file);
    } catch (error: any) {
      console.error('Excel upload error:', error);
      alert(`❌ Failed to process file: ${error.message}`);
    }
  };

  const parseStatementDataWithMetadata = (rows: any[][], providedYear?: number): { lines: StatementLine[]; metadata: any } => {
    const lines: StatementLine[] = [];
    const metadata: any = {
      period: '',
      startDate: '',
      endDate: '',
      openingBalance: 0,
      closingBalance: 0,
      totalDebits: 0,
      totalCredits: 0,
      currency: '',
    };

    let fileYear = providedYear || null;

    // 1. Pre-scan for metadata (Period, Currency)
    for (let i = 0; i < Math.min(25, rows.length); i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j] || '').trim();
        if (!cell) continue;

        const pMatch = cell.match(/Period(?:e)?\s*:\s*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})\s*-\s*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/i);
        if (pMatch) {
          const sDay = parseInt(pMatch[1]), sMon = parseInt(pMatch[2]);
          let sYr = parseInt(pMatch[3]);
          const eDay = parseInt(pMatch[4]), eMon = parseInt(pMatch[5]);
          let eYr = parseInt(pMatch[6]);
          if (sYr < 100) sYr += 2000;
          if (eYr < 100) eYr += 2000;
          fileYear = sYr;
          metadata.startDate = `${sYr}-${String(sMon).padStart(2, '0')}-${String(sDay).padStart(2, '0')}`;
          metadata.endDate = `${eYr}-${String(eMon).padStart(2, '0')}-${String(eDay).padStart(2, '0')}`;
          const monthNames = ['', 'JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];
          metadata.period = `${monthNames[sMon] || sMon} ${sYr}`;
        }

        const cMatch = cell.match(/(?:Currency Code|Mata Uang)\s*:\s*([A-Za-z]+)/i);
        if (cMatch) {
          const rawC = cMatch[1].toUpperCase();
          metadata.currency = rawC === 'RP' ? 'IDR' : rawC;
        }
      }
    }

    // 2. Identify header row
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(25, rows.length); i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      if (row.some(isDateHeader) && (row.some(isDescHeader) || row.some(isAmountHeader) || row.some(isDebitHeader))) {
        headerRowIdx = i;
        break;
      }
    }

    if (headerRowIdx === -1) {
      return { lines, metadata };
    }

    const headerRow = rows[headerRowIdx];
    let dateCol = -1, descCol = -1, branchCol = -1, amountCol = -1, balanceCol = -1;
    let debitCol = -1, creditCol = -1;

    headerRow.forEach((cell: any, idx: number) => {
      const s = String(cell || '');
      if (isDateHeader(s)) dateCol = idx;
      else if (isDescHeader(s)) descCol = idx;
      else if (isBranchHeader(s)) branchCol = idx;
      else if (isDebitHeader(s)) debitCol = idx;
      else if (isCreditHeader(s)) creditCol = idx;
      else if (isAmountHeader(s)) amountCol = idx;
      else if (isBalanceHeader(s)) balanceCol = idx;
    });

    if (dateCol === -1) {
      return { lines, metadata };
    }

    // Pre-scan date column if fileYear is not yet known
    if (!fileYear) {
      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const cell = String(rows[i]?.[dateCol] || '').trim();
        const m = cell.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
        if (m) {
          const yr = parseInt(m[3]);
          fileYear = yr < 100 ? (yr < 70 ? 2000 + yr : 1900 + yr) : yr;
          break;
        }
      }
    }

    const defaultYear = fileYear || providedYear || new Date().getFullYear();

    // 3. Process transaction rows
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0 || row.every((c: any) => !String(c || '').trim())) continue;

      const rowText = row.map((c: any) => String(c || '').toUpperCase().trim()).join(' ');

      if (rowText.includes('SALDO AWAL') || rowText.includes('START BALANCE') || rowText.includes('OPENING BALANCE')) {
        continue;
      }

      if (
        rowText.includes('MUTASI DEBET') ||
        rowText.includes('MUTASI DEBIT') ||
        rowText.includes('MUTASI KREDIT') ||
        rowText.includes('MUTASI CREDIT') ||
        rowText.includes('MUTASI DB') ||
        rowText.includes('MUTASI CR') ||
        rowText.includes('SALDO AKHIR') ||
        rowText.includes('LAST BALANCE') ||
        rowText.includes('CLOSING BALANCE') ||
        rowText.includes('ENDING BALANCE')
      ) {
        break;
      }

      const dateVal = row[dateCol];
      if (!dateVal || !String(dateVal).trim()) continue;

      let parsedDate = '';
      if (typeof dateVal === 'number') {
        const excelEpoch = new Date(1900, 0, 1);
        const daysOffset = dateVal - 2;
        const jsDate = new Date(excelEpoch.getTime() + daysOffset * 24 * 60 * 60 * 1000);
        parsedDate = `${jsDate.getFullYear()}-${String(jsDate.getMonth() + 1).padStart(2, '0')}-${String(jsDate.getDate()).padStart(2, '0')}`;
      } else {
        const dateStr = String(dateVal).trim();
        const fullDateMatch = dateStr.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
        const numericMatch = dateStr.match(/^(\d{1,2})[.\/-](\d{1,2})$/);
        const namedMatch = dateStr.match(/^(\d{1,2})[-\s]([A-Za-z]{3,4})(?:[-\s](\d{2,4}))?$/);
        const monthNames: Record<string, number> = {
          jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5,
          jun: 6, jul: 7, aug: 8, agu: 8, ags: 8, sep: 9,
          oct: 10, okt: 10, nov: 11, dec: 12, des: 12
        };

        let day = 0, mon = 0, yr = defaultYear;

        if (fullDateMatch) {
          day = parseInt(fullDateMatch[1]);
          mon = parseInt(fullDateMatch[2]);
          const rawYr = parseInt(fullDateMatch[3]);
          yr = rawYr < 100 ? (rawYr < 70 ? 2000 + rawYr : 1900 + rawYr) : rawYr;
        } else if (numericMatch) {
          day = parseInt(numericMatch[1]);
          mon = parseInt(numericMatch[2]);
        } else if (namedMatch) {
          day = parseInt(namedMatch[1]);
          mon = monthNames[namedMatch[2].toLowerCase()] || 0;
          if (namedMatch[3]) {
            const rawYr = parseInt(namedMatch[3]);
            yr = rawYr < 100 ? (rawYr < 70 ? 2000 + rawYr : 1900 + rawYr) : rawYr;
          }
        }

        if (day < 1 || day > 31 || mon < 1 || mon > 12) {
          continue;
        }

        parsedDate = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }

      let debit = 0, credit = 0;
      if (debitCol >= 0 && creditCol >= 0) {
        const debitStr = String(row[debitCol] || '').trim();
        const creditStr = String(row[creditCol] || '').trim();
        debit = parseIndonesianNumber(debitStr);
        credit = parseIndonesianNumber(creditStr);
      } else if (amountCol >= 0) {
        const rawAmountStr = String(row[amountCol] || '').trim();
        let isCR = /\bCR\b/i.test(rawAmountStr);
        let isDB = /\bDB\b/i.test(rawAmountStr);

        if (!isCR && !isDB) {
          for (let c = 0; c < row.length; c++) {
            if (c === amountCol || c === dateCol || c === descCol || c === branchCol || c === balanceCol) continue;
            const cellVal = String(row[c] || '').trim();
            if (/^CR$/i.test(cellVal)) { isCR = true; break; }
            if (/^DB$/i.test(cellVal)) { isDB = true; break; }
          }
        }

        const cleanAmountStr = rawAmountStr.replace(/\b(CR|DB)\b/gi, '').trim();
        const amount = parseIndonesianNumber(cleanAmountStr);

        if (isCR) {
          credit = amount;
          debit = 0;
        } else if (isDB) {
          debit = amount;
          credit = 0;
        } else {
          debit = 0;
          credit = 0;
        }
      }

      let balance = 0;
      if (balanceCol >= 0 && row[balanceCol] !== undefined && row[balanceCol] !== null && String(row[balanceCol]).trim() !== '') {
        balance = parseIndonesianNumber(row[balanceCol]);
      }

      // Collect multi-column description and details (e.g. BCA statements where col 1 has
      // generic "TRSF E-BANKING DB" and subsequent unassigned column has beneficiary/salary details)
      const descParts: string[] = [];
      if (descCol >= 0 && row[descCol] !== undefined && row[descCol] !== null) {
        const primary = String(row[descCol] || '').trim();
        if (primary) descParts.push(primary);
      }

      let extraRef = '';
      for (let c = 0; c < row.length; c++) {
        if (
          c === descCol ||
          c === dateCol ||
          c === branchCol ||
          c === debitCol ||
          c === creditCol ||
          c === amountCol ||
          c === balanceCol
        ) {
          continue;
        }

        const cellVal = String(row[c] || '').trim();
        if (!cellVal) continue;

        // Skip standalone CR or DB indicator columns
        if (/^(CR|DB)$/i.test(cellVal)) continue;

        // Capture slip or account ref format (e.g. "0516990-0") if present
        if (/^\d{6,10}-\d+$/.test(cellVal) && !extraRef) {
          extraRef = cellVal;
        }

        descParts.push(cellVal);
      }

      const rawDescription = descParts.join(' ').replace(/\s+/g, ' ').trim();
      const branch = branchCol >= 0 ? String(row[branchCol] || '').trim() : '';

      let reference = branch || extraRef;
      if (!reference) {
        const refMatch = rawDescription.match(/\b(\d{4}\/[A-Z0-9]+\/[A-Z0-9]+)\b/);
        if (refMatch) {
          reference = refMatch[1];
        }
      }

      const description = rawDescription;

      const numDebit = Number(debit) || 0;
      const numCredit = Number(credit) || 0;
      const isValid = (numDebit > 0 && numCredit === 0) || (numCredit > 0 && numDebit === 0);

      if (!isValid) {
        throw new Error(
          `Bank statement line at row ${i + 1} (${parsedDate}) must have exactly one positive debit or credit amount. Found debit=${numDebit}, credit=${numCredit}. Raw values: [${row.map((c: any) => String(c ?? '')).join(' | ')}]`
        );
      }

      lines.push({
        id: `temp-${i}`,
        date: parsedDate,
        description,
        reference,
        debit: numDebit,
        credit: numCredit,
        balance,
        currency: metadata.currency || selectedAccount?.currency || 'IDR',
        status: 'unmatched',
        allocatedAmount: 0,
        remainingAmount: numDebit || numCredit,
        allocations: [],
      });
    }

    // 4. Summary metadata balances scan
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const rowJoined = row.map((c: any) => String(c || '').trim()).join(' ');

      const mStart = rowJoined.match(/(?:Saldo\s*Awal|Start\s*Balance)\s*[:=]?\s*([\d,.]+)/i);
      if (mStart) metadata.openingBalance = parseIndonesianNumber(mStart[1]);

      const mDebit = rowJoined.match(/(?:Mutasi\s*Deb[ei]t|Mutasi\s*DB)\s*[:=]?\s*([\d,.]+)/i);
      if (mDebit) metadata.totalDebits = parseIndonesianNumber(mDebit[1]);

      const mCredit = rowJoined.match(/(?:Mutasi\s*Kredit|Mutasi\s*Credit|Mutasi\s*CR)\s*[:=]?\s*([\d,.]+)/i);
      if (mCredit) metadata.totalCredits = parseIndonesianNumber(mCredit[1]);

      const mLast = rowJoined.match(/(?:Saldo\s*Akhir|Last\s*Balance|Ending\s*Balance|Closing\s*Balance)\s*[:=]?\s*([\d,.]+)/i);
      if (mLast) metadata.closingBalance = parseIndonesianNumber(mLast[1]);
    }

    return { lines, metadata };
  };

  const autoMatchTransactions = async () => {
    if (!selectedBank || autoMatching) return;

    setAutoMatching(true);
    selfActionTimestampRef.current = Date.now();
    try {
      // Use the database function that enforces 7-day date tolerance
      const { data, error } = await supabase.rpc('auto_match_smart');

      if (error) throw error;

      const result = data?.[0];
      const matchedCount = result?.matched_count || 0;
      const suggestedCount = result?.suggested_count || 0;
      const skippedCount = result?.skipped_count || 0;

      await loadStatementLines();

      if (suggestedCount > 0 && activeFilter === 'unmatched') {
        setActiveFilter('suggested');
      }

      setActionFeedback({
        type: 'success',
        title: 'Auto-match completed successfully',
        details: [
          { label: 'Matched', value: `${matchedCount}` },
          { label: 'Needs Review', value: `${suggestedCount}` },
          { label: 'Unmatched / Skipped', value: `${skippedCount}` },
          { label: 'Tolerance', value: '±7 days maximum' },
        ],
        timestamp: Date.now(),
      });
    } catch (err: any) {
      if (err?.name === 'AbortError' || err?.message?.includes('aborted')) {
        console.warn('Auto-match request was aborted.');
      } else {
        console.error('Error auto-matching:', err);
        setActionFeedback({
          type: 'error',
          title: 'Auto-match failed',
          message: err?.message || 'Unknown error occurred',
          timestamp: Date.now(),
        });
      }
    } finally {
      setAutoMatching(false);
    }
  };

  const previewClearData = async () => {
    if (!selectedBank) return;

    try {
      const { data, error } = await supabase.rpc('preview_bank_statement_delete', {
        p_bank_account_id: selectedBank,
        p_start_date: dateRange.start,
        p_end_date: dateRange.end,
      });

      if (error) throw error;

      setDeletePreview(data);
      setShowDeleteModal(true);
    } catch (err: any) {
      console.error('Error previewing delete:', err);
      alert('❌ Failed to preview: ' + err.message);
    }
  };

  const executeClearData = async () => {
    if (!selectedBank || !deletePreview) return;

    try {
      const { data, error } = await supabase.rpc('safe_delete_bank_statement_lines', {
        p_bank_account_id: selectedBank,
        p_start_date: dateRange.start,
        p_end_date: dateRange.end,
      });

      if (error) throw error;

      if (data.success) {
        alert(`✅ Successfully deleted ${data.deleted_count} unmatched transaction(s)`);
        setShowDeleteModal(false);
        setDeletePreview(null);
        await loadStatementLines();
      } else {
        alert(`❌ ${data.error}`);
      }
    } catch (err: any) {
      console.error('Error clearing data:', err);
      alert('❌ Failed to clear data: ' + err.message);
    }
  };

  const confirmMatch = async (lineId: string) => {
    try {
      // Confirm through the canonical link command so suggestions receive the
      // same posting, bank-account, direction, and amount validation as every
      // manual Link Existing action.
      const { data: bsl } = await supabase
        .from('bank_statement_lines')
        .select('id, matched_expense_id, matched_receipt_id, matched_payment_id, matched_petty_cash_id, matched_fund_transfer_id, matched_tax_payment_id, matched_entry_id')
        .eq('id', lineId)
        .maybeSingle();

      if (!bsl) throw new Error('Row not found');

      if (!(bsl.matched_expense_id || bsl.matched_receipt_id || bsl.matched_payment_id || bsl.matched_petty_cash_id || bsl.matched_fund_transfer_id || bsl.matched_tax_payment_id || bsl.matched_entry_id)) {
        setActionFeedback({
          type: 'error',
          title: 'Cannot confirm match',
          message: 'No suggested link found on this row.',
          timestamp: Date.now(),
        });
        return;
      }

      if (bsl.matched_expense_id) {
        const { data: exp } = await supabase
          .from('finance_expenses')
          .select('id, voucher_number, approval_status')
          .eq('id', bsl.matched_expense_id)
          .maybeSingle();

        if (exp?.approval_status === 'pending_approval') {
          setActionFeedback({
            type: 'error',
            title: 'Expense pending approval',
            message: `Expense ${exp.voucher_number || ''} is pending approval.\n\nPlease approve the expense in Finance Expenses before confirming this match.\n\nBank transactions cannot automatically approve pending expenses.`,
            timestamp: Date.now(),
          });
          return;
        }

        if (exp?.approval_status === 'rejected' || exp?.approval_status === 'cancelled') {
          setActionFeedback({
            type: 'error',
            title: `Expense ${exp.approval_status}`,
            message: `Expense ${exp.voucher_number || ''} is ${exp.approval_status}.\n\nCannot confirm match for a ${exp.approval_status} expense. Please reject this suggestion to unlink or resolve the expense.`,
            timestamp: Date.now(),
          });
          return;
        }
        await linkBankStatementLine(lineId, 'expense', bsl.matched_expense_id);
      }
      else if (bsl.matched_receipt_id) await linkBankStatementLine(lineId, 'receipt', bsl.matched_receipt_id);
      else if (bsl.matched_payment_id) await linkBankStatementLine(lineId, 'payment', bsl.matched_payment_id);
      else if (bsl.matched_fund_transfer_id) await linkBankStatementLine(lineId, 'fund_transfer', bsl.matched_fund_transfer_id);
      else if (bsl.matched_petty_cash_id) await linkBankStatementLine(lineId, 'petty_cash', bsl.matched_petty_cash_id);
      else if (bsl.matched_tax_payment_id) await linkBankStatementLine(lineId, 'tax_payment', bsl.matched_tax_payment_id);
      else if (bsl.matched_entry_id) await linkBankStatementLine(lineId, 'journal', bsl.matched_entry_id);

      // Reload the canonical links/status. This is important for fund
      // transfers, where the RPC also writes matched_entry_id and may clear
      // the legacy single-owner fields when allocations are plural.
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      setActionFeedback({
        type: 'success',
        title: 'Match confirmed successfully',
        timestamp: Date.now(),
      });
    } catch (err: any) {
      console.error('Error confirming match:', err);
      setActionFeedback({
        type: 'error',
        title: 'Failed to confirm match',
        message: err?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const rejectMatch = async (lineId: string) => {
    try {
      await unlinkBankStatementLine(lineId);

      await loadStatementLines();
    } catch (err) {
      console.error('Error rejecting match:', err);
    }
  };

  const handleForceImport = async () => {
    if (!importResult?.skippedEntries?.length) return;
    setForceImporting(true);
    try {
      // Preserve the upload_id captured when the entry was first parsed.
      // Each skippedEntries[i] already carries the bank_statement_uploads.id
      // that was inserted moments earlier in the same import run (see the
      // CSV import path where insertData is built with upload_id:
      // uploadRecord.id and then split into finalInsertData + skippedEntries).
      // The previous version overwrote this valid FK with crypto.randomUUID(),
      // which does not reference any row in bank_statement_uploads and
      // therefore violated bank_statement_lines_upload_id_fkey.
      const missingUploadId = importResult.skippedEntries.some(e => !e?.upload_id);
      if (missingUploadId) {
        alert('❌ Force import cannot proceed: the original upload record is missing. Please re-run the import.');
        return;
      }
      const forceData = importResult.skippedEntries.map(entry => ({
        ...entry,
        transaction_hash: `${(entry as any).transaction_hash || crypto.randomUUID()}_override_${Date.now()}`,
        notes: 'Force imported (duplicate override)',
      }));
      const { data: inserted, error } = await supabase
        .from('bank_statement_lines')
        .insert(forceData)
        .select();
      if (error) throw error;
      setShowImportResultModal(false);
      setImportResult(null);
      try { await loadStatementLines(); } catch { /* Import succeeded; refresh can be retried. */ }
      if (inserted?.length) {
        try { await autoMatchTransactions(); } catch { /* Auto-match failure does not invalidate import. */ }
      }
      alert(`✅ Force import complete! ${inserted?.length || 0} entries added.`);
    } catch (err: any) {
      alert(`❌ Force import failed: ${err.message}`);
    } finally {
      setForceImporting(false);
    }
  };

  const openRecordModal = (line: StatementLine) => {
    setRecordingLine(line);
    setReceiptType('');
    setReceiptCustomerId('');
    setReceiptInvoices([]);
    setReceiptAllocations({});
    setRecordExchangeRate(line.currency === 'USD' ? 0 : 1);
    setRecordLoanDebit(false);
    setRecordLoanRepayment(false);
    setRecordDirectorLoanWithdrawal(false);
    setRecordDirectorRelatedParty(false);
    setSelectedDirectorName('Vijay Lunkad');
    setDirectorNotes(line.description || '');
    setDirectorSummary(null);
    setLinkToExpense(false);
    setLinkJournalEntry(false);
    setLinkToSupplierPayment(false);
    setLinkToTaxPayment(false);
    setLinkSettleBills(false);

    const initialDir: 'given' | 'taken' = line.debit > 0 ? 'given' : 'taken';
    setLoanDirection(initialDir);
    setLoanCounterparty('');
    setLoanCoaId('');
    loadLoanAccounts(initialDir);

    setRecordModal(true);
  };

  const handleRecordExpense = async (line: StatementLine, category: string, description: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');

      // Recording a new expense is a document-creation action, not an
      // approval action.  Saving it as pending keeps the creator from
      // accidentally self-approving; the bank line can be linked after an
      // authorized approver posts the expense.
      const savedExpense = await saveFinanceExpense(null, {
        expense_category: category,
        expense_type: 'admin',
        amount: line.debit,
        expense_date: line.date,
        description: description || line.description,
        payment_method: 'bank_transfer',
        bank_account_id: selectedBank,
        payment_reference: line.reference || null,
        transaction_currency: line.currency as 'IDR' | 'USD',
        functional_currency: 'IDR',
        exchange_rate: line.currency === 'IDR' ? 1 : recordExchangeRate,
        approval_status: 'pending_approval',
        created_by: user.id,
      });

      setRecordModal(false);
      setRecordingLine(null);
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
      setActionFeedback({
        type: 'success',
        title: 'Expense recorded as pending',
        message: 'An authorized approver must approve it before this bank transaction can be linked.',
        details: [
          { label: 'Expense ID', value: typeof savedExpense === 'string' ? savedExpense.slice(0, 8) : 'Generated' },
          { label: 'Amount', value: formatCurrency(line.debit, line.currency) },
          { label: 'Category', value: category },
          { label: 'Date', value: new Date(line.date).toLocaleDateString('id-ID') },
          { label: 'Status', value: 'Pending Approval' },
        ],
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error recording expense:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to record expense',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const handleLinkToExpense = async (line: StatementLine, expenseId: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const postingState = await getEffectiveExpensePostingState(expenseId);
      if (!isEffectiveExpensePosting(postingState?.effective_posting_state)) {
        throw new Error('This expense is already reversed/replaced without an effective payable path and cannot receive a new bank allocation.');
      }

      const { data: exp, error: expenseError } = await supabase
          .from('finance_expenses')
          .select('amount, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, expense_category, broker_items, paid_amount, pph_paid_amount')
          .eq('id', expenseId)
          .single();
      if (expenseError || !exp) throw expenseError || new Error('Expense not found');
      // For import_broker expenses, the client-side broker_items JSONB may not
      // fully deserialize from PostgREST (e.g. null on some payloads), which
      // makes calculateCanonicalCashPayable omit reimbursement lines. Use the
      // authoritative DB function calculate_finance_expense_payable — the same
      // canonical function used by the Expense Manager and the database
      // triggers — so the reconciliation modal matches the Expense screen.
      let canonicalPayable: number;
      if (exp.expense_category === 'import_broker' && linkPaymentKind === 'supplier') {
        const { data: rpcPayable, error: rpcError } = await supabase
          .rpc('calculate_finance_expense_payable', { p_expense_id: expenseId });
        if (rpcError) throw rpcError;
        canonicalPayable = Number(rpcPayable) || 0;
      } else {
        canonicalPayable = calculateCanonicalCashPayable(exp);
      }
      const documentOutstanding = linkPaymentKind === 'supplier'
        ? Math.max(0, canonicalPayable - Number(exp.paid_amount || 0))
        : Math.max(0, Number(exp.pph_amount || 0) - Number(exp.pph_paid_amount || 0));
      const amount = Math.min(line.remainingAmount, documentOutstanding);
      if (amount <= 0.01) throw new Error('No remaining amount is available to allocate.');
      setPendingExpenseAllocation({
        line,
        expense: { ...exp, id: expenseId },
        amount,
        bankAfter: Math.max(0, line.remainingAmount - amount),
        documentAfter: Math.max(0, documentOutstanding - amount),
      });
    } catch (error: any) {
      console.error('Error preparing expense allocation:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to prepare expense allocation',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const confirmExpenseAllocation = async () => {
    if (!pendingExpenseAllocation) return;
    const { line, expense, amount } = pendingExpenseAllocation;
    try {
      await linkBankStatementLine(line.id, 'expense', expense.id, linkPaymentKind, amount);
      setPendingExpenseAllocation(null);

      setRecordModal(false);
      setRecordingLine(null);
      setLinkToExpense(false);
      setLinkPaymentKind('supplier');
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
      setActionFeedback({
        type: 'success',
        title: 'Linked to expense successfully',
        details: [
          { label: 'Allocated Amount', value: formatCurrency(amount, line.currency) },
          { label: 'Payment Kind', value: linkPaymentKind === 'supplier' ? 'Supplier' : 'PPh' },
          { label: 'Status', value: 'Confirmed' },
        ],
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error linking to expense:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to link to expense',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const loadCustomerInvoices = async (custId: string) => {
    setLoadingInvoices(true);
    try {
      const { data } = await supabase
        .rpc('get_invoices_with_balance', {
          customer_uuid: custId,
          exclude_voucher_uuid: null
        });
      const unpaid = (data || []).filter((inv: any) => inv.balance_amount > 0);
      setReceiptInvoices(unpaid);
    } catch (err) {
      console.error('Error loading invoices:', err);
    } finally {
      setLoadingInvoices(false);
    }
  };

  const loadExistingReceipts = async () => {
    try {
      const [{ data: allReceipts, error }, linked] = await Promise.all([
        supabase
        .from('receipt_vouchers')
        .select('id, voucher_number, voucher_date, amount, journal_entry_id, customer_id, customers(company_name)')
        .eq('is_posted', true)
        .not('journal_entry_id', 'is', null)
        .order('voucher_date', { ascending: false })
        .limit(100),
        loadLinkedDocumentIds(recordingLine?.id),
      ]);
      if (error) throw error;

      setExistingReceipts(rankBankCandidates(
        (allReceipts || []).map((receipt: any) => ({
          ...receipt,
          _linked: linked.receiptIds.has(receipt.id) || linked.journalIds.has(receipt.journal_entry_id),
          _linkedReason: 'Already linked to another bank statement line',
        })),
        recordingLine!,
        (receipt) => Number(receipt.amount || 0),
        (receipt) => receipt.voucher_date,
        (receipt) => receipt.customers?.company_name,
      ));
    } catch (err) {
      console.error('Error loading receipts:', err);
    }
  };

  const handleRecordLoan = async (line: StatementLine) => {
    if (!loanCounterparty.trim()) {
      setActionFeedback({
        type: 'error',
        title: 'Missing counterparty',
        message: 'Enter the counterparty name for this loan.',
        timestamp: Date.now(),
      });
      return;
    }
    if (!loanCoaId) {
      setActionFeedback({
        type: 'error',
        title: 'Missing account',
        message: 'Select the accounting account for this loan.',
        timestamp: Date.now(),
      });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');

      const isBank = /bank|bca|mandiri|bni|bri|cimb|danamon|permata|uob/i.test(loanCounterparty.trim());
      const counterpartyType = isBank ? 'bank' : 'person';
      const principalAmount = line.debit > 0 ? line.debit : line.credit;
      const selectedAccount = loanAccounts.find(a => a.id === loanCoaId);

      const result = await saveFinanceLoan({
        loan_date: line.date,
        counterparty_name: loanCounterparty.trim(),
        counterparty_type: counterpartyType,
        loan_type: loanDirection,
        coa_id: loanCoaId,
        principal_amount: principalAmount,
        bank_account_id: selectedBank,
        transaction_currency: line.currency as 'IDR' | 'USD',
        exchange_rate: line.currency === 'IDR' ? 1 : recordExchangeRate,
        description: line.description,
        created_by: user.id,
      }, line.id);

      setRecordModal(false);
      setRecordingLine(null);
      setRecordLoanDebit(false);
      setLoanCounterparty('');
      setLoanCoaId('');

      // Optimistic local line update
      setStatementLines(prev => prev.map(l => l.id === line.id ? {
        ...l,
        status: 'recorded',
        reconciliation_status: 'recorded',
        matching_status: 'confirmed',
        remainingAmount: 0,
        allocatedAmount: principalAmount,
      } : l));

      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();

      setActionFeedback({
        type: 'success',
        title: 'LOAN RECORDED SUCCESSFULLY',
        details: [
          { label: 'Counterparty', value: loanCounterparty.trim() },
          { label: 'Direction', value: loanDirection === 'given' ? 'Loan Given' : 'Loan Received' },
          { label: 'Amount', value: formatCurrency(principalAmount, line.currency) },
          { label: 'Account', value: selectedAccount ? `${selectedAccount.code} — ${selectedAccount.name}` : 'Selected Account' },
          { label: 'Status', value: 'Recorded / Open' },
        ],
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error recording loan:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to record loan',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const loadDirectorSummary = async (name: string = 'Vijay Lunkad') => {
    try {
      setLoadingDirectorSummary(true);
      const summaryData = await getDirectorRelatedPartyBalanceSummary(name);
      setDirectorSummary(summaryData);
    } catch (err) {
      console.error('Failed to load director balance summary:', err);
    } finally {
      setLoadingDirectorSummary(false);
    }
  };

  const handleRecordDirectorRelatedParty = async (line: StatementLine) => {
    if (recordingReceiptRef.current) return;
    recordingReceiptRef.current = true;
    setRecordingReceipt(true);
    try {
      const result = await recordDirectorRelatedPartyBankTransaction(
        line.id,
        selectedDirectorName,
        directorNotes || line.description
      );
      setActionFeedback({
        type: 'success',
        title: 'Director / Related Party transaction recorded',
        details: [
          { label: 'Journal Entry', value: result.entry_number },
          { label: 'GL Account', value: `${result.account_code} — ${result.account_name}` },
          { label: 'Amount', value: formatCurrency(result.amount, line.currency) },
          { label: 'Action', value: result.action.replace(/_/g, ' ').toUpperCase() },
          { label: 'Net Position After', value: `${formatCurrency(result.new_balances.net_position, line.currency)} (${result.new_balances.net_status})` }
        ],
        timestamp: Date.now(),
      });
      setRecordModal(false);
      setRecordingLine(null);
      setRecordDirectorRelatedParty(false);
      setReceiptType('');
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
    } catch (err: any) {
      console.error('Error recording director transaction:', err);
      setActionFeedback({
        type: 'error',
        title: 'Failed to record Director transaction',
        details: [{ label: 'Error', value: err.message || 'Unknown error' }],
        timestamp: Date.now(),
      });
    } finally {
      recordingReceiptRef.current = false;
      setRecordingReceipt(false);
    }
  };

  const handleRecordReceipt = async (line: StatementLine, type: string, customerId: string, description: string) => {
    if (recordingReceiptRef.current) return;
    recordingReceiptRef.current = true;
    setRecordingReceipt(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (type === 'customer_payment') {
        if (!customerId) throw new Error('Please select a customer');
        if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');

        const receiptId = await saveReceiptVoucher(null, {
          voucher_date: line.date,
          customer_id: customerId,
          payment_method: 'bank_transfer',
          bank_account_id: selectedBank,
          reference_number: line.reference || null,
          amount: line.credit,
          description: description || line.description,
          transaction_currency: line.currency as 'IDR' | 'USD',
          exchange_rate: line.currency === 'IDR' ? 1 : recordExchangeRate,
          created_by: user.id,
        }, Object.entries(receiptAllocations)
          .filter(([, amount]) => amount > 0)
          .map(([invoiceId, amount]) => ({ sales_invoice_id: invoiceId, amount })));

        const { error: postError } = await supabase.rpc('post_receipt_voucher', {
          p_rv_id: receiptId,
          p_posted_by: user.id,
        });
        if (postError) throw postError;
        await linkBankStatementLine(line.id, 'receipt', receiptId);

        const allocCount = Object.values(receiptAllocations).filter(a => a > 0).length;
        const { data: receipt } = await supabase.from('receipt_vouchers').select('voucher_number').eq('id', receiptId).single();
        setActionFeedback({
          type: 'success',
          title: 'Receipt voucher created and linked successfully',
          details: [
            { label: 'Receipt', value: receipt?.voucher_number || '' },
            { label: 'Amount', value: formatCurrency(line.credit, line.currency) },
            { label: 'Invoices', value: allocCount > 0 ? `${allocCount} allocated` : 'Unallocated' },
            { label: 'Status', value: 'Recorded' },
          ],
          timestamp: Date.now(),
        });
      } else if (type === 'capital') {
        if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');
        const result = await saveCapitalContribution({
          voucher_date: line.date,
          bank_account_id: selectedBank,
          amount: line.credit,
          transaction_currency: line.currency as 'IDR' | 'USD',
          exchange_rate: line.currency === 'IDR' ? 1 : recordExchangeRate,
          description: description || line.description,
          created_by: user.id,
        }, line.id);
        setActionFeedback({
          type: 'success',
          title: 'Capital contribution recorded successfully',
          details: [
            { label: 'Voucher', value: result.voucher_number },
            { label: 'Amount', value: formatCurrency(line.credit, line.currency) },
            { label: 'Date', value: new Date(line.date).toLocaleDateString('id-ID') },
            { label: 'Status', value: 'Recorded' },
          ],
          timestamp: Date.now(),
        });
      } else if (type === 'director_related_party') {
        recordingReceiptRef.current = false;
        setRecordingReceipt(false);
        await handleRecordDirectorRelatedParty(line);
        return;
      } else if (type === 'loan') {
        await handleRecordLoan(line);
        return;
      } else if (type === 'loan_repayment_received') {
        await handleRecordLoanRepayment(line);
        return;
      } else if (type === 'loan_director_owner') {
        const selectedDirectorLoan = directorLoanAccounts.find(option => option.account.id === directorLoanAccountId);
        if (!selectedDirectorLoan) {
          throw new Error('Select the existing Director / Owner loan ledger');
        }
        if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');
        const result = await saveBankLinkedFinanceJournal(
          line.id,
          description || line.description,
          selectedDirectorLoan.account.code,
          'debit',
          line.currency as 'IDR' | 'USD',
          line.currency === 'IDR' ? 1 : recordExchangeRate,
        );
        const { data: journal } = await supabase.from('journal_entries').select('entry_number').eq('id', result.journal_entry_id).single();
        setActionFeedback({
          type: 'success',
          title: 'Director loan receipt recorded successfully',
          details: [
            { label: 'Journal', value: journal?.entry_number || '' },
            { label: 'Ledger', value: selectedDirectorLoan.account.name },
            { label: 'Amount', value: formatCurrency(line.credit, line.currency) },
            { label: 'Status', value: 'Recorded' },
          ],
          timestamp: Date.now(),
        });
      } else {
        if (!NON_CUSTOMER_JOURNAL_TYPES.has(type)) {
          throw new Error(`Unsupported non-customer receipt type: ${type}`);
        }
        if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');
        const counterCode = type === 'bank_interest' ? '4920'
          : type === 'misc_income' ? '4910' : '4900';
        const result = await saveBankLinkedFinanceJournal(
          line.id,
          description || line.description,
          counterCode,
          'debit',
          line.currency as 'IDR' | 'USD',
          line.currency === 'IDR' ? 1 : recordExchangeRate,
        );
        const journalId = result.journal_entry_id;
        const { data: journal } = await supabase.from('journal_entries').select('entry_number').eq('id', journalId).single();
        setActionFeedback({
          type: 'success',
          title: 'Journal entry created and linked successfully',
          details: [
            { label: 'Journal', value: journal?.entry_number || '' },
            { label: 'Amount', value: formatCurrency(line.credit, line.currency) },
            { label: 'Status', value: 'Recorded' },
          ],
          timestamp: Date.now(),
        });
      }

      setRecordModal(false);
      setRecordingLine(null);
      setReceiptType('');
      setReceiptCustomerId('');
      setReceiptInvoices([]);
      setReceiptAllocations({});
      setLoanCounterparty('');
      setDirectorLoanAccountId('');
      setLinkExistingReceipt(false);

      // Local optimistic update of the recorded line
      setStatementLines(prev => prev.map(l => l.id === line.id ? {
        ...l,
        status: 'recorded',
        reconciliation_status: 'recorded',
        matching_status: 'confirmed',
        remainingAmount: 0,
        allocatedAmount: l.credit || l.debit,
      } : l));

      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
    } catch (error: any) {
      console.error('Error recording receipt:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to record receipt',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    } finally {
      recordingReceiptRef.current = false;
      setRecordingReceipt(false);
    }
  };

  // Director/Owner activity uses the existing active Director Loan COA as its
  // complete ledger. No separate party, master, loan, or repayment document is
  // created for this bank-reconciliation classification.
  const loadDirectorLoanAccounts = async () => {
    const { data: accounts, error } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name')
      .eq('is_active', true)
      .eq('is_header', false)
      .eq('account_type', 'liability')
      .ilike('name', 'Director Loan%')
      .order('code');
    if (error) {
      console.error('Unable to load Director/Owner loan ledgers:', error);
      setDirectorLoanAccounts([]);
      return;
    }
    setDirectorLoanAccounts(((accounts || []) as DirectorLoanLedgerAccount[]).map(account => ({ account })));
  };

  const handleRecordDirectorLoanWithdrawal = async (line: StatementLine) => {
    const selectedDirectorLoan = directorLoanAccounts.find(option => option.account.id === directorLoanAccountId);
    if (!selectedDirectorLoan) {
      setActionFeedback({
        type: 'error',
        title: 'Missing ledger selection',
        message: 'Select the existing Director / Owner loan ledger',
        timestamp: Date.now(),
      });
      return;
    }
    try {
      if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');
      const result = await saveBankLinkedFinanceJournal(
        line.id,
        line.description || `Director Loan withdrawal — ${selectedDirectorLoan.account.name}`,
        selectedDirectorLoan.account.code,
        'credit',
        line.currency as 'IDR' | 'USD',
        line.currency === 'IDR' ? 1 : recordExchangeRate,
      );
      setRecordModal(false);
      setRecordingLine(null);
      setRecordDirectorLoanWithdrawal(false);
      setDirectorLoanAccountId('');
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
      const { data: journal } = await supabase.from('journal_entries').select('entry_number').eq('id', result.journal_entry_id).single();
      setActionFeedback({
        type: 'success',
        title: 'Director loan withdrawal recorded successfully',
        details: [
          { label: 'Journal', value: journal?.entry_number || '' },
          { label: 'Ledger', value: selectedDirectorLoan.account.name },
          { label: 'Amount', value: formatCurrency(line.debit, line.currency) },
          { label: 'Status', value: 'Recorded' },
        ],
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error recording Director Loan withdrawal:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to record Director Loan withdrawal',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const handleLinkExistingReceipt = async (line: StatementLine, receiptId: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const receipt = existingReceipts.find((candidate) => candidate.id === receiptId);
      const warning = paymentDateGapWarning(line.date, receipt?.voucher_date);
      if (warning) console.warn(warning, { bankDate: line.date, voucherDate: receipt?.voucher_date });

      await linkBankStatementLine(line.id, 'receipt', receiptId);

      setRecordModal(false);
      setRecordingLine(null);
      setLinkExistingReceipt(false);
      setExistingReceipts([]);
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
      setActionFeedback({
        type: 'success',
        title: 'Linked to existing receipt successfully',
        details: [
          { label: 'Receipt', value: receipt?.voucher_number || receiptId },
          { label: 'Amount', value: formatCurrency(line.credit, line.currency) },
          { label: 'Status', value: 'Confirmed' },
        ],
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error linking receipt:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to link receipt',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const loadAvailableJournals = async (line: StatementLine) => {
    try {
      const amount = line.debit > 0 ? line.debit : line.credit;

      const transactionDate = new Date(line.date);
      const startSearch = new Date(transactionDate);
      startSearch.setDate(startSearch.getDate() - 7);
      const endSearch = new Date(transactionDate);
      endSearch.setDate(endSearch.getDate() + 7);

      const { data: journals, error } = await supabase
        .from('journal_entries')
        .select(`
          id,
          entry_number,
          entry_date,
          description,
          total_debit,
          total_credit,
          source_module,
          reference_number
        `)
        .eq('is_posted', true)
        .eq('is_reversed', false)
        .gte('entry_date', startSearch.toISOString().split('T')[0])
        .lte('entry_date', endSearch.toISOString().split('T')[0])
        .or(`total_debit.eq.${amount},total_credit.eq.${amount}`)
        .order('entry_date', { ascending: false })
        .limit(100);

      if (error) throw error;

      const linked = await loadLinkedDocumentIds(line.id);

      const validJournals: PickerCandidate[] = [];
      for (const j of (journals || [])) {
        if (j.source_module === 'expenses' && j.reference_number) {
          const expId = j.reference_number.replace('EXP-', '');
          const { data: exp } = await supabase
            .from('finance_expenses')
            .select('id')
            .eq('id', expId)
            .maybeSingle();
          if (!exp) continue;
        }

        if (j.source_module === 'receipt' && j.reference_number) {
          const { data: rv } = await supabase
            .from('receipt_vouchers')
            .select('id')
            .eq('journal_entry_id', j.id)
            .maybeSingle();
          if (!rv) continue;
        }

        if (j.source_module === 'payment' && j.reference_number) {
          const { data: pv } = await supabase
            .from('payment_vouchers')
            .select('id')
            .eq('journal_entry_id', j.id)
            .maybeSingle();
          if (!pv) continue;
        }

        if (j.source_module === 'petty_cash' && j.reference_number) {
          const refId = j.reference_number.replace('PC-', '');
          const { data: pc } = await supabase
            .from('petty_cash_transactions')
            .select('id')
            .eq('id', refId)
            .is('fund_transfer_id', null)
            .maybeSingle();
          if (!pc) continue;
        }

        validJournals.push({
          ...j,
          _linked: linked.journalIds.has(j.id),
          _linkedReason: 'Already linked to another bank statement line',
        });
      }

      setAvailableJournals(rankBankCandidates(
        validJournals as PickerCandidate[],
        line,
        (journal) => Number(journal.total_debit || journal.total_credit || 0),
        (journal) => journal.entry_date,
      ));
    } catch (error) {
      console.error('Error loading journals:', error);
      setAvailableJournals([]);
    }
  };

  const handleLinkJournalEntry = async (line: StatementLine, journalId: string) => {
    try {
      await linkBankStatementLine(line.id, 'journal', journalId);

      setRecordModal(false);
      setRecordingLine(null);
      setLinkJournalEntry(false);
      setAvailableJournals([]);
      loadStatementLines();
      alert('Successfully linked to journal entry');
    } catch (error: any) {
      console.error('[BankRecon] Error linking journal:', error);
      alert('Error: ' + error.message);
    }
  };

  const loadSupplierPayments = async (line: StatementLine) => {
    setLoadingSupplierPayments(true);
    try {
      const amount = line.debit;
      const lineDate = new Date(line.date);
      // Bank reconciliation matches the bank statement to the Payment Voucher
      // (not to individual supplier invoices — those are already linked to the
      // voucher via voucher_allocations). Bank settlement can lag the voucher
      // date by weeks (cheque clearing, giro, cross-bank wires), so a tight
      // ±10-day window used to hide vouchers like PV/26-26/005. Widen to ±90d
      // and bound with .limit() to keep the query cheap.
      const from = new Date(lineDate); from.setDate(from.getDate() - 90);
      const to   = new Date(lineDate); to.setDate(to.getDate()   + 90);

      // Fetch candidate vouchers in the window. The finance_staff_master embed
      // requires the staff-accounting migration; fall back without it.
      const { data: initialVouchers, error: pvErr } = await supabase
        .from('payment_vouchers')
        .select('id, voucher_number, voucher_date, amount, net_amount, pph_amount, actual_bank_debit, bank_amount, payment_currency, journal_entry_id, bank_account_id, payment_method, suppliers(company_name), finance_staff_master(full_name)')
        .gte('voucher_date', from.toISOString().split('T')[0])
        .lte('voucher_date', to.toISOString().split('T')[0])
        .order('voucher_date', { ascending: false })
        .limit(500);
      let vouchers = initialVouchers;
      if (pvErr && /finance_staff_master|staff_id/i.test(pvErr.message || '')) {
        const fb = await supabase
          .from('payment_vouchers')
          .select('id, voucher_number, voucher_date, amount, net_amount, pph_amount, actual_bank_debit, bank_amount, payment_currency, journal_entry_id, bank_account_id, payment_method, suppliers(company_name)')
          .gte('voucher_date', from.toISOString().split('T')[0])
          .lte('voucher_date', to.toISOString().split('T')[0])
          .order('voucher_date', { ascending: false })
          .limit(500);
        vouchers = fb.data as typeof vouchers;
      }

      // Derive "already reconciled" from bank_statement_lines (the single
      // source of truth — payment_vouchers has no reconciliation columns).
      const linked = await loadLinkedDocumentIds(line.id);

      const available = (vouchers || []).filter((pv: any) => {
        // A payment voucher without a journal_entry_id has never been posted
        // (or its posting was cancelled — cancel_payment_voucher_posting nulls
        // this column by design). bank_statement_lines.matched_entry_id FKs
        // journal_entries, so an unposted PV cannot be linked. The link-time
        // guard at handleLinkSupplierPayment already refuses this state; apply
        // the same requirement at the picker so we don't offer a link that
        // will error. This closes the reported inconsistency where PV/26-26/003
        // appeared in Supplier Payment but the link failed with
        // "Payment voucher not yet posted (no journal entry)."
        if (!pv.journal_entry_id) return false;
        // Advance-adjustment vouchers never touch the bank — exclude them.
        if (pv.payment_method === 'advance_adjustment') return false;
        // If the voucher pinned a specific bank account, restrict to matches on that account.
        if (pv.bank_account_id && selectedBank && pv.bank_account_id !== selectedBank) return false;
        return true;
      });

      setSupplierPayments(rankBankCandidates(
        available.map((pv: any) => ({
          ...pv,
          _linked: linked.paymentIds.has(pv.id) || linked.journalIds.has(pv.journal_entry_id),
          _linkedReason: 'Already linked to another bank statement line',
        })),
        line,
        (payment) => Number(payment.actual_bank_debit ?? payment.bank_amount ?? payment.net_amount ?? 0),
        (payment) => payment.voucher_date,
        (payment) => payment.suppliers?.company_name || payment.finance_staff_master?.full_name,
      ).slice(0, 100));
    } catch (err) {
      console.error('Error loading supplier payments:', err);
      setSupplierPayments([]);
    } finally {
      setLoadingSupplierPayments(false);
    }
  };

  const handleLinkSupplierPayment = async (line: StatementLine, paymentVoucherId: string) => {
    try {
      const payment = supplierPayments.find((candidate) => candidate.id === paymentVoucherId);
      const warning = paymentDateGapWarning(line.date, payment?.voucher_date);
      if (warning) console.warn(warning, { bankDate: line.date, voucherDate: payment?.voucher_date });
      await linkBankStatementLine(line.id, 'payment', paymentVoucherId);

      setRecordModal(false);
      setRecordingLine(null);
      setLinkToSupplierPayment(false);
      setSupplierPayments([]);
      loadStatementLines();
      alert('Successfully linked to supplier payment');
    } catch (error: any) {
      console.error('Error linking supplier payment:', error);
      alert('Error: ' + error.message);
    }
  };

  const loadOutstandingBills = async () => {
    setLoadingBills(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data, error } = await supabase.rpc('get_outstanding_expense_bills', { p_as_of_date: today });
      if (error) throw error;
      // Voucher settlement needs a payee — supplier or staff. Payee-less
      // expenses keep using the direct "Link Expense" path.
      setOutstandingBills((data || []).filter((b: OutstandingBill) => b.supplier_id || b.staff_id));
    } catch (err) {
      console.error('Error loading outstanding bills:', err);
      setOutstandingBills([]);
    } finally {
      setLoadingBills(false);
    }
  };

  const toggleBillAllocation = (bill: OutstandingBill, lineAmount: number) => {
    setBillAllocations(prev => {
      if (prev.some(a => a.expenseId === bill.id)) {
        return prev.filter(a => a.expenseId !== bill.id);
      }
      const allocated = prev.reduce((s, a) => s + a.amount, 0);
      const remaining = Math.max(0, lineAmount - allocated);
      return [...prev, { expenseId: bill.id, amount: Math.min(bill.balance_amount, remaining) }];
    });
  };

  const setBillAllocationAmount = (expenseId: string, amount: number) => {
    setBillAllocations(prev => prev.map(a => (a.expenseId === expenseId ? { ...a, amount } : a)));
  };

  // One canonical payment path: settling outstanding bills from Bank-Rec
  // CREATES a payment voucher with allocations (same engine as Payment
  // Vouchers) and links the bank line to the voucher's journal entry.
  // matched_expense_id stays NULL — recalculate_expense_payment_state sums
  // voucher_allocations AND directly-matched lines, so setting both would
  // double-count the payment.
  const handleSettleBills = async (line: StatementLine) => {
    const allocs = billAllocations.filter(a => a.amount > 0);
    if (allocs.length === 0) {
      alert('Select at least one bill with an allocation amount');
      return;
    }

    const bills = allocs
      .map(a => outstandingBills.find(b => b.id === a.expenseId))
      .filter((b): b is OutstandingBill => !!b);
    // One voucher = one payee: all selected bills must share the same
    // supplier OR the same staff member (staff bills have no supplier).
    const payeeKeys = [...new Set(bills.map(b => b.supplier_id ? `s:${b.supplier_id}` : `t:${b.staff_id}`))];
    if (payeeKeys.length > 1) {
      alert('A payment voucher has a single payee — please select bills of one supplier or one staff member only.');
      return;
    }
    const payeeSupplierId = bills[0]?.supplier_id ?? null;
    const payeeStaffId = payeeSupplierId ? null : (bills[0]?.staff_id ?? null);
    for (const a of allocs) {
      const bill = bills.find(b => b.id === a.expenseId);
      if (bill && a.amount > bill.balance_amount + 0.01) {
        alert(`Allocation for ${bill.invoice_number || bill.id.slice(0, 8)} exceeds its outstanding balance.`);
        return;
      }
    }
    const total = allocs.reduce((s, a) => s + a.amount, 0);
    if (total > line.debit + 0.01) {
      alert(`Total allocated (${formatCurrency(total, line.currency)}) exceeds the bank amount (${formatCurrency(line.debit, line.currency)}).`);
      return;
    }
    if (
      Math.abs(total - line.debit) > 0.01 &&
      !confirm(
        `Total allocated ${formatCurrency(total, line.currency)} differs from the bank amount ${formatCurrency(line.debit, line.currency)} (partial payment or bank charges). Continue?`,
      )
    ) {
      return;
    }

    setSettleSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');

      const savedVoucher = await savePaymentVoucher(null, {
        voucher_date: line.date,
        supplier_id: payeeSupplierId,
        staff_id: payeeStaffId,
        payment_method: 'bank_transfer',
        bank_account_id: selectedBank || null,
        reference_number: line.reference || null,
        amount: total,
        pph_amount: 0,
        pph_code_id: null,
        description: `Bank settlement: ${line.description}`.slice(0, 500),
        payment_currency: line.currency as 'IDR' | 'USD',
        exchange_rate: line.currency === 'IDR' ? 1 : recordExchangeRate,
        bank_amount: total,
        bank_charge: 0,
        created_by: user.id,
      }, allocs.map(a => ({ finance_expense_id: a.expenseId, amount: a.amount, currency: line.currency })));
      const voucherId = savedVoucher.id;
      const voucherNumber = savedVoucher.voucher_number;

      const { error: postError } = await supabase.rpc('post_payment_voucher', {
        p_pv_id: voucherId,
        p_posted_by: user.id,
      });
      if (postError) {
        alert(
          `⚠️ Payment voucher ${voucherNumber} was created but could not be posted: ${postError.message}\n\n` +
          `Post it in Finance > Payment Vouchers, then link this bank line via "Supplier Payment".`,
        );
        return;
      }

      await linkBankStatementLine(line.id, 'payment', voucherId);

      setRecordModal(false);
      setRecordingLine(null);
      setLinkSettleBills(false);
      setBillAllocations([]);
      setOutstandingBills([]);
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
      setActionFeedback({
        type: 'success',
        title: 'Payment voucher created, posted and linked',
        details: [
          { label: 'Voucher', value: voucherNumber },
          { label: 'Bills Settled', value: `${allocs.length} bill(s)` },
          { label: 'Total Paid', value: formatCurrency(total, line.currency) },
          { label: 'Status', value: 'Recorded' },
        ],
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error settling bills:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to settle bills',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    } finally {
      setSettleSubmitting(false);
    }
  };

  const handleRecordLoanRepayment = async (line: StatementLine) => {
    if (!repaymentLoanId) {
      setActionFeedback({
        type: 'error',
        title: 'Missing loan selection',
        message: 'Select the loan being repaid',
        timestamp: Date.now(),
      });
      return;
    }
    const lineAmount = line.debit > 0 ? line.debit : line.credit;
    if (Math.abs((repaymentPrincipal + repaymentInterest) - lineAmount) > 0.01) {
      setActionFeedback({
        type: 'error',
        title: 'Invalid amount',
        message: 'Principal plus interest must equal the bank transaction amount',
        timestamp: Date.now(),
      });
      return;
    }
    if (repaymentPrincipal < 0 || repaymentInterest < 0 || repaymentPrincipal <= 0) {
      setActionFeedback({
        type: 'error',
        title: 'Invalid amount',
        message: 'Enter a valid principal amount',
        timestamp: Date.now(),
      });
      return;
    }
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');

      const targetLoan = activeLoans.find(l => l.id === repaymentLoanId);

      const result = await saveFinanceLoanRepayment({
        loan_id: repaymentLoanId,
        transaction_date: line.date,
        principal_amount: repaymentPrincipal,
        interest_amount: repaymentInterest,
        bank_account_id: selectedBank,
        transaction_currency: line.currency as 'IDR' | 'USD',
        exchange_rate: line.currency === 'IDR' ? 1 : recordExchangeRate,
        description: line.description,
        created_by: user.id,
      }, line.id);

      const newOutstanding = Math.max(0, (targetLoan?.outstanding_balance || 0) - repaymentPrincipal);

      setRecordModal(false);
      setRecordingLine(null);
      setRecordLoanRepayment(false);
      setRepaymentLoanId('');
      setRepaymentPrincipal(0);
      setRepaymentInterest(0);
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();

      setActionFeedback({
        type: 'success',
        title: 'LOAN REPAYMENT RECORDED',
        details: [
          { label: 'Counterparty', value: targetLoan?.counterparty_name || 'Loan' },
          { label: 'Amount', value: formatCurrency(lineAmount, line.currency) },
          { label: 'Loan', value: targetLoan?.loan_number || result.transaction_number },
          { label: 'Outstanding', value: formatCurrency(newOutstanding, line.currency) },
          { label: 'Status', value: newOutstanding <= 0.01 ? 'Closed' : 'Remaining' },
        ],
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error recording loan repayment:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to record loan repayment',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const handleRecordOwnerWithdrawal = async (line: StatementLine) => {
    if (!confirm(`Record this bank debit as Owner Withdrawal for ${formatCurrency(line.debit, line.currency)}?`)) return;
    try {
      if (line.currency === 'USD' && recordExchangeRate <= 1) throw new Error('Enter a valid USD-to-IDR exchange rate');
      const result = await saveBankLinkedFinanceJournal(
        line.id,
        line.description || 'Owner Withdrawal',
        '3100',
        'credit',
        line.currency as 'IDR' | 'USD',
        line.currency === 'IDR' ? 1 : recordExchangeRate,
      );
      setRecordModal(false);
      setRecordingLine(null);
      selfActionTimestampRef.current = Date.now();
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
      const { data: journal } = await supabase.from('journal_entries').select('entry_number').eq('id', result.journal_entry_id).single();
      setActionFeedback({
        type: 'success',
        title: 'Owner withdrawal recorded successfully',
        details: [
          { label: 'Journal', value: journal?.entry_number || '' },
          { label: 'Amount', value: formatCurrency(line.debit, line.currency) },
          { label: 'Status', value: 'Recorded' },
        ],
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error recording owner withdrawal:', error);
      setActionFeedback({
        type: 'error',
        title: 'Failed to record owner withdrawal',
        message: error?.message || 'Unknown error occurred',
        timestamp: Date.now(),
      });
    }
  };

  const loadAvailableTaxPayments = async (line: StatementLine) => {
    try {
      const amount = line.debit;
      const lineDate = new Date(line.date).getTime();

      // Match the Payment Voucher picker semantics (loadSupplierPayments):
      // no hard date filter, wide sort window. The previous ±7-day box was
      // hiding correct tax payments when bank clearing lagged the payment
      // date (cross-bank giro, MPN batching, weekends).
      const { data: tps } = await supabase
        .from('tax_payments')
        .select('id, tax_type, amount, payment_date, billing_code, ntpn, journal_entry_id, bank_account_id, status')
        .in('status', ['posted', 'draft'])
        .not('journal_entry_id', 'is', null)
        .order('payment_date', { ascending: false })
        .limit(500);

      const linked = await loadLinkedDocumentIds(line.id);

      const scored = (tps || [])
        .filter((tp: any) => {
          if (tp.bank_account_id && selectedBank && tp.bank_account_id !== selectedBank) return false;
          return Math.abs(tp.amount - amount) < 1;
        })
        .map((tp: any) => ({
          ...tp,
          _linked: linked.taxPaymentIds.has(tp.id) || linked.journalIds.has(tp.journal_entry_id),
          _linkedReason: 'Already linked to another bank statement line',
        }));

      setAvailableTaxPayments(rankBankCandidates(
        scored,
        line,
        (payment) => Number(payment.amount || 0),
        (payment) => payment.payment_date,
      ));
    } catch (err) {
      console.error('Error loading tax payments:', err);
      setAvailableTaxPayments([]);
    }
  };

  const handleLinkToTaxPayment = async (line: StatementLine, tp: any) => {
    try {
      if (!tp.journal_entry_id) {
        alert('❌ Tax payment has no journal entry. Please ensure the payment was recorded via Record Tax Payment.');
        return;
      }
      await linkBankStatementLine(line.id, 'tax_payment', tp.id);

      setRecordModal(false);
      setRecordingLine(null);
      setLinkToTaxPayment(false);
      setAvailableTaxPayments([]);
      loadStatementLines();
      alert('Successfully linked to tax payment. Tax payment status will update to Reconciled automatically.');
    } catch (error: any) {
      console.error('Error linking tax payment:', error);
      alert('Error: ' + error.message);
    }
  };

  const matchesSearch = (line: StatementLine, query: string): boolean => {
    if (!query) return true;
    const q = query.trim().toLowerCase();
    if (!q) return true;

    // 1. Description, Reference, Notes
    if (line.description && line.description.toLowerCase().includes(q)) return true;
    if (line.reference && line.reference.toLowerCase().includes(q)) return true;
    if (line.notes && line.notes.toLowerCase().includes(q)) return true;

    // 2. Amount match (handles raw digits, formatted Indonesian Rp, decimals)
    const cleanNumericQuery = q.replace(/[^0-9]/g, '');
    if (cleanNumericQuery.length >= 3) {
      const debitDigits = String(Math.round(Number(line.debit) || 0));
      const creditDigits = String(Math.round(Number(line.credit) || 0));
      if (debitDigits.includes(cleanNumericQuery) || creditDigits.includes(cleanNumericQuery)) return true;
    }
    const debitFormatted = (Number(line.debit) || 0).toLocaleString('id-ID');
    const creditFormatted = (Number(line.credit) || 0).toLocaleString('id-ID');
    if (debitFormatted.includes(q) || creditFormatted.includes(q)) return true;

    // 3. Date match
    // Matches raw ISO date (2026-10-01), formatted DD/MM/YYYY (01/10/2026), DD-MM-YYYY, or parts
    if (line.date.includes(q)) return true;
    const dmy = formatDate(line.date); // e.g. "01/10/2026"
    if (dmy.includes(q)) return true;
    const normDate = normalizeDateToIso(q);
    if (normDate && line.date === normDate) return true;

    // 4. Linked document details
    if (line.allocations && line.allocations.some(a =>
      (a.label && a.label.toLowerCase().includes(q)) ||
      (a.counterparty && a.counterparty.toLowerCase().includes(q)) ||
      (a.document_type && a.document_type.toLowerCase().includes(q))
    )) return true;

    if (line.matchedExpense?.voucher_number && line.matchedExpense.voucher_number.toLowerCase().includes(q)) return true;
    if (line.matchedExpense?.description && line.matchedExpense.description.toLowerCase().includes(q)) return true;
    if (line.matchedPayment?.voucher_number && line.matchedPayment.voucher_number.toLowerCase().includes(q)) return true;
    if (line.matchedReceipt?.payment_number && line.matchedReceipt.payment_number.toLowerCase().includes(q)) return true;

    return false;
  };

  const filteredLines = useMemo(() => {
    return statementLines.filter(line => {
      let statusMatch = true;
      if (activeFilter === 'all') {
        statusMatch = true;
      } else if (activeFilter === 'unmatched') {
        statusMatch = line.status === 'unmatched' || line.status === 'partially_reconciled';
      } else if (activeFilter === 'matched') {
        statusMatch = line.status === 'matched' || line.status === 'recorded';
      } else {
        statusMatch = line.status === activeFilter;
      }
      if (!statusMatch) return false;

      return matchesSearch(line, searchTerm);
    });
  }, [statementLines, activeFilter, searchTerm]);

  // Sorting function
  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const sortedLines = useMemo(() => {
    return [...filteredLines].sort((a, b) => {
      if (!sortConfig) {
        if (a.date !== b.date) {
          return b.date.localeCompare(a.date);
        }
        return a.id.localeCompare(b.id);
      }

      const { key, direction } = sortConfig;
      let aValue: any = a[key as keyof StatementLine];
      let bValue: any = b[key as keyof StatementLine];

      // Handle date sorting
      if (key === 'date') {
        aValue = new Date(aValue).getTime();
        bValue = new Date(bValue).getTime();
      }

      // Handle numeric sorting for debit/credit
      if (key === 'debit' || key === 'credit') {
        aValue = Number(aValue) || 0;
        bValue = Number(bValue) || 0;
      }

      // Handle string sorting
      if (typeof aValue === 'string') {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      if (aValue < bValue) return direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredLines, sortConfig]);

  const stats = useMemo(() => {
    return {
      total: statementLines.length,
      matched: statementLines.filter(l => l.status === 'matched' || l.status === 'recorded').length,
      suggested: statementLines.filter(l => l.status === 'suggested').length,
      unmatched: statementLines.filter(l => l.status === 'unmatched' || l.status === 'partially_reconciled').length,
    };
  }, [statementLines]);

  const totalFiltered = sortedLines.length;
  const numPageSize = typeof pageSize === 'number' ? pageSize : totalFiltered || 1;
  const totalPages = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(totalFiltered / numPageSize));
  const validCurrentPage = Math.min(currentPage, totalPages);

  const paginatedLines = useMemo(() => {
    if (pageSize === 'all') return sortedLines;
    const start = (validCurrentPage - 1) * numPageSize;
    return sortedLines.slice(start, start + numPageSize);
  }, [sortedLines, validCurrentPage, pageSize, numPageSize]);

  const openEditModal = (line: StatementLine) => {
    setEditingLine(line);
    setEditFormData({
      debit: line.debit,
      credit: line.credit,
      description: line.description,
    });
    setEditModal(true);
  };

  const handleUpdateLine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLine) return;

    try {
      const { error } = await supabase
        .from('bank_statement_lines')
        .update({
          debit_amount: editFormData.debit,
          credit_amount: editFormData.credit,
          description: editFormData.description,
        })
        .eq('id', editingLine.id);

      if (error) throw error;

      // Canonical allocations represent a settled amount independently from
      // the bank-line total.  Editing the statement amount must never mutate
      // the allocated document or its journal; allocation adjustments use the
      // explicit unlink/relink workflow instead.  Legacy direct links retain
      // their existing propagation path.
      const newAmount = Number(editFormData.debit) || Number(editFormData.credit) || 0;
      const hasCanonicalAllocations = editingLine.allocations.length > 0;
      const hasLegacyLink = editingLine.matchedExpenseId || editingLine.matchedReceiptId
        || editingLine.matchedPaymentId || editingLine.matchedFundTransferId
        || editingLine.matchedPettyCashId || editingLine.matchedTaxPaymentId
        || editingLine.matchedEntry;
      if (!hasCanonicalAllocations && hasLegacyLink && newAmount > 0) {
        const { data: propResult, error: propError } = await supabase
          .rpc('propagate_bank_line_amount_edit', {
            p_line_id: editingLine.id,
            p_new_amount: newAmount,
          });
        if (propError) {
          console.error('Propagation error:', propError);
          alert('⚠️ Bank line updated, but linked document sync failed: ' + propError.message);
        }
      }

      // Update in local state
      setStatementLines(prev => prev.map(line =>
        line.id === editingLine.id ? {
          ...line,
          debit: editFormData.debit,
          credit: editFormData.credit,
          description: editFormData.description
        } : line
      ));

      setEditModal(false);
      setEditingLine(null);
      alert('✅ Bank statement line updated successfully');
      // Reload to reflect journal changes
      loadStatementLines();
    } catch (error: any) {
      console.error('Error updating line:', error);
      alert('❌ ' + error.message);
    }
  };

  // Reset a row that shows Recorded/Matched but resolves to no linked document.
  // Uses the canonical unmatch command so every typed FK and dependent Expense
  // settlement state is cleared consistently.
  const resetOrphanToUnmatched = async (line: StatementLine) => {
    const ok = window.confirm(
      'This row shows Recorded/Matched but no linked document was found.\n\n' +
      'Reset its status to "Unmatched"?'
    );
    if (!ok) return;
    try {
      await unlinkBankStatementLine(line.id);
      await loadStatementLines();
      alert('✅ Row reset to Unmatched');
    } catch (err: any) {
      console.error('Error resetting orphan:', err);
      alert('❌ ' + err.message);
    }
  };

  const handleUnlinkTransaction = async () => {
    if (!editingLine) return;

    const confirmUnlink = window.confirm(
      'Are you sure you want to unlink this transaction?\n\n' +
      'This will set its status back to "Unmatched" and remove the link to the expense/receipt.'
    );

    if (!confirmUnlink) return;

    try {
      await unlinkBankStatementLine(editingLine.id);

      // Update in local state
      setStatementLines(prev => prev.map(line =>
        line.id === editingLine.id ? {
          ...line,
          status: 'unmatched',
          matchedEntry: undefined,
          matchedExpenseId: undefined,
          matchedReceiptId: undefined,
          matchedPaymentId: undefined,
          matchedFundTransferId: undefined,
          matchedPettyCashId: undefined,
          matchedTaxPaymentId: undefined,
          matchedExpense: null,
          matchedReceipt: null,
          matchedPayment: null,
          matchedFundTransfer: null,
          matchedPettyCash: null,
          matchedTaxPayment: null,
          matchedEntryRecord: null,
          allocations: [],
          allocatedAmount: 0,
          remainingAmount: bankStatementLineAmount(line.debit, line.credit),
          notes: undefined
        } : line
      ));

      setEditModal(false);
      setEditingLine(null);
      notifyFinanceReconciliationRefresh();
      alert('✅ Transaction unlinked successfully');
    } catch (error: any) {
      console.error('Error unlinking transaction:', error);
      alert('❌ ' + error.message);
    }
  };

  const handleUnlinkSingleAllocation = async (allocationId: string, label?: string) => {
    const ok = window.confirm(
      `Are you sure you want to unlink allocation "${label || allocationId}"?\n\n` +
      'This will remove this specific allocation and return its amount to the unallocated bank balance.'
    );
    if (!ok) return;
    try {
      await unlinkBankStatementAllocation(allocationId);
      await loadStatementLines();
      notifyFinanceReconciliationRefresh();
      alert('✅ Allocation unlinked successfully');
    } catch (err: any) {
      console.error('Error unlinking allocation:', err);
      alert('❌ ' + err.message);
    }
  };

  return (
    <div className="space-y-2">
      {/* Persistent Action Feedback Notification */}
      {actionFeedback && (
        <div
          className={`rounded-lg border p-3 shadow-md flex items-start justify-between gap-3 transition-all ${
            actionFeedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
              : actionFeedback.type === 'error'
              ? 'bg-rose-50 border-rose-300 text-rose-950'
              : 'bg-blue-50 border-blue-300 text-blue-950'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {actionFeedback.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            ) : actionFeedback.type === 'error' ? (
              <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            ) : (
              <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <div className="text-sm font-semibold">{actionFeedback.title}</div>
              {actionFeedback.message && (
                <div className="text-xs text-slate-700 whitespace-pre-wrap">{actionFeedback.message}</div>
              )}
              {actionFeedback.details && actionFeedback.details.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-700 mt-1">
                  {actionFeedback.details.map((d, i) => (
                    <span key={i} className="inline-flex items-center gap-1 bg-white px-2 py-0.5 rounded border border-slate-200 font-medium shadow-xs">
                      <span className="text-slate-500">{d.label}:</span>
                      <span className="text-slate-900 font-semibold">{d.value}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => setActionFeedback(null)}
            className="p-1 rounded hover:bg-black/5 text-slate-400 hover:text-slate-700 transition"
            title="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Compact Header with Bank Selection and Actions */}
      <div className="bg-gradient-to-r from-slate-700 to-slate-800 rounded-lg p-2.5 text-white shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-bold">Bank Reconciliation</h3>
            {selectedAccount && (
              <span className="text-slate-300 text-xs">
                {selectedAccount.alias ? `${selectedAccount.alias} (${selectedAccount.account_number})` : `${selectedAccount.bank_name} - ${selectedAccount.account_number}`}
              </span>
            )}
            <div className="flex gap-2 flex-wrap items-center">
              <div className="bg-white/20 rounded px-2.5 py-1">
                <div className="text-slate-200 text-[9px] leading-tight">Matched</div>
                <div className="text-xs font-bold text-green-400">{stats.matched}</div>
              </div>
              <div className="bg-white/20 rounded px-2.5 py-1">
                <div className="text-slate-200 text-[9px] leading-tight">Unmatched</div>
                <div className="text-xs font-bold text-red-400">{stats.unmatched}</div>
              </div>
              {accountBalances && (
                <>
                  <div className="bg-white/20 rounded px-2.5 py-1" title="All imported bank statement transactions + opening balance">
                    <div className="text-slate-200 text-[9px] leading-tight">Statement Balance</div>
                    <div className="text-xs font-bold text-sky-300">
                      {formatCurrency(accountBalances.statementBalance, selectedAccount?.currency)}
                    </div>
                  </div>
                  <div className="bg-white/20 rounded px-2.5 py-1" title="General Ledger Book Balance">
                    <div className="text-slate-200 text-[9px] leading-tight">Book Balance</div>
                    <div className="text-xs font-bold text-slate-100">
                      {formatCurrency(accountBalances.bookBalance, selectedAccount?.currency)}
                    </div>
                  </div>
                  <div className={`rounded px-2.5 py-1 ${Math.abs(accountBalances.difference) < 0.01 ? 'bg-green-600/30 text-green-300' : 'bg-amber-600/30 text-amber-300'}`} title="Statement Balance minus Book Balance">
                    <div className="text-slate-200 text-[9px] leading-tight">Difference</div>
                    <div className="text-xs font-bold">
                      {formatCurrency(accountBalances.difference, selectedAccount?.currency)}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
  
            {canManage && (
              <>
                <button
                  onClick={previewClearData}
                  disabled={!selectedBank}
                  className="p-1.5 bg-white/20 rounded hover:bg-white/30 disabled:opacity-50"
                  title="Clear"
                >
                  <XCircle className="w-3.5 h-3.5" />
                </button>
                <input name="file_upload" aria-label="Upload file"
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || !selectedBank}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-white text-slate-700 rounded hover:bg-slate-50 disabled:opacity-50 font-medium shadow-sm"
                  title="Upload"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {uploading ? 'Uploading' : 'Upload'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white rounded border border-gray-200 p-2.5 shadow-sm space-y-2">
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Bank Account Selector */}
          <select name="bank" aria-label="Bank"
            value={selectedBank}
            onChange={(e) => { setSelectedBank(e.target.value); try { localStorage.setItem('bank_recon_selected_bank', e.target.value); } catch { /* Storage may be unavailable. */ } }}
            className="px-2.5 py-1.5 border border-gray-300 rounded-md text-xs font-medium bg-white text-gray-800 shadow-sm"
          >
            {bankAccounts.map(bank => (
              <option key={bank.id} value={bank.id}>
                {bank.alias ? `${bank.alias} (${bank.account_number})` : `${bank.bank_name} - ${bank.account_number} (${bank.currency})`}
              </option>
            ))}
          </select>

          <div className="h-5 w-px bg-gray-200 hidden sm:block"></div>

          {/* Interactive Date Range Controls */}
          <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-300 rounded-md px-2 py-1 text-xs">
            <Calendar className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <span className="text-gray-500 font-medium text-[11px]">From</span>
            <input
              type="date"
              name="bank_recon_start_date"
              aria-label="Start Date"
              value={toInputFormat(localStartDate)}
              onChange={(e) => handleDateChange(e.target.value, localEndDate)}
              className="px-1.5 py-0.5 border border-gray-200 rounded bg-white text-xs font-mono text-gray-800"
              title="Filter from date"
            />
            <span className="text-gray-400 text-[11px]">to</span>
            <input
              type="date"
              name="bank_recon_end_date"
              aria-label="End Date"
              value={toInputFormat(localEndDate)}
              onChange={(e) => handleDateChange(localStartDate, e.target.value)}
              className="px-1.5 py-0.5 border border-gray-200 rounded bg-white text-xs font-mono text-gray-800"
              title="Filter to date"
            />
          </div>

          <div className="h-5 w-px bg-gray-200 hidden sm:block"></div>

          {/* Search Across Description, Reference, Amount, and Date */}
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              name="bank_recon_search"
              aria-label="Search Transactions"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search description, ref, amount (e.g. 767520), or date (01/10/2026)..."
              className="w-full pl-8 pr-7 py-1.5 border border-gray-300 rounded-md text-xs placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                title="Clear search"
                aria-label="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Clear Filters Button */}
          {(searchTerm || activeFilter !== 'all') && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-700 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-md font-medium transition-colors"
              title="Reset search and status filter"
              aria-label="Clear all filters"
            >
              <RotateCcw className="w-3 h-3 text-gray-500" />
              Clear Filters
            </button>
          )}
        </div>

        {/* Row 2: Status Filter Pills with Accurate Counts & Auto-Match */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-gray-100 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setActiveFilter('all')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                activeFilter === 'all'
                  ? 'bg-slate-700 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              All ({stats.total})
            </button>
            <button
              onClick={() => setActiveFilter('matched')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                activeFilter === 'matched'
                  ? 'bg-green-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              ✓ Matched ({stats.matched})
            </button>
            <button
              onClick={() => setActiveFilter('suggested')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                activeFilter === 'suggested'
                  ? 'bg-yellow-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              ⚠ Review ({stats.suggested})
            </button>
            <button
              onClick={() => setActiveFilter('unmatched')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                activeFilter === 'unmatched'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              ✕ Unmatched ({stats.unmatched})
            </button>

            {/* Auto Match Button beside status filters */}
            <button
              type="button"
              onClick={() => { void autoMatchTransactions(); }}
              disabled={!selectedBank || autoMatching}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 font-semibold shadow-sm whitespace-nowrap ml-1"
              title="Match unlinked transactions to posted finance documents; ambiguous matches remain unlinked"
              aria-label="Run bank transaction auto-match"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${autoMatching ? 'animate-spin' : ''}`} />
              {autoMatching ? 'Matching…' : 'Auto-Match'}
            </button>
          </div>

          {searchTerm && (
            <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded font-medium">
              Found {filteredLines.length} matching "{searchTerm}" in {activeFilter} view
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 bg-white rounded-lg">
          <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
        </div>
      ) : statementLoadError ? (
        <div role="alert" className="flex items-start gap-3 py-5 px-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
          <div>
            <h3 className="font-medium">Unable to load bank transactions</h3>
            <p className="text-sm mt-1">{statementLoadError}</p>
            <button
              type="button"
              onClick={() => { void loadStatementLines(); }}
              className="mt-3 inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        </div>
      ) : statementLines.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border-2 border-dashed">
          <Landmark className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-gray-600 mb-1">No Bank Transactions in this Date Range</h3>
          <p className="text-sm text-gray-500 mb-4">
            No transactions found between {formatDate(dateRange.start)} and {formatDate(dateRange.end)}. Adjust the date filter or upload a BCA statement.
          </p>
          {canManage && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 h-7 px-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              <Upload className="w-4 h-4" />
              Upload Statement
            </button>
          )}
        </div>
      ) : filteredLines.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200 p-6">
          <Landmark className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-gray-800 mb-1">
            {searchTerm ? 'No Matching Transactions' : `No ${activeFilter.charAt(0).toUpperCase() + activeFilter.slice(1)} Transactions`}
          </h3>
          <p className="text-xs text-gray-500 max-w-md mx-auto mb-4">
            {searchTerm
              ? `No transactions matched "${searchTerm}" with status "${activeFilter}" in the selected date range (${formatDate(dateRange.start)} - ${formatDate(dateRange.end)}).`
              : `No transactions found with status "${activeFilter}" for ${selectedAccount?.bank_name || 'this bank'} in the selected date range.`}
          </p>
          {(searchTerm || activeFilter !== 'all') && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Filters & Search
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th
                  onClick={() => handleSort('date')}
                  className="px-1.5 py-1 text-left font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center gap-1">
                    Date
                    {sortConfig?.key === 'date' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('description')}
                  className="px-1.5 py-1 text-left font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center gap-1">
                    Description
                    {sortConfig?.key === 'description' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('debit')}
                  className="px-1.5 py-1 text-right font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    Debit
                    {sortConfig?.key === 'debit' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('credit')}
                  className="px-1.5 py-1 text-right font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    Credit
                    {sortConfig?.key === 'credit' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('status')}
                  className="px-1.5 py-1 text-center font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center justify-center gap-1">
                    Status
                    {sortConfig?.key === 'status' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="px-1.5 py-1 text-center font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {paginatedLines.map(line => (
                <Fragment key={line.id}>
                <tr
                  id={`bank-statement-line-${line.id}`}
                  data-statement-line-id={line.id}
                  key={`${line.id}-row`}
                  className={
                    line.id === highlightedLineId
                      ? 'bg-amber-100 ring-2 ring-inset ring-amber-400'
                      : 'hover:bg-gray-50'
                  }
                >
                  <td className="px-1.5 py-1 text-gray-700 whitespace-nowrap">
                    {new Date(line.date).toLocaleDateString('id-ID')}
                  </td>
                  <td className="px-1.5 py-1 text-gray-700 max-w-md">
                    <div className="whitespace-pre-wrap text-sm leading-tight">{line.description}</div>
                    {line.reference && (
                      <div className="text-xs text-gray-500 font-mono mt-1">{line.reference}</div>
                    )}
                  </td>
                  <td className="px-1.5 py-1 text-right text-red-600 font-medium whitespace-nowrap">
                    {line.debit > 0 ? formatCurrency(line.debit, line.currency) : '-'}
                  </td>
                  <td className="px-1.5 py-1 text-right text-green-600 font-medium whitespace-nowrap">
                    {line.credit > 0 ? formatCurrency(line.credit, line.currency) : '-'}
                  </td>
                  <td className="px-1.5 py-1">
                    <div className="flex flex-col gap-1">
                      {(line.status === 'matched' || line.status === 'recorded') && (
                        <>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                            <CheckCircle2 className="w-3 h-3" /> Recorded
                          </span>
                          {line.allocations.map(allocation => (
                            <span key={allocation.id} className="text-xs text-gray-600">
                              → {allocation.document_type === 'expense' ? 'Expense' : allocation.document_type.replace('_', ' ')}: {allocation.label} ({formatCurrency(allocation.allocation_amount, line.currency)})
                              {allocation.document_remaining !== undefined && allocation.document_remaining > 0.01 && (
                                <span className="ml-1 text-amber-700">· Remaining {formatCurrency(allocation.document_remaining, line.currency)}</span>
                              )}
                            </span>
                          ))}
                        </>
                      )}
                      {line.status === 'partially_reconciled' && (
                        <>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                            <AlertCircle className="w-3 h-3" /> Partial
                          </span>
                          {line.allocations.map(allocation => (
                            <span key={allocation.id} className="text-xs text-gray-600">
                              → {allocation.document_type === 'expense' ? 'Expense' : allocation.document_type.replace('_', ' ')}: {allocation.label} ({formatCurrency(allocation.allocation_amount, line.currency)})
                            </span>
                          ))}
                        </>
                      )}
                      {line.status === 'suggested' && (
                        <>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                            <Clock className="w-3 h-3" /> Needs Review
                          </span>
                          {line.matchedExpense && (
                            <button
                              type="button"
                              onClick={() => setSelectedSuggestedLine(line)}
                              className="text-xs text-purple-700 font-medium hover:underline text-left inline-flex items-center gap-1 cursor-pointer"
                              title="Click to view full match details side-by-side"
                            >
                              → Suggested: {line.matchedExpense.voucher_number || 'Expense'}
                              {line.matchedExpense.approval_status === 'pending_approval' ? (
                                <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800 font-semibold">
                                  Pending Approval
                                </span>
                              ) : line.matchedExpense.approval_status === 'rejected' || line.matchedExpense.approval_status === 'cancelled' ? (
                                <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-800 font-semibold">
                                  {line.matchedExpense.approval_status === 'rejected' ? 'Rejected' : 'Cancelled'}
                                </span>
                              ) : (
                                <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-green-100 text-green-800 font-semibold">
                                  Approved
                                </span>
                              )}
                            </button>
                          )}
                          {line.notes && line.notes.startsWith('Suggested match:') && (
                            <span className="text-[11px] text-gray-500 italic">
                              {line.notes}
                            </span>
                          )}
                        </>
                      )}
                      {line.status === 'unmatched' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                          <XCircle className="w-3 h-3 text-gray-400" /> Unrecorded
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {line.allocations.length > 0 && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100"
                          aria-expanded={expandedLineIds.has(line.id)}
                          onClick={() => setExpandedLineIds(previous => {
                            const next = new Set(previous);
                            if (next.has(line.id)) next.delete(line.id); else next.add(line.id);
                            return next;
                          })}
                        >
                          {expandedLineIds.has(line.id) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          {line.allocations.length} document{line.allocations.length === 1 ? '' : 's'}
                        </button>
                      )}
                      {canManage && (
                        <FinanceActionButton action="edit" label="Edit debit/credit" onClick={() => openEditModal(line)} />
                      )}
                      {line.status === 'suggested' && (
                        <>
                          <button
                            type="button"
                            onClick={() => setSelectedSuggestedLine(line)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-purple-300 text-purple-700 bg-purple-50 hover:bg-purple-100 rounded font-medium"
                            title="Review suggested match side-by-side"
                          >
                            Review
                          </button>
                          <FinanceActionButton
                            action="approve"
                            label="Confirm Match"
                            onClick={() => confirmMatch(line.id)}
                            aria-label={t.finance.bankAcceptSuggestedMatch}
                          />
                          <FinanceActionButton
                            action="reject"
                            label="Reject Match"
                            onClick={() => rejectMatch(line.id)}
                          />
                        </>
                      )}
                      {(line.status === 'unmatched' || line.status === 'partially_reconciled') && canManage && (
                        <button
                          onClick={() => openRecordModal(line)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                          title={line.status === 'partially_reconciled' ? 'Allocate remaining amount' : 'Record transaction'}
                        >
                          <Plus className="w-3 h-3" />
                          {line.status === 'partially_reconciled' ? 'Allocate' : 'Record'}
                        </button>
                      )}
                      {line.allocatedAmount > 0 && (
                        <div className="text-[10px] text-gray-600 leading-tight">
                          <div>Bank: {formatCurrency(line.debit || line.credit, line.currency)}</div>
                          <div>Allocated: {formatCurrency(line.allocatedAmount, line.currency)}</div>
                          <div className={line.remainingAmount > BANK_ALLOCATION_EPSILON ? 'text-amber-700 font-medium' : 'text-green-700 font-medium'}>
                            Remaining: {formatCurrency(line.remainingAmount, line.currency)}
                          </div>
                          <div>{line.remainingAmount > BANK_ALLOCATION_EPSILON ? 'Partially Reconciled' : 'Fully Reconciled'}</div>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedLineIds.has(line.id) && line.allocations.length > 0 && (
                  <tr key={`${line.id}-allocations`} className="bg-slate-50 border-b">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="flex items-center justify-between text-xs text-gray-700 mb-2">
                        <span className="font-semibold">Allocation breakdown</span>
                        <span>
                          Bank {formatCurrency(line.debit || line.credit, line.currency)} · Allocated {formatCurrency(line.allocatedAmount, line.currency)} · Remaining {formatCurrency(line.remainingAmount, line.currency)}
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-gray-500 border-b">
                              <th className="py-1 pr-2">Document</th>
                              <th className="py-1 pr-2">Counterparty</th>
                              <th className="py-1 pr-2 text-right">Allocated</th>
                              <th className="py-1 pr-2 text-right">Document total</th>
                              <th className="py-1 pr-2 text-right">Document remaining</th>
                              <th className="py-1 pr-2">Journal</th>
                              <th className="py-1 pr-2 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {line.allocations.map(allocation => (
                              <tr key={allocation.id} className="border-b last:border-b-0">
                                <td className="py-1 pr-2">
                                  <button
                                    type="button"
                                    className="font-mono text-blue-700 hover:underline"
                                    onClick={() => allocation.journal_entry_id && onOpenJournal?.(allocation.journal_entry_id)}
                                  >
                                    {allocation.label || allocation.document_type}
                                  </button>
                                  <span className="ml-2 text-gray-500">{allocation.document_type}</span>
                                </td>
                                <td className="py-1 pr-2">{allocation.counterparty || '—'}</td>
                                <td className="py-1 pr-2 text-right font-medium">{formatCurrency(allocation.allocation_amount, line.currency)}</td>
                                <td className="py-1 pr-2 text-right">{allocation.document_total == null ? '—' : formatCurrency(allocation.document_total, line.currency)}</td>
                                <td className="py-1 pr-2 text-right">{allocation.document_remaining == null ? '—' : formatCurrency(allocation.document_remaining, line.currency)}</td>
                                <td className="py-1 pr-2">{allocation.journal_entry_id ? `${allocation.journal_entry_id.slice(0, 8)} · ${allocation.journal_status || 'Unknown'}` : '—'}</td>
                                <td className="py-1 pr-2 text-right">
                                  {canManage && (
                                    <button
                                      type="button"
                                      onClick={() => handleUnlinkSingleAllocation(allocation.id, allocation.label)}
                                      className="text-xs text-red-600 hover:text-red-800 underline font-medium"
                                      title="Unlink this individual allocation"
                                    >
                                      Unlink
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
              {/* Totals Row */}
              <tr className="bg-blue-50 border-t-2 border-blue-200 font-bold">
                <td colSpan={2} className="px-1.5 py-1 text-right text-gray-900">
                  TOTAL ({sortedLines.length} transactions):
                </td>
                <td className="px-1.5 py-1 text-right text-red-700 font-bold whitespace-nowrap">
                  {formatCurrency(sortedLines.reduce((sum, line) => sum + line.debit, 0), selectedAccount?.currency)}
                </td>
                <td className="px-1.5 py-1 text-right text-green-700 font-bold whitespace-nowrap">
                  {formatCurrency(sortedLines.reduce((sum, line) => sum + line.credit, 0), selectedAccount?.currency)}
                </td>
                <td colSpan={2} className="px-1.5 py-1 text-center text-gray-600 text-sm">
                  Net: {formatCurrency(sortedLines.reduce((sum, line) => sum + line.credit, 0) - sortedLines.reduce((sum, line) => sum + line.debit, 0), selectedAccount?.currency)}
                </td>
              </tr>
            </tbody>
          </table>

          {/* Pagination Toolbar */}
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-600 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span>
                Showing {totalFiltered === 0 ? 0 : (validCurrentPage - 1) * numPageSize + 1} to{' '}
                {pageSize === 'all' ? totalFiltered : Math.min(validCurrentPage * numPageSize, totalFiltered)} of{' '}
                <strong className="font-semibold text-gray-900">{totalFiltered}</strong> transactions
                {searchTerm ? ` (filtered from ${statementLines.length} total)` : ''}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span>Rows per page:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    const val = e.target.value === 'all' ? 'all' : Number(e.target.value);
                    setPageSize(val);
                    setCurrentPage(1);
                  }}
                  className="px-2 py-0.5 border border-gray-300 rounded bg-white text-xs font-medium"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={250}>250</option>
                  <option value="all">All</option>
                </select>
              </div>
              {pageSize !== 'all' && totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={validCurrentPage <= 1}
                    className="p-1 rounded border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40"
                    title="Previous Page"
                    aria-label="Previous Page"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="px-2 font-medium">
                    Page {validCurrentPage} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={validCurrentPage >= totalPages}
                    className="p-1 rounded border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40"
                    title="Next Page"
                    aria-label="Next Page"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Recording Modal */}
      <Modal
        isOpen={recordModal}
        onClose={() => {
          setRecordModal(false);
          setRecordingLine(null);
          setLinkToExpense(false);
          setLinkJournalEntry(false);
          setAvailableJournals([]);
          setLinkToSupplierPayment(false);
          setSupplierPayments([]);
          setLinkToTaxPayment(false);
          setAvailableTaxPayments([]);
          setLinkSettleBills(false);
          setBillAllocations([]);
          setOutstandingBills([]);
          setReceiptType('');
          setReceiptCustomerId('');
          setReceiptInvoices([]);
          setReceiptAllocations({});
          recordingReceiptRef.current = false;
          setRecordingReceipt(false);
        }}
        title="Record Transaction"
      >
        {recordingLine && (
          <div className="space-y-4 pb-32">
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Date:</span>
                <span className="font-medium">{new Date(recordingLine.date).toLocaleDateString('id-ID')}</span>
              </div>
              <div className="mt-2 text-sm">
                <span className="text-gray-600">Description:</span>
                <p className="font-medium mt-1">{recordingLine.description}</p>
              </div>
              {recordingLine.debit > 0 && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-sm text-gray-600">Amount:</span>
                  <span className="text-lg font-bold text-red-600">
                    {formatCurrency(recordingLine.debit, recordingLine.currency)}
                  </span>
                </div>
              )}
              {recordingLine.credit > 0 && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-sm text-gray-600">Amount:</span>
                  <span className="text-lg font-bold text-green-600">
                    {formatCurrency(recordingLine.credit, recordingLine.currency)}
                  </span>
                </div>
              )}
            </div>

            {recordingLine.allocatedAmount > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs space-y-1">
                <div className="font-semibold text-amber-900 flex items-center justify-between">
                  <span>Partially Reconciled Bank Transaction</span>
                  <span className="text-amber-800 font-bold">Remaining: {formatCurrency(recordingLine.remainingAmount, recordingLine.currency)}</span>
                </div>
                <div className="flex justify-between text-gray-600">
                  <span>Total Bank Amount:</span>
                  <span>{formatCurrency(recordingLine.debit || recordingLine.credit, recordingLine.currency)}</span>
                </div>
                <div className="flex justify-between text-gray-600">
                  <span>Already Allocated:</span>
                  <span className="text-green-700 font-medium">{formatCurrency(recordingLine.allocatedAmount, recordingLine.currency)}</span>
                </div>
              </div>
            )}

            {recordingLine.currency === 'USD' && (
              <div className="p-3 border border-blue-200 bg-blue-50 rounded-lg">
                <SapRow>
                  <FloatingField label="USD to IDR Exchange Rate" span={6} required filled={!!recordExchangeRate}>
                    <input name="record_exchange_rate" aria-label="Record Exchange Rate"
                      type="number"
                      min="1.000001"
                      step="0.000001"
                      value={recordExchangeRate || ''}
                      onChange={(e) => setRecordExchangeRate(parseFloat(e.target.value) || 0)}
                      className={FLOAT_INPUT}
                      required
                    />
                  </FloatingField>
                  <FloatingField label="Functional Amount (IDR)" span={6} staticLabel>
                    <div className="px-2 pt-2.5 pb-0 text-right font-mono font-semibold text-xs h-full flex items-center">
                      {formatCurrency((recordingLine.debit || recordingLine.credit) * recordExchangeRate, 'IDR')}
                    </div>
                  </FloatingField>
                </SapRow>
              </div>
            )}

            {recordingLine.debit > 0 && (
              <div>
                <div className="space-y-2 mb-3">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Money Out Actions</div>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setRecordDirectorRelatedParty(false);
                        setRecordLoanRepayment(false);
                        setRecordLoanDebit(false);
                        setRecordDirectorLoanWithdrawal(false);
                        setLinkToSupplierPayment(true);
                        setLinkToExpense(false);
                        setLinkJournalEntry(false);
                        setLinkToTaxPayment(false);
                        setLinkSettleBills(false);
                        loadSupplierPayments(recordingLine);
                      }}
                      className={`py-2 px-3 rounded-lg text-sm font-medium ${linkToSupplierPayment ? 'bg-orange-600 text-white' : 'bg-orange-50 text-orange-700 border border-orange-200'}`}
                    >
                      Supplier Payment
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRecordDirectorRelatedParty(true);
                        setRecordLoanDebit(false);
                        setRecordLoanRepayment(false);
                        setRecordDirectorLoanWithdrawal(false);
                        setLinkToExpense(false);
                        setLinkJournalEntry(false);
                        setLinkToSupplierPayment(false);
                        setLinkToTaxPayment(false);
                        setLinkSettleBills(false);
                        loadDirectorSummary(selectedDirectorName);
                        setDirectorNotes(recordingLine.description || '');
                      }}
                      className={`py-2 px-3 rounded-lg text-sm font-medium ${recordDirectorRelatedParty ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 border border-indigo-200'}`}
                    >
                      Director / Related Party
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRecordDirectorRelatedParty(false);
                        setRecordLoanRepayment(false);
                        setRecordLoanDebit(false);
                        setRecordDirectorLoanWithdrawal(false);
                        setLinkToTaxPayment(true);
                        setLinkToExpense(false);
                        setLinkJournalEntry(false);
                        setLinkToSupplierPayment(false);
                        setLinkSettleBills(false);
                        loadAvailableTaxPayments(recordingLine);
                      }}
                      className={`py-2 px-3 rounded-lg text-sm font-medium ${linkToTaxPayment ? 'bg-purple-600 text-white' : 'bg-purple-50 text-purple-700 border border-purple-200'}`}
                    >
                      Tax Payment
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRecordDirectorRelatedParty(false);
                        setLinkToExpense(false);
                        setLinkJournalEntry(false);
                        setLinkToSupplierPayment(false);
                        setLinkToTaxPayment(false);
                        setLinkSettleBills(false);
                        setRecordLoanRepayment(false);
                        setRecordLoanDebit(false);
                        setRecordDirectorLoanWithdrawal(false);
                      }}
                      className={`py-2 px-3 rounded-lg text-sm font-medium ${!linkToExpense && !linkJournalEntry && !linkToSupplierPayment && !linkToTaxPayment && !linkSettleBills && !recordDirectorRelatedParty ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                    >
                      Create New Expense
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRecordDirectorRelatedParty(false);
                        setRecordLoanRepayment(false);
                        setRecordLoanDebit(false);
                        setRecordDirectorLoanWithdrawal(false);
                        setLinkToExpense(true);
                        setLinkJournalEntry(false);
                        setLinkToSupplierPayment(false);
                        setLinkToTaxPayment(false);
                        setLinkSettleBills(false);
                      }}
                      className={`py-2 px-3 rounded-lg text-sm font-medium ${linkToExpense && !linkJournalEntry && !linkToSupplierPayment && !linkToTaxPayment && !linkSettleBills && !recordDirectorRelatedParty ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                    >
                      Link Expense
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRecordDirectorRelatedParty(false);
                        setRecordLoanRepayment(false);
                        setRecordLoanDebit(false);
                        setRecordDirectorLoanWithdrawal(false);
                        setLinkSettleBills(true);
                        setLinkToExpense(false);
                        setLinkJournalEntry(false);
                        setLinkToSupplierPayment(false);
                        setLinkToTaxPayment(false);
                        setBillAllocations([]);
                        loadOutstandingBills();
                      }}
                      className={`py-2 px-3 rounded-lg text-sm font-medium ${linkSettleBills ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}
                    >
                      Settle Bills
                    </button>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setRecordDirectorRelatedParty(false);
                        setRecordLoanRepayment(false);
                        setRecordLoanDebit(false);
                        setRecordDirectorLoanWithdrawal(false);
                        setLinkJournalEntry(true);
                        setLinkToExpense(false);
                        setLinkToSupplierPayment(false);
                        setLinkToTaxPayment(false);
                        setLinkSettleBills(false);
                        loadAvailableJournals(recordingLine);
                      }}
                      className={`py-1.5 px-3 rounded-lg text-xs font-medium ${linkJournalEntry && !linkToSupplierPayment && !linkToTaxPayment && !recordDirectorRelatedParty ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                    >
                      Link Journal
                    </button>
                    <button
                      type="button"
                      onClick={() => onRecordContra?.({
                        bankAccountId: selectedBank,
                        statementLineId: recordingLine.id,
                        date: recordingLine.date,
                        amount: recordingLine.remainingAmount > 0 ? recordingLine.remainingAmount : recordingLine.debit,
                        description: recordingLine.description,
                        direction: 'from',
                      })}
                      className="py-1.5 px-3 rounded-lg text-xs font-medium bg-cyan-50 text-cyan-700 border border-cyan-200"
                    >
                      Record Contra
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const prefill = {
                          bankAccountId: selectedBank,
                          statementLineId: recordingLine.id,
                          date: recordingLine.date,
                          amount: recordingLine.remainingAmount > 0 ? recordingLine.remainingAmount : recordingLine.debit,
                          currency: recordingLine.currency as 'IDR' | 'USD',
                          reference: recordingLine.reference || '',
                          description: recordingLine.description,
                          partyType: 'supplier' as const,
                          paymentPurpose: 'supplier_advance',
                          settlementAgainst: 'advance' as const,
                        };
                        setRecordModal(false);
                        if (onRecordPayment) onRecordPayment(prefill);
                        else setEmbeddedPaymentPrefill(prefill);
                      }}
                      className="py-1.5 px-2.5 rounded-lg text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200 shadow-sm"
                      title="Record an advance or deposit paid to a supplier"
                    >
                      Supplier Advance
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const prefill = {
                          bankAccountId: selectedBank,
                          statementLineId: recordingLine.id,
                          date: recordingLine.date,
                          amount: recordingLine.remainingAmount > 0 ? recordingLine.remainingAmount : recordingLine.debit,
                          currency: recordingLine.currency as 'IDR' | 'USD',
                          reference: recordingLine.reference || '',
                          description: recordingLine.description,
                          partyType: 'supplier',
                          paymentPurpose: 'supplier_invoice_payment',
                        };
                        setRecordModal(false);
                        if (onRecordPayment) onRecordPayment(prefill);
                        else setEmbeddedPaymentPrefill(prefill);
                      }}
                      className="py-1.5 px-2.5 rounded-lg text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100"
                    >
                      Supplier Payment
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const prefill = {
                          bankAccountId: selectedBank,
                          statementLineId: recordingLine.id,
                          date: recordingLine.date,
                          amount: recordingLine.remainingAmount > 0 ? recordingLine.remainingAmount : recordingLine.debit,
                          currency: recordingLine.currency as 'IDR' | 'USD',
                          reference: recordingLine.reference || '',
                          description: recordingLine.description,
                          partyType: 'customer',
                          paymentPurpose: 'customer_refund',
                        };
                        setRecordModal(false);
                        if (onRecordPayment) onRecordPayment(prefill);
                        else setEmbeddedPaymentPrefill(prefill);
                      }}
                      className="py-1.5 px-2.5 rounded-lg text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                    >
                      Customer Refund
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const prefill = {
                          bankAccountId: selectedBank,
                          statementLineId: recordingLine.id,
                          date: recordingLine.date,
                          amount: recordingLine.remainingAmount > 0 ? recordingLine.remainingAmount : recordingLine.debit,
                          currency: recordingLine.currency as 'IDR' | 'USD',
                          reference: recordingLine.reference || '',
                          description: recordingLine.description,
                          partyType: 'employee',
                          paymentPurpose: 'salary_payroll',
                        };
                        setRecordModal(false);
                        if (onRecordPayment) onRecordPayment(prefill);
                        else setEmbeddedPaymentPrefill(prefill);
                      }}
                      className="py-1.5 px-2.5 rounded-lg text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                    >
                      Staff Payment
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const prefill = {
                          bankAccountId: selectedBank,
                          statementLineId: recordingLine.id,
                          date: recordingLine.date,
                          amount: recordingLine.remainingAmount > 0 ? recordingLine.remainingAmount : recordingLine.debit,
                          currency: recordingLine.currency as 'IDR' | 'USD',
                          reference: recordingLine.reference || '',
                          description: recordingLine.description,
                          partyType: 'director',
                          paymentPurpose: 'director_loan_repayment',
                        };
                        setRecordModal(false);
                        if (onRecordPayment) onRecordPayment(prefill);
                        else setEmbeddedPaymentPrefill(prefill);
                      }}
                      className="py-1.5 px-2.5 rounded-lg text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                    >
                      Director Repayment
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const prefill = {
                          bankAccountId: selectedBank,
                          statementLineId: recordingLine.id,
                          date: recordingLine.date,
                          amount: recordingLine.remainingAmount > 0 ? recordingLine.remainingAmount : recordingLine.debit,
                          currency: recordingLine.currency as 'IDR' | 'USD',
                          reference: recordingLine.reference || '',
                          description: recordingLine.description,
                          partyType: 'other',
                          paymentPurpose: 'other_payment',
                        };
                        setRecordModal(false);
                        if (onRecordPayment) onRecordPayment(prefill);
                        else setEmbeddedPaymentPrefill(prefill);
                      }}
                      className="py-1.5 px-2.5 rounded-lg text-xs font-medium bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100"
                    >
                      Other Payment
                    </button>
                  </div>
                </div>

                {recordDirectorRelatedParty ? (
                  <div className="space-y-4 bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                    <div className="border-b pb-2 flex items-center justify-between">
                      <div>
                        <h4 className="font-semibold text-sm text-slate-800">DIRECTOR / RELATED PARTY TRANSACTION</h4>
                        <p className="text-xs text-slate-500">Money moving between SAPJ and Director / Owner</p>
                      </div>
                      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-rose-100 text-rose-800">
                        Money Paid To Director (Cash Outflow)
                      </span>
                    </div>

                    {/* Live Balance Summary */}
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                      <div className="flex items-center justify-between text-xs text-slate-600 mb-2">
                        <span className="font-medium">Director Position ({selectedDirectorName}):</span>
                        {loadingDirectorSummary && <span className="text-slate-400">Loading live balances...</span>}
                      </div>
                      {directorSummary && (
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="bg-white p-2 rounded border border-slate-200">
                            <span className="block text-[11px] text-slate-500 font-medium">Due TO Director (2105)</span>
                            <span className="text-xs font-bold text-rose-600">
                              {formatCurrency(directorSummary.due_to_director, recordingLine.currency)}
                            </span>
                          </div>
                          <div className="bg-white p-2 rounded border border-slate-200">
                            <span className="block text-[11px] text-slate-500 font-medium">Due FROM Director (1310)</span>
                            <span className="text-xs font-bold text-blue-600">
                              {formatCurrency(directorSummary.due_from_director, recordingLine.currency)}
                            </span>
                          </div>
                          <div className="bg-white p-2 rounded border border-slate-200">
                            <span className="block text-[11px] text-slate-500 font-medium">Net Position</span>
                            <span className={`text-xs font-bold ${directorSummary.net_status === 'payable' ? 'text-rose-700' : directorSummary.net_status === 'receivable' ? 'text-blue-700' : 'text-slate-700'}`}>
                              {formatCurrency(directorSummary.net_position, recordingLine.currency)} ({directorSummary.net_status})
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Form Fields */}
                    <SapRow>
                      <FloatingField label="Director / Related Party" span={6} required filled={!!selectedDirectorName}>
                        <select
                          value={selectedDirectorName}
                          onChange={(e) => {
                            const name = e.target.value;
                            setSelectedDirectorName(name);
                            loadDirectorSummary(name);
                          }}
                          className={FLOAT_INPUT}
                        >
                          <option value="Vijay Lunkad">Vijay Lunkad</option>
                        </select>
                      </FloatingField>
                      <FloatingField label="Transaction Direction" span={6} staticLabel>
                        <div className="px-2 pt-2.5 pb-0 text-rose-800 text-xs font-medium h-full flex items-center">
                          🔴 Money Paid To Director
                        </div>
                      </FloatingField>
                    </SapRow>

                    <SapRow>
                      <FloatingField label="Amount" span={6} staticLabel>
                        <div className="px-2 pt-2.5 pb-0 font-mono font-bold text-gray-800 text-xs h-full flex items-center">
                          {formatCurrency(recordingLine.debit, recordingLine.currency)}
                        </div>
                      </FloatingField>
                      <FloatingField label="Date" span={6} staticLabel>
                        <div className="px-2 pt-2.5 pb-0 text-gray-800 text-xs h-full flex items-center">
                          {new Date(recordingLine.date).toLocaleDateString('id-ID')}
                        </div>
                      </FloatingField>
                    </SapRow>

                    <SapRow>
                      <FloatingField label="Description / Notes" span={12} filled={!!directorNotes}>
                        <input
                          type="text"
                          value={directorNotes}
                          onChange={(e) => setDirectorNotes(e.target.value)}
                          placeholder="e.g. Settle Vijay balance / advance"
                          className={FLOAT_INPUT}
                        />
                      </FloatingField>
                    </SapRow>

                    {/* Automatic Accounting Treatment Preview */}
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-900 space-y-1">
                      <div className="font-semibold flex items-center gap-1">
                        <span>⚡ Automatic Accounting Treatment:</span>
                      </div>
                      {directorSummary && directorSummary.due_to_director > 0 ? (
                        <p>
                          SAPJ currently owes {selectedDirectorName} {formatCurrency(directorSummary.due_to_director, recordingLine.currency)}.
                          This payment will <strong>settle Director Payable (Dr 2105)</strong> up to {formatCurrency(Math.min(recordingLine.debit, directorSummary.due_to_director), recordingLine.currency)}.
                          {recordingLine.debit > directorSummary.due_to_director && (
                            <span> The remaining {formatCurrency(recordingLine.debit - directorSummary.due_to_director, recordingLine.currency)} will be recorded as <strong>Due from Director (Dr 1310)</strong>.</span>
                          )}
                        </p>
                      ) : (
                        <p>
                          SAPJ has no outstanding payable to {selectedDirectorName}. This payment will be recorded as <strong>Due from Director / Receivable (Dr 1310)</strong>.
                        </p>
                      )}
                      <p className="text-[11px] text-blue-700 italic">Double-entry: Dr 2105/1310, Cr Bank. No P&L impact.</p>
                    </div>

                    <button
                      type="button"
                      disabled={recordingReceipt}
                      onClick={() => handleRecordDirectorRelatedParty(recordingLine)}
                      className="w-full py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium text-sm disabled:opacity-50"
                    >
                      {recordingReceipt ? 'Recording...' : 'Record Money Paid To Director'}
                    </button>
                  </div>
                ) : recordLoanDebit ? (
                  <div className="space-y-3 bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                    <h4 className="font-semibold text-sm text-slate-800 border-b pb-2">RECORD AS LOAN</h4>
                    <SapRow>
                      <FloatingField label="Loan Direction" span={6} required filled={!!loanDirection}>
                        <select
                          value={loanDirection}
                          onChange={(e) => {
                            const dir = e.target.value as 'given' | 'taken';
                            setLoanDirection(dir);
                            loadLoanAccounts(dir, loanCounterparty);
                          }}
                          className={FLOAT_INPUT}
                        >
                          <option value="given">Loan Given / Receivable</option>
                          <option value="taken">Loan Received / Liability</option>
                        </select>
                      </FloatingField>
                      <FloatingField label="Counterparty" span={6} required filled={!!loanCounterparty}>
                        <input
                          type="text"
                          value={loanCounterparty}
                          onChange={(e) => {
                            const val = e.target.value;
                            setLoanCounterparty(val);
                            const cp = val.toLowerCase();
                            if (loanDirection === 'taken') {
                              if (cp.includes('vijay') || cp.includes('lunkad') || cp.includes('director')) {
                                const a = loanAccounts.find(acc => acc.code === '2105');
                                if (a) setLoanCoaId(a.id);
                              } else if (cp.match(/bank|bca|mandiri|bni|bri|cimb|danamon|permata|uob/)) {
                                const a = loanAccounts.find(acc => acc.code === '2210');
                                if (a) setLoanCoaId(a.id);
                              }
                            } else if (loanDirection === 'given') {
                              const a = loanAccounts.find(acc => acc.code === '1310');
                              if (a) setLoanCoaId(a.id);
                            }
                          }}
                          placeholder="e.g. Vijay Lunkad"
                          required
                          className={FLOAT_INPUT}
                        />
                      </FloatingField>
                    </SapRow>

                    <SapRow>
                      <FloatingField label="Account" span={12} required filled={!!loanCoaId} hint={loanDirection === 'given' ? 'Asset account for loan given (default: 1310 — Loan Receivable).' : 'Liability account for borrowings (e.g. 2105 Director Loan, 2210 Bank Loans).'}>
                        <select
                          value={loanCoaId}
                          onChange={(e) => setLoanCoaId(e.target.value)}
                          required
                          className={FLOAT_INPUT}
                        >
                          <option value="">Select account...</option>
                          {loanAccounts.map(acc => (
                            <option key={acc.id} value={acc.id}>
                              {acc.code} — {acc.name}
                            </option>
                          ))}
                        </select>
                      </FloatingField>
                    </SapRow>

                    <SapRow>
                      <FloatingField label="Amount" span={12} staticLabel>
                        <div className="px-2 pt-2.5 pb-0 font-mono font-bold text-gray-800 text-xs h-full flex items-center">
                          {formatCurrency(recordingLine.debit, recordingLine.currency)}
                        </div>
                      </FloatingField>
                    </SapRow>

                    <SapRow>
                      <FloatingField label="Description" span={12} filled={!!recordingLine.description}>
                        <input
                          type="text"
                          name="description"
                          defaultValue={recordingLine.description}
                          className={FLOAT_INPUT}
                        />
                      </FloatingField>
                    </SapRow>

                    <button
                      type="button"
                      onClick={() => handleRecordLoan(recordingLine)}
                      className="w-full py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium text-sm"
                    >
                      Record Loan
                    </button>
                  </div>
                ) : recordLoanRepayment ? (
                  <div className="space-y-3">
                    <SapRow>
                      <FloatingField label="Loan" span={12} required filled={!!repaymentLoanId}>
                        <select name="loan" aria-label="Loan"
                          value={repaymentLoanId}
                          onChange={(e) => setRepaymentLoanId(e.target.value)}
                          className={FLOAT_INPUT}
                          required
                        >
                          <option value="">Select active loan...</option>
                          {activeLoans
                            .filter(loan => loan.currency === recordingLine.currency && (!loan.loan_type || loan.loan_type === 'taken'))
                            .map(loan => (
                              <option key={loan.id} value={loan.id}>
                                {loan.loan_number} — {loan.counterparty_name} — {formatCurrency(loan.outstanding_balance, loan.currency)} outstanding
                              </option>
                            ))}
                        </select>
                      </FloatingField>
                    </SapRow>
                    <SapRow>
                      <FloatingField label="Principal" span={6} required filled={!!repaymentPrincipal}>
                        <MoneyInput decimal value={repaymentPrincipal}
                          onChange={(n) => setRepaymentPrincipal(n)}
                          className={FLOAT_INPUT} />
                      </FloatingField>
                      <FloatingField label="Interest" span={6} filled={!!repaymentInterest}>
                        <MoneyInput decimal value={repaymentInterest}
                          onChange={(n) => setRepaymentInterest(n)}
                          className={FLOAT_INPUT} />
                      </FloatingField>
                    </SapRow>
                    <button type="button" onClick={() => handleRecordLoanRepayment(recordingLine)}
                      className="w-full py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
                      Record Loan Repayment
                    </button>
                  </div>
                ) : recordDirectorLoanWithdrawal ? (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500">Post this bank debit to an existing Director Loan COA. This creates a normal bank-linked journal only.</p>
                    <SapRow>
                      <FloatingField label="Director / Owner loan ledger" span={12} required filled={!!directorLoanAccountId}>
                        <SearchableSelect
                          value={directorLoanAccountId}
                          onChange={setDirectorLoanAccountId}
                          options={directorLoanAccounts.map(option => ({ value: option.account.id, label: directorOwnerName(option) }))}
                          placeholder="Select existing Director / Owner..."
                        />
                      </FloatingField>
                    </SapRow>
                    {directorLoanAccountId && (() => {
                      const option = directorLoanAccounts.find(item => item.account.id === directorLoanAccountId);
                      return option ? <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"><span className="font-medium">Account:</span> <span className="font-mono">{option.account.code}</span> — {option.account.name}</div> : null;
                    })()}
                    <button type="button" onClick={() => handleRecordDirectorLoanWithdrawal(recordingLine)} disabled={!directorLoanAccountId}
                      className="w-full py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50">
                      Record Director Loan Withdrawal
                    </button>
                  </div>
                ) : linkSettleBills ? (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500">
                      Pay one or more outstanding bills with this bank debit. A posted Payment Voucher is created and linked automatically. Bills of one supplier or one staff member per payment.
                    </p>
                    {loadingBills ? (
                      <div className="flex justify-center py-4"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-emerald-600" /></div>
                    ) : outstandingBills.length === 0 ? (
                      <div className="p-3 text-center text-gray-500 text-sm border rounded-lg">
                        No outstanding supplier or staff bills found. Bills without a payee can be linked via "Link Expense".
                      </div>
                    ) : (
                      <>
                        <div className="max-h-56 overflow-y-auto border border-emerald-200 rounded-lg">
                          <table className="w-full text-xs">
                            <thead className="bg-emerald-50 sticky top-0">
                              <tr>
                                <th className="px-2 py-1.5"></th>
                                <th className="px-2 py-1.5 text-left font-medium text-emerald-700">Payee / Invoice</th>
                                <th className="px-2 py-1.5 text-right font-medium text-emerald-700">Outstanding</th>
                                <th className="px-2 py-1.5 text-right font-medium text-emerald-700">Pay Now</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-emerald-100">
                              {outstandingBills.map(bill => {
                                const alloc = billAllocations.find(a => a.expenseId === bill.id);
                                return (
                                  <tr key={bill.id} className={alloc ? 'bg-emerald-50/60' : bill.days_overdue > 0 ? 'bg-red-50/50' : ''}>
                                    <td className="px-2 py-1.5 text-center">
                                      <input name="checkbox" aria-label="Checkbox"
                                        type="checkbox"
                                        checked={!!alloc}
                                        onChange={() => toggleBillAllocation(bill, recordingLine.debit)}
                                        className="accent-emerald-600"
                                      />
                                    </td>
                                    <td className="px-2 py-1.5">
                                      <div className="font-medium text-gray-800">
                                        {bill.supplier_name || bill.staff_name}
                                        {!bill.supplier_name && bill.staff_name && <span className="ml-1 text-[9px] text-teal-600 font-semibold">STAFF</span>}
                                      </div>
                                      <div className="text-gray-500 font-mono">{bill.invoice_number || bill.id.slice(0, 8)}</div>
                                      <div className="text-gray-400">
                                        {new Date(bill.invoice_date).toLocaleDateString('id-ID')}
                                        {bill.days_overdue > 0 && <span className="text-red-500 ml-1">{bill.days_overdue}d overdue</span>}
                                      </div>
                                    </td>
                                    <td className="px-2 py-1.5 text-right font-medium text-red-600">
                                      {formatCurrency(bill.balance_amount, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </td>
                                    <td className="px-2 py-1.5 text-right">
                                      {alloc && (
                                        <MoneyInput
                                          decimal
                                          min={0}
                                          max={bill.balance_amount}
                                          value={alloc.amount}
                                          onChange={(n) => setBillAllocationAmount(bill.id, Math.min(n, bill.balance_amount))}
                                          className="w-24 px-2 py-1 border border-emerald-300 rounded text-right focus:border-emerald-500 outline-none"
                                        />
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {(() => {
                          const total = billAllocations.reduce((s, a) => s + a.amount, 0);
                          const diff = recordingLine.debit - total;
                          return (
                            <div className="flex items-center justify-between text-xs font-medium">
                              <span className={Math.abs(diff) < 0.01 ? 'text-emerald-700' : diff < 0 ? 'text-red-600' : 'text-amber-600'}>
                                Allocated: {formatCurrency(total, recordingLine.currency)} / {formatCurrency(recordingLine.debit, recordingLine.currency)}
                                {Math.abs(diff) >= 0.01 && ` (${diff > 0 ? 'under' : 'over'} by ${formatCurrency(Math.abs(diff), recordingLine.currency)})`}
                              </span>
                              <button
                                onClick={() => handleSettleBills(recordingLine)}
                                disabled={settleSubmitting || billAllocations.filter(a => a.amount > 0).length === 0}
                                className="py-2 px-4 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium"
                              >
                                {settleSubmitting ? 'Settling…' : 'Create Voucher & Link'}
                              </button>
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </div>
                ) : linkJournalEntry ? (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500">Select a journal entry to link to this bank transaction (matching amount, +/-7 days).</p>
                    <div className="max-h-48 overflow-y-auto border rounded-lg divide-y">
                      {visiblePickerCandidates(availableJournals).length === 0 ? (
                        <div className="p-3 text-center text-gray-500 text-sm">No matching journal entries found</div>
                      ) : (
                        visiblePickerCandidates(availableJournals).map(j => (
                          <button
                            key={j.id}
                            onClick={() => handleLinkJournalEntry(recordingLine, j.id)}
                            disabled={j._linked}
                            className="w-full p-2 text-left hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm flex justify-between items-center"
                          >
                            <div>
                              <span className="font-mono font-medium text-blue-600">{j.entry_number}</span>
                              <span className="text-xs ml-2 px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                                {j.source_module === 'manual' ? 'Manual' : j.source_module}
                              </span>
                              <div className="text-xs text-gray-500 mt-0.5">{j.description}</div>
                              <div className="text-xs text-gray-400">{new Date(j.entry_date).toLocaleDateString('id-ID')}</div>
                              {j._linked && <div className="text-xs text-amber-700">Already linked</div>}
                            </div>
                            <span className="font-medium text-green-600">
                              {formatCurrency(j.total_debit || j.total_credit, recordingLine.currency)}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : linkToSupplierPayment ? (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500">Select a supplier payment voucher to link to this bank debit.</p>
                    {loadingSupplierPayments ? (
                      <div className="flex justify-center py-4"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-orange-600" /></div>
                    ) : (
                      <div className="max-h-56 overflow-y-auto border rounded-lg divide-y">
                        {visiblePickerCandidates(supplierPayments).length === 0 ? (
                          <div className="p-3 text-center text-gray-500 text-sm">No matching supplier payments found</div>
                        ) : (
                          visiblePickerCandidates(supplierPayments).map((pv: any) => (
                            <button
                              key={pv.id}
                              onClick={() => handleLinkSupplierPayment(recordingLine, pv.id)}
                              disabled={pv._linked}
                              className="w-full p-3 text-left hover:bg-orange-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm flex justify-between items-center"
                            >
                              <div>
                                <span className="font-mono font-medium text-orange-700">{pv.voucher_number}</span>
                                <div className="text-xs text-gray-500 mt-0.5">{pv.suppliers?.company_name || pv.finance_staff_master?.full_name}</div>
                                <div className="text-xs text-gray-400">{new Date(pv.voucher_date).toLocaleDateString('id-ID')}</div>
                                {pv._linked && <div className="text-xs text-amber-700">Already linked</div>}
                              </div>
                              <div className="text-right">
                                <div className="font-medium text-red-600">{formatCurrency(pv.bank_amount && Number(pv.bank_amount) > 0 ? pv.bank_amount : pv.net_amount, recordingLine.currency)}</div>
                                {pv.bank_amount && Number(pv.bank_amount) > 0 && Number(pv.bank_amount) !== Number(pv.amount) && <div className="text-xs text-blue-500">Invoice: {formatCurrency(pv.amount, pv.payment_currency || 'USD')}</div>}
                                {pv.pph_amount > 0 && <div className="text-xs text-orange-500">PPh: {formatCurrency(pv.pph_amount, recordingLine.currency)}</div>}
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ) : linkToTaxPayment ? (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500">Select a posted tax payment to link to this bank debit (matching bank account, amount within Rp 1, within ±7 days).</p>
                    {visiblePickerCandidates(availableTaxPayments).length === 0 ? (
                      <div className="p-3 text-center text-gray-500 text-sm border rounded-lg">No matching tax payments found</div>
                    ) : (
                      <div className="max-h-56 overflow-y-auto border rounded-lg divide-y">
                        {visiblePickerCandidates(availableTaxPayments).map((tp: any) => (
                          <button
                            key={tp.id}
                            onClick={() => handleLinkToTaxPayment(recordingLine, tp)}
                            disabled={tp._linked}
                            className="w-full p-3 text-left hover:bg-purple-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm flex justify-between items-center"
                          >
                            <div>
                              <span className="font-medium text-purple-700">{tp.tax_type}</span>
                              {tp.billing_code && <span className="text-xs ml-2 text-gray-500 font-mono">{tp.billing_code}</span>}
                              <div className="text-xs text-gray-400">{new Date(tp.payment_date).toLocaleDateString('id-ID')}</div>
                              {tp.ntpn && <div className="text-xs text-gray-400 font-mono">NTPN: {tp.ntpn}</div>}
                              {tp._linked && <div className="text-xs text-amber-700">Already linked</div>}
                            </div>
                            <div className="text-right">
                              <div className="font-medium text-red-600">{formatCurrency(tp.amount, 'IDR')}</div>
                              <div className={`text-xs px-1.5 py-0.5 rounded font-medium ${tp.status === 'posted' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{tp.status}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : !linkToExpense ? (
                  <div className="space-y-4 bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                    <div className="border-b pb-2">
                      <h4 className="font-semibold text-sm text-slate-800">RECORD AS EXPENSE</h4>
                      <p className="text-xs text-slate-500">
                        Opens the full SAPJ Expense form supporting Category, Utility (e.g. PT. PAM JAYA - water), billing date, billing month, billing reference, amount, PPN, PPH withholding/code, invoice description, payment method, currency, and original bill/receipt attachments.
                      </p>
                    </div>

                    {recordingLine.matchedExpense && (
                      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
                        <div className="flex items-center gap-2 text-amber-900 font-semibold text-xs">
                          <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                          <span>Existing Expense Found For This Transaction</span>
                        </div>
                        <div className="text-xs text-amber-800">
                          Expense <strong>{recordingLine.matchedExpense.voucher_number || 'Expense'}</strong> ({formatCurrency(recordingLine.matchedExpense.amount, recordingLine.currency)} · {recordingLine.matchedExpense.description}) was previously created for this bank transaction.
                        </div>
                        <button
                          type="button"
                          onClick={() => handleLinkToExpense(recordingLine, recordingLine.matchedExpenseId!)}
                          className="w-full py-2 bg-amber-600 hover:bg-amber-700 text-white rounded font-medium text-xs flex items-center justify-center gap-1.5 shadow-sm"
                        >
                          <Link2 className="w-3.5 h-3.5" />
                          Link to Existing {recordingLine.matchedExpense.voucher_number || 'Expense'}
                        </button>
                      </div>
                    )}

                    <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs space-y-1.5">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Billing Date:</span>
                        <span className="font-medium text-slate-800">{new Date(recordingLine.date).toLocaleDateString('id-ID')}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Debit Amount:</span>
                        <span className="font-bold text-red-600">{formatCurrency(recordingLine.debit, recordingLine.currency)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Invoice Description:</span>
                        <span className="font-medium text-slate-800 text-right max-w-[260px] truncate">{recordingLine.description}</span>
                      </div>
                      {recordingLine.reference && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Billing Reference:</span>
                          <span className="font-mono text-slate-700">{recordingLine.reference}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-slate-500">Payment Method:</span>
                        <span className="font-medium text-slate-700">Bank Transfer</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Currency:</span>
                        <span className="font-medium text-slate-700">{recordingLine.currency}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        const prefill: BankReconciliationExpensePrefill = {
                          statementLineId: recordingLine.id,
                          bankAccountId: selectedBank,
                          date: recordingLine.date,
                          amount: recordingLine.debit,
                          description: recordingLine.description,
                          currency: recordingLine.currency as 'IDR' | 'USD',
                          reference: recordingLine.reference || '',
                        };
                        setRecordModal(false);
                        setEmbeddedExpensePrefill(prefill);
                      }}
                      className="w-full py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm flex items-center justify-center gap-2 shadow-sm"
                    >
                      <span>Record as Expense</span>
                    </button>
                    {onRecordExpense && (
                      <button
                        type="button"
                        onClick={() => {
                          const prefill: BankReconciliationExpensePrefill = {
                            statementLineId: recordingLine.id,
                            bankAccountId: selectedBank,
                            date: recordingLine.date,
                            amount: recordingLine.debit,
                            description: recordingLine.description,
                            currency: recordingLine.currency as 'IDR' | 'USD',
                            reference: recordingLine.reference || '',
                          };
                          setRecordModal(false);
                          onRecordExpense(prefill);
                        }}
                        className="w-full py-1.5 text-xs text-slate-500 hover:text-blue-600 font-medium text-center"
                      >
                        Open Full Expense Form
                      </button>
                    )}
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formData = new FormData(e.currentTarget);
                      const expenseId = formData.get('expense_id') as string;
                      if (!expenseId) {
                        alert('Please select an expense');
                        return;
                      }
                      handleLinkToExpense(recordingLine, expenseId);
                    }}
                    className="space-y-3"
                  >
                    <SapRow>
                      <FloatingField label="Select Expense" span={12} required filled={false} hint={`Showing ${visibleExpenseCandidates(expenses).length} available expense${visibleExpenseCandidates(expenses).length !== 1 ? 's' : ''}. Match by voucher number or amount.`}>
                        <select
                          name="expense_id"
                          required
                          className={FLOAT_INPUT}
                          disabled={visibleExpenseCandidates(expenses).length === 0}
                        >
                          <option value="">
                            {visibleExpenseCandidates(expenses).length === 0 ? 'No available expenses found' : 'Choose an expense...'}
                          </option>
                          {visibleExpenseCandidates(expenses).map(expense => {
                            // Format date as DD/MM/YY
                            const date = new Date(expense.expense_date);
                            const dd = String(date.getDate()).padStart(2, '0');
                            const mm = String(date.getMonth() + 1).padStart(2, '0');
                            const yy = String(date.getFullYear()).slice(-2);
                            const formattedDate = `${dd}/${mm}/${yy}`;

                            return (
                              <option key={expense.id} value={expense.id} disabled={!expenseCanAcceptLink(expense)}>
                                {formattedDate} - {expense.voucher_number ? `[${expense.voucher_number}] ` : ''}
                                {expense.description} -
                                {formatCurrency(calculateCanonicalCashPayable(expense), recordingLine.currency)}
                                {!expenseCanAcceptLink(expense) ? ' (already settled)' : ''}
                              </option>
                            );
                          })}
                        </select>
                      </FloatingField>
                    </SapRow>
                    <SapRow>
                      <FloatingField label="Payment Kind" span={12} required filled={!!linkPaymentKind} hint="Choose PPh23 only when this bank line is the withholding tax being remitted to the government.">
                        <select name="payment_kind" aria-label="Payment Kind"
                          value={linkPaymentKind}
                          onChange={(e) => setLinkPaymentKind(e.target.value as 'supplier' | 'pph23')}
                          className={FLOAT_INPUT}
                        >
                          <option value="supplier">Supplier Payment</option>
                          <option value="pph23">PPh23 Remittance to Government</option>
                        </select>
                      </FloatingField>
                    </SapRow>
                    <button
                      type="submit"
                      className="w-full py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                    >
                      Link to Expense
                    </button>
                  </form>
                )}
              </div>
            )}

            {recordingLine.credit > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium">Record as Receipt</h4>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => onRecordContra?.({
                        bankAccountId: selectedBank,
                        statementLineId: recordingLine.id,
                        date: recordingLine.date,
                        amount: recordingLine.credit,
                        description: recordingLine.description,
                        direction: 'to',
                      })}
                      className="text-xs text-cyan-700 hover:underline"
                    >
                      Record Contra
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          const prefill: BankReconciliationReceiptPrefill = {
                            statementLineId: recordingLine.id,
                            bankAccountId: selectedBank,
                            date: recordingLine.date,
                            amount: recordingLine.credit,
                            description: recordingLine.description,
                            currency: recordingLine.currency as 'IDR' | 'USD',
                            reference: recordingLine.reference || '',
                            partyType: 'customer',
                            paymentPurpose: 'invoice_payment',
                          };
                          setRecordModal(false);
                          if (onRecordReceipt) onRecordReceipt(prefill);
                          else setEmbeddedReceiptPrefill(prefill);
                        }}
                        className="py-1 px-2.5 rounded-lg text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                      >
                        Customer Receipt
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const prefill: BankReconciliationReceiptPrefill = {
                            statementLineId: recordingLine.id,
                            bankAccountId: selectedBank,
                            date: recordingLine.date,
                            amount: recordingLine.credit,
                            description: recordingLine.description,
                            currency: recordingLine.currency as 'IDR' | 'USD',
                            reference: recordingLine.reference || '',
                            partyType: 'supplier',
                            paymentPurpose: 'supplier_refund',
                          };
                          setRecordModal(false);
                          if (onRecordReceipt) onRecordReceipt(prefill);
                          else setEmbeddedReceiptPrefill(prefill);
                        }}
                        className="py-1 px-2.5 rounded-lg text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                      >
                        Supplier Refund
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const prefill: BankReconciliationReceiptPrefill = {
                            statementLineId: recordingLine.id,
                            bankAccountId: selectedBank,
                            date: recordingLine.date,
                            amount: recordingLine.credit,
                            description: recordingLine.description,
                            currency: recordingLine.currency as 'IDR' | 'USD',
                            reference: recordingLine.reference || '',
                            partyType: 'employee',
                            paymentPurpose: 'employee_advance_recovery',
                          };
                          setRecordModal(false);
                          if (onRecordReceipt) onRecordReceipt(prefill);
                          else setEmbeddedReceiptPrefill(prefill);
                        }}
                        className="py-1 px-2.5 rounded-lg text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                      >
                        Staff Recovery
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const prefill: BankReconciliationReceiptPrefill = {
                            statementLineId: recordingLine.id,
                            bankAccountId: selectedBank,
                            date: recordingLine.date,
                            amount: recordingLine.credit,
                            description: recordingLine.description,
                            currency: recordingLine.currency as 'IDR' | 'USD',
                            reference: recordingLine.reference || '',
                            partyType: 'director',
                            paymentPurpose: 'director_funding',
                          };
                          setRecordModal(false);
                          if (onRecordReceipt) onRecordReceipt(prefill);
                          else setEmbeddedReceiptPrefill(prefill);
                        }}
                        className="py-1 px-2.5 rounded-lg text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                      >
                        Director Funding
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const prefill: BankReconciliationReceiptPrefill = {
                            statementLineId: recordingLine.id,
                            bankAccountId: selectedBank,
                            date: recordingLine.date,
                            amount: recordingLine.credit,
                            description: recordingLine.description,
                            currency: recordingLine.currency as 'IDR' | 'USD',
                            reference: recordingLine.reference || '',
                            partyType: 'other',
                            paymentPurpose: 'other_money_received',
                          };
                          setRecordModal(false);
                          if (onRecordReceipt) onRecordReceipt(prefill);
                          else setEmbeddedReceiptPrefill(prefill);
                        }}
                        className="py-1 px-2.5 rounded-lg text-xs font-medium bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100"
                      >
                        Other Receipt
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setLinkExistingReceipt(!linkExistingReceipt);
                        setLinkJournalEntry(false);
                        if (!linkExistingReceipt) loadExistingReceipts();
                      }}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      {linkExistingReceipt ? 'Create New Receipt' : 'Link Existing Receipt'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLinkJournalEntry(!linkJournalEntry);
                        setLinkExistingReceipt(false);
                        if (!linkJournalEntry) loadAvailableJournals(recordingLine);
                      }}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      {linkJournalEntry ? 'Create New Receipt' : 'Link Journal Entry'}
                    </button>
                  </div>
                </div>

                {linkExistingReceipt ? (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500">Select an existing receipt voucher to link to this bank statement line.</p>
                    <div className="max-h-48 overflow-y-auto border rounded-lg divide-y">
                      {visiblePickerCandidates(existingReceipts).length === 0 ? (
                        <div className="p-3 text-center text-gray-500 text-sm">No receipt vouchers found</div>
                      ) : (
                        visiblePickerCandidates(existingReceipts).map(r => (
                          <button
                            key={r.id}
                            onClick={() => handleLinkExistingReceipt(recordingLine, r.id)}
                            disabled={r._linked}
                            className="w-full p-2 text-left hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm flex justify-between items-center"
                          >
                            <div>
                              <span className="font-mono font-medium">{r.voucher_number}</span>
                              <span className="text-gray-500 ml-2">{r.customers?.company_name}</span>
                              <div className="text-xs text-gray-400">{new Date(r.voucher_date).toLocaleDateString('id-ID')}</div>
                              {r._linked && <div className="text-xs text-amber-700">Already linked</div>}
                            </div>
                            <span className="font-medium text-green-600">
                              {formatCurrency(r.amount, recordingLine.currency)}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : linkJournalEntry ? (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500">Select a journal entry to link to this bank transaction (matching amount, +/-7 days).</p>
                    <div className="max-h-48 overflow-y-auto border rounded-lg divide-y">
                      {visiblePickerCandidates(availableJournals).length === 0 ? (
                        <div className="p-3 text-center text-gray-500 text-sm">No matching journal entries found</div>
                      ) : (
                        visiblePickerCandidates(availableJournals).map(j => (
                          <button
                            key={j.id}
                            onClick={() => handleLinkJournalEntry(recordingLine, j.id)}
                            disabled={j._linked}
                            className="w-full p-2 text-left hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm flex justify-between items-center"
                          >
                            <div>
                              <span className="font-mono font-medium text-blue-600">{j.entry_number}</span>
                              <span className="text-xs ml-2 px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                                {j.source_module === 'manual' ? 'Manual' : j.source_module}
                              </span>
                              <div className="text-xs text-gray-500 mt-0.5">{j.description}</div>
                              <div className="text-xs text-gray-400">{new Date(j.entry_date).toLocaleDateString('id-ID')}</div>
                              {j._linked && <div className="text-xs text-amber-700">Already linked</div>}
                            </div>
                            <span className="font-medium text-green-600">
                              {formatCurrency(j.total_debit || j.total_credit, recordingLine.currency)}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formData = new FormData(e.currentTarget);
                      const type = formData.get('type') as string;
                      const description = formData.get('description') as string;
                      handleRecordReceipt(recordingLine, type, receiptCustomerId, description);
                    }}
                    className="space-y-3"
                  >
                    <SapRow>
                      <FloatingField label="Type" span={12} required filled={!!receiptType}>
                        <select
                          name="type"
                          value={receiptType}
                          required
                          className={FLOAT_INPUT}
                          onChange={(e) => {
                            const t = e.target.value;
                            setReceiptType(t);
                            if (t === 'director_related_party') {
                              loadDirectorSummary(selectedDirectorName);
                              setDirectorNotes(recordingLine.description || '');
                            } else if (t === 'loan') {
                              setLoanDirection('taken');
                              loadLoanAccounts('taken');
                            } else if (t === 'loan_repayment_received') {
                              loadActiveLoans();
                            }
                            if (t !== 'loan_director_owner') {
                              setDirectorLoanAccountId('');
                            }
                            if (t !== 'customer_payment') {
                              setReceiptCustomerId('');
                              setReceiptInvoices([]);
                              setReceiptAllocations({});
                            }
                          }}
                        >
                          <option value="">Select type...</option>
                          <optgroup label="MONEY IN">
                            <option value="customer_payment">Customer Receipt</option>
                            <option value="director_related_party">Director / Related Party</option>
                            <option value="capital">Capital Contribution</option>
                          </optgroup>
                          <optgroup label="OTHER RECEIPTS">
                            <option value="bank_interest">Bank Interest</option>
                            <option value="other_income">Other Income</option>
                            <option value="misc_income">Miscellaneous Income</option>
                            <option value="refund">Refund / Cash Return</option>
                          </optgroup>
                        </select>
                      </FloatingField>
                    </SapRow>

                    {receiptType === 'director_related_party' && (
                      <div className="space-y-4 bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                        <div className="border-b pb-2 flex items-center justify-between">
                          <div>
                            <h4 className="font-semibold text-sm text-slate-800">DIRECTOR / RELATED PARTY TRANSACTION</h4>
                            <p className="text-xs text-slate-500">Money moving between Director / Owner and SAPJ</p>
                          </div>
                          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800">
                            Money Received From Director (Cash Inflow)
                          </span>
                        </div>

                        {/* Live Balance Summary */}
                        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                          <div className="flex items-center justify-between text-xs text-slate-600 mb-2">
                            <span className="font-medium">Director Position ({selectedDirectorName}):</span>
                            {loadingDirectorSummary && <span className="text-slate-400">Loading live balances...</span>}
                          </div>
                          {directorSummary && (
                            <div className="grid grid-cols-3 gap-2 text-center">
                              <div className="bg-white p-2 rounded border border-slate-200">
                                <span className="block text-[11px] text-slate-500 font-medium">Due TO Director (2105)</span>
                                <span className="text-xs font-bold text-rose-600">
                                  {formatCurrency(directorSummary.due_to_director, recordingLine.currency)}
                                </span>
                              </div>
                              <div className="bg-white p-2 rounded border border-slate-200">
                                <span className="block text-[11px] text-slate-500 font-medium">Due FROM Director (1310)</span>
                                <span className="text-xs font-bold text-blue-600">
                                  {formatCurrency(directorSummary.due_from_director, recordingLine.currency)}
                                </span>
                              </div>
                              <div className="bg-white p-2 rounded border border-slate-200">
                                <span className="block text-[11px] text-slate-500 font-medium">Net Position</span>
                                <span className={`text-xs font-bold ${directorSummary.net_status === 'payable' ? 'text-rose-700' : directorSummary.net_status === 'receivable' ? 'text-blue-700' : 'text-slate-700'}`}>
                                  {formatCurrency(directorSummary.net_position, recordingLine.currency)} ({directorSummary.net_status})
                                </span>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Form Fields */}
                        <SapRow>
                          <FloatingField label="Director / Related Party" span={6} required filled={!!selectedDirectorName}>
                            <select
                              value={selectedDirectorName}
                              onChange={(e) => {
                                const name = e.target.value;
                                setSelectedDirectorName(name);
                                loadDirectorSummary(name);
                              }}
                              className={FLOAT_INPUT}
                            >
                              <option value="Vijay Lunkad">Vijay Lunkad</option>
                            </select>
                          </FloatingField>
                          <FloatingField label="Transaction Direction" span={6} staticLabel>
                            <div className="px-2 pt-2.5 pb-0 text-emerald-800 text-xs font-medium h-full flex items-center">
                              🟢 Money Received From Director
                            </div>
                          </FloatingField>
                        </SapRow>

                        <SapRow>
                          <FloatingField label="Amount" span={6} staticLabel>
                            <div className="px-2 pt-2.5 pb-0 font-mono font-bold text-gray-800 text-xs h-full flex items-center">
                              {formatCurrency(recordingLine.credit, recordingLine.currency)}
                            </div>
                          </FloatingField>
                          <FloatingField label="Date" span={6} staticLabel>
                            <div className="px-2 pt-2.5 pb-0 text-gray-800 text-xs h-full flex items-center">
                              {new Date(recordingLine.date).toLocaleDateString('id-ID')}
                            </div>
                          </FloatingField>
                        </SapRow>

                        <SapRow>
                          <FloatingField label="Description / Notes" span={12} filled={!!directorNotes}>
                            <input
                              type="text"
                              value={directorNotes}
                              onChange={(e) => setDirectorNotes(e.target.value)}
                              placeholder="e.g. Director funding / settlement"
                              className={FLOAT_INPUT}
                            />
                          </FloatingField>
                        </SapRow>

                        {/* Automatic Accounting Treatment Preview */}
                        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 space-y-1">
                          <div className="font-semibold flex items-center gap-1">
                            <span>⚡ Automatic Accounting Treatment:</span>
                          </div>
                          {directorSummary && directorSummary.due_from_director > 0 ? (
                            <p>
                              {selectedDirectorName} currently owes SAPJ {formatCurrency(directorSummary.due_from_director, recordingLine.currency)}.
                              This receipt will <strong>settle Due from Director (Cr 1310)</strong> up to {formatCurrency(Math.min(recordingLine.credit, directorSummary.due_from_director), recordingLine.currency)}.
                              {recordingLine.credit > directorSummary.due_from_director && (
                                <span> The remaining {formatCurrency(recordingLine.credit - directorSummary.due_from_director, recordingLine.currency)} will be recorded as <strong>Director Funding (Cr 2105)</strong>.</span>
                              )}
                            </p>
                          ) : (
                            <p>
                              No outstanding receivable from {selectedDirectorName}. This receipt will be recorded as <strong>Director Funding (Cr 2105 — Director Loan – Vijay)</strong>.
                            </p>
                          )}
                          <p className="text-[11px] text-emerald-700 italic">Double-entry: Dr Bank, Cr 1310/2105. No P&L impact.</p>
                        </div>

                        <button
                          type="button"
                          disabled={recordingReceipt}
                          onClick={() => handleRecordDirectorRelatedParty(recordingLine)}
                          className="w-full py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium text-sm disabled:opacity-50"
                        >
                          {recordingReceipt ? 'Recording...' : 'Record Money Received From Director'}
                        </button>
                      </div>
                    )}
                    {receiptType === 'customer_payment' && (
                      <SapRow>
                        <FloatingField label="Customer" span={12} required filled={!!receiptCustomerId}>
                          <SearchableSelect
                            value={receiptCustomerId}
                            onChange={(val) => {
                              setReceiptCustomerId(val);
                              setReceiptAllocations({});
                              if (val) {
                                loadCustomerInvoices(val);
                              } else {
                                setReceiptInvoices([]);
                              }
                            }}
                            options={customers.map(c => ({ value: c.id, label: c.company_name }))}
                            placeholder="Select customer..."
                          />
                        </FloatingField>
                      </SapRow>
                    )}

                    {receiptType === 'loan_director_owner' && (
                      <div className="space-y-2">
                        <SapRow>
                          <FloatingField label="Director / Owner" span={12} required filled={!!directorLoanAccountId}>
                            <SearchableSelect
                              value={directorLoanAccountId}
                              onChange={setDirectorLoanAccountId}
                              options={directorLoanAccounts.map(option => ({
                                value: option.account.id,
                                label: directorOwnerName(option),
                              }))}
                              placeholder="Select existing Director / Owner..."
                            />
                          </FloatingField>
                        </SapRow>
                        {directorLoanAccountId && (() => {
                          const option = directorLoanAccounts.find(item => item.account.id === directorLoanAccountId);
                          return option ? (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                              <span className="font-medium">Account:</span>{' '}
                              <span className="font-mono">{option.account.code}</span> — {option.account.name}
                            </div>
                          ) : null;
                        })()}
                        {directorLoanAccounts.length === 0 && (
                          <p className="text-xs text-amber-700">No existing active Director/Owner loan ledger is available.</p>
                        )}
                      </div>
                    )}

                    {receiptType === 'loan' && (
                      <div className="space-y-3 bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                        <h4 className="font-semibold text-sm text-slate-800 border-b pb-2">RECORD AS LOAN</h4>
                        <div className="grid grid-cols-2 gap-3">
                          <FloatingField label="Loan Direction" span={6} required filled={!!loanDirection}>
                            <select
                              value={loanDirection}
                              onChange={(e) => {
                                const dir = e.target.value as 'given' | 'taken';
                                setLoanDirection(dir);
                                loadLoanAccounts(dir, loanCounterparty);
                              }}
                              className={FLOAT_INPUT}
                            >
                              <option value="taken">Loan Received / Liability</option>
                              <option value="given">Loan Given / Receivable</option>
                            </select>
                          </FloatingField>
                          <FloatingField label="Counterparty" span={6} required filled={!!loanCounterparty}>
                            <input
                              type="text"
                              value={loanCounterparty}
                              onChange={(e) => {
                                const val = e.target.value;
                                setLoanCounterparty(val);
                                const cp = val.toLowerCase();
                                if (loanDirection === 'taken') {
                                  if (cp.includes('vijay') || cp.includes('lunkad') || cp.includes('director')) {
                                    const a = loanAccounts.find(acc => acc.code === '2105');
                                    if (a) setLoanCoaId(a.id);
                                  } else if (cp.match(/bank|bca|mandiri|bni|bri|cimb|danamon|permata|uob/)) {
                                    const a = loanAccounts.find(acc => acc.code === '2210');
                                    if (a) setLoanCoaId(a.id);
                                  }
                                } else if (loanDirection === 'given') {
                                  const a = loanAccounts.find(acc => acc.code === '1310');
                                  if (a) setLoanCoaId(a.id);
                                }
                              }}
                              placeholder="e.g. Vijay Lunkad or BCA"
                              required
                              className={FLOAT_INPUT}
                            />
                          </FloatingField>
                        </div>

                        <SapRow>
                          <FloatingField label="Account" span={12} required filled={!!loanCoaId} hint={loanDirection === 'given' ? 'Asset account for loan given (e.g. 1310 — Loan Receivable).' : 'Liability account for borrowings (e.g. 2105 Director Loan, 2210 Bank Loans).'}>
                            <select
                              value={loanCoaId}
                              onChange={(e) => setLoanCoaId(e.target.value)}
                              required
                              className={FLOAT_INPUT}
                            >
                              <option value="">Select account...</option>
                              {loanAccounts.map(acc => (
                                <option key={acc.id} value={acc.id}>
                                  {acc.code} — {acc.name}
                                </option>
                              ))}
                            </select>
                          </FloatingField>
                        </SapRow>
                      </div>
                    )}

                    {receiptType === 'loan_repayment_received' && (
                      <div className="space-y-3 bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                        <h4 className="font-semibold text-sm text-slate-800 border-b pb-2">LOAN REPAYMENT RECEIVED</h4>
                        <SapRow>
                          <FloatingField label="Loan Being Returned" span={12} required filled={!!repaymentLoanId} hint={activeLoans.filter(l => l.currency === recordingLine.currency && l.loan_type === 'given').length === 0 ? 'No active loans given with outstanding balance found.' : undefined}>
                            <select
                              value={repaymentLoanId}
                              onChange={(e) => {
                                const lid = e.target.value;
                                setRepaymentLoanId(lid);
                                const target = activeLoans.find(l => l.id === lid);
                                if (target) {
                                  setRepaymentPrincipal(Math.min(recordingLine.credit, target.outstanding_balance));
                                  setRepaymentInterest(0);
                                }
                              }}
                              className={FLOAT_INPUT}
                              required
                            >
                              <option value="">Select active loan given...</option>
                              {activeLoans
                                .filter(loan => loan.currency === recordingLine.currency && loan.loan_type === 'given')
                                .map(loan => (
                                  <option key={loan.id} value={loan.id}>
                                    {loan.loan_number} — {loan.counterparty_name} — {formatCurrency(loan.outstanding_balance, loan.currency)} outstanding
                                  </option>
                                ))}
                            </select>
                          </FloatingField>
                        </SapRow>
                        <SapRow>
                          <FloatingField label="Principal" span={6} required filled={!!repaymentPrincipal}>
                            <MoneyInput decimal value={repaymentPrincipal}
                              onChange={(n) => setRepaymentPrincipal(n)}
                              className={FLOAT_INPUT} />
                          </FloatingField>
                          <FloatingField label="Interest" span={6} filled={!!repaymentInterest}>
                            <MoneyInput decimal value={repaymentInterest}
                              onChange={(n) => setRepaymentInterest(n)}
                              className={FLOAT_INPUT} />
                          </FloatingField>
                        </SapRow>
                      </div>
                    )}

                    {receiptType === 'customer_payment' && receiptCustomerId && receiptInvoices.length > 0 && (
                      <div className="border rounded-lg p-2">
                        <p className="text-xs font-medium text-gray-600 mb-2">Allocate to Invoices (optional)</p>
                        <div className="max-h-40 overflow-y-auto space-y-1">
                          {receiptInvoices.map((inv: any) => {
                            const isChecked = receiptAllocations[inv.id] !== undefined;
                            return (
                              <div key={inv.id} className="flex items-center gap-2 text-xs p-1 hover:bg-gray-50 rounded">
                                <input name="checkbox" aria-label="Checkbox"
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      const remaining = recordingLine.credit - Object.values(receiptAllocations).reduce((a, b) => a + b, 0);
                                      setReceiptAllocations(prev => ({
                                        ...prev,
                                        [inv.id]: Math.min(inv.balance_amount, remaining)
                                      }));
                                    } else {
                                      const next = { ...receiptAllocations };
                                      delete next[inv.id];
                                      setReceiptAllocations(next);
                                    }
                                  }}
                                />
                                <div className="flex-1 min-w-0">
                                  <span className="font-mono">{inv.invoice_number}</span>
                                  <span className="text-red-500 ml-1">Bal: {formatCurrency(inv.balance_amount, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
                                </div>
                                {isChecked && (
                                  <MoneyInput
                                    decimal
                                    min={0}
                                    max={inv.balance_amount}
                                    value={receiptAllocations[inv.id] || 0}
                                    onChange={(n) => {
                                      setReceiptAllocations(prev => ({ ...prev, [inv.id]: Math.min(n, inv.balance_amount) }));
                                    }}
                                    className="w-24 px-1 py-0.5 border rounded text-right text-xs"
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-2 pt-2 border-t text-xs flex justify-between">
                          <span>Allocated:</span>
                          <span className="font-medium text-green-600">
                            {formatCurrency(Object.values(receiptAllocations).reduce((a, b) => a + b, 0), recordingLine.currency)}
                          </span>
                        </div>
                      </div>
                    )}
                    {receiptType === 'customer_payment' && receiptCustomerId && loadingInvoices && (
                      <div className="text-xs text-gray-500 text-center py-2">Loading invoices...</div>
                    )}

                    {receiptType !== 'director_related_party' && (
                      <>
                        <SapRow>
                          <FloatingField label="Description" span={12} filled={!!recordingLine.description}>
                            <input
                              type="text"
                              name="description"
                              defaultValue={recordingLine.description}
                              className={FLOAT_INPUT}
                              placeholder="Optional: Override description"
                            />
                          </FloatingField>
                        </SapRow>
                        <button
                          type="submit"
                          disabled={recordingReceipt}
                          className="w-full py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                        >
                          {recordingReceipt ? 'Recording...' : 'Record Receipt'}
                        </button>
                      </>
                    )}
                  </form>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!pendingExpenseAllocation}
        onClose={() => setPendingExpenseAllocation(null)}
        title={pendingExpenseAllocation && (pendingExpenseAllocation.bankAfter > 0.01 || pendingExpenseAllocation.documentAfter > 0.01)
          ? 'Confirm Partial Reconciliation' : 'Confirm Reconciliation'}
        size="sm"
        footer={<>
          <button type="button" onClick={() => setPendingExpenseAllocation(null)} className="px-3 py-2 text-xs border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={() => void confirmExpenseAllocation()} className="px-3 py-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
            {pendingExpenseAllocation && (pendingExpenseAllocation.bankAfter > 0.01 || pendingExpenseAllocation.documentAfter > 0.01)
              ? `Yes, Link ${formatCurrency(pendingExpenseAllocation.amount, pendingExpenseAllocation.line.currency)}` : 'Yes, Link'}
          </button>
        </>}
      >
        {pendingExpenseAllocation && <div className="space-y-3 text-sm">
          {paymentDateGapWarning(
            pendingExpenseAllocation.line.date,
            pendingExpenseAllocation.expense.expense_date,
          ) && <p className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded">
            {paymentDateGapWarning(pendingExpenseAllocation.line.date, pendingExpenseAllocation.expense.expense_date)}
          </p>}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 p-3 bg-gray-50 border rounded">
            <span className="text-gray-500">Bank transaction</span><span className="text-right font-semibold">{formatCurrency(pendingExpenseAllocation.line.debit || pendingExpenseAllocation.line.credit, pendingExpenseAllocation.line.currency)}</span>
            <span className="text-gray-500">Already allocated</span><span className="text-right">{formatCurrency(pendingExpenseAllocation.line.allocatedAmount, pendingExpenseAllocation.line.currency)}</span>
            <span className="text-gray-500">Document outstanding</span><span className="text-right">{formatCurrency(pendingExpenseAllocation.amount + pendingExpenseAllocation.documentAfter, pendingExpenseAllocation.line.currency)}</span>
            <span className="font-medium">Amount to link</span><span className="text-right font-bold text-blue-700">{formatCurrency(pendingExpenseAllocation.amount, pendingExpenseAllocation.line.currency)}</span>
            <span className="text-gray-500">Remaining bank balance</span><span className="text-right">{formatCurrency(pendingExpenseAllocation.bankAfter, pendingExpenseAllocation.line.currency)}</span>
            <span className="text-gray-500">Document remaining</span><span className="text-right">{formatCurrency(pendingExpenseAllocation.documentAfter, pendingExpenseAllocation.line.currency)}</span>
          </div>
          {(pendingExpenseAllocation.bankAfter > 0.01 || pendingExpenseAllocation.documentAfter > 0.01) && <p className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded">
            You are linking {formatCurrency(pendingExpenseAllocation.amount, pendingExpenseAllocation.line.currency)} to this document.
            {pendingExpenseAllocation.bankAfter > 0.01 && ` ${formatCurrency(pendingExpenseAllocation.bankAfter, pendingExpenseAllocation.line.currency)} will remain unreconciled and available for another document.`}
            {pendingExpenseAllocation.documentAfter > 0.01 && ` ${formatCurrency(pendingExpenseAllocation.documentAfter, pendingExpenseAllocation.line.currency)} will remain outstanding on the document.`}
          </p>}
        </div>}
      </Modal>

      {ocrError && (
        <Modal
          isOpen={true}
          onClose={() => {
            setOcrError(null);
            setLastUploadedFile(null);
          }}
          title="PDF Extraction Failed"
        >
          <div className="space-y-2">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-yellow-800 text-sm font-medium mb-2">{ocrError.message}</p>
              <div className="space-y-2">
                <p className="text-sm text-yellow-700 font-medium">Recommended options:</p>
                <ul className="list-disc list-inside space-y-1 text-sm text-yellow-700">
                  {ocrError.suggestions.map((suggestion, idx) => (
                    <li key={idx}>{suggestion}</li>
                  ))}
                </ul>
              </div>
            </div>

            {ocrError.canUseOCR && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 text-sm font-medium mb-2">Advanced Option: OCR Processing</p>
                <p className="text-blue-700 text-xs mb-3">
                  Optical Character Recognition (OCR) can extract text from image-based or encrypted PDFs.
                  This process takes 30-60 seconds and requires Google Vision API configuration.
                  You'll be able to preview the results before saving.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleRunOCR}
                    disabled={uploading}
                    className="flex-1 h-7 px-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
                  >
                    {uploading ? 'Processing with OCR...' : 'Run OCR Anyway'}
                  </button>
                  <button
                    onClick={() => {
                      setOcrError(null);
                      setLastUploadedFile(null);
                    }}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm font-medium"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {ocrPreview && (
        <Modal
          isOpen={true}
          onClose={() => setOcrPreview(null)}
          title="OCR Preview - Confirm Before Saving"
        >
          <div className="space-y-2">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-green-800 text-sm font-medium mb-2">
                ✅ OCR extracted {ocrPreview.transactionCount} transactions
              </p>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-gray-600">Period:</span>
                  <span className="ml-2 font-medium text-gray-900">{ocrPreview.period}</span>
                </div>
                <div>
                  <span className="text-gray-600">Opening Balance:</span>
                  <span className="ml-2 font-medium text-gray-900">
                    {formatCurrency(ocrPreview.openingBalance, selectedAccount?.currency)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Closing Balance:</span>
                  <span className="ml-2 font-medium text-gray-900">
                    {formatCurrency(ocrPreview.closingBalance, selectedAccount?.currency)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Transactions:</span>
                  <span className="ml-2 font-medium text-gray-900">{ocrPreview.transactionCount}</span>
                </div>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">Sample Transactions (First 10):</h4>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-1 text-left">Date</th>
                      <th className="px-2 py-1 text-left">Description</th>
                      <th className="px-2 py-1 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ocrPreview.transactions.map((txn: any, idx: number) => (
                      <tr key={`${txn.date}-${txn.description}-${txn.debitAmount ?? ''}-${txn.creditAmount ?? ''}-${idx}`} className="border-t">
                        <td className="px-2 py-1">{txn.date}</td>
                        <td className="px-2 py-1 truncate max-w-xs">{txn.description}</td>
                        <td className="px-2 py-1 text-right">
                          {formatCurrency(txn.debitAmount || txn.creditAmount, selectedAccount?.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-yellow-800 text-xs">
                ⚠️ Please verify the extracted data looks correct before confirming.
                OCR may have minor errors in dates, amounts, or descriptions.
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleConfirmOCRPreview}
                disabled={uploading}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium"
              >
                {uploading ? 'Saving...' : 'Confirm & Save'}
              </button>
              <button
                onClick={() => setOcrPreview(null)}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setDeletePreview(null);
        }}
        title="Confirm Clear Data"
      >
        {deletePreview && (
          <div className="space-y-2">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h4 className="font-medium text-yellow-900 mb-2">Warning: Data Deletion</h4>
              <p className="text-sm text-yellow-800">
                You are about to clear bank statement data. This action cannot be undone.
              </p>
            </div>

            <div className="bg-gray-50 border rounded-lg p-4 space-y-3">
              <div>
                <div className="text-xs text-gray-600 mb-1">Bank Account</div>
                <div className="font-medium text-gray-900">
                  {deletePreview.bank_info?.bank_name} - {deletePreview.bank_info?.account_number}
                  <span className="ml-2 px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">
                    {deletePreview.bank_info?.currency}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-gray-600 mb-1">Date Range</div>
                  <div className="text-sm font-medium text-gray-900">
                    {new Date(deletePreview.start_date).toLocaleDateString('id-ID')} -
                    {' '}{new Date(deletePreview.end_date).toLocaleDateString('id-ID')}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-gray-600 mb-1">Total Transactions</div>
                  <div className="text-sm font-bold text-gray-900">
                    {deletePreview.total_count}
                  </div>
                </div>
              </div>

              <div className="border-t pt-3 grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-red-600 font-medium mb-1">Reconciled (Protected)</div>
                  <div className="text-lg font-bold text-red-600">
                    {deletePreview.reconciled_count}
                  </div>
                  <div className="text-xs text-gray-500">Cannot be deleted</div>
                </div>

                <div>
                  <div className="text-xs text-gray-600 font-medium mb-1">Unmatched (Deletable)</div>
                  <div className="text-lg font-bold text-gray-900">
                    {deletePreview.unmatched_count}
                  </div>
                  <div className="text-xs text-gray-500">Will be deleted</div>
                </div>
              </div>
            </div>

            {deletePreview.warning && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-800 font-medium">
                  {deletePreview.warning}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeletePreview(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeClearData}
                disabled={!deletePreview.can_delete}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deletePreview.can_delete ? `Delete ${deletePreview.unmatched_count} Transaction(s)` : 'Cannot Delete'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Edit Bank Statement Line Modal */}
      <Modal
        isOpen={editModal}
        onClose={() => {
          setEditModal(false);
          setEditingLine(null);
        }}
        title="Edit Bank Statement Line"
      >
        {editingLine && (
          <form onSubmit={handleUpdateLine} className="space-y-2">
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-sm text-gray-600 mb-1">Date:</div>
              <div className="font-medium">{new Date(editingLine.date).toLocaleDateString('id-ID')}</div>
              {editingLine.reference && (
                <>
                  <div className="text-sm text-gray-600 mt-2 mb-1">Reference:</div>
                  <div className="font-medium font-mono text-sm">{editingLine.reference}</div>
                </>
              )}
              <div className="text-sm text-gray-600 mt-2 mb-1">Status:</div>
              <div className="inline-flex items-center gap-1.5">
                {editingLine.status === 'matched' && (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    <span className="text-green-700 font-medium">Matched</span>
                  </>
                )}
                {editingLine.status === 'partially_reconciled' && (
                  <>
                    <AlertCircle className="w-4 h-4 text-amber-600" />
                    <span className="text-amber-700 font-medium">Partial</span>
                  </>
                )}
                {editingLine.status === 'unmatched' && (
                  <>
                    <XCircle className="w-4 h-4 text-gray-400" />
                    <span className="text-gray-600 font-medium">Unmatched</span>
                  </>
                )}
              </div>
            </div>

            {(editingLine.allocations.length > 0 || editingLine.matchedExpense || editingLine.matchedReceipt || editingLine.matchedPayment || editingLine.matchedFundTransfer) && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" />
                    <h4 className="font-semibold text-blue-900">Linked Transaction</h4>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={handleUnlinkTransaction}
                      className="text-sm text-red-600 hover:text-red-700 font-medium"
                    >
                      Unlink
                    </button>
                  )}
                </div>

                {editingLine.allocations.length > 0 && (
                  <div className="space-y-1 text-sm mb-3">
                    {editingLine.allocations.map(allocation => (
                      <div key={allocation.id} className="flex justify-between gap-2">
                        <span className="text-gray-600">
                          {allocation.document_type === 'expense' ? 'Expense' : allocation.document_type.replace('_', ' ')} {allocation.label}
                        </span>
                        <span className="font-medium text-gray-900 font-mono">
                          {formatCurrency(allocation.allocation_amount, editingLine.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {editingLine.matchedExpense && editingLine.allocations.length <= 1 && (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Type:</span>
                      <span className="font-medium text-gray-900">Expense</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Category:</span>
                      <span className="font-medium text-gray-900">
                        {expenseCategories.find(c => c.value === editingLine.matchedExpense?.expense_category)?.label || editingLine.matchedExpense.expense_category}
                      </span>
                    </div>
                    {editingLine.matchedExpense.voucher_number && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Voucher:</span>
                        <span className="font-medium text-gray-900 font-mono">{editingLine.matchedExpense.voucher_number}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-600">Amount:</span>
                      <span className="font-medium text-gray-900">
                        {formatCurrency(calculateCanonicalCashPayable(editingLine.matchedExpense), editingLine.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Date:</span>
                      <span className="font-medium text-gray-900">
                        {new Date(editingLine.matchedExpense.expense_date).toLocaleDateString('id-ID')}
                      </span>
                    </div>
                    {editingLine.matchedExpense.description && (
                      <div className="pt-2 border-t border-blue-200">
                        <div className="text-gray-600 mb-1">Description:</div>
                        <div className="text-gray-900">{editingLine.matchedExpense.description}</div>
                      </div>
                    )}
                  </div>
                )}

                {editingLine.matchedReceipt && (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Type:</span>
                      <span className="font-medium text-gray-900">Receipt</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Payment Number:</span>
                      <span className="font-medium text-gray-900 font-mono">{editingLine.matchedReceipt.payment_number}</span>
                    </div>
                    {editingLine.matchedReceipt.customer_name && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Customer:</span>
                        <span className="font-medium text-gray-900">{editingLine.matchedReceipt.customer_name}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-600">Amount:</span>
                      <span className="font-medium text-gray-900">
                        {formatCurrency(editingLine.matchedReceipt.amount, editingLine.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Date:</span>
                      <span className="font-medium text-gray-900">
                        {new Date(editingLine.matchedReceipt.payment_date).toLocaleDateString('id-ID')}
                      </span>
                    </div>
                  </div>
                )}

                {editingLine.matchedPayment && (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Type:</span>
                      <span className="font-medium text-gray-900">Payment</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Voucher:</span>
                      <span className="font-medium text-gray-900 font-mono">{editingLine.matchedPayment.voucher_number}</span>
                    </div>
                    {(editingLine.matchedPayment.supplier_name || editingLine.matchedPayment.staff_name) && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Payee:</span>
                        <span className="font-medium text-gray-900">{editingLine.matchedPayment.supplier_name || editingLine.matchedPayment.staff_name}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-600">Amount:</span>
                      <span className="font-medium text-gray-900">{formatCurrency(editingLine.matchedPayment.amount, editingLine.currency)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Date:</span>
                      <span className="font-medium text-gray-900">{new Date(editingLine.matchedPayment.voucher_date).toLocaleDateString('id-ID')}</span>
                    </div>
                  </div>
                )}

                {editingLine.matchedFundTransfer && (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Type:</span>
                      <span className="font-medium text-gray-900">Fund Transfer</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Transfer No:</span>
                      <span className="font-medium text-gray-900 font-mono">{editingLine.matchedFundTransfer.transfer_number}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">From:</span>
                      <span className="font-medium text-gray-900">{editingLine.matchedFundTransfer.from_account_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">To:</span>
                      <span className="font-medium text-gray-900">{editingLine.matchedFundTransfer.to_account_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Amount:</span>
                      <span className="font-medium text-gray-900">
                        {formatCurrency(editingLine.matchedFundTransfer.amount, editingLine.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Date:</span>
                      <span className="font-medium text-gray-900">
                        {new Date(editingLine.matchedFundTransfer.transfer_date).toLocaleDateString('id-ID')}
                      </span>
                    </div>
                    {editingLine.matchedFundTransfer.description && (
                      <div className="pt-2 border-t border-blue-200">
                        <div className="text-gray-600 mb-1">Description:</div>
                        <div className="text-gray-900">{editingLine.matchedFundTransfer.description}</div>
                      </div>
                    )}
                  </div>
                )}

                {editingLine.notes && (
                  <div className="mt-3 pt-3 border-t border-blue-200">
                    <div className="text-xs text-gray-600 mb-1">Match Notes:</div>
                    <div className="text-sm text-gray-700 italic">{editingLine.notes}</div>
                  </div>
                )}
              </div>
            )}

            <SapRow>
              <FloatingField label="Description" span={12} textarea filled={!!editFormData.description}>
                <textarea name="description" aria-label="Description"
                  value={editFormData.description}
                  onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })}
                  rows={3}
                  className={FLOAT_TEXTAREA}
                />
              </FloatingField>
            </SapRow>

            <SapRow>
              <FloatingField label="Debit Amount" span={6} filled={!!editFormData.debit} hint="Money OUT (expenses)">
                <MoneyInput
                  decimal
                  value={editFormData.debit}
                  onChange={(n) => setEditFormData({ ...editFormData, debit: n, credit: 0 })}
                  className={FLOAT_INPUT}
                />
              </FloatingField>

              <FloatingField label="Credit Amount" span={6} filled={!!editFormData.credit} hint="Money IN (receipts)">
                <MoneyInput
                  decimal
                  value={editFormData.credit}
                  onChange={(n) => setEditFormData({ ...editFormData, credit: n, debit: 0 })}
                  className={FLOAT_INPUT}
                />
              </FloatingField>
            </SapRow>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-xs text-yellow-800">
                ⚠️ <strong>Note:</strong> Each transaction should have either a Debit OR a Credit amount, not both.
                When you enter one, the other will be cleared.
              </p>
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  setEditModal(false);
                  setEditingLine(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-7 px-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Update
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Import Result Modal */}
      {showImportResultModal && importResult && (
        <Modal
          isOpen={true}
          onClose={() => {
            setShowImportResultModal(false);
            setImportResult(null);
          }}
          title="CSV Import Result"
        >
          <div className="space-y-2">
            {importResult.importedCount > 0 ? (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-green-800">
                  <p className="font-semibold">Import successful</p>
                  <p>Total in file: {importResult.totalInFile} &nbsp;|&nbsp; New entries added: <strong>{importResult.importedCount}</strong></p>
                </div>
              </div>
            ) : (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-blue-800">
                  <p className="font-semibold">All {importResult.totalInFile} {importResult.totalInFile === 1 ? 'entry' : 'entries'} already exist in the database</p>
                  <p className="text-blue-600 mt-1">No new entries were imported.</p>
                </div>
              </div>
            )}

            {importResult.skippedEntries.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-700">
                    Skipped entries ({importResult.skippedEntries.length} — already in system)
                  </h4>
                </div>
                <div className="border border-gray-200 rounded-lg divide-y max-h-48 overflow-y-auto">
                  {importResult.skippedEntries.map((e, i) => {
                    const d = new Date(e.transaction_date).toLocaleDateString('en-GB');
                    const amt = e.debit_amount || e.credit_amount;
                    const isDebit = !!e.debit_amount;
                    return (
                      <div key={`${e.transaction_date}-${e.description}-${e.debit_amount ?? ''}-${e.credit_amount ?? ''}-${i}`} className="px-1.5 py-1 flex items-center justify-between text-sm">
                        <div>
                          <span className="text-gray-500 text-xs font-mono">{d}</span>
                          <span className="ml-2 text-gray-800">{String(e.description).substring(0, 55)}</span>
                        </div>
                        <span className={`ml-2 font-medium text-xs whitespace-nowrap ${isDebit ? 'text-red-600' : 'text-green-600'}`}>
                          {isDebit ? '-' : '+'}{formatCurrency(amt, selectedAccount?.currency, {
                            minimumFractionDigits: selectedAccount?.currency === 'IDR' ? 0 : 2,
                            maximumFractionDigits: selectedAccount?.currency === 'IDR' ? 0 : 2,
                          })}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs text-amber-800">
                    <strong>These entries appear to already exist.</strong> If you believe they are new legitimate transactions
                    (e.g. same amount to the same party on the same day), you can force import them anyway.
                  </p>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => {
                  setShowImportResultModal(false);
                  setImportResult(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm font-medium"
              >
                Close
              </button>
              {importResult.skippedEntries.length > 0 && (
                <button
                  onClick={handleForceImport}
                  disabled={forceImporting}
                  className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 text-sm font-medium flex items-center gap-2"
                >
                  {forceImporting ? (
                    <>
                      <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span>
                      Importing...
                    </>
                  ) : (
                    <>Import Anyway ({importResult.skippedEntries.length})</>
                  )}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Suggested Match Review Modal / Drawer */}
      {selectedSuggestedLine && selectedSuggestedLine.matchedExpense && (() => {
        const line = selectedSuggestedLine;
        const exp = line.matchedExpense;
        if (!exp) return null;
        const bankAmount = Number(line.debit) || Number(line.credit) || 0;
        const expAmount = Number(exp.amount) || 0;
        const amountDiff = Math.abs(bankAmount - expAmount);
        const isAmountExact = amountDiff <= 0.01;

        const bankDateObj = new Date(line.date);
        const expDateObj = new Date(exp.expense_date);
        const daysDiff = Math.round(Math.abs((bankDateObj.getTime() - expDateObj.getTime()) / (1000 * 60 * 60 * 24)));
        const isDateExact = daysDiff === 0;

        const direction = line.debit > 0 ? 'Debit' : 'Credit';

        const tierMatch = line.notes?.match(/Tier\s*(\d+)/i);
        const tierStr = tierMatch ? tierMatch[1] : (isAmountExact && isDateExact ? '1' : '2');
        const textScoreMatch = line.notes?.match(/text score\s*(\d+)/i);
        const textScoreStr = textScoreMatch ? textScoreMatch[1] : (exp.voucher_number && line.description.includes(exp.voucher_number) ? '8' : '4');

        const isPending = exp.approval_status === 'pending_approval';
        const isRejected = exp.approval_status === 'rejected' || exp.approval_status === 'cancelled';
        const cannotConfirm = isPending || isRejected;

        return (
          <Modal
            isOpen={true}
            onClose={() => setSelectedSuggestedLine(null)}
            title={`Suggested Match: ${exp.voucher_number || 'Expense'}`}
            maxWidth="max-w-4xl"
          >
            <div className="space-y-4 text-sm">
              {/* Pending Approval Banner */}
              {isPending && (
                <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-amber-900">
                      Pending Approval — Confirm Match Disabled
                    </p>
                    <p className="text-xs text-amber-800 mt-0.5">
                      Approve this expense in Finance before confirming the bank match. Bank transactions cannot automatically approve pending expenses.
                    </p>
                  </div>
                </div>
              )}

              {/* Rejected / Cancelled Banner */}
              {isRejected && (
                <div className="bg-red-50 border border-red-300 rounded-lg p-3 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-red-900">
                      Expense {exp.approval_status === 'rejected' ? 'Rejected' : 'Cancelled'} — Confirm Match Disabled
                    </p>
                    <p className="text-xs text-red-800 mt-0.5">
                      This expense has been {exp.approval_status}. Reject this suggestion to unlink the bank transaction or record a new expense.
                    </p>
                  </div>
                </div>
              )}

              {/* Side-by-Side Sections */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Column 1: Bank Transaction */}
                <div className="border border-gray-200 rounded-lg p-3.5 bg-gray-50/50 space-y-2.5">
                  <div className="flex items-center justify-between border-b pb-2 border-gray-200">
                    <h4 className="font-semibold text-gray-900 flex items-center gap-1.5 text-xs uppercase tracking-wide">
                      <Landmark className="w-4 h-4 text-blue-600" />
                      Bank Transaction
                    </h4>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${line.debit > 0 ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}>
                      {direction}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 text-xs">
                    <span className="text-gray-500">Date:</span>
                    <span className="col-span-2 font-medium text-gray-800">
                      {new Date(line.date).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </span>

                    <span className="text-gray-500">Amount:</span>
                    <span className={`col-span-2 font-bold ${line.debit > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {formatCurrency(bankAmount, line.currency)}
                    </span>

                    <span className="text-gray-500">Description:</span>
                    <span className="col-span-2 text-gray-800 break-words whitespace-pre-wrap font-mono text-[11px] bg-white p-1.5 rounded border border-gray-200 max-h-24 overflow-y-auto">
                      {line.description}
                    </span>

                    <span className="text-gray-500">Reference:</span>
                    <span className="col-span-2 text-gray-800 font-mono">
                      {line.reference || '—'}
                    </span>

                    <span className="text-gray-500">Branch:</span>
                    <span className="col-span-2 text-gray-800">
                      {line.reference || '—'}
                    </span>

                    <span className="text-gray-500">Recon Status:</span>
                    <span className="col-span-2">
                      <span className="px-1.5 py-0.5 rounded text-[11px] bg-purple-100 text-purple-700 font-medium">
                        Needs Review
                      </span>
                    </span>

                    <span className="text-gray-500">Match Status:</span>
                    <span className="col-span-2 font-medium text-purple-700">
                      Suggested
                    </span>
                  </div>
                </div>

                {/* Column 2: Suggested Expense */}
                <div className="border border-gray-200 rounded-lg p-3.5 bg-gray-50/50 space-y-2.5">
                  <div className="flex items-center justify-between border-b pb-2 border-gray-200">
                    <h4 className="font-semibold text-gray-900 flex items-center gap-1.5 text-xs uppercase tracking-wide">
                      <FileText className="w-4 h-4 text-purple-600" />
                      Suggested Expense
                    </h4>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${isPending ? 'bg-amber-100 text-amber-800' : isRejected ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}>
                      {isPending ? 'Pending Approval' : isRejected ? (exp.approval_status === 'rejected' ? 'Rejected' : 'Cancelled') : 'Approved'}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 text-xs">
                    <span className="text-gray-500">Voucher #:</span>
                    <span className="col-span-2 font-bold text-gray-900 font-mono">
                      {exp.voucher_number || '—'}
                    </span>

                    <span className="text-gray-500">Expense Date:</span>
                    <span className="col-span-2 font-medium text-gray-800">
                      {new Date(exp.expense_date).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </span>

                    <span className="text-gray-500">Amount:</span>
                    <span className="col-span-2 font-bold text-gray-900">
                      {formatCurrency(expAmount, exp.currency_code || 'IDR')}
                    </span>

                    <span className="text-gray-500">Category:</span>
                    <span className="col-span-2 text-gray-800">
                      {exp.expense_category || '—'}
                    </span>

                    <span className="text-gray-500">Supplier:</span>
                    <span className="col-span-2 font-medium text-gray-800">
                      {exp.suppliers?.company_name || '—'}
                    </span>

                    <span className="text-gray-500">Payee / Staff:</span>
                    <span className="col-span-2 text-gray-800">
                      {exp.finance_staff_master?.full_name || exp.finance_payees?.full_name || '—'}
                    </span>

                    <span className="text-gray-500">Invoice #:</span>
                    <span className="col-span-2 text-gray-800 font-mono">
                      {exp.invoice_number || '—'}
                    </span>

                    <span className="text-gray-500">Payment Ref:</span>
                    <span className="col-span-2 text-gray-800 font-mono">
                      {exp.payment_reference || '—'}
                    </span>

                    <span className="text-gray-500">Container:</span>
                    <span className="col-span-2 text-gray-800">
                      {exp.import_containers?.container_ref || '—'}
                    </span>

                    <span className="text-gray-500">Description:</span>
                    <span className="col-span-2 text-gray-800 break-words whitespace-pre-wrap text-[11px] bg-white p-1.5 rounded border border-gray-200 max-h-24 overflow-y-auto">
                      {exp.description || '—'}
                    </span>

                    <span className="text-gray-500">PPN / PPh:</span>
                    <span className="col-span-2 text-gray-700">
                      PPN: {Number(exp.ppn_amount) > 0 ? formatCurrency(exp.ppn_amount, exp.currency_code || 'IDR') : 'None'}
                      {' · '}
                      PPh: {Number(exp.pph_amount) > 0 ? formatCurrency(exp.pph_amount, exp.currency_code || 'IDR') : 'None'}
                    </span>

                    <span className="text-gray-500">Payment Method:</span>
                    <span className="col-span-2 text-gray-800">
                      {exp.payment_method ? exp.payment_method.replace('_', ' ') : 'Unspecified'}
                    </span>

                    <span className="text-gray-500">Bank Account:</span>
                    <span className="col-span-2 text-gray-800">
                      {exp.bank_accounts?.account_name ? `${exp.bank_accounts.account_name} (${exp.bank_accounts.account_number})` : '—'}
                    </span>

                    <span className="text-gray-500">Paid Amount:</span>
                    <span className="col-span-2 text-gray-800">
                      {formatCurrency(exp.paid_amount || 0, exp.currency_code || 'IDR')}
                    </span>

                    <span className="text-gray-500">Currency / Rate:</span>
                    <span className="col-span-2 text-gray-800">
                      {exp.currency_code || 'IDR'} {exp.exchange_rate && exp.exchange_rate !== 1 ? `· Rate: ${exp.exchange_rate}` : ''}
                    </span>

                    <span className="text-gray-500">Created By:</span>
                    <span className="col-span-2 text-gray-700">
                      {exp.created_by_profile?.full_name || '—'}
                    </span>

                    {exp.document_urls && exp.document_urls.length > 0 && (
                      <>
                        <span className="text-gray-500">Attachments:</span>
                        <div className="col-span-2 flex flex-col gap-1">
                          {exp.document_urls.map((url: string, idx: number) => {
                            const filename = url.split('/').pop() || `Document ${idx + 1}`;
                            return (
                              <a
                                key={url}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline text-[11px] truncate flex items-center gap-1"
                              >
                                📎 {filename.substring(0, 35)}
                              </a>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Match Analysis Section */}
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-purple-900 text-xs uppercase tracking-wider">
                    Match Analysis
                  </h4>
                  <span className="text-xs text-purple-700 font-medium">
                    Tier {tierStr} · Text Score: {textScoreStr}
                  </span>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="bg-white p-2 rounded border border-purple-100">
                    <span className="text-gray-500 block text-[11px]">Amount</span>
                    <span className={`font-semibold ${isAmountExact ? 'text-green-700' : 'text-amber-700'}`}>
                      {isAmountExact ? 'Exact ✓' : `Diff: ${formatCurrency(amountDiff, line.currency)}`}
                    </span>
                  </div>

                  <div className="bg-white p-2 rounded border border-purple-100">
                    <span className="text-gray-500 block text-[11px]">Date</span>
                    <span className={`font-semibold ${isDateExact ? 'text-green-700' : 'text-blue-700'}`}>
                      {isDateExact ? 'Exact ✓' : `${daysDiff} day${daysDiff === 1 ? '' : 's'} diff`}
                    </span>
                  </div>

                  <div className="bg-white p-2 rounded border border-purple-100">
                    <span className="text-gray-500 block text-[11px]">Direction</span>
                    <span className="font-semibold text-green-700">
                      Debit = Debit ✓
                    </span>
                  </div>

                  <div className="bg-white p-2 rounded border border-purple-100">
                    <span className="text-gray-500 block text-[11px]">Match Confidence</span>
                    <span className="font-semibold text-purple-700">
                      Tier {tierStr} (High)
                    </span>
                  </div>
                </div>

                {line.notes && (
                  <p className="text-xs text-purple-800 bg-white/70 p-2 rounded border border-purple-100">
                    <strong>Suggestion reason:</strong> {line.notes}
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-2 border-t border-gray-200">
                <div className="flex items-center gap-2">
                  {exp.document_urls && exp.document_urls.length > 0 && (
                    <a
                      href={exp.document_urls[0]}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 border border-gray-300 rounded text-xs font-medium hover:bg-gray-50 text-gray-700 flex items-center gap-1"
                    >
                      View Attachment
                    </a>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedSuggestedLine(null)}
                    className="px-3 py-1.5 border border-gray-300 rounded text-xs font-medium hover:bg-gray-50 text-gray-700"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await rejectMatch(line.id);
                      setSelectedSuggestedLine(null);
                    }}
                    className="px-3 py-1.5 border border-red-200 text-red-700 bg-red-50 hover:bg-red-100 rounded text-xs font-medium"
                  >
                    Reject Suggestion
                  </button>
                  <button
                    type="button"
                    disabled={cannotConfirm}
                    onClick={async () => {
                      await confirmMatch(line.id);
                      setSelectedSuggestedLine(null);
                    }}
                    className={`px-4 py-1.5 rounded text-xs font-semibold text-white ${cannotConfirm ? 'bg-gray-300 cursor-not-allowed opacity-60' : 'bg-green-600 hover:bg-green-700 shadow-sm'}`}
                    title={isPending ? 'Approve this expense in Finance before confirming' : isRejected ? 'Cannot confirm match for a rejected or cancelled expense' : 'Confirm and reconcile'}
                  >
                    Confirm Match
                  </button>
                </div>
              </div>
            </div>
          </Modal>
        );
      })()}

      {embeddedExpensePrefill && (
        <ExpenseManager
          canManage={canManage}
          embeddedModalOnly={true}
          prefillFromBankReconciliation={embeddedExpensePrefill}
          onCloseEmbedded={() => setEmbeddedExpensePrefill(null)}
          onExpenseSavedFromBankReconciliation={async (savedExpense) => {
            setEmbeddedExpensePrefill(null);
            await loadStatementLines();
            await loadExpenses();
            notifyFinanceReconciliationRefresh();
            const isApproved = savedExpense.approval_status === 'approved';
            setActionFeedback({
              type: 'success',
              title: isApproved ? 'Expense recorded & reconciled' : 'Expense recorded as pending',
              message: isApproved
                ? 'Expense created, approved, posted to general ledger, and reconciled to bank transaction.'
                : 'Expense created and linked to statement line. An authorized approver must approve it before posting.',
              details: [
                { label: 'Expense ID', value: savedExpense.id.slice(0, 8) },
                { label: 'Amount', value: formatCurrency(savedExpense.amount, savedExpense.transaction_currency) },
                { label: 'Category', value: savedExpense.expense_category },
                { label: 'Date', value: new Date(savedExpense.expense_date).toLocaleDateString('id-ID') },
                { label: 'Status', value: isApproved ? 'Approved & Reconciled' : 'Pending Approval' },
              ],
              timestamp: Date.now(),
            });
          }}
        />
      )}

      {embeddedReceiptPrefill && (
        <ReceiptVoucherManager
          canManage={canManage}
          embeddedModalOnly={true}
          prefillFromBankReconciliation={embeddedReceiptPrefill}
          onCloseEmbedded={() => setEmbeddedReceiptPrefill(null)}
          onReceiptSavedFromBankReconciliation={async () => {
            setEmbeddedReceiptPrefill(null);
            await loadStatementLines();
            notifyFinanceReconciliationRefresh();
          }}
        />
      )}

      {embeddedPaymentPrefill && (
        <PaymentVoucherManager
          canManage={canManage}
          embeddedModalOnly={true}
          prefillFromBankReconciliation={embeddedPaymentPrefill}
          onCloseEmbedded={() => setEmbeddedPaymentPrefill(null)}
          onPaymentSavedFromBankReconciliation={async () => {
            setEmbeddedPaymentPrefill(null);
            await loadStatementLines();
            notifyFinanceReconciliationRefresh();
          }}
        />
      )}
    </div>
  );
}
