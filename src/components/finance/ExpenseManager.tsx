import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Package, Truck, Pencil as Edit, Trash2, FileText, X, Download, Eye, CheckCircle, XCircle, Clipboard, ClipboardCheck, Lock, RotateCcw, UserPlus, AlertCircle, Banknote, Link2, Search, Clock, Loader2, ChevronDown, Minus, Landmark } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { SearchableSelect } from '../SearchableSelect';
import { FinanceModal } from './FinanceModal';
import { F_BTN_PRIMARY, F_BTN_SECONDARY } from './FinanceForm';
import { FinanceActionButton } from './FinanceUI';
import { getCategoryFieldRules } from './categoryFieldRules';
import { SapRow, SapField, SAP_INPUT } from './SapLayout';
import { FloatingField } from './FloatingField';
import { useExpenseCategories } from './useExpenseCategories';
import { BankTransactionLinkField } from './BankTransactionLinkField';
import { validateExpenseMandatoryTaxLinkage } from '../../utils/expenseValidation';
import {
  approveFinanceExpense,
  editApprovedFinanceExpense,
  getReportingUsdRate,
  linkBankStatementLine,
  saveFinanceExpense,
  unlinkBankStatementAllocation,
  unlinkFinanceExpenseBankLink,
} from '../../services/financeCommands';
import {
  getConsistentExpensePostingState,
  getEffectiveExpensePostingState,
  getEffectiveExpensePostingStates,
  type EffectiveExpensePostingState,
  type ExpensePostingState,
} from '../../services/expensePostingLifecycle';
import {
  FINANCE_RECONCILIATION_REFRESH_EVENT,
  linkBankTransaction,
  notifyFinanceReconciliationRefresh,
  unlinkBankTransaction,
} from './bankTransactionLinking';
import { useErpSyncListener, emitErpSync } from '../../utils/erpSyncBus';
import { FinanceDocumentAttachments, uploadFinanceDocuments } from './FinanceDocumentAttachments';
import { getPostedJournalsForExport, writeReconciliationWorkbook, type ReconciliationSummaryRow } from './reconciliationExport';
import { ExpenseCategorySelect, groupExpenseCategories } from './ExpenseCategorySelect';
import { normalizeExpenseBankLinks } from '../../utils/expenseBankLinks';

// Tiny inline helper used inside the SAP header PPN cell — a 3-state
// selector rendered as a right-side chip so it doesn't consume a column.
function PpnModeToggle({ value, onChange }: {
  value: 'standard' | 'dpp_nilai_lain' | 'manual' | undefined;
  onChange: (mode: 'standard' | 'dpp_nilai_lain' | 'manual') => void;
}) {
  return (
    <select name="value" aria-label="Value"
      value={value || 'standard'}
      onChange={(e) => onChange(e.target.value as 'standard' | 'dpp_nilai_lain' | 'manual')}
      title="PPN calculation mode"
      className="h-6 px-1 text-[9px] font-semibold border border-gray-200 bg-white rounded-none"
    >
      <option value="standard">STD</option>
      <option value="dpp_nilai_lain">DPP</option>
      <option value="manual">MAN</option>
    </select>
  );
}

// Compact PPH treatment toggle matching PpnModeToggle styling
function PphTreatmentToggle({ value, onChange }: {
  value: 'deduct' | 'add' | undefined;
  onChange: (treatment: 'deduct' | 'add') => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] text-gray-400 font-medium whitespace-nowrap">PPH Treatment</span>
      <select
        name="pph_treatment"
        aria-label="PPH Treatment"
        value={value || 'deduct'}
        onChange={(e) => onChange(e.target.value as 'deduct' | 'add')}
        title="PPH Treatment: Deduct (-) or Add (+)"
        className="h-6 px-1 text-[9px] font-semibold border border-gray-200 bg-white rounded-none cursor-pointer"
      >
        <option value="deduct">Deduct (-)</option>
        <option value="add">Add (+)</option>
      </select>
    </div>
  );
}

// Broker Invoice PPN % selector — Indonesian tax practice: 0 / 11 / 12 / Custom.
// - 0/11/12: PPN Amount is auto-calculated from Invoice DPP × rate (read-only).
// - Custom: user types both rate (optional) and PPN Amount manually.
function BrokerPpnRateSelector({ rate, isCustom, onChange }: {
  rate: number;
  isCustom: boolean;
  onChange: (v: { rate: number; custom: boolean }) => void;
}) {
  // Preset only reflects the selector when NOT in Custom mode and the rate is a known preset.
  const preset: string = isCustom ? 'custom'
    : rate === 0 ? '0'
    : rate === 11 ? '11'
    : rate === 12 ? '12'
    : 'custom';
  return (
    <div className="flex items-center gap-1 w-full">
      <select name="preset" aria-label="Preset"
        value={preset}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'custom')      onChange({ rate: rate || 0, custom: true });
          else if (v === '0')      onChange({ rate: 0,  custom: false });
          else if (v === '11')     onChange({ rate: 11, custom: false });
          else if (v === '12')     onChange({ rate: 12, custom: false });
        }}
        className={SAP_INPUT + ' !flex-none !w-20'}
        title="PPN rate — 0 / 11 / 12 / Custom"
      >
        <option value="0">0%</option>
        <option value="11">11%</option>
        <option value="12">12%</option>
        <option value="custom">Custom</option>
      </select>
      {isCustom && (
        <input name="rate" aria-label="Custom %"
          type="number" min="0" max="100" step="0.5"
          value={rate === 0 ? '' : rate}
          onChange={(e) => {
            const r = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
            onChange({ rate: r, custom: true });
          }}
          className={SAP_INPUT + ' !flex-1 !text-right !font-mono'}
          placeholder="Custom %"
        />
      )}
    </div>
  );
}
import { useFinance } from '../../contexts/FinanceContext';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { downloadStorageDocument, openStorageDocument, resolveStorageUrlCached } from '../../utils/signedUrlCache';
import { currentFinancePeriod, formatFinancePeriodValue, normalizeSalaryPeriod, salaryPeriodOptions } from '../../utils/financePeriod';
import { supabaseErrorMessage } from '../../utils/supabaseError';
import { formatCurrency, normalizeCurrency, resolveTransactionCurrency } from '../../utils/currency';
import { useSupabaseRealtimeChannel } from '../../hooks/useSupabaseRealtimeChannel';
import {
  DOCUMENT_TYPE_GROUPS,
  DOCUMENT_TYPE_TAX_CONFIG,
  SUPPLIER_TYPES,
  type BrokerItem,
  type DocumentType,
  calculatePPN,
  calculateExpenseTotals,
  calculateCanonicalExpenseTotal,
  calculateCanonicalCashPayable,
  calculateExpenseReconciliation,
  getExpenseSettlementStatus,
  type ExpenseSettlementStatus,
  getSimplifiedExpenseStatus,
  type SimplifiedExpenseStatus,
  calculateBrokerExpenseTotals,
  brokerLineTotal,
  computeBrokerLinePpn,
  getDueDateFromTerms,
  computeExpensePPh,
  formatIDR,
  type PphCalculationRegime,
} from '../../utils/taxCalculations';

const SALARY_PERIOD_OPTIONS = salaryPeriodOptions();

interface FinanceExpense {
  id: string;
  expense_category: string;
  amount: number;
  expense_date: string;
  description: string | null;
  batch_id: string | null;
  import_container_id: string | null;
  delivery_challan_id: string | null;
  expense_type: string | null;
  document_urls: string[] | null;
  payment_method: string | null;
  bank_account_id: string | null;
  payment_reference: string | null;
  voucher_number: string | null;
  currency_code?: string | null;
  transaction_currency?: string | null;
  functional_currency?: string | null;
  exchange_rate?: number | null;
  bank_account_currency?: string | null;
  payment_currency?: string | null;
  approval_status: 'pending_approval' | 'approved' | 'rejected' | 'cancelled';
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  // New supplier invoice fields
  supplier_id?: string | null;
  staff_id?: string | null;
  payee_id?: string | null;
  linked_sales_invoice_id?: string | null;
  pph_calculation_regime?: string | null;
  pph_dpp_ratio?: number | null;
  pph_dpp_amount?: number | null;
  pph_rate?: number | null;
  is_tax_manual_override?: boolean | null;
  invoice_number?: string | null;
  due_date?: string | null;
  paid_amount?: number | null;
  broker_items?: BrokerItem[] | null;
  // PIB Import breakdown columns (non-null only when expense_category = 'pib_import')
  pib_bm_amount?: number | null;
  pib_ppn_amount?: number | null;
  pib_pph_amount?: number | null;
  // Tax fields for non-PIB expenses
  ppn_amount?: number | null;
  ppn_manual_override?: boolean | null;
  ppn_calc_mode?: 'standard' | 'dpp_nilai_lain' | 'manual' | null;
  dpp_amount?: number | null;
  ppn_rate?: number | null;
  pph_amount?: number | null;
  pph_code_id?: string | null;
  pph_treatment?: 'deduct' | 'add' | null;
  stamp_duty_amount?: number | null;
  fixed_asset_account_id?: string | null;
  // BPJS & Payroll period integration
  bpjs_employee_deduction?: number | null;
  bpjs_register_item_id?: string | null;
  payroll_period_month?: number | null;
  payroll_period_year?: number | null;
  // Utility-only optional bank charges
  bank_charges_amount?: number | null;
  batches?: { batch_number: string } | null;
  import_containers?: { container_ref: string } | null;
  delivery_challans?: { challan_number: string } | null;
  bank_accounts?: { bank_name: string; account_number: string; alias: string | null; currency: string } | null;
  bank_statement_lines?: Array<{
    id: string;
    transaction_date: string;
    description: string | null;
    reference?: string | null;
    debit_amount: number;
    credit_amount: number;
    bank_account_id: string;
    payment_kind?: string | null;
    allocation_amount?: number | null;
    allocation_id?: string | null;
    bank_accounts?: { bank_name: string; account_number: string; alias: string | null; currency: string } | null;
  }> | null;
  pph_paid_amount?: number | null;
  voucher_allocations?: Array<{
    id: string;
    allocated_amount: number;
    payment_kind?: string | null;
    payment_vouchers?: { voucher_number: string; voucher_date?: string; payment_date?: string; payment_purpose?: string | null } | null;
  }> | null;
  salary_advance_applications?: Array<{
    id: string;
    applied_amount: number;
    advance_payment_voucher_id?: string | null;
    settlement_payment_voucher_id?: string | null;
  }> | null;
  suppliers?: { id: string; company_name: string } | null;
  payees?: { id: string; payee_code: string; full_name: string; business_role: string; tax_classification: string; nik: string | null; npwp: string | null } | null;
  sales_invoices?: { id: string; invoice_number: string } | null;
  posting_lifecycle?: EffectiveExpensePostingState | null;
  effective_posting_state?: ExpensePostingState;
  sales_order_allocations?: SalesOrderAllocation[] | null;
}

export interface SalesOrderAllocation {
  sales_order_id: string;
  so_number?: string;
  customer_name?: string;
  total_amount?: number;
  allocated_amount: number;
}

const getExpenseCurrency = (expense: FinanceExpense): string =>
  resolveTransactionCurrency({
    ...expense,
    bank_accounts: expense.bank_accounts
      ?? expense.bank_statement_lines?.[0]?.bank_accounts,
  });

async function hydrateExpensePostingLifecycle<T extends FinanceExpense>(expenses: T[]): Promise<T[]> {
  const states = await getEffectiveExpensePostingStates(expenses.map(expense => expense.id));
  return Promise.all(expenses.map(async expense => {
    let lifecycle = states.get(expense.id) || null;
    if (
      expense.approval_status === 'approved' &&
      (!lifecycle || (lifecycle.effective_posting_state === 'AMBIGUOUS' && lifecycle.ambiguity_reason?.includes('posted_journal_evidence')))
    ) {
      const consistent = await getConsistentExpensePostingState(expense.id);
      if (consistent) lifecycle = consistent;
    }
    return {
      ...expense,
      posting_lifecycle: lifecycle,
      effective_posting_state: lifecycle?.effective_posting_state || 'AMBIGUOUS',
    };
  }));
}

const SETTLED_EXPENSE_CANCELLATION_MESSAGE =
  'This expense is already paid/reconciled. Reverse or unlink the payment/bank reconciliation first.';

type ExpenseCancellationBlock = {
  kind: 'settled' | 'closed_period' | 'already_reversed' | 'no_active_journal' | 'not_approved' | 'verification_failed';
  message: string;
  bankStatementLineId?: string;
  paymentVoucherId?: string;
};

type ExpenseCancellationPreflight = {
  block: ExpenseCancellationBlock | null;
};

async function preflightExpenseCancellation(expenseId: string): Promise<ExpenseCancellationPreflight> {
  const lifecycle = await getEffectiveExpensePostingState(expenseId);
  if (!lifecycle) {
    return { block: { kind: 'verification_failed', message: 'Unable to resolve the effective accounting state for this expense.' } };
  }
  if (lifecycle.effective_posting_state === 'REVERSED' || lifecycle.effective_posting_state === 'REPLACED') {
    return {
      block: {
        kind: 'already_reversed',
        message: lifecycle.effective_posting_state === 'REPLACED'
          ? 'This expense already has a current effective posting. Refresh and work with the current transaction; the obsolete posting cannot be cancelled.'
          : 'This expense is already cancelled. It cannot be cancelled again.',
      },
    };
  }
  if (lifecycle.effective_posting_state !== 'ACTIVE') {
    return {
      block: {
        kind: lifecycle.effective_posting_state === 'REJECTED' || lifecycle.effective_posting_state === 'PENDING'
          ? 'not_approved'
          : 'verification_failed',
        message: lifecycle.effective_posting_state === 'AMBIGUOUS'
          ? `This expense has inconsistent posting evidence (${lifecycle.ambiguity_reason || 'manual review required'}). Cancellation was not sent.`
          : 'This expense has no active posting to cancel.',
      },
    };
  }

  const [expenseResult, journalResult, voucherResult, expenseAllocationResult, legacyBankResult] = await Promise.all([
    supabase
      .from('finance_expenses')
      .select('id, voucher_number, approval_status, paid_amount, pph_paid_amount')
      .eq('id', expenseId)
      .maybeSingle(),
    supabase
      .from('journal_entries')
      .select('id, entry_date, is_posted, is_reversed, created_at')
      .in('source_module', ['expense', 'expenses'])
      .or(`reference_id.eq.${expenseId},reference_number.eq.EXP-${expenseId}`)
      .eq('is_posted', true)
      .order('created_at', { ascending: false }),
    supabase
      .from('voucher_allocations')
      .select('id, payment_voucher_id')
      .eq('finance_expense_id', expenseId)
      .limit(1),
    supabase
      .from('bank_statement_allocations')
      .select('id, bank_statement_line_id')
      .eq('document_type', 'expense')
      .eq('document_id', expenseId)
      .limit(1),
    supabase
      .from('bank_statement_lines')
      .select('id')
      .eq('matched_expense_id', expenseId)
      .limit(1),
  ]);

  const firstError = [expenseResult, journalResult, voucherResult, expenseAllocationResult, legacyBankResult]
    .find(result => result.error)?.error;
  if (firstError) throw firstError;

  const expense = expenseResult.data;
  if (!expense) {
    return { block: { kind: 'verification_failed', message: 'Unable to verify this expense because it no longer exists.' } };
  }
  if (expense.approval_status !== 'approved') {
    return { block: { kind: 'not_approved', message: 'This expense is not currently posted, so there is no posting to cancel.' } };
  }

  const journals = journalResult.data || [];
  const activeJournal = journals.find(journal => journal.id === lifecycle.effective_journal_id && !journal.is_reversed);
  if (!activeJournal) {
    const alreadyReversed = journals.some(journal => journal.is_reversed);
    return {
      block: {
        kind: alreadyReversed ? 'already_reversed' : 'no_active_journal',
        message: alreadyReversed
          ? 'This expense posting has already been reversed.'
          : 'No active journal exists for this expense. Cancellation cannot continue.',
      },
    };
  }

  const [journalAllocationResult, reconciliationResult, periodResult] = await Promise.all([
    supabase
      .from('bank_statement_allocations')
      .select('id, bank_statement_line_id')
      .eq('journal_entry_id', activeJournal.id)
      .limit(1),
    supabase
      .from('bank_reconciliation_items')
      .select('id')
      .eq('journal_entry_id', activeJournal.id)
      .limit(1),
    supabase
      .from('accounting_periods')
      .select('status')
      .lte('start_date', activeJournal.entry_date)
      .gte('end_date', activeJournal.entry_date)
      .order('start_date', { ascending: false })
      .limit(1),
  ]);
  const dependentError = [journalAllocationResult, reconciliationResult, periodResult]
    .find(result => result.error)?.error;
  if (dependentError) throw dependentError;

  const voucherAllocation = voucherResult.data?.[0];
  const expenseAllocation = expenseAllocationResult.data?.[0];
  const journalAllocation = journalAllocationResult.data?.[0];
  const legacyBankLine = legacyBankResult.data?.[0];
  const isSettled = Number(expense.paid_amount || 0) > 0.01
    || Number(expense.pph_paid_amount || 0) > 0.01
    || Boolean(voucherAllocation)
    || Boolean(expenseAllocation)
    || Boolean(journalAllocation)
    || Boolean(legacyBankLine)
    || Boolean(reconciliationResult.data?.length);
  if (isSettled) {
    return {
      block: {
        kind: 'settled',
        message: SETTLED_EXPENSE_CANCELLATION_MESSAGE,
        bankStatementLineId: expenseAllocation?.bank_statement_line_id
          || journalAllocation?.bank_statement_line_id
          || legacyBankLine?.id,
        paymentVoucherId: voucherAllocation?.payment_voucher_id || undefined,
      },
    };
  }

  const period = periodResult.data?.[0];
  if (period && period.status !== 'open') {
    return {
      block: {
        kind: 'closed_period',
        message: 'This expense is in a closed accounting period. Reopen the period before cancelling its posting.',
      },
    };
  }
  return { block: null };
}

interface Supplier {
  id: string;
  company_name: string;
  pkp_status: boolean;
  payment_terms_days: number | null;
  default_expense_category: string | null;
  default_pph_code_id: string | null;
  tax_preference: 'none' | 'ppn_only' | 'ppn_pph' | 'pph_only' | null;
  supplier_type?: string | null;
}

interface Batch {
  id: string;
  batch_number: string;
}

interface ImportContainer {
  id: string;
  container_ref: string;
}

interface DeliveryChallan {
  id: string;
  challan_number: string;
  challan_date: string;
  customers?: {
    company_name: string;
  } | null;
}

interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  alias: string | null;
  currency: string;
}

interface TaxCode {
  id: string;
  code: string;
  name: string;
  rate: number;
  tax_type: string;
}

interface COAAccount {
  id: string;
  code: string;
  name: string;
}

interface ExpenseExportAccount {
  expense_id: string;
  coa_code: string | null;
  coa_name: string | null;
}

export interface BankReconciliationExpensePrefill {
  statementLineId: string;
  bankAccountId: string;
  date: string;
  amount: number;
  description: string;
  currency?: 'IDR' | 'USD';
  reference?: string;
}

export interface ExpenseManagerProps {
  canManage: boolean;
  initialViewExpenseId?: string | null;
  onInitialViewHandled?: () => void;
  onSettleBill?: (bill: { id: string; supplier_id: string | null; staff_id: string | null; balance_amount: number }) => void;
  onViewPaymentVoucher?: (paymentVoucherId: string) => void;
  prefillFromBankReconciliation?: BankReconciliationExpensePrefill | null;
  onBankReconciliationPrefillConsumed?: () => void;
  onExpenseSavedFromBankReconciliation?: (expense: FinanceExpense, statementLineId: string) => void;
  embeddedModalOnly?: boolean;
  onCloseEmbedded?: () => void;
}

export function ExpenseManager({
  canManage,
  initialViewExpenseId,
  onInitialViewHandled,
  onSettleBill,
  onViewPaymentVoucher,
  prefillFromBankReconciliation,
  onBankReconciliationPrefillConsumed,
  onExpenseSavedFromBankReconciliation,
  embeddedModalOnly,
  onCloseEmbedded,
}: ExpenseManagerProps) {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const isAdmin = profile?.role === 'admin';
  // The database Expense Category master is the selector and posting source.
  // A newly-created active master row is available here without a deploy.
  const { categories: expenseCategories } = useExpenseCategories();
  const [rejectionModalOpen, setRejectionModalOpen] = useState(false);
  const [rejectionTarget, setRejectionTarget] = useState<{ id: string; type: 'expense' } | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [approvalLoading, setApprovalLoading] = useState<string | null>(null);
  const [cancelPostingModalOpen, setCancelPostingModalOpen] = useState(false);
  const [cancelPostingTarget, setCancelPostingTarget] = useState<FinanceExpense | null>(null);
  const [cancelPostingReason, setCancelPostingReason] = useState('');
  const [cancelPostingLoading, setCancelPostingLoading] = useState(false);
  const [cancelPostingBlock, setCancelPostingBlock] = useState<ExpenseCancellationBlock | null>(null);
  const [expenses, setExpenses] = useState<FinanceExpense[]>([]);
  const [, setBatches] = useState<Batch[]>([]);
  const [containers, setContainers] = useState<ImportContainer[]>([]);
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [salesOrders, setSalesOrders] = useState<Array<{ id: string; so_number: string; total_amount: number; currency: string; customers?: { company_name: string } | null }>>([]);
  const [soAllocations, setSoAllocations] = useState<SalesOrderAllocation[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [reconciledExpenseIds, setReconciledExpenseIds] = useState<Set<string>>(new Set());
  const [selectedBankTransactionId, setSelectedBankTransactionId] = useState<string>('');
  const [selectedBankAllocationAmount, setSelectedBankAllocationAmount] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [expandedExpenses, setExpandedExpenses] = useState<Set<string>>(new Set());

  const toggleExpenseExpand = (id: string) => {
    setExpandedExpenses(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const [modalOpen, setModalOpen] = useState(false);
  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inFlightExpenseIdRef = useRef<string | null>(null);
  const [editingExpense, setEditingExpense] = useState<FinanceExpense | null>(null);
  const [viewingExpense, setViewingExpense] = useState<FinanceExpense | null>(null);
  const [salaryAdvanceApplications, setSalaryAdvanceApplications] = useState<Array<{
    application_id: string;
    advance_payment_voucher_id: string;
    advance_voucher_number: string | null;
    settlement_payment_voucher_id: string;
    settlement_voucher_number: string | null;
    applied_amount: number;
    applied_at: string;
  }>>([]);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [bankLinkError, setBankLinkError] = useState<string | null>(null);
  const [linkedDCQuickView, setLinkedDCQuickView] = useState<{ challan: any; items: any[] } | null>(null);
  const [linkedDCQuickViewLoading, setLinkedDCQuickViewLoading] = useState(false);
  const [accountingExpanded, setAccountingExpanded] = useState(false);
  const [signedUrlCache, setSignedUrlCache] = useState<Record<string, string>>({});
  const [filterType, setFilterType] = useState<'all' | 'import' | 'sales' | 'staff' | 'operations' | 'admin'>('all');
  const [reconFilter, setReconFilter] = useState<'all' | 'reconciled' | 'partial' | 'outstanding'>('all');
  const [approvalFilter, setApprovalFilter] = useState<'all' | 'approved' | 'pending_approval'>('all');
  const [lifecycleFilter, setLifecycleFilter] = useState<'operational' | 'cancelled'>('operational');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [coaAssets, setCoaAssets] = useState<COAAccount[]>([]);
  // Supplier state
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [selectedDocType, setSelectedDocType] = useState<DocumentType | ''>('');
  const [brokerItems, setBrokerItems] = useState<BrokerItem[]>([]);
  // Category-driven pickers (2026-07-08) — Staff Master + Utility Master.
  // These are pure UI selectors; the underlying finance_expenses.supplier_id
  // column stays as-is (utilities resolve through the linked supplier;
  // staff rows leave supplier_id null and prefix the description with the
  // staff name for traceability).
  const [staffRoster, setStaffRoster] = useState<Array<{
    id: string;
    full_name: string;
    department: string | null;
    default_gl_code: string | null;
    monthly_salary: number;
  }>>([]);
  const [utilityRoster, setUtilityRoster] = useState<Array<{ id: string; provider_name: string; utility_type: string; supplier_id: string | null; default_gl_code: string | null }>>([]);
  const [payeeRoster, setPayeeRoster] = useState<Array<{
    id: string;
    payee_code: string;
    full_name: string;
    business_role: string;
    tax_classification: string;
    nik: string | null;
    npwp: string | null;
    bank_name: string | null;
    bank_account_number: string | null;
    bank_account_holder: string | null;
    default_pph_code_id: string | null;
    is_active: boolean;
  }>>([]);
  const [salesInvoices, setSalesInvoices] = useState<Array<{
    id: string;
    invoice_number: string;
    invoice_date: string;
    delivery_challan_number: string | null;
    linked_challan_ids: string[] | null;
    total_amount: number;
    customers: { company_name: string } | null;
  }>>([]);
  const [providerType, setProviderType] = useState<'corporate' | 'individual'>('corporate');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [workingDays, setWorkingDays] = useState<number>(1);
  const [selectedStaffId, setSelectedStaffId] = useState<string>('');
  const [salaryAdvances, setSalaryAdvances] = useState<Array<{
    advance_id: string;
    voucher_number: string;
    voucher_date: string;
    amount: number;
    applied_amount: number;
    available_amount: number;
  }>>([]);
  const [selectedSalaryAdvanceIds, setSelectedSalaryAdvanceIds] = useState<string[]>([]);
  const [salaryCalculation, setSalaryCalculation] = useState<{
    gross_salary: number;
    outstanding_salary_advances: number;
    pph21_amount: number;
    bpjs_amount: number;
    net_salary_payable: number;
    pph21_method: 'percentage' | 'manual';
    pph21_applicable: boolean;
    default_payment_method: string;
  } | null>(null);
  // Applied advances are persisted settlement facts. They are not returned by
  // the outstanding-advance query, so retain their total while editing.
  const [persistedSalaryAdvanceApplied, setPersistedSalaryAdvanceApplied] = useState(0);
  const salaryInitialLoadRef = useRef<string | null>(null);
  const [selectedUtilityId, setSelectedUtilityId] = useState<string>('');
  const [periodLabel, setPeriodLabel] = useState<string>('');   // Salary Month / Billing Month
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  // Quick Add Supplier modal
  const [showQuickAddSupplier, setShowQuickAddSupplier] = useState(false);
  const [quickAddSupplierName, setQuickAddSupplierName] = useState('');
  const [quickAddSupplierLoading, setQuickAddSupplierLoading] = useState(false);
  const [quickAddSupplierType, setQuickAddSupplierType] = useState('General');
  const [quickAddSupplierPKP, setQuickAddSupplierPKP] = useState(false);
  const [quickAddSupplierTerms, setQuickAddSupplierTerms] = useState(30);
  // Health Check panel
  const [healthCheckOpen, setHealthCheckOpen] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  interface HealthIssue { key: string; label: string; count: number; severity: 'error' | 'warning' | 'info' }
  const [healthIssues, setHealthIssues] = useState<HealthIssue[]>([]);

  // Use master date range from Finance context
  const { dateRange } = useFinance();
  const startDate = dateRange.startDate;
  const endDate = dateRange.endDate;

  const [formData, setFormData] = useState({
    expense_category: 'other',
    amount: 0,
    transaction_currency: 'IDR' as 'IDR' | 'USD',
    exchange_rate: 1,
    expense_date: new Date().toISOString().split('T')[0],
    description: '',
    batch_id: '',
    import_container_id: '',
    delivery_challan_id: '',
    payment_method: null as string | null,
    bank_account_id: '',
    payment_reference: '',
    document_urls: [] as string[],
    // New supplier invoice fields
    supplier_id: '',
    invoice_number: '',
    due_date: getDueDateFromTerms(new Date().toISOString().split('T')[0], 30),
    // PIB Import breakdown (only used when expense_category = 'pib_import')
    pib_bm_amount: 0,
    pib_ppn_amount: 0,
    pib_pph_amount: 0,
    // Non-PIB tax fields
    ppn_amount: 0,
    // Task 2 (2026-07-06): TRUE once the user has manually edited ppn_amount.
    // Kept for backward compat — new logic below uses ppn_calc_mode instead.
    ppn_manual_override: false,
    // Indonesian PPN calc mode (2026-07-07): standard | dpp_nilai_lain | manual
    ppn_calc_mode: 'standard' as 'standard' | 'dpp_nilai_lain' | 'manual',
    dpp_amount: 0,
    ppn_rate: 11,
    pph_amount: 0,
    pph_code_id: '',
    pph_treatment: 'deduct' as 'deduct' | 'add',
    stamp_duty_amount: 0,
    fixed_asset_account_id: '',
    // Task 5: Utility-only optional bank charges paid alongside the utility bill.
    bank_charges_amount: 0,
    payee_id: '',
    linked_sales_invoice_id: '',
    pph_calculation_regime: '',
    pph_dpp_ratio: 1.0,
    pph_dpp_amount: 0,
    pph_rate: 0,
    is_tax_manual_override: false,
    bpjs_employee_deduction: 0,
    bpjs_register_item_id: null as string | null,
    payroll_period_month: null as number | null,
    payroll_period_year: null as number | null,
  });

  useEffect(() => {
    if (!linkedDCQuickView) return;

    const handleEscapeForLinkedDC = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setLinkedDCQuickView(null);
      }
    };

    document.addEventListener('keydown', handleEscapeForLinkedDC, true);
    return () => document.removeEventListener('keydown', handleEscapeForLinkedDC, true);
  }, [linkedDCQuickView]);

  useEffect(() => {
    if (!viewModalOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !linkedDCQuickView) {
        event.preventDefault();
        setViewModalOpen(false);
        setViewingExpense(null);
        setLinkedDCQuickView(null);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [viewModalOpen, linkedDCQuickView]);

  const openLinkedDCQuickView = async () => {
    if (!viewingExpense?.delivery_challan_id) return;

    setLinkedDCQuickViewLoading(true);
    try {
      const { data: challan, error: challanError } = await supabase
        .from('delivery_challans')
        .select(`*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)`)
        .eq('id', viewingExpense.delivery_challan_id)
        .maybeSingle();

      if (challanError) throw challanError;
      if (!challan) throw new Error('Linked delivery challan not found');

      const { data: items, error: itemsError } = await supabase
        .from('delivery_challan_items')
        .select(`*, products(product_name, product_code, unit), batches(batch_number)`)
        .eq('challan_id', challan.id);

      if (itemsError) throw itemsError;

      setLinkedDCQuickView({ challan, items: items || [] });
    } catch (error) {
      console.error('Error loading linked DC quick view:', error);
      alert('Failed to open Delivery Challan details');
    } finally {
      setLinkedDCQuickViewLoading(false);
    }
  };

  // Initial load + reload when date range changes (loadData itself has no server-side
  // date filter, so reload is only meaningful when other loaders depend on state,
  // but we preserve the original behavior).
  useEffect(() => {
    loadData();
  }, [dateRange]);

  useErpSyncListener(
    ['expenses', 'bank_transactions', 'vouchers'],
    () => {
      loadData();
    }
  );

  useEffect(() => {
    if (formData.expense_category !== 'salary' || !selectedStaffId) {
      setSalaryAdvances([]);
      setSalaryCalculation(null);
      setSelectedSalaryAdvanceIds(current => current.length ? [] : current);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.all([
        supabase.rpc('get_outstanding_salary_advances', {
          p_staff_id: selectedStaffId,
          p_as_of_date: formData.expense_date,
        }),
        supabase.rpc('calculate_staff_salary', {
          p_staff_id: selectedStaffId,
          p_salary_date: formData.expense_date,
          // Amount is prefilled from Staff Master on selection, but remains the
          // authoritative gross value after the user edits it.
          p_gross_override: formData.amount,
        }),
      ]).then(async ([advancesResult, calculationResult]) => {
        if (cancelled) return;
        if (advancesResult.error || calculationResult.error) {
          console.error('Unable to load canonical salary calculation:', advancesResult.error?.message || calculationResult.error?.message);
          setSalaryAdvances([]);
          setSalaryCalculation(null);
          return;
        }
        const calculation = calculationResult.data as typeof salaryCalculation;
        const preservingHistoricalValues = Boolean(editingExpense?.id)
          && salaryInitialLoadRef.current !== editingExpense?.id;
        if (preservingHistoricalValues) salaryInitialLoadRef.current = editingExpense!.id;
        
        const existingApplied = editingExpense?.id
          ? Number((await supabase.rpc('get_salary_advance_applications', { p_salary_expense_id: editingExpense.id })).data?.reduce((sum: number, item: { applied_amount: number }) => sum + Number(item.applied_amount || 0), 0) ?? 0)
          : 0;
        const loadedAdvances = (advancesResult.data || []) as typeof salaryAdvances;
        setSalaryAdvances(loadedAdvances);
        setSelectedSalaryAdvanceIds(current => {
          const valid = current.filter(id => loadedAdvances.some(advance => advance.advance_id === id));
          return valid.length === current.length ? current : valid;
        });
        const selectedAdvanceTotal = loadedAdvances
          .filter(advance => selectedSalaryAdvanceIds.includes(advance.advance_id))
          .reduce((sum, advance) => sum + Number(advance.available_amount || 0), 0);
        const advanceApplied = existingApplied > 0 ? existingApplied : selectedAdvanceTotal;
        setPersistedSalaryAdvanceApplied(existingApplied);
        setSalaryCalculation(calculation ? {
          ...calculation,
          gross_salary: preservingHistoricalValues ? Number(formData.amount || 0) : calculation.gross_salary,
          pph21_amount: preservingHistoricalValues ? Number(formData.pph_amount || 0) : calculation.pph21_amount,
          outstanding_salary_advances: advanceApplied,
          net_salary_payable: Math.max(
            (preservingHistoricalValues ? Number(formData.amount || 0) : calculation.gross_salary)
              - advanceApplied
              - (formData.pph_treatment === 'add' ? 0 : (preservingHistoricalValues ? Number(formData.pph_amount || 0) : calculation.pph21_amount))
              - calculation.bpjs_amount,
            0,
          ),
        } : null);
        // Existing settlement links are persisted facts; new deductions require explicit advance selections.
        // Only explicitly selected advances can be settled.
        if (calculation && !preservingHistoricalValues) {
          const pph21Code = taxCodes.find((code) => code.code.toUpperCase() === 'PPH21');
          setFormData((previous) => ({
            ...previous,
            pph_amount: calculation.pph21_method === 'percentage' ? calculation.pph21_amount : previous.pph_amount,
            pph_code_id: calculation.pph21_applicable && pph21Code ? pph21Code.id : previous.pph_code_id,
            bpjs_employee_deduction: calculation.bpjs_amount,
            payment_method: editingExpense
              ? previous.payment_method
              : (calculation.default_payment_method === 'bank_transfer'
                ? calculation.default_payment_method
                : previous.payment_method),
          }));
        } else if (calculation && preservingHistoricalValues) {
          setFormData((previous) => ({
            ...previous,
            bpjs_employee_deduction: previous.bpjs_employee_deduction || calculation.bpjs_amount,
          }));
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [formData.expense_category, formData.expense_date, formData.amount, selectedStaffId, taxCodes, editingExpense?.id, selectedSalaryAdvanceIds, formData.pph_treatment]);

  // A deliberate PPh21 edit is a UI override, not a new payroll calculation.
  // Keep the canonical advances/BPJS result and update only the displayed
  // deduction/net so the panel immediately reflects the value that will save.
  useEffect(() => {
    if (formData.expense_category !== 'salary') return;
    const isAdd = formData.pph_treatment === 'add';
    const pphToDeduct = isAdd ? 0 : (Number(formData.pph_amount) || 0);
    setSalaryCalculation(current => current ? {
      ...current,
      pph21_amount: formData.pph_amount,
      net_salary_payable: Math.max(
        current.gross_salary
          - current.outstanding_salary_advances
          - pphToDeduct
          - current.bpjs_amount,
        0,
      ),
    } : current);
  }, [formData.expense_category, formData.pph_amount, formData.pph_treatment]);

  useEffect(() => {
    if (formData.expense_category === 'salary' && periodLabel) {
      const normalized = normalizeSalaryPeriod(periodLabel);
      const parts = normalized.split('-');
      if (parts.length === 2) {
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        if (!isNaN(year) && !isNaN(month)) {
          setFormData(prev => ({
            ...prev,
            payroll_period_year: year,
            payroll_period_month: month,
          }));
        }
      }
    }
  }, [formData.expense_category, periodLabel]);

  useEffect(() => {
    if (!viewingExpense || viewingExpense.expense_category !== 'salary') {
      setSalaryAdvanceApplications([]);
      return;
    }
    void supabase.rpc('get_salary_advance_applications', {
      p_salary_expense_id: viewingExpense.id,
    }).then(({ data, error }) => {
      if (error) {
        console.error('Unable to load salary advance applications:', error.message);
        setSalaryAdvanceApplications([]);
        return;
      }
      setSalaryAdvanceApplications((data || []) as typeof salaryAdvanceApplications);
    });
  }, [viewingExpense]);

  // Retry the Staff / Utility load-back after the rosters arrive.
  // handleEdit runs immediately on click; if the rosters were still loading
  // at that moment the picker lookup misses. This effect re-resolves it once
  // the roster fetch settles, without re-parsing the tag.
  useEffect(() => {
    if (!editingExpense) return;
    const rules = getCategoryFieldRules(editingExpense.expense_category);
    const desc = editingExpense.description || '';
    const tagMatch = desc.match(/^\[([^·\]]+?)(?:\s*·\s*([^\]]+))?\]\s*/);
    if (!tagMatch) return;
    const name = tagMatch[1].trim();
    if (rules.staff === 'show' && !selectedStaffId) {
      const s = staffRoster.find(x => x.full_name === name);
      if (s) setSelectedStaffId(s.id);
    } else if (rules.utility === 'show' && !selectedUtilityId) {
      const u = utilityRoster.find(x => x.provider_name === name);
      if (u) setSelectedUtilityId(u.id);
    }
    // Intentional deps: react to roster arrival, not to editingExpense identity churn.
  }, [staffRoster, utilityRoster, editingExpense]);

  // Realtime subscriptions via shared hook. Patch state from payload instead of
  // reloading the entire list.
  const patchExpense = (payload: any) => {
    const evt = payload.eventType;
    if (evt === 'INSERT') {
      // Row is missing joined relations; fall back to a targeted refetch of the row.
      const id = payload.new?.id;
      if (!id) return;
      supabase
        .from('finance_expenses')
        .select(`
          *,
          suppliers(id, company_name),
          batches(batch_number),
          import_containers(container_ref),
          delivery_challans(challan_number),
          bank_accounts(bank_name, account_number, alias, currency),
          bank_statement_lines!bsl_matched_expense_fk(
            id,
            transaction_date,
            description,
            debit_amount,
            credit_amount,
            bank_account_id,
            bank_accounts(bank_name, account_number, alias, currency)
          )
        `)
        .eq('id', id)
        .maybeSingle()
        .then(({ data }) => {
          if (!data) return;
          void hydrateExpensePostingLifecycle([data as FinanceExpense]).then(([hydrated]) => {
            setExpenses(prev => (prev.some(e => e.id === id) ? prev : [hydrated, ...prev]));
          });
        });
    } else if (evt === 'UPDATE') {
      setExpenses(prev => prev.map(e => (e.id === payload.new.id ? { ...e, ...payload.new } : e)));
    } else if (evt === 'DELETE') {
      setExpenses(prev => prev.filter(e => e.id !== payload.old.id));
    }
  };

  const fetchExpenseBankLinks = async (expenseId: string): Promise<FinanceExpense['bank_statement_lines']> => {
    const [allocRes, linesRes] = await Promise.all([
      supabase
        .from('bank_statement_allocations')
        .select(`
          id,
          document_id,
          allocation_amount,
          payment_kind,
          bank_statement_lines!inner(
            id,
            transaction_date,
            description,
            reference,
            debit_amount,
            credit_amount,
            bank_account_id,
            bank_accounts(bank_name, account_number, alias, currency)
          )
        `)
        .eq('document_type', 'expense')
        .eq('document_id', expenseId),
      supabase
        .from('bank_statement_lines')
        .select(`
          id,
          transaction_date,
          description,
          reference,
          debit_amount,
          credit_amount,
          bank_account_id,
          payment_kind,
          matched_expense_id,
          bank_accounts(bank_name, account_number, alias, currency)
        `)
        .eq('matched_expense_id', expenseId),
    ]);

    if (allocRes.error) {
      console.error('Error fetching bank allocations:', allocRes.error);
      throw new Error(`Failed to load bank allocations: ${allocRes.error.message}`);
    }
    if (linesRes.error) {
      console.error('Error fetching matched bank lines:', linesRes.error);
      throw new Error(`Failed to load matched bank lines: ${linesRes.error.message}`);
    }

    const legacyRows = (linesRes.data || []).map((line: any) => ({
      ...line,
      allocation_id: null,
      allocation_amount: Number(line.debit_amount || line.credit_amount || 0),
    }));

    const canonicalRows = (allocRes.data || []).map((alloc: any) => {
      const line = alloc.bank_statement_lines;
      return {
        ...line,
        id: line?.id,
        raw_line_id: line?.id,
        allocation_id: alloc.id,
        allocation_amount: Number(alloc.allocation_amount || 0),
        payment_kind: alloc.payment_kind,
      };
    }).filter((row: any) => Boolean(row.id));

    return normalizeExpenseBankLinks([...legacyRows, ...canonicalRows]) as FinanceExpense['bank_statement_lines'];
  };

  // The canonical reconciliation relationship is owned by
  // bank_statement_lines.matched_expense_id.  Detail and edit views keep a
  // joined copy of those rows, so updating only reconciledExpenseIds leaves
  // them stale after a link made from Bank Reconciliation.
  const syncExpenseBankLinks = async (candidateIds: Array<string | null | undefined>) => {
    const expenseIds = [...new Set(candidateIds.filter((id): id is string => Boolean(id)))];
    if (expenseIds.length === 0) return;

    const CHUNK_SIZE = 50;
    const linesList: any[] = [];
    const allocationsList: any[] = [];

    for (let i = 0; i < expenseIds.length; i += CHUNK_SIZE) {
      const chunk = expenseIds.slice(i, i + CHUNK_SIZE);
      const [linesRes, allocRes] = await Promise.all([
        supabase
          .from('bank_statement_lines')
          .select(`
            id,
            transaction_date,
            description,
            debit_amount,
            credit_amount,
            bank_account_id,
            payment_kind,
            matched_expense_id,
            bank_accounts(bank_name, account_number, alias, currency)
          `)
          .in('matched_expense_id', chunk),
        supabase
          .from('bank_statement_allocations')
          .select(`
            id,
            document_id,
            allocation_amount,
            payment_kind,
            bank_statement_lines!inner(
              id,
              transaction_date,
              description,
              debit_amount,
              credit_amount,
              bank_account_id,
              bank_accounts(bank_name, account_number, alias, currency)
            )
          `)
          .eq('document_type', 'expense')
          .in('document_id', chunk),
      ]);

      if (linesRes.error || allocRes.error) {
        console.error('Unable to synchronize expense bank links:', linesRes.error?.message || allocRes.error?.message);
        return;
      }
      if (linesRes.data) linesList.push(...linesRes.data);
      if (allocRes.data) allocationsList.push(...allocRes.data);
    }

    const data = linesList;
    const canonicalAllocations = allocationsList;

    const linksByExpenseId = new Map<string, FinanceExpense['bank_statement_lines']>();
    expenseIds.forEach(id => linksByExpenseId.set(id, []));
    (data || []).forEach((line: any) => {
      // matched_expense_id is deliberately omitted from the UI row shape, but
      // is needed here to group the canonical rows by Expense.
      const expenseId = line.matched_expense_id;
      if (!expenseId) return;
      const links = linksByExpenseId.get(expenseId) || [];
      links.push({
        ...line,
        allocation_id: null,
        allocation_amount: Number(line.debit_amount || line.credit_amount || 0),
      });
      linksByExpenseId.set(expenseId, links);
    });

    (canonicalAllocations || []).forEach((allocation: any) => {
      const expenseId = allocation.document_id;
      const line = allocation.bank_statement_lines;
      if (!expenseId || !line) return;
      const links = linksByExpenseId.get(expenseId) || [];
      const directMatchIdx = links.findIndex(existing => existing.id === line.id && !existing.allocation_id);
      if (
        directMatchIdx >= 0 &&
        Math.abs(Number(links[directMatchIdx].allocation_amount || 0) - Number(allocation.allocation_amount || 0)) < 0.01
      ) {
        // Exact canonical mirror of the direct match line -> attach allocation metadata
        links[directMatchIdx] = {
          ...links[directMatchIdx],
          allocation_id: allocation.id,
          allocation_amount: Number(allocation.allocation_amount || 0),
          payment_kind: allocation.payment_kind,
        };
      } else {
        // Distinct allocation record (e.g. separate 40k allocation alongside the 6.82M direct line)
        links.push({
          ...line,
          id: links.some(existing => existing.id === line.id) ? `${line.id}_alloc_${allocation.id}` : line.id,
          raw_line_id: line.id,
          allocation_id: allocation.id,
          allocation_amount: Number(allocation.allocation_amount || 0),
          payment_kind: allocation.payment_kind,
        });
      }
      linksByExpenseId.set(expenseId, links);
    });

    const patchLinks = (expense: FinanceExpense): FinanceExpense => {
      const links = linksByExpenseId.get(expense.id);
      return links === undefined ? expense : { ...expense, bank_statement_lines: normalizeExpenseBankLinks(links as any[]) as FinanceExpense['bank_statement_lines'] };
    };

    setExpenses(prev => prev.map(patchLinks));
    setViewingExpense(prev => (prev ? patchLinks(prev) : prev));
    setEditingExpense(prev => (prev ? patchLinks(prev) : prev));
    setReconciledExpenseIds(prev => {
      const next = new Set(prev);
      expenseIds.forEach(id => {
        if ((linksByExpenseId.get(id) || []).length > 0) next.add(id);
        else next.delete(id);
      });
      return next;
    });
  };

  const patchBankLine = (payload: any) => {
    // A match can move from one Expense to another, so refresh both sides.
    // Replica identity may omit the old matched_expense_id; the local joined
    // snapshots still identify the previous owner in that case.
    const lineId = payload.new?.id || payload.old?.id;
    const previouslyLinkedExpenseIds = [
      ...expenses
        .filter(expense => expense.bank_statement_lines?.some(line => line.id === lineId))
        .map(expense => expense.id),
      viewingExpense?.bank_statement_lines?.some(line => line.id === lineId) ? viewingExpense.id : null,
      editingExpense?.bank_statement_lines?.some(line => line.id === lineId) ? editingExpense.id : null,
    ];
    void syncExpenseBankLinks([
      payload.new?.matched_expense_id,
      payload.old?.matched_expense_id,
      ...previouslyLinkedExpenseIds,
    ]);
  };

  useSupabaseRealtimeChannel({
    channelName: 'expense_changes_expmgr',
    table: 'finance_expenses',
    onEvent: patchExpense,
  });
  useSupabaseRealtimeChannel({
    channelName: 'bank_lines_expmgr',
    table: 'bank_statement_lines',
    onEvent: patchBankLine,
  });

  const patchBankAllocation = (payload: any) => {
    const expenseId = payload.new?.document_id || payload.old?.document_id;
    if (expenseId) {
      void syncExpenseBankLinks([expenseId, viewingExpense?.id, editingExpense?.id]);
    }
  };

  useSupabaseRealtimeChannel({
    channelName: 'bank_allocations_expmgr',
    table: 'bank_statement_allocations',
    onEvent: patchBankAllocation,
  });

  // Realtime supplies the immediate path. The shared event is the fallback
  // for a link/unlink initiated elsewhere in this SPA, and also keeps the
  // list, detail and edit snapshots in agreement when realtime delivery is
  // delayed.
  useEffect(() => {
    const synchronizeVisibleExpenses = () => {
      void syncExpenseBankLinks([
        ...expenses.map(expense => expense.id),
        viewingExpense?.id,
        editingExpense?.id,
      ]);
    };
    window.addEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, synchronizeVisibleExpenses);
    return () => window.removeEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, synchronizeVisibleExpenses);
  }, [expenses, viewingExpense, editingExpense]);

  useEffect(() => {
    if (!initialViewExpenseId) return;

    const openExpense = async () => {
      const existing = expenses.find(expense => expense.id === initialViewExpenseId);
      if (existing) {
        try {
          const bankLines = await fetchExpenseBankLinks(existing.id);
          existing.bank_statement_lines = bankLines;
        } catch (err) {
          console.error('Failed to load bank allocations for existing expense:', err);
        }
        setViewingExpense({ ...existing });
        setViewModalOpen(true);
        onInitialViewHandled?.();
        return;
      }

      const { data, error } = await supabase
        .from('finance_expenses')
        .select(`
          *,
          suppliers(id, company_name),
          batches(batch_number),
          import_containers(container_ref),
          delivery_challans(challan_number),
          bank_accounts(bank_name, account_number, alias, currency),
          bank_statement_lines!bsl_matched_expense_fk(
            id,
            transaction_date,
            description,
            debit_amount,
            credit_amount,
            bank_account_id,
            bank_accounts(bank_name, account_number, alias, currency)
          ),
          salary_advance_applications(
            id,
            applied_amount,
            advance_payment_voucher_id,
            settlement_payment_voucher_id
          ),
          voucher_allocations(
            id,
            allocated_amount,
            payment_kind,
            payment_vouchers(voucher_number, voucher_date, payment_purpose)
          )
        `)
        .eq('id', initialViewExpenseId)
        .maybeSingle();

      if (!error && data) {
        const [hydrated] = await hydrateExpensePostingLifecycle([data as FinanceExpense]);
        try {
          const bankLines = await fetchExpenseBankLinks(hydrated.id);
          hydrated.bank_statement_lines = bankLines;
        } catch (err) {
          console.error('Failed to load bank allocations for initial view expense:', err);
        }
        if (hydrated.expense_category === 'salary' && (!hydrated.salary_advance_applications || hydrated.salary_advance_applications.length === 0)) {
          const { data: apps } = await supabase
            .from('salary_advance_applications')
            .select('id, salary_expense_id, applied_amount, advance_payment_voucher_id, settlement_payment_voucher_id')
            .eq('salary_expense_id', hydrated.id);
          if (apps && apps.length > 0) hydrated.salary_advance_applications = apps;
        }
        setViewingExpense(hydrated);
        setViewModalOpen(true);
      }
      onInitialViewHandled?.();
    };

    openExpense();
  }, [initialViewExpenseId, expenses, onInitialViewHandled]);

  useEffect(() => {
    if (!prefillFromBankReconciliation || loading) return;

    resetForm();
    const bank = bankAccounts.find(b => b.id === prefillFromBankReconciliation.bankAccountId);
    const txnCurrency = prefillFromBankReconciliation.currency || (bank?.currency as 'IDR' | 'USD') || 'IDR';

    setSelectedBankTransactionId(prefillFromBankReconciliation.statementLineId);
    setSelectedBankAllocationAmount(prefillFromBankReconciliation.amount);

    setFormData(prev => ({
      ...prev,
      expense_date: prefillFromBankReconciliation.date,
      due_date: prefillFromBankReconciliation.date,
      amount: prefillFromBankReconciliation.amount,
      description: prefillFromBankReconciliation.description,
      payment_method: 'bank_transfer',
      bank_account_id: prefillFromBankReconciliation.bankAccountId,
      payment_reference: prefillFromBankReconciliation.reference || '',
      transaction_currency: txnCurrency,
      exchange_rate: txnCurrency === 'IDR' ? 1 : prev.exchange_rate,
    }));

    setModalOpen(true);
    onBankReconciliationPrefillConsumed?.();
  }, [prefillFromBankReconciliation, loading, bankAccounts, onBankReconciliationPrefillConsumed]);

  const loadData = async () => {
    try {
      setLoading(true);
      const dropdownQueries = [
        supabase
          .from('batches')
          .select('id, batch_number')
          .order('batch_number'),
        supabase
          .from('import_containers')
          .select('id, container_ref')
          .order('container_ref'),
        supabase
          .from('delivery_challans')
          .select('id, challan_number, challan_date, customers(company_name)')
          .order('challan_number', { ascending: false })
          .limit(50),
        supabase
          .from('bank_accounts')
          .select('id, bank_name, account_number, alias, currency')
          .order('bank_name'),
        supabase
          .from('sales_orders')
          .select('id, so_number, total_amount, currency, customers(company_name)')
          .order('so_number', { ascending: false })
          .limit(100),
      ] as const;

      if (embeddedModalOnly) {
        const [batchesRes, containersRes, challansRes, banksRes, salesOrdersRes] = await Promise.all(dropdownQueries);
        setBatches(batchesRes.data || []);
        setContainers(containersRes.data || []);
        setChallans((challansRes.data || []).map(challan => ({
          ...challan,
          customers: Array.isArray(challan.customers) ? challan.customers[0] || null : challan.customers,
        })));
        setSalesOrders((salesOrdersRes.data || []).map((so: any) => ({
          ...so,
          customers: Array.isArray(so.customers) ? so.customers[0] || null : so.customers,
        })));
        setBankAccounts(banksRes.data || []);
      } else {
        // perf: server-side date filter (was client-side .filter in filteredExpenses).
        let expensesQuery = supabase
          .from('finance_expenses')
          .select(`
            *,
            suppliers(id, company_name),
            batches(batch_number),
            import_containers(container_ref),
            delivery_challans(challan_number),
            bank_accounts(bank_name, account_number, alias, currency),
            bank_statement_lines!bsl_matched_expense_fk(
              id,
              transaction_date,
              description,
              debit_amount,
              credit_amount,
              bank_account_id,
              bank_accounts(bank_name, account_number, alias, currency)
            ),
            salary_advance_applications(
              id,
              applied_amount,
              advance_payment_voucher_id,
              settlement_payment_voucher_id
            ),
            voucher_allocations(
              id,
              allocated_amount,
              payment_kind,
              payment_vouchers(voucher_number, voucher_date, payment_purpose)
            )
          `)
          .order('expense_date', { ascending: false })
          .order('created_at', { ascending: false });
        if (startDate) expensesQuery = expensesQuery.gte('expense_date', startDate);
        if (endDate) expensesQuery = expensesQuery.lte('expense_date', endDate);

        const [expensesRes, batchesRes, containersRes, challansRes, banksRes, salesOrdersRes, bankStmtRes] = await Promise.all([
          expensesQuery,
          dropdownQueries[0],
          dropdownQueries[1],
          dropdownQueries[2],
          dropdownQueries[3],
          dropdownQueries[4],
          supabase
            .from('bank_statement_lines')
            .select('matched_expense_id')
            .not('matched_expense_id', 'is', null),
        ]);

        if (expensesRes.error) throw expensesRes.error;
        const loadedExpenses = await hydrateExpensePostingLifecycle((expensesRes.data || []) as FinanceExpense[]);

        // Ensure salary advance applications are hydrated for all salary expenses
        const salaryExpensesWithoutApps = loadedExpenses.filter(
          e => e.expense_category === 'salary' && (!e.salary_advance_applications || e.salary_advance_applications.length === 0)
        );
        if (salaryExpensesWithoutApps.length > 0) {
          const { data: advanceApps } = await supabase
            .from('salary_advance_applications')
            .select('id, salary_expense_id, applied_amount, advance_payment_voucher_id, settlement_payment_voucher_id')
            .in('salary_expense_id', salaryExpensesWithoutApps.map(e => e.id));
          if (advanceApps && advanceApps.length > 0) {
            const appsByExpId = new Map<string, any[]>();
            advanceApps.forEach(app => {
              const list = appsByExpId.get(app.salary_expense_id) || [];
              list.push(app);
              appsByExpId.set(app.salary_expense_id, list);
            });
            loadedExpenses.forEach(exp => {
              if (appsByExpId.has(exp.id)) {
                exp.salary_advance_applications = appsByExpId.get(exp.id);
              }
            });
          }
        }

        setExpenses(loadedExpenses);
        // Legacy matched_* joins intentionally disappear for split allocations;
        // hydrate the canonical allocation relationships for payment breakdowns.
        void syncExpenseBankLinks(loadedExpenses.map((expense: any) => expense.id));
        setBatches(batchesRes.data || []);
        setContainers(containersRes.data || []);
        setChallans((challansRes.data || []).map(challan => ({
          ...challan,
          customers: Array.isArray(challan.customers) ? challan.customers[0] || null : challan.customers,
        })));
        setSalesOrders((salesOrdersRes.data || []).map((so: any) => ({
          ...so,
          customers: Array.isArray(so.customers) ? so.customers[0] || null : so.customers,
        })));
        setBankAccounts(banksRes.data || []);

        // Build set of reconciled expense IDs
        const reconciledIds = new Set<string>();
        if (bankStmtRes.data) {
          bankStmtRes.data.forEach(line => {
            if (line.matched_expense_id) {
              reconciledIds.add(line.matched_expense_id);
            }
          });
        }
        setReconciledExpenseIds(reconciledIds);
      }

      // Load tax codes (withholding PPh) and asset COA accounts once
      if (taxCodes.length === 0) {
        const { data: tc } = await supabase.from('tax_codes').select('id, code, name, rate, tax_type').eq('is_withholding', true).order('code');
        setTaxCodes(tc || []);
      }
      if (coaAssets.length === 0) {
        const { data: coa } = await supabase.from('chart_of_accounts').select('id, code, name').in('account_type', ['asset', 'Asset']).order('code');
        setCoaAssets(coa || []);
      }
      if (suppliers.length === 0) {
        const { data: sup } = await supabase
          .from('suppliers')
          .select('id, company_name, pkp_status, payment_terms_days, default_expense_category, default_pph_code_id, tax_preference, supplier_type')
          .order('company_name');
        setSuppliers((sup as Supplier[]) || []);
      }
      // Staff Master + Utility Master (dynamic form pickers).
      // Non-blocking — if the tables aren't deployed yet we degrade gracefully.
      if (staffRoster.length === 0) {
        const { data: staff } = await supabase
          .from('finance_staff_master')
          .select('id, full_name, department, default_gl_code, monthly_salary')
          .eq('status', 'active')
          .order('full_name');
        if (staff) setStaffRoster(staff);
      }
      if (utilityRoster.length === 0) {
        const { data: utl } = await supabase
          .from('finance_utility_master')
          .select('id, provider_name, utility_type, supplier_id, default_gl_code')
          .eq('status', 'active')
          .order('provider_name');
        if (utl) setUtilityRoster(utl);
      }
      if (payeeRoster.length === 0) {
        const { data: payees } = await supabase
          .from('finance_payees')
          .select('id, payee_code, full_name, business_role, tax_classification, nik, npwp, bank_name, bank_account_number, bank_account_holder, default_pph_code_id, is_active')
          .eq('is_active', true)
          .order('full_name');
        if (payees) setPayeeRoster(payees);
      }
      if (salesInvoices.length === 0) {
        const { data: si } = await supabase
          .from('sales_invoices')
          .select('id, invoice_number, invoice_date, delivery_challan_number, linked_challan_ids, total_amount, customers(company_name)')
          .order('invoice_number', { ascending: false })
          .limit(100);
        if (si) setSalesInvoices(si.map((inv: any) => ({
          ...inv,
          customers: Array.isArray(inv.customers) ? inv.customers[0] || null : inv.customers,
        })));
      }
    } catch (error: any) {
      console.error('Error loading data:', error.message);
      alert('Failed to load expenses');
    } finally {
      setLoading(false);
    }
  };

  const getSignedUrl = (fileUrl: string): Promise<string> =>
    resolveStorageUrlCached(fileUrl, 3600);

  const openDocument = async (url: string) => {
    await openStorageDocument(url);
  };

  const downloadDocument = async (url: string, filename: string) => {
    await downloadStorageDocument(url, filename);
  };

  const handleViewExpense = useCallback(async (expense: FinanceExpense) => {
    setBankLinkError(null);
    let bankLines = expense.bank_statement_lines;
    try {
      bankLines = await fetchExpenseBankLinks(expense.id);
    } catch (err: any) {
      console.error('Failed to load bank allocations for expense:', err);
      setBankLinkError(err?.message || 'Failed to load bank allocations');
    }

    const hydratedExpense: FinanceExpense = {
      ...expense,
      bank_statement_lines: bankLines,
    };

    setViewingExpense(hydratedExpense);
    setViewModalOpen(true);

    if (bankLines) {
      setExpenses(prev => prev.map(e => e.id === expense.id ? { ...e, bank_statement_lines: bankLines } : e));
    }

    if (expense.document_urls?.length) {
      const entries = await Promise.all(
        expense.document_urls.map(async (url) => [url, await getSignedUrl(url)] as [string, string])
      );
      setSignedUrlCache(prev => ({ ...prev, ...Object.fromEntries(entries) }));
    }
  }, []);

  const handleAddSoAllocation = () => {
    const existingIds = new Set(soAllocations.map(a => a.sales_order_id));
    const available = salesOrders.find(s => !existingIds.has(s.id));
    const chosen = available || salesOrders[0];
    if (!chosen) {
      alert('No sales orders found.');
      return;
    }
    const allocatedSoFar = soAllocations.reduce((sum, a) => sum + (Number(a.allocated_amount) || 0), 0);
    const remaining = Math.max(0, (formData.amount || 0) - allocatedSoFar);
    setSoAllocations([
      ...soAllocations,
      {
        sales_order_id: chosen.id,
        so_number: chosen.so_number,
        customer_name: (chosen.customers as any)?.company_name || '',
        total_amount: Number(chosen.total_amount) || 0,
        allocated_amount: remaining,
      },
    ]);
  };

  const handleUpdateSoAllocation = (index: number, field: keyof SalesOrderAllocation, value: any) => {
    const updated = [...soAllocations];
    if (field === 'sales_order_id') {
      const so = salesOrders.find(s => s.id === value);
      updated[index] = {
        ...updated[index],
        sales_order_id: value,
        so_number: so?.so_number || '',
        customer_name: (so?.customers as any)?.company_name || '',
        total_amount: Number(so?.total_amount) || 0,
      };
    } else {
      updated[index] = {
        ...updated[index],
        [field]: value,
      };
    }
    setSoAllocations(updated);
  };

  const handleRemoveSoAllocation = (index: number) => {
    setSoAllocations(soAllocations.filter((_, i) => i !== index));
  };

  const handleAutoSplitProportional = () => {
    if (soAllocations.length === 0 || !formData.amount) return;
    const totalAmount = formData.amount;
    const soTotalSum = soAllocations.reduce((acc, alloc) => acc + (alloc.total_amount || 0), 0);

    let runningSum = 0;
    const updated = soAllocations.map((alloc, idx) => {
      let amt = 0;
      if (idx === soAllocations.length - 1) {
        amt = Math.round((totalAmount - runningSum) * 100) / 100;
      } else {
        if (soTotalSum > 0) {
          amt = Math.round((totalAmount * ((alloc.total_amount || 0) / soTotalSum)) * 100) / 100;
        } else {
          amt = Math.round((totalAmount / soAllocations.length) * 100) / 100;
        }
        runningSum += amt;
      }
      return { ...alloc, allocated_amount: amt };
    });
    setSoAllocations(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);

    console.log('=== EXPENSE FORM SUBMIT ===');
    console.log('Editing:', !!editingExpense);
    console.log('Files to upload:', uploadingFiles.length);
    console.log('Existing URLs:', formData.document_urls);

    try {
      // Dynamic-form validation — Staff / Utility categories require their
      // respective master row to be picked. Supplier categories keep the
      // existing behaviour (supplier is optional at the DB level).
      const preRules = getCategoryFieldRules(formData.expense_category);

      // Mandatory Tax Linkage Validation:
      // Any expense containing PPN or PPh > 0 must have a valid Supplier/Payee selected.
      // If recorded as paid, valid payment details are mandatory.
      const isPibExpense = formData.expense_category === 'pib_import';
      const resolvedSupplierId = (preRules.supplier === 'hide' || isPibExpense || preRules.payee === 'show' || (preRules.providerTypeToggle && providerType === 'individual'))
        ? null
        : (formData.supplier_id || null);
      const resolvedPayeeId = (preRules.payee === 'show' || (preRules.providerTypeToggle && providerType === 'individual'))
        ? (formData.payee_id || null)
        : null;
      const resolvedStaffId = preRules.staff === 'show' ? (selectedStaffId || null) : null;

      const currentExpenseBank = bankAccounts.find(bank => bank.id === formData.bank_account_id);
      const effectivePaymentMethod = formData.payment_method && formData.payment_method !== 'outstanding'
        ? formData.payment_method
        : (selectedBankTransactionId ? 'bank_transfer' : formData.payment_method);
      const effectiveBankAccountId = formData.bank_account_id || (selectedBankTransactionId ? currentExpenseBank?.id : null);

      const taxValidation = validateExpenseMandatoryTaxLinkage({
        expense_category: formData.expense_category,
        amount: formData.amount,
        ppn_amount: formData.ppn_amount,
        pph_amount: formData.pph_amount,
        supplier_id: resolvedSupplierId,
        payee_id: resolvedPayeeId,
        staff_id: resolvedStaffId,
        payment_method: effectivePaymentMethod,
        bank_account_id: effectiveBankAccountId,
        selected_bank_transaction_id: selectedBankTransactionId,
        paid_amount: selectedBankAllocationAmount || editingExpense?.paid_amount,
      });

      if (!taxValidation.isValid) {
        setFieldErrors(taxValidation.errors);
        isSubmittingRef.current = false;
        setIsSubmitting(false);

        const msg = taxValidation.firstErrorMessage || 'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.';
        alert(msg);

        setTimeout(() => {
          if (taxValidation.firstErrorField === 'party') {
            const el = document.querySelector(
              'input[placeholder="Search supplier..."], input[placeholder="Search payee..."], input[placeholder="Search staff..."], input[placeholder="Search utility..."]'
            ) as HTMLElement;
            el?.focus();
          } else if (taxValidation.firstErrorField === 'bank_account_id') {
            const el = document.querySelector('select[name="bank_account_id"]') as HTMLElement;
            el?.focus();
          } else if (taxValidation.firstErrorField === 'payment_method') {
            const el = document.querySelector('select[name="payment_method"]') as HTMLElement;
            el?.focus();
          }
        }, 50);

        return;
      }
      setFieldErrors({});

      if (formData.expense_category === 'non_permanent_employee_fee' && selectedSupplier
          && !['employee', 'non-permanent individual', 'freelancer', 'casual worker', 'honorarium recipient']
            .includes((selectedSupplier.supplier_type || '').trim().toLowerCase())) {
        alert('Non-Permanent Employee Fee is intended for an individual subject to PPh 21. Select an Employee, Freelancer, Casual Worker, or Honorarium supplier.');
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
      if (preRules.staff === 'show' && !selectedStaffId) {
        alert('Please pick a Staff member for this salary / staff expense.');
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
      if (formData.expense_category === 'staff_advance' && !formData.payment_method) {
        alert('A staff advance is money paid out — select how it was paid (it cannot be recorded as an outstanding bill).');
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
      if (preRules.utility === 'show' && !selectedUtilityId) {
        alert('Please pick a Utility Provider for this utility expense.');
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
      const category = expenseCategories.find(c => c.value === formData.expense_category);

      // PIB Import: validate that the breakdown sums to the payment amount
      if (formData.expense_category === 'pib_import') {
        const breakdown = (formData.pib_bm_amount || 0) + (formData.pib_ppn_amount || 0) + (formData.pib_pph_amount || 0);
        if (Math.abs(breakdown - (formData.amount || 0)) > 1) {
          alert(
            `❌ PIB Breakdown Mismatch\n\n` +
            `BM + PPN + PPh = Rp ${breakdown.toLocaleString('id-ID')}\n` +
            `Payment Amount = Rp ${(formData.amount || 0).toLocaleString('id-ID')}\n\n` +
            `The three components must equal the total payment amount.`
          );
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
        if (breakdown === 0) {
          alert('❌ PIB Import requires a breakdown. Please enter BM, PPN, and/or PPh amounts.');
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
      }

      // Fixed Asset: account selection is mandatory before save.
      if (formData.expense_category === 'fixed_asset' && !formData.fixed_asset_account_id) {
        alert(
          '❌ Fixed Asset Account Required\n\n' +
          'This expense is categorised as Fixed Asset.\n\n' +
          'Select the Fixed Asset GL account (e.g. Equipment, Furniture, Machinery) ' +
          'before saving. The Journal Entry cannot be generated without it.'
        );
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        return;
      }

      // Validate: PPh code is required whenever a PPh amount is entered.
      // pib_import expenses use the pib_pph_amount breakdown field instead.
      if (formData.expense_category !== 'pib_import'
          && (formData.pph_amount || 0) > 0
          && !formData.pph_code_id) {
        alert(
          '❌ PPh Code Required\n\n' +
          'A PPh code must be selected when PPh Withheld is greater than zero.\n\n' +
          'Select the applicable PPh code (e.g. PPh21 Employee, PPh23 Services) ' +
          'so the amount flows correctly into the PPh Register.'
        );
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        return;
      }

      // Sales Order allocations validation for sales expenses
      if (requiresDC && soAllocations.length > 0) {
        const allocSum = soAllocations.reduce((sum, a) => sum + (Number(a.allocated_amount) || 0), 0);
        if (Math.abs(allocSum - (formData.amount || 0)) > 0.01) {
          alert(
            `❌ Sales Order Allocation Mismatch\n\n` +
            `Sum of allocations = Rp ${allocSum.toLocaleString('id-ID')}\n` +
            `Expense Amount = Rp ${(formData.amount || 0).toLocaleString('id-ID')}\n\n` +
            `The total allocated across Sales Orders must equal the expense amount.`
          );
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
      }

      // Upload new files first
      const uploadedUrls = uploadingFiles.length > 0
        ? await uploadFinanceDocuments(uploadingFiles, `expenses/${formData.expense_category}`)
        : [];

      // Combine existing URLs with newly uploaded ones
      const allDocumentUrls = [...formData.document_urls, ...uploadedUrls];
      console.log('Combined document URLs:', allDocumentUrls);

      // 2026-07 refactor — Broker Invoice amount and reimbursement lines are
      // independent by design (Indonesian brokers issue their own invoice for
      // their fee; reimbursement lines are pass-through sub-supplier invoices).
      // Do NOT validate that lines must sum to invoice amount.

      const isBrokerInvoice = formData.expense_category === 'import_broker';
      const isPib = formData.expense_category === 'pib_import';
      const isFixedAsset = formData.expense_category === 'fixed_asset';
      const isImportCategory = category?.type === 'import';
      // Broker invoices behave like any other supplier invoice at the header
      // level: they own their own PPN / PPh / stamp / DPP-mode. Only pure
      // import cost categories (freight, duty, etc.) still zero out those
      // header tax fields — that logic is unchanged.
      const persistHeaderTax = !isPib && (!isImportCategory || isBrokerInvoice);
      // Dynamic-form prefix — inject Staff / Utility name and period into
      // description for ledger traceability. Prefix is added ONLY when the
      // category dictates and only if the user has not already typed the same
      // value at the start of description.
      const rules = getCategoryFieldRules(formData.expense_category);
      let composedDescription = (formData.description || '').trim();
      if (rules.staff === 'show' && selectedStaffId) {
        const s = staffRoster.find(x => x.id === selectedStaffId);
        if (s) {
          const tag = `[${s.full_name}${periodLabel ? ' · ' + formatFinancePeriodValue(periodLabel) : ''}]`;
          if (!composedDescription.startsWith(tag)) composedDescription = `${tag} ${composedDescription}`.trim();
        }
      } else if (rules.utility === 'show' && selectedUtilityId) {
        const u = utilityRoster.find(x => x.id === selectedUtilityId);
        if (u) {
          const tag = `[${u.provider_name}${periodLabel ? ' · ' + formatFinancePeriodValue(periodLabel) : ''}]`;
          if (!composedDescription.startsWith(tag)) composedDescription = `${tag} ${composedDescription}`.trim();
        }
      }
      const selectedExpenseBank = bankAccounts.find(bank => bank.id === formData.bank_account_id);
      const transactionCurrency = normalizeCurrency(
        formData.payment_method !== null ? selectedExpenseBank?.currency : formData.transaction_currency,
      ) as 'IDR' | 'USD';
      const exchangeRate = transactionCurrency === 'IDR'
        ? 1
        : (formData.exchange_rate > 1 ? formData.exchange_rate : await getReportingUsdRate());
      const expenseData = {
        expense_category: formData.expense_category,
        // finance_expenses.expense_type is the legacy transaction context,
        // distinct from the broader Expense Category Master category_type.
        // The database derives this again so every write path stays canonical.
        expense_type: category?.type === 'import' ? 'import' : category?.type === 'sales' ? 'sales' : 'general',
        amount: formData.amount,
        expense_date: formData.expense_date,
        description: composedDescription || null,
        batch_id: formData.batch_id || null,
        import_container_id: formData.import_container_id || null,
        delivery_challan_id: formData.delivery_challan_id || null,
        payment_method: effectivePaymentMethod || null,
        bank_account_id: effectivePaymentMethod && effectivePaymentMethod !== 'outstanding' ? (effectiveBankAccountId || formData.bank_account_id || null) : null,
        payment_reference: formData.payment_reference || null,
        paid_by: (selectedBankTransactionId || effectivePaymentMethod === 'bank_transfer') ? 'bank' : (effectivePaymentMethod === 'cash' || effectivePaymentMethod === 'petty_cash' ? 'cash' : null),
        selected_bank_transaction_id: selectedBankTransactionId || null,
        // save_finance_expense expects document_urls to always be a JSON array;
        // null causes jsonb_array_elements_text to fail in the RPC.
        document_urls: allDocumentUrls,
        // Main invoice supplier. NEVER derived from broker_items[i].supplier_id
        // — broker line suppliers are used ONLY for tax invoice / PPN register.
        // PIB import obligations are statutory (Kas Negara) and strictly use supplier_id = null.
        supplier_id: (rules.supplier === 'hide' || isPib || rules.payee === 'show' || (rules.providerTypeToggle && providerType === 'individual')) ? null : (formData.supplier_id || null),
        // Staff FK (salary / overtime / welfare / advance) — the description
        // prefix stays for ledger traceability, but the FK is authoritative.
        staff_id: rules.staff === 'show' ? (selectedStaffId || null) : null,
        payee_id: (rules.payee === 'show' || (rules.providerTypeToggle && providerType === 'individual')) ? (formData.payee_id || null) : null,
        linked_sales_invoice_id: rules.salesInvoice === 'show' ? (formData.linked_sales_invoice_id || null) : null,
        pph_calculation_regime: formData.pph_calculation_regime || null,
        pph_dpp_ratio: formData.pph_dpp_ratio != null ? formData.pph_dpp_ratio : null,
        pph_dpp_amount: formData.pph_dpp_amount != null ? formData.pph_dpp_amount : null,
        pph_rate: formData.pph_rate != null ? formData.pph_rate : null,
        is_tax_manual_override: !!formData.is_tax_manual_override,
        invoice_number: formData.invoice_number || null,
        due_date: formData.due_date || null,
        // Broker items (only for import_broker). Per-line supplier_id inside these
        // items feeds vw_input_ppn_report Branch 5 — the main supplier above is untouched.
        broker_items: isBrokerInvoice && brokerItems.length > 0 ? brokerItems : null,
        // PIB breakdown — only persisted for pib_import category
        pib_bm_amount:  isPib ? (formData.pib_bm_amount  || 0) : null,
        pib_ppn_amount: isPib ? (formData.pib_ppn_amount || 0) : null,
        pib_pph_amount: isPib ? (formData.pib_pph_amount || 0) : null,
        // Non-PIB header tax fields. Broker invoices own their own header tax
        // (independent of reimbursement lines), so persistHeaderTax includes
        // import_broker but excludes pure import cost categories.
        ppn_amount:             persistHeaderTax ? (formData.ppn_amount || 0) : 0,
        ppn_manual_override:    persistHeaderTax ? (formData.ppn_calc_mode === 'manual' || !!formData.ppn_manual_override) : false,
        ppn_calc_mode:          persistHeaderTax ? (formData.ppn_calc_mode || 'standard') : 'standard',
        // Persist header DDP whenever set — used both as the DPP Nilai Lain
        // taxable base AND, for broker invoices, as an independent additive
        // component of Total Payable. Nulled only when the field is empty.
        dpp_amount:             persistHeaderTax && (formData.dpp_amount || 0) > 0 ? (formData.dpp_amount || 0) : null,
        ppn_rate:               persistHeaderTax ? (formData.ppn_rate || 11) : 11,
        pph_amount:             persistHeaderTax ? (formData.pph_amount || 0) : 0,
        pph_code_id:            (persistHeaderTax && formData.pph_code_id) ? formData.pph_code_id : null,
        pph_treatment:          formData.pph_treatment || 'deduct',
        stamp_duty_amount:      persistHeaderTax ? (formData.stamp_duty_amount || 0) : 0,
        fixed_asset_account_id: isFixedAsset ? (formData.fixed_asset_account_id || null) : null,
        bank_charges_amount:    Number(formData.bank_charges_amount ?? editingExpense?.bank_charges_amount ?? 0),
        currency_code: transactionCurrency,
        transaction_currency: transactionCurrency,
        functional_currency: 'IDR' as const,
        exchange_rate: exchangeRate,
        bank_account_currency: selectedExpenseBank?.currency || transactionCurrency,
        payment_currency: transactionCurrency,
        sales_order_allocations: requiresDC && soAllocations.length > 0 ? soAllocations : [],
        bpjs_employee_deduction: formData.expense_category === 'salary'
          ? Number(formData.bpjs_employee_deduction || salaryCalculation?.bpjs_amount || 0)
          : 0,
        bpjs_register_item_id: formData.expense_category === 'salary' ? (formData.bpjs_register_item_id || null) : null,
        payroll_period_month: formData.expense_category === 'salary' ? (formData.payroll_period_month || null) : null,
        payroll_period_year: formData.expense_category === 'salary' ? (formData.payroll_period_year || null) : null,
      };

      console.log('=== EXPENSE DATA TO SAVE ===');
      console.log('document_urls:', expenseData.document_urls);
      console.log('Full expense data:', expenseData);

      if (formData.expense_category === 'salary' && persistedSalaryAdvanceApplied > 0) {
        const minRequired = persistedSalaryAdvanceApplied + (Number(formData.pph_amount) || 0);
        if (Number(formData.amount || 0) < minRequired - 0.01) {
          alert(`Cannot reduce gross salary to ${formatCurrency(formData.amount, expenseFormCurrency)}: ${formatCurrency(persistedSalaryAdvanceApplied, expenseFormCurrency)} is already applied in salary advances. Adjust or reverse the advance settlement first.`);
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
      }

      if (editingExpense) {
        // Regular update - bank expenses only (cash expenses go to Petty Cash Manager)
        console.log('=== UPDATING EXPENSE ===');
        console.log('Expense ID:', editingExpense.id);

        const editingApprovedExpense = editingExpense.approval_status === 'approved';
        if (editingApprovedExpense) {
          const docPayable = calculateCanonicalCashPayable({ ...editingExpense, ...expenseData });
          const allocAmt = selectedBankAllocationAmount && selectedBankAllocationAmount > 0.01
            ? (docPayable > 0.01 ? Math.min(selectedBankAllocationAmount, docPayable) : selectedBankAllocationAmount)
            : (docPayable > 0.01 ? docPayable : undefined);
          await editApprovedFinanceExpense(
            editingExpense.id,
            expenseData,
            selectedBankTransactionId || null,
            allocAmt,
          );
        } else {
          await saveFinanceExpense(editingExpense.id, expenseData);
        }

        if (formData.expense_category === 'salary' && selectedStaffId && selectedSalaryAdvanceIds.length > 0 && persistedSalaryAdvanceApplied === 0) {
          const { error: advanceError } = await supabase.rpc('apply_selected_salary_advances_to_expense', {
            p_salary_expense_id: editingExpense.id,
            p_advance_ids: selectedSalaryAdvanceIds,
          });
          if (advanceError) throw advanceError;
        }

        console.log('Update successful! Fetching updated data...');

        // Fetch the updated expense with relations
        const { data: updatedExpense, error: fetchError } = await supabase
          .from('finance_expenses')
          .select(`
            *,
            batches (batch_number),
            import_containers (container_ref),
            delivery_challans (challan_number),
            bank_accounts (bank_name, account_number),
            bank_statement_lines!bsl_matched_expense_fk (
              id,
              transaction_date,
              description,
              debit_amount,
              credit_amount,
              bank_account_id,
              bank_accounts (bank_name, account_number)
            ),
            salary_advance_applications (
              id,
              applied_amount,
              advance_payment_voucher_id,
              settlement_payment_voucher_id
            ),
            voucher_allocations (
              id,
              allocated_amount,
              payment_kind,
              payment_vouchers (voucher_number, voucher_date, payment_purpose)
            )
          `)
          .eq('id', editingExpense.id)
          .single();

        if (fetchError) {
          console.error('Fetch error:', fetchError);
          throw fetchError;
        }

        console.log('=== FETCHED UPDATED EXPENSE ===');
        console.log('document_urls from DB:', updatedExpense.document_urls);
        console.log('Full updated expense:', updatedExpense);

        const [hydratedUpdatedExpense] = await hydrateExpensePostingLifecycle([updatedExpense as FinanceExpense]);

        // Update in local state
        setExpenses(prev => prev.map(exp =>
          exp.id === editingExpense.id ? hydratedUpdatedExpense : exp
        ));
        void syncExpenseBankLinks([editingExpense.id]);

        if (selectedBankTransactionId && editingApprovedExpense) {
          setReconciledExpenseIds(prev => new Set(prev).add(editingExpense.id));
          notifyFinanceReconciliationRefresh();
        }

        alert('Expense updated successfully');
      } else {
        // Create new bank expense - cash expenses should be recorded in Petty Cash Manager
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        console.log('=== CREATING NEW EXPENSE ===');

        if (selectedBankTransactionId) {
          const { data: lineCheck, error: checkErr } = await supabase
            .from('bank_statement_lines')
            .select('id, matched_expense_id, matching_status, debit_amount, credit_amount')
            .eq('id', selectedBankTransactionId)
            .single();
          if (checkErr) throw checkErr;
          if (lineCheck?.matched_expense_id) {
            const existingExpId = lineCheck.matched_expense_id;

            // Check if this existing expense already has canonical allocations on this line
            const { data: existingAllocations } = await supabase
              .from('bank_statement_allocations')
              .select('id, allocation_amount')
              .eq('bank_statement_line_id', selectedBankTransactionId)
              .eq('document_id', existingExpId);

            const hasCanonicalAllocation = Boolean(existingAllocations && existingAllocations.length > 0);

            if (!hasCanonicalAllocation) {
              // Existing expense exists (e.g. EXP/26/306) but lacks canonical allocation!
              // Requirement: Link that existing expense instead of creating a duplicate.
              console.log(`Linking existing expense ${existingExpId} to statement line ${selectedBankTransactionId}`);

              if (isAdmin) {
                try {
                  await approveFinanceExpense(existingExpId, profile?.id || user.id);
                } catch (approveErr: any) {
                  console.warn('Approve existing expense notice:', approveErr?.message || approveErr);
                }
              }

              const lineAmount = Number(lineCheck.debit_amount || lineCheck.credit_amount || 0);
              const { data: fetchedExp } = await supabase
                .from('finance_expenses')
                .select('*')
                .eq('id', existingExpId)
                .single();

              const docPayable = fetchedExp ? calculateCanonicalCashPayable(fetchedExp) : lineAmount;
              const allocAmt = selectedBankAllocationAmount && selectedBankAllocationAmount > 0.01
                ? (docPayable > 0.01 ? Math.min(selectedBankAllocationAmount, docPayable) : selectedBankAllocationAmount)
                : (docPayable > 0.01 ? docPayable : (lineAmount > 0 ? lineAmount : undefined));

              try {
                await linkBankStatementLine(selectedBankTransactionId, 'expense', existingExpId, 'supplier', allocAmt);
                await syncExpenseBankLinks([existingExpId]);
                setReconciledExpenseIds(prev => new Set(prev).add(existingExpId));
                notifyFinanceReconciliationRefresh();

                if (fetchedExp) {
                  setExpenses(prev => {
                    const idx = prev.findIndex(e => e.id === existingExpId);
                    if (idx >= 0) {
                      const updated = [...prev];
                      updated[idx] = { ...updated[idx], ...fetchedExp };
                      return updated;
                    }
                    return [fetchedExp, ...prev];
                  });
                  onExpenseSavedFromBankReconciliation?.(fetchedExp as FinanceExpense, selectedBankTransactionId);
                }

                if (!embeddedModalOnly) {
                  alert(`Linked bank transaction to existing expense (${fetchedExp?.voucher_number || existingExpId}) without creating a duplicate.`);
                }
                setModalOpen(false);
                resetForm();
                return;
              } catch (linkError: any) {
                console.error('Failed to link existing expense:', linkError);
                throw new Error(`Failed to link existing expense (${existingExpId}): ${linkError?.message || linkError}`);
              }
            } else {
              if (inFlightExpenseIdRef.current && lineCheck.matched_expense_id === inFlightExpenseIdRef.current) {
                // Retry of same operation after network timeout
              } else {
                throw new Error(`This bank statement line is already linked to an expense (ID: ${lineCheck.matched_expense_id}).`);
              }
            }
          }
        }

        const newExpensePayload = {
          ...expenseData,
          created_by: user.id,
          ...(selectedBankTransactionId ? { originating_bank_statement_line_id: selectedBankTransactionId } : {}),
        };
        // Ensure new expense is saved without premature posting: const newExpenseId = await saveFinanceExpense(null, newExpensePayload);
        const expenseToSaveId = inFlightExpenseIdRef.current || null;
        const newExpenseId = await saveFinanceExpense(expenseToSaveId, newExpensePayload);
        inFlightExpenseIdRef.current = newExpenseId;

        if (formData.expense_category === 'salary' && selectedStaffId && selectedSalaryAdvanceIds.length > 0) {
          const { error: advanceError } = await supabase.rpc('apply_selected_salary_advances_to_expense', {
            p_salary_expense_id: newExpenseId,
            p_advance_ids: selectedSalaryAdvanceIds,
          });
          if (advanceError) throw advanceError;
        }

        if (selectedBankTransactionId && newExpenseId) {
          try {
            await supabase
              .from('finance_expenses')
              .update({ originating_bank_statement_line_id: selectedBankTransactionId })
              .eq('id', newExpenseId);
          } catch {
            // Safe fallback if column is not present in local schema
          }
        }

        // For authorized administrators, approve and post directly via existing authorized server pipeline
        if (isAdmin && newExpenseId) {
          await approveFinanceExpense(newExpenseId, profile?.id || user.id);
        }

        const selectClause = `
            *,
            batches (batch_number),
            import_containers (container_ref),
            delivery_challans (challan_number),
            bank_accounts (bank_name, account_number),
            bank_statement_lines!bsl_matched_expense_fk (
              id,
              transaction_date,
              description,
              debit_amount,
              credit_amount,
              bank_account_id,
              bank_accounts (bank_name, account_number)
            ),
            salary_advance_applications (
              id,
              applied_amount,
              advance_payment_voucher_id,
              settlement_payment_voucher_id
            ),
            voucher_allocations (
              id,
              allocated_amount,
              payment_kind,
              payment_vouchers (voucher_number, voucher_date, payment_purpose)
            )
          `;

        const { data: newExpense, error: insertErr } = await supabase
          .from('finance_expenses').select(selectClause).eq('id', newExpenseId).single();
        if (insertErr) throw insertErr;

        console.log('=== NEW EXPENSE CREATED ===');
        console.log('document_urls from DB:', newExpense?.document_urls);
        console.log('Full new expense:', newExpense);

        const [hydratedNewExpense] = await hydrateExpensePostingLifecycle([newExpense as FinanceExpense]);
        const finalExpense = (hydratedNewExpense as FinanceExpense) || (newExpense as FinanceExpense);

        if (selectedBankTransactionId && newExpense) {
          const isApproved = isAdmin || (newExpense.approval_status === 'approved');
          if (isApproved) {
            try {
              const docPayable = calculateCanonicalCashPayable(newExpense);
              const allocAmt = selectedBankAllocationAmount && selectedBankAllocationAmount > 0.01
                ? (docPayable > 0.01 ? Math.min(selectedBankAllocationAmount, docPayable) : selectedBankAllocationAmount)
                : (docPayable > 0.01 ? docPayable : undefined);

              await linkBankStatementLine(selectedBankTransactionId, 'expense', newExpense.id, 'supplier', allocAmt);
              await syncExpenseBankLinks([newExpense.id]);
              setReconciledExpenseIds(prev => new Set(prev).add(newExpense.id));
              notifyFinanceReconciliationRefresh();
            } catch (linkErr: any) {
              console.error('Error linking bank statement line to expense:', linkErr);
              alert(`⚠️ Expense was created successfully (${newExpense.voucher_number || newExpense.id}), but automatic bank reconciliation linking could not be completed: ${linkErr?.message || linkErr}.\n\nYou can link this expense manually from the Bank Reconciliation screen.`);
            }
          } else {
            const { error: linkErr } = await supabase
              .from('bank_statement_lines')
              .update({
                matched_expense_id: newExpense.id,
                matching_status: 'suggested',
              })
              .eq('id', selectedBankTransactionId);
            if (linkErr) {
              console.error('Error linking bank statement line to expense:', linkErr);
            }
            await syncExpenseBankLinks([newExpense.id]);
            notifyFinanceReconciliationRefresh();
          }
          onExpenseSavedFromBankReconciliation?.(finalExpense, selectedBankTransactionId);
        }

        // Add to local state (with bank link if applicable)
        setExpenses(prev => [finalExpense, ...prev]);
        inFlightExpenseIdRef.current = null;
        void loadHealthCheck();
        if (!embeddedModalOnly) {
          alert('Expense recorded successfully');
        }
      }

      setModalOpen(false);
      resetForm();
      onCloseEmbedded?.();
    } catch (error: any) {
      console.error('Error saving expense:', error.message);
      // Show clear error message from backend validation
      const errorMessage = error.message || 'Unknown error occurred';
      if (errorMessage.includes('Import expenses must be linked')) {
        alert('❌ Context Required\n\nImport expenses must be linked to an Import Container.\nPlease select a container before saving.');
      } else {
        alert('Failed to save expense:\n\n' + errorMessage);
      }
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleEdit = async (expense: FinanceExpense, openBankLink = false) => {
    if (expense.effective_posting_state === 'REVERSED' || expense.effective_posting_state === 'AMBIGUOUS') {
      alert(expense.effective_posting_state === 'REVERSED'
        ? 'This expense is cancelled and cannot be edited.'
        : 'This expense requires accounting review before it can be edited.');
      return;
    }
    setEditingExpense(expense);
    if (expense.expense_category === 'salary') {
      const { data, error } = await supabase.rpc('get_salary_advance_applications', { p_salary_expense_id: expense.id });
      if (error) {
        alert(`Unable to load salary advance settlement: ${error.message}`);
        setEditingExpense(null);
        return;
      }
      setPersistedSalaryAdvanceApplied((data || []).reduce((sum: number, item: { applied_amount: number }) => sum + Number(item.applied_amount || 0), 0));
    } else {
      setPersistedSalaryAdvanceApplied(0);
    }

    // Check if expense is reconciled to a bank statement
    const reconciledBankInfo = expense.bank_statement_lines && expense.bank_statement_lines.length > 0
      ? expense.bank_statement_lines[0]
      : null;

    // Use reconciled bank info if available, otherwise use expense's own payment info
    const effectiveBankAccountId = reconciledBankInfo?.bank_account_id || expense.bank_account_id || '';
    // The row-level bank-link shortcut opens the existing edit workflow with
    // bank transfer selected, so the user can choose the correct bank account
    // and statement line without changing any saved data just by clicking the icon.
    const effectivePaymentMethod = openBankLink
      ? 'bank_transfer'
      : reconciledBankInfo?.bank_account_id
        ? 'bank_transfer'
        : expense.payment_method;

    // Determine document type from category
    const docType = (Object.entries(DOCUMENT_TYPE_GROUPS) as [DocumentType, string[]][])
      .find(([, cats]) => cats.includes(expense.expense_category))?.[0] ?? '' as DocumentType | '';
    setSelectedDocType(docType);

    // Set supplier
    const sup = expense.supplier_id ? suppliers.find(s => s.id === expense.supplier_id) ?? null : null;
    setSelectedSupplier(sup);

    // Set broker items
    setBrokerItems(expense.broker_items ?? []);

    // Set sales order allocations
    setSoAllocations(
      Array.isArray(expense.sales_order_allocations)
        ? (expense.sales_order_allocations as SalesOrderAllocation[]).map(a => ({
            ...a,
            allocated_amount: Number(a.allocated_amount) || 0,
          }))
        : []
    );

    // Dynamic-form load-back — if the expense was saved as Staff or Utility,
    // reconstruct the picker selection + period from the "[Name · Period]"
    // description prefix so the form re-opens in the same state.
    const rules = getCategoryFieldRules(expense.expense_category);
    const desc = expense.description || '';
    const tagMatch = desc.match(/^\[([^·\]]+?)(?:\s*·\s*([^\]]+))?\]\s*/);
    let cleanedDesc = desc;
    let loadedStaffId = '';
    let loadedUtilityId = '';
    let loadedPeriod = '';
    if (tagMatch) {
      const [full, name, period] = tagMatch;
      cleanedDesc = desc.slice(full.length);
      loadedPeriod = (period ?? '').trim();
      if (rules.staff === 'show') {
        const s = staffRoster.find(x => x.full_name === name.trim());
        if (s) loadedStaffId = s.id;
      } else if (rules.utility === 'show') {
        const u = utilityRoster.find(x => x.provider_name === name.trim());
        if (u) loadedUtilityId = u.id;
      }
    }
    // staff_id FK (Phase 2) is authoritative over the description-prefix match
    if (rules.staff === 'show' && expense.staff_id) loadedStaffId = expense.staff_id;
    setSelectedStaffId(loadedStaffId);
    setSelectedUtilityId(loadedUtilityId);
    const explicitPeriod = (expense.payroll_period_year && expense.payroll_period_month)
      ? `${expense.payroll_period_year}-${String(expense.payroll_period_month).padStart(2, '0')}`
      : (rules.salaryMonth === 'show' ? normalizeSalaryPeriod(loadedPeriod, new Date(expense.expense_date).getFullYear()) : loadedPeriod);
    setPeriodLabel(explicitPeriod);

    setFormData({
      expense_category: expense.expense_category,
      amount: expense.amount,
      transaction_currency: normalizeCurrency(expense.transaction_currency ?? expense.currency_code) as 'IDR' | 'USD',
      exchange_rate: expense.exchange_rate ?? 1,
      expense_date: expense.expense_date,
      description: cleanedDesc,
      batch_id: expense.batch_id || '',
      import_container_id: expense.import_container_id || '',
      delivery_challan_id: expense.delivery_challan_id || '',
      payment_method: effectivePaymentMethod,
      bank_account_id: effectiveBankAccountId,
      payment_reference: expense.payment_reference || '',
      document_urls: expense.document_urls || [],
      supplier_id: expense.supplier_id ?? '',
      invoice_number: expense.invoice_number ?? '',
      due_date: expense.due_date ?? '',
      pib_bm_amount:  expense.pib_bm_amount  ?? 0,
      pib_ppn_amount: expense.pib_ppn_amount ?? 0,
      pib_pph_amount: expense.pib_pph_amount ?? 0,
      ppn_amount: expense.ppn_amount ?? 0,
      ppn_manual_override: expense.ppn_manual_override ?? false,
      // Derive mode when loading pre-existing rows: manual_override was true → 'manual';
      // otherwise fall back to whatever the server tells us, defaulting to 'standard'.
      ppn_calc_mode: (expense.ppn_calc_mode ?? (expense.ppn_manual_override ? 'manual' : 'standard')) as 'standard' | 'dpp_nilai_lain' | 'manual',
      dpp_amount: expense.dpp_amount ?? 0,
      ppn_rate: expense.ppn_rate ?? 11,
      pph_amount: expense.pph_amount ?? 0,
      pph_code_id: expense.pph_code_id ?? '',
      pph_treatment: (expense.pph_treatment === 'add' ? 'add' : 'deduct') as 'deduct' | 'add',
      stamp_duty_amount: expense.stamp_duty_amount ?? 0,
      fixed_asset_account_id: expense.fixed_asset_account_id ?? '',
      bank_charges_amount: expense.bank_charges_amount ?? 0,
      payee_id: expense.payee_id ?? '',
      linked_sales_invoice_id: expense.linked_sales_invoice_id ?? '',
      pph_calculation_regime: expense.pph_calculation_regime ?? '',
      pph_dpp_ratio: expense.pph_dpp_ratio ?? (expense.pph_amount ? 0.5 : 1.0),
      pph_dpp_amount: expense.pph_dpp_amount ?? (expense.pph_amount ? Math.round(expense.amount * 0.5) : 0),
      pph_rate: expense.pph_rate ?? 0,
      is_tax_manual_override: expense.is_tax_manual_override ?? false,
      bpjs_employee_deduction: Number(expense.bpjs_employee_deduction) || 0,
      bpjs_register_item_id: expense.bpjs_register_item_id || null,
      payroll_period_month: expense.payroll_period_month || null,
      payroll_period_year: expense.payroll_period_year || null,
    });

    setProviderType(expense.payee_id ? 'individual' : 'corporate');
    setWorkingDays(1);

    // An existing allocation is displayed by BankTransactionLinkField; it is
    // not a newly selected bank line. Preloading it here made Update call the
    // allocation RPC again and correctly fail on the duplicate allocation.
    setSelectedBankTransactionId('');
    setSelectedBankAllocationAmount(undefined);

    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    const expense = expenses.find(candidate => candidate.id === id);
    if (!expense || !['PENDING', 'REJECTED'].includes(expense.effective_posting_state || 'AMBIGUOUS')) {
      alert('This expense is not deletable through the normal workflow. Reversed, replaced, active, or ambiguous accounting history must be preserved.');
      return;
    }
    if (!confirm('Are you sure you want to delete this expense?')) return;

    try {
      const { error } = await supabase.rpc('delete_expense_safe', { p_expense_id: id });

      if (error) throw error;

      // Remove from local state
      setExpenses(prev => prev.filter(exp => exp.id !== id));
      alert('Expense deleted successfully');
    } catch (error: any) {
      console.error('Error deleting expense:', error.message);
      alert('Failed to delete expense: ' + error.message);
    }
  };


  const handleApproveExpense = async (id: string) => {
    if (!isAdmin) return;

    // Block approval if this is a fixed_asset expense with no account selected.
    const target = expenses.find(e => e.id === id);
    if (target?.expense_category === 'fixed_asset' && !target.fixed_asset_account_id) {
      alert(
        '❌ Cannot Approve — Fixed Asset Account Missing\n\n' +
        'This expense is categorised as Fixed Asset but no GL account has been selected.\n\n' +
        'Open the expense, select the Fixed Asset Account, save it, then approve.'
      );
      return;
    }

    setApprovalLoading(id);
    try {
      await approveFinanceExpense(id, profile?.id);

      // Auto-reconcile linked bank statement line if present and not yet allocated
      try {
        const { data: linkedLines } = await supabase
          .from('bank_statement_lines')
          .select('id, debit_amount, credit_amount')
          .eq('matched_expense_id', id);

        if (linkedLines && linkedLines.length > 0) {
          for (const line of linkedLines) {
            const { data: existingAlloc } = await supabase
              .from('bank_statement_allocations')
              .select('id')
              .eq('bank_statement_line_id', line.id)
              .eq('document_id', id);

            if (!existingAlloc || existingAlloc.length === 0) {
              const lineAmt = Number(line.debit_amount || line.credit_amount || 0);
              const expObj = expenses.find(e => e.id === id);
              const allocAmt = expObj ? Math.min(lineAmt, calculateCanonicalCashPayable(expObj)) : lineAmt;
              await linkBankStatementLine(line.id, 'expense', id, 'supplier', allocAmt > 0.01 ? allocAmt : undefined);
            }
          }
        }
      } catch (autoLinkErr) {
        console.error('Error auto-linking bank line on expense approval:', autoLinkErr);
      }

      await syncExpenseBankLinks([id]);
      notifyFinanceReconciliationRefresh();
      const lifecycle = await getConsistentExpensePostingState(id);
      setExpenses(prev => prev.map(e => e.id === id ? {
        ...e,
        approval_status: 'approved',
        approved_by: profile?.id ?? null,
        approved_at: new Date().toISOString(),
        posting_lifecycle: lifecycle,
        effective_posting_state: lifecycle?.effective_posting_state || 'AMBIGUOUS',
      } : e));
    } catch (err: any) {
      alert('Failed to approve: ' + err.message);
    } finally {
      setApprovalLoading(null);
    }
  };

  const handleRejectExpenseConfirm = async () => {
    if (!rejectionTarget || !rejectionReason.trim()) return;
    setApprovalLoading(rejectionTarget.id);
    try {
      const { error } = await supabase
        .from('finance_expenses')
        .update({ approval_status: 'rejected', approved_by: profile?.id, approved_at: new Date().toISOString(), rejection_reason: rejectionReason })
        .eq('id', rejectionTarget.id);
      if (error) throw error;

      // Update bank statement line notes with rejection reason to preserve audit history
      const { data: matchedLines } = await supabase
        .from('bank_statement_lines')
        .select('id, notes')
        .eq('matched_expense_id', rejectionTarget.id);

      if (matchedLines && matchedLines.length > 0) {
        const targetExp = expenses.find(e => e.id === rejectionTarget.id);
        const voucherNumber = targetExp?.voucher_number || rejectionTarget.id;
        for (const line of matchedLines) {
          const rejectionNote = `[Expense ${voucherNumber} rejected: ${rejectionReason}]`;
          const updatedNotes = line.notes ? `${line.notes} ${rejectionNote}` : rejectionNote;
          await supabase
            .from('bank_statement_lines')
            .update({ notes: updatedNotes })
            .eq('id', line.id);
        }
        notifyFinanceReconciliationRefresh();
      }

      const lifecycle = await getEffectiveExpensePostingState(rejectionTarget.id);
      setExpenses(prev => prev.map(e => e.id === rejectionTarget.id ? {
        ...e,
        approval_status: 'rejected',
        rejection_reason: rejectionReason,
        posting_lifecycle: lifecycle,
        effective_posting_state: lifecycle?.effective_posting_state || 'AMBIGUOUS',
      } : e));
      setRejectionModalOpen(false);
      setRejectionTarget(null);
      setRejectionReason('');
    } catch (err: any) {
      alert('Failed to reject: ' + err.message);
    } finally {
      setApprovalLoading(null);
    }
  };

  const closeCancelPostingModal = () => {
    setCancelPostingModalOpen(false);
    setCancelPostingTarget(null);
    setCancelPostingReason('');
    setCancelPostingBlock(null);
  };

  const handleCancelPostingRequest = async (expense: FinanceExpense) => {
    setCancelPostingLoading(true);
    setCancelPostingTarget(expense);
    setCancelPostingReason('');
    try {
      const { block } = await preflightExpenseCancellation(expense.id);
      setCancelPostingBlock(block);
      setCancelPostingModalOpen(true);
    } catch (err) {
      setCancelPostingBlock({
        kind: 'verification_failed',
        message: `Cancellation safety checks could not be completed: ${supabaseErrorMessage(err)}. No cancellation request was sent.`,
      });
      setCancelPostingModalOpen(true);
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const handleCancelPostingConfirm = async () => {
    if (!cancelPostingTarget || !cancelPostingReason.trim()) return;
    setCancelPostingLoading(true);
    try {
      // Repeat the read-only guard immediately before the RPC so a payment or
      // reconciliation added while the dialog was open cannot race cancellation.
      const { block } = await preflightExpenseCancellation(cancelPostingTarget.id);
      if (block) {
        setCancelPostingBlock(block);
        return;
      }
      const { error } = await supabase.rpc('cancel_expense_posting', {
        p_exp_id:       cancelPostingTarget.id,
        p_cancelled_by: profile?.id,
        p_reason:       cancelPostingReason,
      });
      if (error) throw error;
      closeCancelPostingModal();
      loadData();
    } catch (err) {
      const msg = supabaseErrorMessage(err);
      const lower = msg.toLowerCase();
      if (lower.includes('paid') || lower.includes('settled') || lower.includes('allocation')) {
        setCancelPostingBlock({ kind: 'settled', message: SETTLED_EXPENSE_CANCELLATION_MESSAGE });
      } else if (lower.includes('closed')) {
        setCancelPostingBlock({ kind: 'closed_period', message: `Period closed: ${msg}` });
      } else if (lower.includes('already reversed') || lower.includes('not approved')) {
        setCancelPostingBlock({ kind: 'already_reversed', message: 'This expense posting has already been reversed or cancelled.' });
      } else if (lower.includes('no active journal')) {
        setCancelPostingBlock({ kind: 'no_active_journal', message: 'No active journal exists for this expense. Cancellation cannot continue.' });
      } else {
        alert(`Failed to cancel posting: ${msg}`);
      }
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const handleCancelPostingBankUnlink = async () => {
    if (!cancelPostingTarget || !cancelPostingBlock?.bankStatementLineId) return;
    if (!confirm(
      'Open the safe unlink workflow for this bank reconciliation?\n\n' +
      'This removes the reconciliation relationship but does not delete the bank statement, expense, or journal.'
    )) return;
    setCancelPostingLoading(true);
    try {
      await unlinkBankTransaction(cancelPostingBlock.bankStatementLineId);
      await supabase.rpc('recalculate_expense_payment_state', { p_expense_id: cancelPostingTarget.id });
      notifyFinanceReconciliationRefresh();
      const { block } = await preflightExpenseCancellation(cancelPostingTarget.id);
      setCancelPostingBlock(block);
      await loadData();
    } catch (err) {
      alert(`Failed to unlink bank reconciliation: ${supabaseErrorMessage(err)}`);
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const handleUnlinkFromBankStatement = async (expenseId: string) => {
    if (!confirm(
      'Are you sure you want to unlink this expense from the bank statement?\n\n' +
      'The bank statement line will be set back to "Unmatched" status.'
    )) return;

    try {
      await unlinkFinanceExpenseBankLink(expenseId);

      const updatedLines = await fetchExpenseBankLinks(expenseId);

      // Fetch the updated expense with relations
      const { data: updatedExpense, error: fetchError } = await supabase
        .from('finance_expenses')
        .select(`
          *,
          batches (batch_number),
          import_containers (container_ref),
          delivery_challans (challan_number),
          bank_accounts (bank_name, account_number)
        `)
        .eq('id', expenseId)
        .single();

      if (fetchError) throw fetchError;

      const merged = { ...updatedExpense, bank_statement_lines: updatedLines };

      // Update in local state
      setExpenses(prev => prev.map(exp =>
        exp.id === expenseId ? merged : exp
      ));
      if (viewingExpense?.id === expenseId) {
        setViewingExpense(merged);
      }
      notifyFinanceReconciliationRefresh();

      alert('Expense unlinked from bank statement successfully');
      setModalOpen(false);
      setEditingExpense(null);
      resetForm();
    } catch (error: any) {
      console.error('Error unlinking expense:', error.message);
      alert('Failed to unlink expense: ' + error.message);
    }
  };

  const resetForm = () => {
    isSubmittingRef.current = false;
    setIsSubmitting(false);
    inFlightExpenseIdRef.current = null;
    setEditingExpense(null);
    salaryInitialLoadRef.current = null;
    setSelectedBankTransactionId('');
    setSelectedBankAllocationAmount(undefined);
    setUploadingFiles([]);
    setSelectedSupplier(null);
    setSelectedDocType('');
    setBrokerItems([]);
    setSoAllocations([]);
    setSelectedStaffId('');
    setSalaryAdvances([]);
    setSalaryCalculation(null);
    setSelectedSalaryAdvanceIds([]);
    setSelectedUtilityId('');
    setPeriodLabel('');
    setFormData({
      expense_category: 'other',
      amount: 0,
      transaction_currency: 'IDR',
      exchange_rate: 1,
      expense_date: new Date().toISOString().split('T')[0],
      description: '',
      batch_id: '',
      import_container_id: '',
      delivery_challan_id: '',
      payment_method: null,
      bank_account_id: '',
      payment_reference: '',
      document_urls: [],
      supplier_id: '',
      invoice_number: '',
      due_date: getDueDateFromTerms(new Date().toISOString().split('T')[0], 30),
      pib_bm_amount: 0,
      pib_ppn_amount: 0,
      pib_pph_amount: 0,
      ppn_amount: 0,
      ppn_manual_override: false,
      ppn_calc_mode: 'standard',
      dpp_amount: 0,
      ppn_rate: 11,
      pph_amount: 0,
      pph_treatment: 'deduct',
      pph_code_id: '',
      stamp_duty_amount: 0,
      fixed_asset_account_id: '',
      bank_charges_amount: 0,
      payee_id: '',
      linked_sales_invoice_id: '',
      pph_calculation_regime: '',
      pph_dpp_ratio: 1.0,
      pph_dpp_amount: 0,
      pph_rate: 0,
      is_tax_manual_override: false,
      bpjs_employee_deduction: 0,
      bpjs_register_item_id: null,
      payroll_period_month: null,
      payroll_period_year: null,
    });
    setProviderType('corporate');
    setWorkingDays(1);
  };

  // Handle supplier selection — auto-fills category, due_date, tax fields
  const handleSupplierSelect = (supplierId: string) => {
    setFieldErrors(prev => ({ ...prev, party: '' }));
    const sup = suppliers.find(s => s.id === supplierId) ?? null;
    setSelectedSupplier(sup);
    setFormData(prev => {
      const updates: Partial<typeof prev> = { supplier_id: supplierId };
      if (sup) {
        // Auto-fill category if supplier has a default
        if (sup.default_expense_category) {
          updates.expense_category = sup.default_expense_category;
          // Also update docType
          const docType = (Object.entries(DOCUMENT_TYPE_GROUPS) as [DocumentType, string[]][])
            .find(([, cats]) => cats.includes(sup.default_expense_category!))?.[0];
          if (docType) setSelectedDocType(docType);
        }
        // Auto-fill PPh code
        if (sup.default_pph_code_id && (sup.tax_preference === 'pph_only' || sup.tax_preference === 'ppn_pph')) {
          updates.pph_code_id = sup.default_pph_code_id;
        }
        // Auto-fill PPN only for PKP suppliers AND when we're in STANDARD calc mode.
        // DPP Nilai Lain and MANUAL modes keep whatever the user has entered.
        const mode = prev.ppn_calc_mode || 'standard';
        if (mode === 'standard' && sup.pkp_status && (sup.tax_preference === 'ppn_only' || sup.tax_preference === 'ppn_pph') && !prev.ppn_manual_override) {
          updates.ppn_amount = calculatePPN(prev.amount, true);
        }
        // Auto-fill due_date from payment terms (default 30 days)
        if (prev.expense_date) {
          updates.due_date = getDueDateFromTerms(prev.expense_date, sup.payment_terms_days ?? 30);
        }
      }
      return { ...prev, ...updates };
    });
  };

  // Handle payee selection — recommends default tax code and recalculates PPh
  const handlePayeeSelect = (payeeId: string) => {
    setFieldErrors(prev => ({ ...prev, party: '' }));
    const payee = payeeRoster.find(p => p.id === payeeId) ?? null;
    let defaultCodeId = payee?.default_pph_code_id || '';
    if (!defaultCodeId) {
      if (payee?.tax_classification === 'pegawai_tidak_tetap') {
        defaultCodeId = taxCodes.find(tc => tc.code === 'PPH21-TT')?.id || '';
      } else if (payee?.tax_classification === 'pemilik_sewa_op') {
        defaultCodeId = taxCodes.find(tc => tc.code === 'PPH4(2)')?.id || '';
      } else {
        defaultCodeId = taxCodes.find(tc => tc.code === 'PPH21-NE')?.id || '';
      }
    }
    const tc = taxCodes.find(t => t.id === defaultCodeId) || null;
    const calc = computeExpensePPh({
      grossAmount: formData.amount,
      taxCode: tc,
      payeeClassification: payee?.tax_classification,
      workingDays,
    });
    setFormData(prev => ({
      ...prev,
      payee_id: payeeId,
      supplier_id: '',
      pph_code_id: tc ? tc.id : prev.pph_code_id,
      pph_amount: calc.pphAmount,
      pph_dpp_ratio: calc.dppRatio,
      pph_dpp_amount: calc.dppAmount,
      pph_rate: calc.pphRate,
      pph_calculation_regime: calc.regime,
      is_tax_manual_override: false,
    }));
    setSelectedSupplier(null);
  };

  // Handle sales invoice selection — links invoice and auto-resolves Delivery Challan
  const handleSalesInvoiceSelect = (invoiceId: string) => {
    const inv = salesInvoices.find(si => si.id === invoiceId) ?? null;
    let resolvedDcId = '';
    if (inv) {
      if (inv.linked_challan_ids && inv.linked_challan_ids.length > 0) {
        resolvedDcId = inv.linked_challan_ids[0];
      } else if (inv.delivery_challan_number) {
        const matchingDc = challans.find(c => c.challan_number === inv.delivery_challan_number);
        if (matchingDc) resolvedDcId = matchingDc.id;
      }
    }
    setFormData(prev => ({
      ...prev,
      linked_sales_invoice_id: invoiceId,
      delivery_challan_id: resolvedDcId || prev.delivery_challan_id,
    }));
  };

  // Handle authoritative tax code change — dynamically recalculates with selected regime
  const handleTaxCodeChange = (codeId: string) => {
    const tc = taxCodes.find(t => t.id === codeId) || null;
    const currentPayee = payeeRoster.find(p => p.id === formData.payee_id) || null;
    const calc = computeExpensePPh({
      grossAmount: formData.amount,
      taxCode: tc,
      payeeClassification: currentPayee?.tax_classification,
      workingDays,
    });
    setFormData(prev => ({
      ...prev,
      pph_code_id: codeId,
      pph_amount: calc.pphAmount,
      pph_dpp_ratio: calc.dppRatio,
      pph_dpp_amount: calc.dppAmount,
      pph_rate: calc.pphRate,
      pph_calculation_regime: calc.regime,
      is_tax_manual_override: false,
    }));
  };

  // Quick Add Supplier handler
  const handleQuickAddSupplier = async () => {
    if (!quickAddSupplierName.trim()) return;
    setQuickAddSupplierLoading(true);
    try {
      const typeConfig = SUPPLIER_TYPES.find(t => t.value === quickAddSupplierType);
      const { data: newSupplier, error } = await supabase
        .from('suppliers')
        .insert([{
          company_name: quickAddSupplierName.trim(),
          supplier_type: quickAddSupplierType || null,
          pkp_status: quickAddSupplierPKP,
          payment_terms_days: quickAddSupplierTerms,
          tax_preference: typeConfig?.taxPreference ?? 'none',
          default_expense_category: typeConfig?.defaultCategory ?? null,
          country: 'Indonesia',
          is_active: true,
        }])
        .select('id, company_name, pkp_status, payment_terms_days, default_expense_category, default_pph_code_id, tax_preference, supplier_type')
        .single();
      if (error) throw error;
      const sup = newSupplier as Supplier;
      setSuppliers(prev => [...prev, sup].sort((a, b) => a.company_name.localeCompare(b.company_name)));
      setShowQuickAddSupplier(false);
      setQuickAddSupplierName('');
      setQuickAddSupplierType('General');
      setQuickAddSupplierPKP(false);
      setQuickAddSupplierTerms(30);
      // Auto-select the new supplier
      handleSupplierSelect(sup.id);
    } catch (err: any) {
      alert('Failed to add supplier: ' + err.message);
    } finally {
      setQuickAddSupplierLoading(false);
    }
  };

  // Finance Health Check
  const loadHealthCheck = async () => {
    setHealthLoading(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      const [r1, r2, r3, r4, r5, r6, r7] = await Promise.all([
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).neq('approval_status', 'cancelled').is('payment_method', null).is('supplier_id', null).is('staff_id', null).is('payee_id', null),
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).neq('approval_status', 'cancelled').is('payment_method', null).is('due_date', null),
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).or('document_urls.is.null,document_urls.eq.{}').gte('created_at', new Date(Date.now() - 90 * 86400000).toISOString()),
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).eq('expense_category', 'fixed_asset').is('fixed_asset_account_id', null),
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).eq('expense_category', 'import_broker').is('import_container_id', null),
        supabase.from('suppliers').select('id', { count: 'exact', head: true }).is('default_expense_category', null).eq('is_active', true),
        supabase.rpc('get_outstanding_expense_bills', { p_as_of_date: today }),
      ]);
      const issues: HealthIssue[] = [
        { key: 'outstanding_no_supplier', label: 'Outstanding bills without supplier', count: r1.count ?? 0, severity: 'warning' },
        { key: 'outstanding_no_due', label: 'Outstanding bills missing due date', count: r2.count ?? 0, severity: 'error' },
        { key: 'no_attachment', label: 'Expenses without attachment (last 90d)', count: r3.count ?? 0, severity: 'info' },
        { key: 'fa_no_account', label: 'Fixed assets without asset account', count: r4.count ?? 0, severity: 'error' },
        { key: 'broker_no_container', label: 'Broker invoices not linked to container', count: r5.count ?? 0, severity: 'warning' },
        { key: 'supplier_no_defaults', label: 'Active suppliers without expense defaults', count: r6.count ?? 0, severity: 'info' },
        { key: 'all_outstanding', label: 'Total outstanding expense bills', count: (r7.data ?? []).length, severity: 'info' },
      ].filter(i => i.count > 0) as HealthIssue[];
      setHealthIssues(issues);
    } catch (err) {
      console.error('Health check failed:', err);
    } finally {
      setHealthLoading(false);
    }
  };

  const selectedCategory = expenseCategories.find(c => c.value === formData.expense_category);
  const requiresContainer = selectedCategory?.type === 'import';
  const requiresDC = selectedCategory?.type === 'sales';
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();

  const baseExpenses = useMemo(() => expenses.filter((exp) => {
    const isCancelled = exp.approval_status === 'cancelled';
    if (lifecycleFilter === 'cancelled' ? !isCancelled : isCancelled) return false;

    // Filter by type
    if (filterType !== 'all') {
      const cat = expenseCategories.find(c => c.value === exp.expense_category);
      if (cat?.type !== filterType) return false;
    }

    // Filter by specific category
    if (categoryFilter !== 'all' && exp.expense_category !== categoryFilter) {
      return false;
    }

    // Filter by supplier
    if (supplierFilter !== 'all') {
      if (supplierFilter === 'no_supplier') {
        if (exp.supplier_id) return false;
      } else {
        if (exp.supplier_id !== supplierFilter) return false;
      }
    }

    // Filter by approval status
    if (approvalFilter === 'approved') {
      if (exp.approval_status !== 'approved') return false;
    } else if (approvalFilter === 'pending_approval') {
      if (exp.approval_status !== 'pending_approval' || exp.effective_posting_state === 'REVERSED') return false;
    }

    if (normalizedSearch) {
      const category = expenseCategories.find(c => c.value === exp.expense_category);
      const searchableValues = [
        exp.voucher_number,
        exp.description,
        exp.suppliers?.company_name,
        exp.payees?.full_name,
        exp.invoice_number,
        exp.payment_reference,
        exp.expense_category,
        category?.label,
        category?.group,
      ];
      if (!searchableValues.some(value => String(value ?? '').toLocaleLowerCase().includes(normalizedSearch))) {
        return false;
      }
    }

    return true;
  }), [
    expenses,
    lifecycleFilter,
    filterType,
    expenseCategories,
    categoryFilter,
    supplierFilter,
    approvalFilter,
    normalizedSearch,
  ]);

  const filteredExpenses = useMemo(() => {
    if (reconFilter === 'all') return baseExpenses;
    return baseExpenses.filter(exp => {
      const status = getSimplifiedExpenseStatus(exp);
      if (reconFilter === 'reconciled') return status.payment === 'Paid';
      if (reconFilter === 'partial') return status.payment === 'Partially Paid';
      if (reconFilter === 'outstanding') return status.payment === 'Unpaid';
      return true;
    });
  }, [baseExpenses, reconFilter]);

  // Sorting function
  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // Accountant-priority sort: Pending Approval → Approved+Outstanding → Partial → Paid+Pending Recon → Paid+Reconciled → Petty Cash → Cancelled
  // Only applies when no explicit user sort is active.
  const accountantPriorityRank = useCallback((exp: FinanceExpense): number => {
    const recon = calculateExpenseReconciliation(exp);
    const isReconciled = recon.isFullyReconciled;
    if (exp.approval_status === 'pending_approval') return 0;
    if (exp.approval_status === 'rejected') return 1;
    if (exp.approval_status === 'cancelled') return 6;
    if (exp.payment_method === 'cash') return 5;
    const isPaid = (exp.paid_amount ?? 0) >= (calculateCanonicalCashPayable(exp) - 0.01);
    const isPartiallyPaid = (exp.paid_amount ?? 0) > 0.01 && !isPaid;
    if (isReconciled) return 4; // Paid & Reconciled
    if (recon.isPartiallyReconciled || isPartiallyPaid) return 2.5; // Partially Paid / Reconciled
    if (!isPaid) return 2; // Approved but Outstanding
    return 3; // Paid but Pending Bank Reconciliation
  }, []);

  const sortedExpenses = useMemo(() => [...filteredExpenses].sort((a, b) => {
    if (!sortConfig) {
      const rankA = accountantPriorityRank(a);
      const rankB = accountantPriorityRank(b);
      if (rankA !== rankB) return rankA - rankB;
      // Secondary: newest first within the same rank
      return new Date(b.expense_date).getTime() - new Date(a.expense_date).getTime();
    }

    const { key, direction } = sortConfig;
    let aValue: any;
    let bValue: any;

    if (key === 'date') {
      aValue = new Date(a.expense_date).getTime();
      bValue = new Date(b.expense_date).getTime();
    } else if (key === 'category') {
      const aCat = expenseCategories.find(c => c.value === a.expense_category);
      const bCat = expenseCategories.find(c => c.value === b.expense_category);
      aValue = aCat?.label?.toLowerCase() || '';
      bValue = bCat?.label?.toLowerCase() || '';
    } else if (key === 'amount') {
      aValue = calculateCanonicalExpenseTotal(a);
      bValue = calculateCanonicalExpenseTotal(b);
    } else if (key === 'description') {
      aValue = (a.description || '').toLowerCase();
      bValue = (b.description || '').toLowerCase();
    } else if (key === 'payment_method') {
      // Sort by payment method (bank expenses only - cash expenses are in Petty Cash)
      aValue = (a.payment_method || 'unknown').toLowerCase();
      bValue = (b.payment_method || 'unknown').toLowerCase();
    } else if (key === 'reconciliation') {
      // Sort by reconciliation status
      const aReconciled = calculateExpenseReconciliation(a).isFullyReconciled;
      const bReconciled = calculateExpenseReconciliation(b).isFullyReconciled;
      aValue = aReconciled ? 1 : 0;
      bValue = bReconciled ? 1 : 0;
    } else if (key === 'payment_status') {
      // Sort by payment status: Outstanding(0) < Partial(1) < Paid(2)
      const payRank = (e: FinanceExpense) => {
        const bal = calculateCanonicalCashPayable(e) - (e.paid_amount ?? 0);
        if (bal <= 0.01) return 2;
        if ((e.paid_amount ?? 0) > 0.01) return 1;
        return 0;
      };
      aValue = payRank(a);
      bValue = payRank(b);
    } else {
      aValue = a[key as keyof FinanceExpense];
      bValue = b[key as keyof FinanceExpense];
      if (typeof aValue === 'string') aValue = aValue.toLowerCase();
      if (typeof bValue === 'string') bValue = bValue.toLowerCase();
    }

    if (aValue < bValue) return direction === 'asc' ? -1 : 1;
    if (aValue > bValue) return direction === 'asc' ? 1 : -1;
    return 0;
  }), [filteredExpenses, sortConfig, expenseCategories, accountantPriorityRank]);

  const exportToCSV = async () => {
    if (filteredExpenses.length === 0) {
      alert('No expenses to export');
      return;
    }

    let exportAccountRows: ExpenseExportAccount[] = [];
    try {
      const { data, error } = await supabase.rpc('get_expense_export_accounts', {
        p_expense_ids: filteredExpenses.map(expense => expense.id),
      });
      if (error) throw error;
      exportAccountRows = (data || []) as ExpenseExportAccount[];
    } catch (error) {
      console.error('Error resolving Expense export accounts:', error);
      alert('Unable to resolve Chart of Account details. Please try again after the accounting export setup is available.');
      return;
    }

    const exportAccounts = Object.fromEntries(
      exportAccountRows.map(account => [account.expense_id, account]),
    );

    const documentNumbers = Object.fromEntries(filteredExpenses.map((expense) => [expense.id, expense.voucher_number || expense.invoice_number || expense.id]));
    const bankAccounts = Object.fromEntries(filteredExpenses.map((expense) => [
      expense.id,
      expense.bank_accounts
        ? (expense.bank_accounts.alias || expense.bank_accounts.bank_name)
        : (expense.bank_statement_lines?.[0]?.bank_accounts?.alias || expense.bank_statement_lines?.[0]?.bank_accounts?.bank_name || ''),
    ]));
    let postedJournals;
    try {
      postedJournals = await getPostedJournalsForExport(
        filteredExpenses.map((expense) => expense.id), ['expense', 'expenses'], documentNumbers, 'Expenses', bankAccounts,
      );
    } catch (error) {
      console.error('Error resolving Expense journal lines:', error);
      alert('Unable to resolve posted journal lines for this export.');
      return;
    }

    const rows: ReconciliationSummaryRow[] = filteredExpenses.map(exp => {
      const simplified = getSimplifiedExpenseStatus(exp);
      const category = expenseCategories.find(c => c.value === exp.expense_category);
      const linkedTo =
        exp.import_containers?.container_ref ||
        exp.delivery_challans?.challan_number ||
        '';
      const bankInfo = exp.bank_accounts
        ? (exp.bank_accounts.alias || exp.bank_accounts.bank_name)
        : (exp.bank_statement_lines?.[0]?.bank_accounts?.alias ||
           exp.bank_statement_lines?.[0]?.bank_accounts?.bank_name ||
           '');
      const account = exportAccounts[exp.id];
      const journal = postedJournals.get(exp.id);
      const totals = calculateExpenseTotals(exp);
      const pphCode = taxCodes.find((code) => code.id === exp.pph_code_id)?.code || '';
      const pphColumn = pphCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const partyName = exp.staff_id
        ? staffRoster.find(s => s.id === exp.staff_id)?.full_name || ''
        : exp.suppliers?.company_name || '';
      const actualBankAmount = exp.bank_statement_lines?.reduce((sum, line) => sum + Math.abs(Number(line.debit_amount || 0) - Number(line.credit_amount || 0)), 0) || 0;
      return {
        'Source Module': 'Expenses',
        'Document Type': exp.expense_type || 'Expense',
        'Document Number': documentNumbers[exp.id],
        'Document Date': exp.expense_date,
        'Posting Date': journal?.date || '',
        'Journal Number': journal?.number || '',
        'Journal Status': exp.effective_posting_state === 'REVERSED'
          ? 'Reversed'
          : exp.effective_posting_state === 'REPLACED'
            ? (journal?.status || 'Posted')
            : journal?.status || (simplified.approval === 'Approved' ? 'Posted' : 'Not posted'),
        'Approval Status': simplified.approval,
        'Payment Status': simplified.payment,
        'Bank Link Status': simplified.isCash
          ? (exp.payment_method === 'petty_cash' ? 'Petty Cash' : 'Cash')
          : simplified.bankLink,
        'Reconciliation Status': simplified.isCash ? 'Cash' : (simplified.bankLink === 'Linked' ? 'Linked' : 'Unlinked'),
        'Party Type': exp.staff_id ? 'Employee' : exp.suppliers ? 'Supplier' : '',
        'Party Name': partyName,
        'Category Parent': category?.group || '',
        'Leaf Category': category?.label || exp.expense_category,
        Currency: getExpenseCurrency(exp),
        'Exchange Rate': Number(exp.exchange_rate || 1),
        'Gross Amount': calculateCanonicalExpenseTotal(exp),
        Discount: '',
        'DPP / Tax Base': Number(exp.dpp_amount ?? exp.amount ?? 0),
        PPN: Number(exp.ppn_amount || 0),
        PPh21: pphColumn.includes('PPH21') ? Number(exp.pph_amount || 0) : '',
        PPh22: pphColumn.includes('PPH22') ? Number(exp.pph_amount || 0) : '',
        PPh23: pphColumn.includes('PPH23') ? Number(exp.pph_amount || 0) : '',
        'PPh4(2)': pphColumn.includes('PPH42') ? Number(exp.pph_amount || 0) : '',
        'Other Taxes': pphCode && !/PPH(21|22|23|42)/.test(pphColumn) ? Number(exp.pph_amount || 0) : Number(exp.stamp_duty_amount || 0) || '',
        'Bank Charges': totals.bankChargesAmount || '',
        'Salary Advance': '',
        'Other Deductions': '',
        'Net Settlement Amount': totals.settlementAmount,
        'Actual Bank Amount': actualBankAmount || '',
        'Settlement Difference': actualBankAmount ? actualBankAmount - totals.settlementAmount : '',
        'Primary COA Code': account?.coa_code || category?.coaCode || '',
        'Primary COA Name': account?.coa_name || category?.coaName || '',
        'Bank Account': bankInfo,
        'Bank Statement Reference': exp.bank_statement_lines?.[0]?.description || '',
        'Tax Period': '',
        'Tax Reference / NTPN (where applicable)': exp.invoice_number || '',
        Remarks: [linkedTo, exp.description || ''].filter(Boolean).join(' — '),
      };
    });
    writeReconciliationWorkbook(rows, [...postedJournals.values()].flatMap((journal) => journal.lines), `expenses_reconciliation_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`);
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'import': return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'sales': return 'bg-green-100 text-green-800 border-green-300';
      case 'staff': return 'bg-purple-100 text-purple-800 border-purple-300';
      case 'operations': return 'bg-orange-100 text-orange-800 border-orange-300';
      case 'admin': return 'bg-gray-100 text-gray-800 border-gray-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const formatExpenseTotals = useCallback((expensesToTotal: FinanceExpense[]) => {
    const totals = expensesToTotal.reduce<Record<string, number>>((result, expense) => {
      const currency = getExpenseCurrency(expense);
      result[currency] = (result[currency] || 0) + calculateCanonicalExpenseTotal(expense);
      return result;
    }, {});
    return Object.entries(totals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => formatCurrency(amount, currency, {
        minimumFractionDigits: currency === 'IDR' ? 0 : 2,
        maximumFractionDigits: currency === 'IDR' ? 0 : 2,
      }))
      .join(' · ');
  }, []);

  const expenseSummaryKpis = useMemo(() => {
    const totalFormatted = formatExpenseTotals(baseExpenses) || formatCurrency(0);

    let approvedCount = 0;
    let pendingApprovalCount = 0;
    let paidCount = 0;
    let partialCount = 0;
    let unpaidCount = 0;
    let linkedCount = 0;
    let unlinkedBankCount = 0;

    for (let i = 0; i < baseExpenses.length; i++) {
      const e = baseExpenses[i];
      const status = getSimplifiedExpenseStatus(e);
      if (status.approval === 'Approved') approvedCount++;
      else pendingApprovalCount++;

      if (status.payment === 'Paid') paidCount++;
      else if (status.payment === 'Partially Paid') partialCount++;
      else unpaidCount++;

      if (!status.isCash) {
        if (status.bankLink === 'Linked') linkedCount++;
        else unlinkedBankCount++;
      }
    }

    const applicableTotal = baseExpenses.length;
    const reconciledCount = paidCount;

    return {
      totalFormatted,
      applicableTotal,
      approvedCount,
      pendingApprovalCount,
      paidCount,
      partialCount,
      unpaidCount,
      linkedCount,
      unlinkedBankCount,
      reconciledRatio: `${reconciledCount} / ${applicableTotal}`,
      reconciledCount,
      outstandingCount: unpaidCount,
    };
  }, [baseExpenses, formatExpenseTotals]);

  const staffOptions = useMemo(() => [
    { value: '', label: '— None —' },
    ...staffRoster.map(s => ({ value: s.id, label: `${s.full_name}${s.department ? ' · ' + s.department : ''}` }))
  ], [staffRoster]);

  const utilityOptions = useMemo(() => [
    { value: '', label: '— None —' },
    ...utilityRoster.map(u => ({ value: u.id, label: `${u.provider_name} · ${u.utility_type}` }))
  ], [utilityRoster]);

  const payeeOptions = useMemo(() => [
    { value: '', label: '— Select Payee —' },
    ...payeeRoster.map((p) => ({
      value: p.id,
      label: `${p.full_name}${p.business_role ? ` (${p.business_role.replace(/_/g, ' ')})` : ''}${p.nik || p.npwp ? ` · ${p.npwp || p.nik}` : ' · No NIK/NPWP'}`,
    }))
  ], [payeeRoster]);

  const supplierOptions = useMemo(() => [
    { value: '', label: '— None —' },
    ...suppliers.map((s) => ({ value: s.id, label: `${s.company_name}${s.pkp_status ? ' ✓PKP' : ''}` }))
  ], [suppliers]);

  const salesInvoiceOptions = useMemo(() => [
    { value: '', label: '— None —' },
    ...salesInvoices.map(si => ({
      value: si.id,
      label: `${si.invoice_number} · ${si.customers?.company_name || 'Customer'} · ${formatIDR(si.total_amount)}`,
    }))
  ], [salesInvoices]);

  const taxCodeOptions = useMemo(() => [
    { value: '', label: 'None' },
    ...taxCodes.map(tc => ({
      value: tc.id,
      label: tc.code === 'PPH21-NE' ? 'PPH21-NE — Bukan Pegawai (DPP 50% / Ps 17)'
        : tc.code === 'PPH21-TT' ? 'PPH21-TT — Pegawai Tidak Tetap (TER Harian)'
        : tc.code === 'PPH4(2)' ? 'PPH4(2) — Final 10%'
        : `${tc.code} — ${tc.rate}%`,
    }))
  ], [taxCodes]);

  const containerOptions = useMemo(() => [
    { value: '', label: 'Select import container' },
    ...containers.map(c => ({ value: c.id, label: c.container_ref }))
  ], [containers]);

  const challanOptions = useMemo(() => [
    { value: '', label: 'None' },
    ...challans.map(ch => ({
      value: ch.id,
      label: `${ch.challan_number} — ${new Date(ch.challan_date).toLocaleDateString('en-GB')} — ${ch.customers?.company_name || ''}`,
    }))
  ], [challans]);

  const coaAssetOptions = useMemo(() => [
    { value: '', label: 'Select account' },
    ...coaAssets.map(a => ({ value: a.id, label: `${a.code} — ${a.name}` }))
  ], [coaAssets]);

  const expenseFormCurrency = normalizeCurrency(
    bankAccounts.find((bank) => bank.id === formData.bank_account_id)?.currency ?? formData.transaction_currency,
  );

  const formatDate = (dateString: string) => {
    if (!dateString) return '—';
    const [year, month, day] = dateString.slice(0, 10).split('-');
    return `${day}/${month}/${year?.slice(-2)}`;
  };

  // Canonical allocations supersede the legacy matched_* projection for
  // display and payment totals. Keep each statement line exactly once.
  const editingBankLines = normalizeExpenseBankLinks(editingExpense?.bank_statement_lines || []);

  return (
    <div className={embeddedModalOnly ? undefined : "flex flex-col gap-2"}>
      {!embeddedModalOnly && (
        <>
          {/* Row 1: Title, KPI summary badges, Health, Export & New actions */}
          <div className="flex items-center justify-between gap-2.5 px-3 py-1.5 bg-white border border-gray-200 rounded-lg min-h-[38px] flex-wrap shadow-2xs">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-sm font-semibold text-gray-900 whitespace-nowrap">Expenses</h1>
              <div className="flex items-center gap-1.5 flex-wrap text-xs">
                <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-[11px] font-medium leading-none">
                  <span className="text-gray-500 font-normal">Total:</span>
                  <span className="font-mono font-semibold">
                    {expenseSummaryKpis.totalFormatted}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 bg-teal-50 text-teal-800 border border-teal-200/60 px-2 py-0.5 rounded text-[11px] font-medium leading-none">
                  <span className="text-teal-600 font-normal">Reconciled:</span>
                  <span className="font-mono font-semibold">
                    {expenseSummaryKpis.reconciledRatio}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-800 border border-amber-200/60 px-2 py-0.5 rounded text-[11px] font-medium leading-none">
                  <span className="text-amber-600 font-normal">Partial:</span>
                  <span className="font-mono font-semibold">
                    {expenseSummaryKpis.partialCount}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 bg-rose-50 text-rose-800 border border-rose-200/60 px-2 py-0.5 rounded text-[11px] font-medium leading-none">
                  <span className="text-rose-600 font-normal">Outstanding:</span>
                  <span className="font-mono font-semibold">
                    {expenseSummaryKpis.outstandingCount}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 bg-blue-50 text-blue-800 border border-blue-200/60 px-2 py-0.5 rounded text-[11px] font-medium leading-none">
                  <span className="text-blue-600 font-normal">Linked:</span>
                  <span className="font-mono font-semibold">
                    {expenseSummaryKpis.linkedCount}
                  </span>
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0 ml-auto">
              <button
                type="button"
                onClick={() => {
                  setHealthCheckOpen(o => !o);
                  if (!healthCheckOpen && healthIssues.length === 0) loadHealthCheck();
                }}
                className={`relative inline-flex items-center gap-1.5 h-7 px-2.5 border rounded text-xs font-medium transition-colors shadow-2xs ${
                  healthCheckOpen
                    ? 'bg-amber-100 border-amber-300 text-amber-900'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
                title="Finance Health Check"
              >
                <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                <span>Health</span>
                {healthIssues.length > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {healthIssues.length}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={exportToCSV}
                disabled={filteredExpenses.length === 0}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 rounded text-xs font-medium transition-colors shadow-2xs disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5 text-gray-500" />
                <span>Export ({filteredExpenses.length})</span>
              </button>

              {canManage && (
                <button
                  type="button"
                  onClick={() => { resetForm(); setModalOpen(true); }}
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 transition-colors shadow-2xs whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Expense</span>
                </button>
              )}
            </div>
          </div>

          {/* Two-row toolbar: Row A (Type tabs, Recon pills, Approval pills) & Row B (Category, Supplier, Lifecycle, Search) */}
          <div className="bg-white border border-gray-200 rounded-lg p-2 space-y-1.5 shadow-2xs">
            {/* Toolbar Row 1: Primary filter groups */}
            <div className="flex items-center gap-2 flex-wrap text-xs">
              {/* Type tabs */}
              <div className="inline-flex items-center bg-gray-100/90 p-0.5 rounded border border-gray-200/60">
                {[
                  { value: 'all', label: 'All' },
                  { value: 'import', label: 'Import' },
                  { value: 'sales', label: 'Sales' },
                  { value: 'staff', label: 'Staff' },
                  { value: 'operations', label: 'Ops' },
                  { value: 'admin', label: 'Admin' },
                ].map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => setFilterType(tab.value as any)}
                    className={`h-6 px-2 rounded text-[11px] font-medium transition-colors ${
                      filterType === tab.value
                        ? 'bg-blue-600 text-white font-semibold shadow-2xs'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/50'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="h-4 w-px bg-gray-200 hidden sm:block" />

              {/* Recon filter group */}
              <div className="inline-flex items-center gap-1 bg-gray-50 border border-gray-200/80 px-1.5 py-0.5 rounded">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mr-0.5">Recon</span>
                {[
                  { value: 'all', label: 'All' },
                  { value: 'reconciled', label: 'Reconciled' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'outstanding', label: 'Outstanding' },
                ].map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setReconFilter(filter.value as any)}
                    className={`h-5 px-1.5 rounded text-[11px] font-medium transition-colors ${
                      reconFilter === filter.value
                        ? 'bg-emerald-600 text-white font-semibold shadow-2xs'
                        : 'text-gray-600 hover:bg-gray-200/60'
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>

              <div className="h-4 w-px bg-gray-200 hidden sm:block" />

              {/* Approval filter group */}
              <div className="inline-flex items-center gap-1 bg-gray-50 border border-gray-200/80 px-1.5 py-0.5 rounded">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mr-0.5">Approval</span>
                {[
                  { value: 'all', label: 'All' },
                  { value: 'pending_approval', label: 'Pending' },
                  { value: 'approved', label: 'Approved' },
                ].map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setApprovalFilter(filter.value as any)}
                    className={`h-5 px-1.5 rounded text-[11px] font-medium transition-colors ${
                      approvalFilter === filter.value
                        ? 'bg-amber-600 text-white font-semibold shadow-2xs'
                        : 'text-gray-600 hover:bg-gray-200/60'
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Toolbar Row 2: Category, Supplier, Lifecycle, and Search expanding to fill remaining width */}
            <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap text-xs pt-0.5 border-t border-gray-100">
              {/* Category dropdown */}
              <select
                name="category_filter"
                aria-label="Category Filter"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="h-7 px-2 border border-gray-300 rounded text-xs bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500 shrink-0"
              >
                <option value="all">All Categories</option>
                {groupExpenseCategories(expenseCategories).map(([parent, categories]) => (
                  <optgroup key={parent} label={parent}>
                    {categories.map((category) => (
                      <option key={category.value} value={category.value}>{category.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>

              {suppliers.length > 0 && (
                <select
                  name="supplier_filter"
                  aria-label="Supplier Filter"
                  value={supplierFilter}
                  onChange={(e) => setSupplierFilter(e.target.value)}
                  className="h-7 px-2 border border-gray-300 rounded text-xs bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[180px] shrink-0"
                >
                  <option value="all">All Suppliers</option>
                  <option value="no_supplier">— No Supplier —</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>{s.company_name}</option>
                  ))}
                </select>
              )}

              {/* Lifecycle toggle (Operational vs Cancelled) */}
              <div className="inline-flex items-center bg-gray-100/90 p-0.5 rounded border border-gray-200/60 shrink-0">
                {[
                  { value: 'operational', label: 'Operational' },
                  { value: 'cancelled', label: 'Cancelled' },
                ].map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setLifecycleFilter(filter.value as 'operational' | 'cancelled')}
                    className={`h-6 px-2 rounded text-[11px] font-medium transition-colors ${
                      lifecycleFilter === filter.value
                        ? 'bg-gray-800 text-white font-semibold shadow-2xs'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/50'
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>

              {/* Search — receives remaining width */}
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input
                  name="search_query"
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search expenses by voucher, utility, description..."
                  aria-label="Search expenses"
                  style={{ paddingLeft: '2rem' }}
                  className="h-7 w-full rounded border border-gray-300 bg-white pr-2.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

      {/* Desktop Table View (>= 768px) */}
      <div className="hidden md:block bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600">No.</th>
              <th
                onClick={() => handleSort('date')}
                className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Date
                  {sortConfig?.key === 'date' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('category')}
                className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Category
                  {sortConfig?.key === 'category' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600">Context</th>
              <th
                onClick={() => handleSort('description')}
                className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Description
                  {sortConfig?.key === 'description' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('amount')}
                className="px-2 py-1.5 text-right text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center justify-end gap-1">
                  Expense Total
                  {sortConfig?.key === 'amount' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600">Type</th>
              <th
                onClick={() => handleSort('payment_status')}
                className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center justify-center gap-1">
                  Payment
                  {sortConfig?.key === 'payment_status' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('reconciliation')}
                className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center justify-center gap-1">
                  Recon
                  {sortConfig?.key === 'reconciliation' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600">Approval</th>
              {canManage && <th className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={canManage ? 11 : 10} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : modalOpen ? (
              <tr>
                <td colSpan={canManage ? 11 : 10} className="px-6 py-8 text-center text-gray-400">
                  Expense editor open
                </td>
              </tr>
            ) : filteredExpenses.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 11 : 10} className="px-6 py-8 text-center text-gray-500">
                  No expenses found
                </td>
              </tr>
            ) : (
              sortedExpenses.map((expense) => {
                const category = expenseCategories.find(c => c.value === expense.expense_category);
                const postingState = expense.effective_posting_state || 'AMBIGUOUS';
                const simplifiedStatus = getSimplifiedExpenseStatus(expense);

                // Reconciliation state is authoritative: includes valid salary advances
                // and amount-based allocations.
                const recon = calculateExpenseReconciliation(expense);
                const isPartiallyReconciled = recon.isPartiallyReconciled;
                const isReconciled = recon.isFullyReconciled;

                return (
                  <tr key={expense.id} className="hover:bg-blue-50/50 transition-colors">
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="font-mono text-xs text-gray-500">
                        {expense.voucher_number || '—'}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="text-xs text-gray-900 font-medium">
                        {formatDate(expense.expense_date)}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="text-xs font-medium text-gray-900">
                        {category?.label || expense.expense_category}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      {expense.import_container_id && expense.import_containers ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <Package className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                          <span className="text-blue-700 font-medium">
                            {expense.import_containers.container_ref}
                          </span>
                        </div>
                      ) : expense.delivery_challan_id && expense.delivery_challans ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <Truck className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                          <span className="text-green-700 font-medium">
                            {expense.delivery_challans.challan_number}
                          </span>
                        </div>
                      ) : category?.requiresContainer ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-red-700 bg-red-50 border border-red-200 rounded">
                          ⚠️ Missing
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="text-xs text-gray-700 line-clamp-1">
                        {(() => {
                          const rules = getCategoryFieldRules(expense.expense_category);
                          let partyName = '';
                          if (rules.staff === 'show' && expense.staff_id) {
                            partyName = staffRoster.find(s => s.id === expense.staff_id)?.full_name || '';
                          } else if (expense.payee_id) {
                            partyName = payeeRoster.find(p => p.id === expense.payee_id)?.full_name || (expense as any).payees?.full_name || '';
                          } else if (expense.suppliers) {
                            partyName = expense.suppliers.company_name;
                          }
                          const desc = expense.description || '';
                          if (partyName && desc) return `[${partyName}] ${desc}`;
                          if (partyName) return `[${partyName}]`;
                          return desc || '—';
                        })()}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-right">
                      <div className="text-xs font-semibold text-gray-900">
                        {formatCurrency(calculateCanonicalExpenseTotal(expense), getExpenseCurrency(expense), {
                          minimumFractionDigits: getExpenseCurrency(expense) === 'IDR' ? 0 : 2,
                          maximumFractionDigits: getExpenseCurrency(expense) === 'IDR' ? 0 : 2,
                        })}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold rounded ${getTypeColor(category?.type || 'admin')}`}>
                        {category?.type === 'import' && 'CAP'}
                        {category?.type === 'sales' && 'EXP'}
                        {category?.type === 'staff' && 'EXP'}
                        {category?.type === 'operations' && 'EXP'}
                        {category?.type === 'admin' && 'EXP'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      {simplifiedStatus.payment === 'Paid' ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700"
                          title="Paid"
                        >
                          <Banknote className="w-3 h-3" />
                        </span>
                      ) : simplifiedStatus.payment === 'Partially Paid' ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-yellow-100 text-yellow-700"
                          title={`Partially Paid · Paid ${formatCurrency(expense.paid_amount ?? 0, getExpenseCurrency(expense))} of ${formatCurrency(calculateCanonicalCashPayable(expense), getExpenseCurrency(expense))}`}
                        >
                          <Banknote className="w-3 h-3" />
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700"
                          title="Outstanding"
                        >
                          <Banknote className="w-3 h-3" />
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      {simplifiedStatus.isCash ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 cursor-default select-none"
                          title="Petty Cash"
                        >
                          <Banknote className="w-3 h-3" />
                        </span>
                      ) : isReconciled || (simplifiedStatus.bankLink === 'Linked' && simplifiedStatus.payment === 'Paid') ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700 cursor-default select-none"
                          title="Paid / Reconciled"
                        >
                          <CheckCircle className="w-3 h-3" />
                        </span>
                      ) : isPartiallyReconciled || (simplifiedStatus.bankLink === 'Linked' && simplifiedStatus.payment === 'Partially Paid') ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 cursor-default select-none"
                          title="Partially Paid / Reconciled"
                        >
                          <Clock className="w-3 h-3" />
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 text-gray-400 cursor-default select-none"
                          title="Outstanding · Unreconciled"
                        >
                          <Minus className="w-3 h-3" />
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      {simplifiedStatus.approval === 'Approved' ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700"
                          title="Approved · Active posting"
                        >
                          <ClipboardCheck className="w-3 h-3" />
                        </span>
                      ) : postingState === 'REJECTED' ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700"
                          title={`Rejected${expense.rejection_reason ? ': ' + expense.rejection_reason : ''}`}
                        >
                          <ClipboardCheck className="w-3 h-3" />
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-yellow-100 text-yellow-700"
                          title="Pending"
                        >
                          <ClipboardCheck className="w-3 h-3" />
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-2 py-1.5 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center gap-0.5 whitespace-nowrap">
                          {(() => {
                            const isLinked = simplifiedStatus.bankLink === 'Linked';
                            const linkActionTitle = isLinked ? 'Manage Bank Links' : 'Link Bank Transaction';

                            return (
                              <button
                                type="button"
                                aria-label={`${linkActionTitle} for ${expense.voucher_number || 'expense'}`}
                                onClick={() => {
                                  if (simplifiedStatus.isCash || isLinked || !canManage) {
                                    void handleViewExpense(expense);
                                  } else {
                                    void handleEdit(expense, true);
                                  }
                                }}
                                title={simplifiedStatus.isCash ? `${expense.payment_method === 'petty_cash' ? 'Petty Cash' : 'Cash'} Expense` : linkActionTitle}
                                className={`no-compact !p-0 inline-flex !h-6 !w-6 !min-h-[24px] !min-w-[24px] items-center justify-center rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                                  simplifiedStatus.isCash
                                    ? 'text-gray-400 hover:bg-gray-100'
                                    : isLinked
                                      ? 'text-emerald-700 hover:bg-emerald-50 text-green-700 hover:bg-green-50'
                                      : 'text-blue-600 hover:bg-blue-50'
                                }`}
                              >
                                <Landmark className="w-3.5 h-3.5 shrink-0" />
                              </button>
                            );
                          })()}
                          <FinanceActionButton
                            action="view"
                            onClick={() => void handleViewExpense(expense)}
                          />
                          {(postingState === 'ACTIVE' || postingState === 'PENDING' || postingState === 'REJECTED') && (
                            <FinanceActionButton action="edit" onClick={() => handleEdit(expense)} />
                          )}
                          {expense.approval_status === 'approved' && postingState === 'ACTIVE' && (
                            <FinanceActionButton
                              action="reverse"
                              label="Unpost"
                              onClick={() => void handleCancelPostingRequest(expense)}
                            />
                          )}
                          {isAdmin && simplifiedStatus.approval === 'Pending' && (
                            <>
                              <span className="w-px h-4 bg-gray-200 mx-0.5" aria-hidden="true" />
                              <FinanceActionButton
                                action="approve"
                                onClick={() => handleApproveExpense(expense.id)}
                                disabled={approvalLoading === expense.id}
                              />
                              <FinanceActionButton
                                action="reject"
                                onClick={() => { setRejectionTarget({ id: expense.id, type: 'expense' }); setRejectionModalOpen(true); }}
                                disabled={approvalLoading === expense.id}
                              />
                            </>
                          )}
                          {(postingState === 'PENDING' || postingState === 'REJECTED') && (
                            <>
                              <span className="w-px h-4 bg-gray-200 mx-0.5" aria-hidden="true" />
                              <FinanceActionButton action="delete" onClick={() => handleDelete(expense.id)} />
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
            {/* Totals Row */}
            {!modalOpen && !loading && sortedExpenses.length > 0 && (
              <tr className="bg-gradient-to-r from-blue-50 to-blue-100 border-t-2 border-blue-200 font-bold">
                <td colSpan={5} className="px-2 py-1.5 text-right text-xs text-gray-900">
                  TOTAL ({sortedExpenses.length} expenses):
                </td>
                <td className="px-2 py-1.5 text-right text-sm text-blue-900 font-bold">
                  {formatExpenseTotals(sortedExpenses)}
                </td>
                <td colSpan={canManage ? 5 : 4}></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile Card View (< 768px) */}
      <div className="block md:hidden space-y-2.5">
        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-xs text-gray-500">
            Loading...
          </div>
        ) : filteredExpenses.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-xs text-gray-500">
            No expenses found
          </div>
        ) : (
          sortedExpenses.map((expense) => {
            const category = expenseCategories.find(c => c.value === expense.expense_category);
            const postingState = expense.effective_posting_state || 'AMBIGUOUS';

            const isExpanded = expandedExpenses.has(expense.id);
            const isPaid = (calculateCanonicalCashPayable(expense) - (expense.paid_amount ?? 0)) <= 0.01;
            const isPartial = (expense.paid_amount ?? 0) > 0.01 && !isPaid;

            return (
              <div
                key={expense.id}
                onClick={() => toggleExpenseExpand(expense.id)}
                className="bg-white rounded-xl border border-slate-200/90 p-2.5 space-y-1 shadow-2xs hover:border-slate-300 transition active:scale-[0.99] cursor-pointer"
              >
                {/* Line 1: Voucher Number + Status Badge + Actions */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="font-mono font-bold text-xs text-gray-900 truncate">
                      {expense.voucher_number || '—'}
                    </span>
                    <span className="shrink-0">
                      {postingState === 'ACTIVE' ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700">Active</span>
                      ) : postingState === 'REVERSED' ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-200 text-gray-700">Reversed</span>
                      ) : postingState === 'REJECTED' ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700">Rejected</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-100 text-yellow-800">Pending</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <FinanceActionButton
                      action="view"
                      label="View"
                      onClick={() => void handleViewExpense(expense)}
                    />
                    {canManage && (postingState === 'ACTIVE' || postingState === 'PENDING' || postingState === 'REJECTED') && (
                      <FinanceActionButton action="edit" onClick={() => handleEdit(expense)} />
                    )}
                    {canManage && expense.approval_status === 'approved' && postingState === 'ACTIVE' && (
                      <FinanceActionButton
                        action="reverse"
                        label="Unpost"
                        onClick={() => void handleCancelPostingRequest(expense)}
                      />
                    )}
                    {canManage && (postingState === 'PENDING' || postingState === 'REJECTED') && (
                      <FinanceActionButton action="delete" label="Delete" onClick={() => handleDelete(expense.id)} />
                    )}
                    <button
                      type="button"
                      onClick={() => toggleExpenseExpand(expense.id)}
                      className="p-1 text-slate-400 hover:text-slate-600 rounded active:bg-slate-100"
                      title={isExpanded ? 'Collapse' : 'Expand'}
                    >
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                </div>

                {/* Line 2: Category + Expense Date */}
                <div className="flex items-center justify-between text-xs text-gray-600 gap-2">
                  <div className="font-medium text-gray-800 truncate min-w-0 flex-1">
                    {category?.label || expense.expense_category}
                  </div>
                  <div className="text-[11px] text-gray-400 font-normal shrink-0">
                    {formatDate(expense.expense_date)}
                  </div>
                </div>

                {/* Line 3: Total Amount + Bill Status Pill */}
                <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-xs gap-2">
                  <div className="font-mono font-bold text-xs text-gray-900 truncate">
                    {formatCurrency(calculateCanonicalExpenseTotal(expense), getExpenseCurrency(expense))}
                  </div>
                  <div className="shrink-0 text-xs font-semibold">
                    {isPaid ? (
                      <span className="text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded text-[10px] font-semibold border border-emerald-200/60">Paid</span>
                    ) : isPartial ? (
                      <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded text-[10px] font-semibold border border-amber-200/60">Partial</span>
                    ) : (
                      <span className="text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded text-[10px] font-semibold border border-rose-200/60">Unpaid</span>
                    )}
                  </div>
                </div>

                {/* Expandable Drawer for Secondary Info */}
                {isExpanded && (
                  <div
                    className="pt-2 mt-1 border-t border-dashed border-slate-200 bg-slate-50/70 p-2 rounded-lg text-xs space-y-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {expense.description && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-400 block uppercase tracking-wider">Description</span>
                        <p className="text-gray-700 text-[11px] mt-0.5">{expense.description}</p>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <span className="text-[10px] font-semibold text-gray-400 block uppercase tracking-wider">Approval Status</span>
                        <span className="text-gray-800 font-medium capitalize">{expense.approval_status || 'Pending'}</span>
                      </div>
                      <div>
                        <span className="text-[10px] font-semibold text-gray-400 block uppercase tracking-wider">Paid Amount</span>
                        <span className="text-gray-800 font-mono font-medium">{formatCurrency(expense.paid_amount ?? 0, getExpenseCurrency(expense))}</span>
                      </div>
                    </div>
                    {canManage && (postingState === 'PENDING' || postingState === 'REJECTED') && (
                      <div className="flex justify-end pt-1 border-t border-slate-200">
                        <FinanceActionButton action="delete" onClick={() => handleDelete(expense.id)} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
        </>
      )}

      {modalOpen && (
        <FinanceModal
          isOpen={modalOpen}
          onClose={() => { setModalOpen(false); resetForm(); onCloseEmbedded?.(); }}
          title={editingExpense ? 'Edit Expense' : 'Record New Expense'}
          subtitle={editingExpense?.voucher_number || undefined}
          size="2xl"
          footer={
            <>
              <button
                type="button"
                onClick={() => { setModalOpen(false); resetForm(); onCloseEmbedded?.(); }}
                className={F_BTN_SECONDARY}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                form="expense-form"
                disabled={isSubmitting}
                className={`${F_BTN_PRIMARY} ${isSubmitting ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                {isSubmitting ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {editingExpense ? 'Updating...' : 'Saving...'}
                  </span>
                ) : (
                  `${editingExpense ? 'Update' : 'Save'} Expense`
                )}
              </button>
            </>
          }
        >
          <form
            id="expense-form"
            onSubmit={handleSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
                if (isSubmittingRef.current) {
                  e.preventDefault();
                }
              }
            }}
          >
            {/* ══════════════════════════════════════════════════════════════
                 SAP Business One – style header
                 Horizontal-label 3-column grid. Every field is `label | input`
                 on ONE line. Fields flow left-to-right in the 12-col grid.
                 Same handlers as before — pure layout change (STEP 4).
                 ══════════════════════════════════════════════════════════════ */}
            {(() => {
              const rules   = getCategoryFieldRules(formData.expense_category);
              const taxCfg  = selectedDocType ? DOCUMENT_TYPE_TAX_CONFIG[selectedDocType as DocumentType] : null;
              const category = expenseCategories.find(c => c.value === formData.expense_category);
              const isBroker = formData.expense_category === 'import_broker';
              // Tax is an invoice attribute, not a document-type/category lock.
              // Only PIB (its own tax breakdown) and staff advances are excluded.
              // This lets an operating service such as fumigation carry PPN and
              // any supported PPh code on the same invoice.
              const isPib = category?.taxBehavior === 'pib_import';
              const supportsPpn = !!category && !isPib && category.taxBehavior !== 'advance' && category.taxBehavior !== 'salary';
              const supportsPph = !!category && !isPib && category.taxBehavior !== 'advance';
              return (
                <div className="pb-1.5 mb-1 border-b border-gray-200 flex flex-col gap-1">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none mb-0.5">Basic Information</p>
                  {/* ── Row A: Date · Invoice No · Category · Supplier ── */}
                  <SapRow>
                    <FloatingField
                      label={rules.billingMonth === 'show' ? 'Billing Date' : 'Date'}
                      required span={3}
                      filled={!!formData.expense_date}
                    >
                      <input name="expense_date" aria-label="Expense Date" type="date" value={formData.expense_date}
                        onChange={(e) => {
                          const d = e.target.value;
                          setFormData(prev => ({
                            ...prev, expense_date: d,
                            due_date: getDueDateFromTerms(d, selectedSupplier?.payment_terms_days ?? 30),
                          }));
                        }}
                        className={SAP_INPUT} required
                        title={rules.billingMonth === 'show' ? 'Date printed on the utility bill' : undefined} />
                    </FloatingField>
                    <FloatingField
                      label={rules.billingMonth === 'show' ? 'Billing Reference' : 'Supplier Invoice Number'}
                      span={3}
                      filled={!!formData.invoice_number}
                    >
                      <input name="invoice_number" aria-label="Enter invoice number" type="text" value={formData.invoice_number}
                        onChange={(e) => setFormData({ ...formData, invoice_number: e.target.value })}
                        className={SAP_INPUT}
                        placeholder={rules.billingMonth === 'show' ? 'Bill number / account ref' : 'Enter invoice number'} />
                    </FloatingField>
                    <FloatingField label="Category" required span={3} filled={!!formData.expense_category}>
                      <ExpenseCategorySelect
                        value={formData.expense_category}
                        onChange={(val) => {
                          const cat = val || '';
                          let dt: DocumentType | '' = '';
                          for (const [docType, cats] of Object.entries(DOCUMENT_TYPE_GROUPS) as [DocumentType, string[]][]) {
                            if (cats.includes(cat)) { dt = docType; break; }
                          }
                          setSelectedDocType(dt);
                          if (
                            getCategoryFieldRules(cat).salaryMonth === 'show'
                            && getCategoryFieldRules(formData.expense_category).salaryMonth !== 'show'
                          ) {
                            setPeriodLabel(currentFinancePeriod());
                          }
                          setFormData(prev => ({
                            ...prev,
                            expense_category: cat,
                            ...(cat === 'non_permanent_employee_fee'
                              ? { pph_code_id: taxCodes.find(tc => tc.code === 'PPH21')?.id || prev.pph_code_id }
                              : {}),
                          }));
                        }}
                        categories={expenseCategories}
                      />
                    </FloatingField>
                    <FloatingField
                      label={
                        rules.staff === 'show' ? 'Staff'
                        : rules.utility === 'show' ? 'Utility'
                        : (rules.payee === 'show' || (rules.providerTypeToggle && providerType === 'individual'))
                          ? (rules.payeeLabel || 'Payee')
                          : (isPib ? 'Statutory Payee' : isBroker ? 'Broker' : 'Supplier')
                      }
                      required={!isPib && (rules.staff === 'show' || rules.utility === 'show' || rules.supplier === 'show' || rules.payee === 'show' || (rules.providerTypeToggle && providerType === 'individual'))}
                      error={fieldErrors.party}
                      span={3}
                      filled={
                        isPib ? true
                        : rules.staff === 'show' ? !!selectedStaffId
                        : rules.utility === 'show' ? !!selectedUtilityId
                        : (rules.payee === 'show' || (rules.providerTypeToggle && providerType === 'individual')) ? !!formData.payee_id
                        : !!formData.supplier_id
                      }
                      right={
                        rules.providerTypeToggle ? (
                          <div className="inline-flex rounded border border-gray-200 bg-gray-100 p-0.5 text-[9px] font-medium shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                setProviderType('corporate');
                                setFormData(prev => ({ ...prev, payee_id: '' }));
                              }}
                              className={`px-1.5 py-0.5 rounded transition ${providerType === 'corporate' ? 'bg-blue-600 text-white font-semibold shadow-xs' : 'text-gray-600 hover:text-gray-900'}`}
                              title="Corporate (Badan)"
                            >
                              Corporate
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setProviderType('individual');
                                setFormData(prev => ({ ...prev, supplier_id: '' }));
                                setSelectedSupplier(null);
                              }}
                              className={`px-1.5 py-0.5 rounded transition ${providerType === 'individual' ? 'bg-blue-600 text-white font-semibold shadow-xs' : 'text-gray-600 hover:text-gray-900'}`}
                              title="Individual (Orang Pribadi)"
                            >
                              Individual
                            </button>
                          </div>
                        ) : selectedSupplier && !isPib && rules.staff !== 'show' && rules.utility !== 'show' && rules.payee !== 'show' ? (
                          <div className="flex gap-1 text-[9px] shrink-0">
                            {selectedSupplier.pkp_status && <span className="px-1 py-0.5 bg-green-100 text-green-700 rounded font-medium">PKP</span>}
                            {selectedSupplier.payment_terms_days ? <span className="px-1 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">N{selectedSupplier.payment_terms_days}</span> : null}
                          </div>
                        ) : null
                      }>
                      {isPib ? (
                        <div
                          className={SAP_INPUT + " !bg-gray-100 !text-gray-800 !font-semibold flex items-center justify-between cursor-default"}
                          title="Statutory customs payee (Directorate General of Customs and Excise / Kas Negara). Customs liabilities do not inherit or affect commercial supplier ledgers."
                        >
                          <span>Kas Negara (Bea Cukai)</span>
                          <span className="text-[9px] font-normal px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded">Statutory</span>
                        </div>
                      ) : rules.staff === 'show' ? (
                        <SearchableSelect
                          value={selectedStaffId}
                          onChange={(val) => {
                            setFieldErrors(prev => ({ ...prev, party: '' }));
                            setSelectedStaffId(val);
                            const staff = staffRoster.find((item) => item.id === val);
                            setFormData(prev => ({
                              ...prev,
                              supplier_id: '',
                              ...(prev.expense_category === 'salary' && staff
                                ? { amount: Number(staff.monthly_salary) || 0, pph_amount: 0 }
                                : {}),
                            }));
                            setSelectedSupplier(null);
                          }}
                          options={staffOptions}
                          placeholder="Search staff..."
                        />
                      ) : rules.utility === 'show' ? (
                        <SearchableSelect
                          value={selectedUtilityId}
                          onChange={(val) => {
                            setFieldErrors(prev => ({ ...prev, party: '' }));
                            setSelectedUtilityId(val);
                            const util = utilityRoster.find(u => u.id === val);
                            if (util?.supplier_id) handleSupplierSelect(util.supplier_id);
                            else { setFormData(prev => ({ ...prev, supplier_id: '' })); setSelectedSupplier(null); }
                          }}
                          options={utilityOptions}
                          placeholder="Search utility..."
                        />
                      ) : (rules.payee === 'show' || (rules.providerTypeToggle && providerType === 'individual')) ? (
                        <SearchableSelect
                          value={formData.payee_id}
                          onChange={(val) => handlePayeeSelect(val)}
                          options={payeeOptions}
                          placeholder="Search payee..."
                        />
                      ) : (
                        <SearchableSelect
                          value={formData.supplier_id}
                          onChange={(val) => handleSupplierSelect(val)}
                          options={supplierOptions}
                          placeholder="Search supplier..."
                          onCreateNew={(name) => { setQuickAddSupplierName(name); setShowQuickAddSupplier(true); }}
                        />
                      )}
                    </FloatingField>
                    {rules.salesInvoice === 'show' && (
                      <FloatingField label="Linked Sales Invoice" span={3} filled={!!formData.linked_sales_invoice_id}>
                        <SearchableSelect
                          value={formData.linked_sales_invoice_id}
                          onChange={(val) => handleSalesInvoiceSelect(val)}
                          options={salesInvoiceOptions}
                          placeholder="Search sales invoice..."
                        />
                      </FloatingField>
                    )}
                    {rules.workingDays === 'show' && (
                      <FloatingField label="Working Days (for TER)" span={3} filled={!!workingDays}>
                        <input name="working_days" aria-label="Working Days"
                          type="number"
                          min="1"
                          max="31"
                          value={workingDays}
                          onChange={(e) => {
                            const days = Math.max(1, parseInt(e.target.value) || 1);
                            setWorkingDays(days);
                            if (formData.pph_code_id && !formData.is_tax_manual_override) {
                              const tc = taxCodes.find(t => t.id === formData.pph_code_id);
                              const currentPayee = payeeRoster.find(p => p.id === formData.payee_id);
                              const calc = computeExpensePPh({
                                grossAmount: formData.amount,
                                taxCode: tc,
                                payeeClassification: currentPayee?.tax_classification,
                                workingDays: days,
                              });
                              setFormData(prev => ({
                                ...prev,
                                pph_amount: calc.pphAmount,
                                pph_dpp_ratio: calc.dppRatio,
                                pph_dpp_amount: calc.dppAmount,
                                pph_rate: calc.pphRate,
                                pph_calculation_regime: calc.regime,
                              }));
                            }
                          }}
                          className={SAP_INPUT + ' !text-right !font-mono'}
                        />
                      </FloatingField>
                    )}
                  </SapRow>

                  {/* ── Row B: Period (conditional — salary / billing month only) ── */}
                  {(rules.salaryMonth === 'show' || rules.billingMonth === 'show') && (
                    <SapRow>
                      {rules.salaryMonth === 'show' ? (
                        <FloatingField label="Salary Month" required span={3} filled={!!periodLabel}>
                          <select name="normalize_salary_period" aria-label="Normalize Salary Period" value={normalizeSalaryPeriod(periodLabel || currentFinancePeriod())}
                            onChange={(e) => setPeriodLabel(e.target.value)}
                            className={SAP_INPUT}>
                            {SALARY_PERIOD_OPTIONS.map(({ value, label }) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </FloatingField>
                      ) : (
                        <FloatingField label="Billing Month" required span={3} filled={!!periodLabel}>
                          <select name="normalize_salary_period" aria-label="Normalize Salary Period" value={normalizeSalaryPeriod(periodLabel || currentFinancePeriod())}
                            onChange={(e) => setPeriodLabel(e.target.value)}
                            className={SAP_INPUT} title="The month this bill covers">
                            {SALARY_PERIOD_OPTIONS.map(({ value, label }) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </FloatingField>
                      )}
                    </SapRow>
                  )}

                  {rules.staff === 'show' && formData.expense_category === 'salary' && selectedStaffId && salaryCalculation && (
                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold text-amber-900">Canonical Salary Calculation</div>
                          <div className="text-[10px] text-amber-700">Select only advances confirmed as still outstanding. Unchecked advances will not be deducted.</div>
                        </div>
                        <span className="text-[10px] font-semibold text-blue-700">Manual selection</span>
                      </div>
                      {salaryAdvances.length > 0 && <div className="mt-2 space-y-1 text-xs">
                        {salaryAdvances.map((advance) => {
                          const checked = selectedSalaryAdvanceIds.includes(advance.advance_id);
                          return (
                            <label key={advance.advance_id} className="flex items-center justify-between gap-3 border-t border-amber-100 pt-1 text-amber-900 cursor-pointer">
                              <span className="flex min-w-0 items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={Number(advance.available_amount || 0) <= 0 || (Boolean(editingExpense) && persistedSalaryAdvanceApplied > 0)}
                                  onChange={(e) => setSelectedSalaryAdvanceIds(current =>
                                    e.target.checked
                                      ? [...current, advance.advance_id]
                                      : current.filter(id => id !== advance.advance_id)
                                  )}
                                  className="h-3.5 w-3.5 rounded border-amber-400"
                                />
                                <span>{advance.voucher_number} · {new Date(advance.voucher_date).toLocaleDateString('en-GB')}</span>
                              </span>
                              <span className="font-mono whitespace-nowrap">Available {formatCurrency(advance.available_amount, expenseFormCurrency)}</span>
                            </label>
                          );
                        })}
                      </div>}
                      {(() => {
                        const isAdd = formData.pph_treatment === 'add';
                        const pph21Val = Number(formData.pph_amount ?? salaryCalculation.pph21_amount ?? 0);
                        const netPayable = salaryCalculation.net_salary_payable;
                        const totals = calculateExpenseTotals({
                          ...formData,
                          amount: Number(formData.amount || salaryCalculation.gross_salary || 0),
                          pph_amount: pph21Val,
                          pph_treatment: formData.pph_treatment,
                          bpjs_employee_deduction: salaryCalculation.bpjs_amount,
                        });
                        const totalCashOutflow = totals.totalCashOutflow;
                        const alreadyPaid = Math.max(
                          editingBankLines.reduce(
                            (sum, line) => sum + Number(line.allocation_amount ?? line.debit_amount ?? line.credit_amount ?? 0),
                            0,
                          ),
                          Number(editingExpense?.paid_amount || 0)
                        );
                        const balance = Math.max(0, netPayable - alreadyPaid);
                        return (
                          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 border-t border-amber-200 pt-2 text-xs">
                            <div><span className="text-amber-700">Gross Salary</span><div className="font-mono font-semibold text-amber-950">{formatCurrency(salaryCalculation.gross_salary, expenseFormCurrency)}</div></div>
                            <div><span className="text-amber-700">Less Advance</span><div className="font-mono font-semibold text-amber-950">−{formatCurrency(salaryCalculation.outstanding_salary_advances, expenseFormCurrency)}</div></div>
                            <div>
                              <span className="text-amber-700">{isAdd ? 'PPh 21 (Add)' : 'PPh 21 (Deduct)'}</span>
                              <div className={`font-mono font-semibold ${isAdd ? 'text-blue-900' : 'text-amber-950'}`}>
                                {isAdd ? '+' : '−'}{formatCurrency(pph21Val, expenseFormCurrency)}
                              </div>
                            </div>
                            <div><span className="text-amber-700">Less BPJS</span><div className="font-mono font-semibold text-amber-950">−{formatCurrency(salaryCalculation.bpjs_amount, expenseFormCurrency)}</div></div>
                            <div><span className="text-amber-700 font-bold">Net Payable (Employee)</span><div className="font-mono font-bold text-emerald-800">{formatCurrency(netPayable, expenseFormCurrency)}</div></div>
                            <div><span className="text-amber-700 font-bold">Total Cash Outflow</span><div className="font-mono font-bold text-purple-900">{formatCurrency(totalCashOutflow, expenseFormCurrency)}</div></div>
                            <div><span className="text-amber-700 font-bold">Paid</span><div className="font-mono font-bold text-gray-900">{formatCurrency(alreadyPaid, expenseFormCurrency)}</div></div>
                            <div><span className="text-amber-700 font-bold">Balance</span><div className={`font-mono font-bold ${balance > 0.01 ? 'text-amber-700' : 'text-emerald-700'}`}>{formatCurrency(balance, expenseFormCurrency)}</div></div>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* ── Row C: Amount · DPP · PPN · PPh · PPh Code · Stamp · Bank Chg · Container · DC · Asset ── */}
                  <SapRow>
                     <FloatingField label={`${isBroker ? 'Broker Invoice Amount' : formData.expense_category === 'salary' ? 'Gross Salary Amount' : 'Amount'} (${expenseFormCurrency})`} required span={3}
                      filled={Number(formData.amount) > 0}>
                      <MoneyInput value={formData.amount} required placeholder="0.00"
                        onChange={(amt) => {
                          setFormData(prev => {
                            const mode = prev.ppn_calc_mode || 'standard';
                            const rate = prev.ppn_rate || 11;
                            const ppn = !isBroker && mode === 'standard' && selectedSupplier?.pkp_status
                              ? Math.round(amt * rate / 100) : prev.ppn_amount;
                            let pph = prev.pph_amount;
                            let dppAmt = prev.pph_dpp_amount;
                            let dppRatio = prev.pph_dpp_ratio;
                            let pphRate = prev.pph_rate;
                            let regime = prev.pph_calculation_regime;

                            if (prev.pph_code_id && !prev.is_tax_manual_override) {
                              const tc = taxCodes.find(t => t.id === prev.pph_code_id) || null;
                              const currentPayee = payeeRoster.find(p => p.id === prev.payee_id) || null;
                              const calc = computeExpensePPh({
                                grossAmount: amt,
                                taxCode: tc,
                                payeeClassification: currentPayee?.tax_classification,
                                workingDays,
                              });
                              pph = calc.pphAmount;
                              dppAmt = calc.dppAmount;
                              dppRatio = calc.dppRatio;
                              pphRate = calc.pphRate;
                              regime = calc.regime;
                            }
                            return {
                              ...prev,
                              amount: amt,
                              ppn_amount: ppn,
                              pph_amount: pph,
                              pph_dpp_amount: dppAmt,
                              pph_dpp_ratio: dppRatio,
                              pph_rate: pphRate,
                              pph_calculation_regime: regime,
                            };
                          });
                        }}
                        className={SAP_INPUT + ' !text-right !font-mono !font-semibold'} />
                    </FloatingField>
                    {isBroker && (
                      <FloatingField label="Invoice DPP (Tax Base)" span={3} filled={Number(formData.dpp_amount) > 0}>
                        <MoneyInput value={formData.dpp_amount} placeholder="0.00"
                          onChange={(dpp) => setFormData(prev => {
                            const rate = prev.ppn_rate ?? 11;
                            const isManual = prev.ppn_calc_mode === 'manual';
                            const ppn = isManual ? prev.ppn_amount : Math.round(dpp * rate / 100);
                            return { ...prev, dpp_amount: dpp, ppn_amount: ppn };
                          })}
                          className={SAP_INPUT + ' !text-right !font-mono'} />
                      </FloatingField>
                    )}
                    {supportsPpn && !isBroker && formData.ppn_calc_mode === 'dpp_nilai_lain' && (
                      <>
                        <FloatingField label="DPP (Nilai Lain)" span={3} filled={Number(formData.dpp_amount) > 0}>
                          <MoneyInput value={formData.dpp_amount} placeholder="0"
                            onChange={(dpp) => setFormData(prev => ({ ...prev, dpp_amount: dpp, ppn_amount: Math.round(dpp * (prev.ppn_rate || 11) / 100) }))}
                            className={SAP_INPUT + ' !text-right !font-mono'} />
                        </FloatingField>
                        <FloatingField label="PPN" span={3} filled={Number(formData.ppn_amount) > 0}
                          right={<PpnModeToggle value={formData.ppn_calc_mode} onChange={(mode) => setFormData(prev => {
                            const rate = prev.ppn_rate || 11;
                            let ppn = prev.ppn_amount;
                            if (mode === 'standard') ppn = selectedSupplier?.pkp_status ? Math.round((prev.amount || 0) * rate / 100) : 0;
                            else if (mode === 'dpp_nilai_lain') ppn = Math.round((prev.dpp_amount || 0) * rate / 100);
                            return { ...prev, ppn_calc_mode: mode, ppn_amount: ppn, ppn_manual_override: mode === 'manual', dpp_amount: mode === 'dpp_nilai_lain' ? (prev.dpp_amount || prev.amount || 0) : 0 };
                          })} />}>
                          <MoneyInput value={formData.ppn_amount} placeholder="0"
                            onChange={(v) => setFormData(prev => ({ ...prev, ppn_amount: v }))}
                            className={SAP_INPUT + ' !text-right !font-mono text-blue-700'} />
                        </FloatingField>
                      </>
                    )}
                    {supportsPpn && !(formData.ppn_calc_mode === 'dpp_nilai_lain' && !isBroker) && (
                      <>
                        {isBroker && (
                          <FloatingField label="PPN %" span={3} filled={!!formData.ppn_rate}>
                            <BrokerPpnRateSelector
                              rate={formData.ppn_rate ?? 11}
                              isCustom={formData.ppn_calc_mode === 'manual'}
                              onChange={({ rate, custom }) => setFormData(prev => {
                                const dpp = prev.dpp_amount || 0;
                                if (custom) {
                                  return {
                                    ...prev,
                                    ppn_rate: rate,
                                    ppn_calc_mode: 'manual',
                                    ppn_manual_override: true,
                                  };
                                }
                                return {
                                  ...prev,
                                  ppn_rate: rate,
                                  ppn_calc_mode: 'standard',
                                  ppn_manual_override: false,
                                  ppn_amount: Math.round(dpp * rate / 100),
                                };
                              })}
                            />
                          </FloatingField>
                        )}
                        <FloatingField label={isBroker ? 'Invoice PPN' : 'PPN'} span={3} filled={Number(formData.ppn_amount) > 0}
                          right={!isBroker ? <PpnModeToggle value={formData.ppn_calc_mode} onChange={(mode) => setFormData(prev => {
                            const rate = prev.ppn_rate || 11;
                            let ppn = prev.ppn_amount;
                            if (mode === 'standard') ppn = selectedSupplier?.pkp_status ? Math.round((prev.amount || 0) * rate / 100) : 0;
                            else if (mode === 'dpp_nilai_lain') ppn = Math.round((prev.dpp_amount || 0) * rate / 100);
                            return { ...prev, ppn_calc_mode: mode, ppn_amount: ppn, ppn_manual_override: mode === 'manual', dpp_amount: mode === 'dpp_nilai_lain' ? (prev.dpp_amount || prev.amount || 0) : 0 };
                          })} /> : null}>
                          <MoneyInput value={formData.ppn_amount} placeholder="0.00"
                            readOnly={isBroker && formData.ppn_calc_mode !== 'manual'}
                            onChange={(v) => setFormData(prev => {
                              if (prev.expense_category === 'import_broker') {
                                return { ...prev, ppn_amount: v };
                              }
                              return {
                                ...prev,
                                ppn_amount: v,
                                ppn_calc_mode: 'manual',
                                ppn_manual_override: true,
                              };
                            })}
                            className={SAP_INPUT + ' !text-right !font-mono text-blue-700'
                              + (isBroker && formData.ppn_calc_mode !== 'manual' ? ' !bg-gray-100 !text-gray-600' : '')} />
                        </FloatingField>
                      </>
                    )}
                    {supportsPph && (
                      <FloatingField
                        label={category?.taxBehavior === 'salary' ? 'PPh 21' : 'PPh Withheld'}
                        span={3}
                        filled={Number(formData.pph_amount) > 0}
                        right={
                          <PphTreatmentToggle
                            value={formData.pph_treatment}
                            onChange={(treatment) => setFormData(prev => ({ ...prev, pph_treatment: treatment }))}
                          />
                        }
                      >
                        <MoneyInput value={formData.pph_amount} placeholder="0.00"
                          onChange={(v) => setFormData(prev => ({
                            ...prev,
                            pph_amount: v,
                            is_tax_manual_override: true,
                            pph_calculation_regime: 'manual',
                          }))}
                          className={SAP_INPUT + ' !text-right !font-mono text-orange-700'} />
                      </FloatingField>
                    )}
                    {supportsPph && (
                      <FloatingField label="PPh Code" span={3} filled={!!formData.pph_code_id}>
                        <SearchableSelect
                          value={formData.pph_code_id}
                          onChange={(val) => handleTaxCodeChange(val)}
                          options={taxCodeOptions}
                          placeholder="None"
                        />
                      </FloatingField>
                    )}
                    {taxCfg?.stamp && (
                      <FloatingField label="Stamp Duty" span={3} filled={Number(formData.stamp_duty_amount) > 0}>
                        <MoneyInput value={formData.stamp_duty_amount} placeholder="0"
                          onChange={(v) => setFormData({ ...formData, stamp_duty_amount: v })}
                          className={SAP_INPUT + ' !text-right !font-mono'} />
                      </FloatingField>
                    )}
                    <FloatingField label={`Bank Charges (${expenseFormCurrency})`} span={3} filled={Number(formData.bank_charges_amount) > 0}>
                      <MoneyInput
                        name="bank_charges_amount"
                        aria-label={`Bank Charges (${expenseFormCurrency})`}
                        value={formData.bank_charges_amount}
                        placeholder="0.00"
                        onChange={(v) => setFormData({ ...formData, bank_charges_amount: v })}
                        className={SAP_INPUT + ' !text-right !font-mono'}
                      />
                    </FloatingField>
                    {(requiresContainer || isBroker) && (
                      <FloatingField label="Import Container" required={requiresContainer} span={3} filled={!!formData.import_container_id}>
                        <SearchableSelect
                          value={formData.import_container_id}
                          onChange={(val) => setFormData({ ...formData, import_container_id: val })}
                          options={containerOptions}
                          placeholder="Select import container"
                        />
                      </FloatingField>
                    )}
                    {requiresDC && (
                      <FloatingField label="DC" span={3} filled={!!formData.delivery_challan_id}>
                        <SearchableSelect
                          value={formData.delivery_challan_id}
                          onChange={(val) => setFormData({ ...formData, delivery_challan_id: val })}
                          options={challanOptions}
                          placeholder="None"
                        />
                      </FloatingField>
                    )}
                    {formData.expense_category === 'fixed_asset' && (
                      <FloatingField label="Asset Acct" required span={3} filled={!!formData.fixed_asset_account_id}>
                        <SearchableSelect
                          value={formData.fixed_asset_account_id}
                          onChange={(val) => setFormData({ ...formData, fixed_asset_account_id: val })}
                          options={coaAssetOptions}
                          placeholder="Select account"
                        />
                      </FloatingField>
                    )}
                  </SapRow>

                  {/* ── Multi-SO Expense Allocation (Sales Order Profitability Distribution) ── */}
                  {requiresDC && (
                    <div className="my-2 p-3 bg-blue-50/60 border border-blue-200 rounded-lg">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-blue-900 uppercase tracking-wide">
                            Multi-SO Expense Allocation
                          </span>
                          <span className="text-[11px] text-blue-700">
                            (Prorates expense across Sales Orders for Profitability reporting)
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {soAllocations.length > 1 && (
                            <button
                              type="button"
                              onClick={handleAutoSplitProportional}
                              className="px-2.5 py-1 text-xs bg-white border border-blue-300 text-blue-700 hover:bg-blue-100 rounded shadow-sm font-medium transition"
                            >
                              Auto-Split Proportional
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={handleAddSoAllocation}
                            className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded shadow-sm font-medium transition flex items-center gap-1"
                          >
                            + Add Sales Order
                          </button>
                        </div>
                      </div>

                      {soAllocations.length === 0 ? (
                        <p className="text-xs text-gray-500 italic py-1">
                          Optional: Allocate this expense to specific Sales Orders. If left empty, it attaches generally to the selected Delivery Challan or department.
                        </p>
                      ) : (
                        <div className="space-y-2 mt-2">
                          <div className="grid grid-cols-12 gap-2 text-[11px] font-semibold text-gray-600 px-1 uppercase tracking-wider">
                            <div className="col-span-5">Sales Order</div>
                            <div className="col-span-3 text-right">SO Total</div>
                            <div className="col-span-3 text-right">Allocated Amount ({formData.transaction_currency})</div>
                            <div className="col-span-1 text-center">Action</div>
                          </div>
                          {soAllocations.map((alloc, idx) => (
                            <div key={idx} className="grid grid-cols-12 gap-2 items-center bg-white p-1.5 rounded border border-blue-100 shadow-sm">
                              <div className="col-span-5">
                                <select
                                  value={alloc.sales_order_id}
                                  onChange={(e) => handleUpdateSoAllocation(idx, 'sales_order_id', e.target.value)}
                                  className="w-full text-xs border border-gray-300 rounded px-2 py-1 font-mono focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                                >
                                  {salesOrders.map((so) => (
                                    <option key={so.id} value={so.id}>
                                      {so.so_number} — {(so.customers as any)?.company_name || 'No Customer'} (Rp {Number(so.total_amount || 0).toLocaleString('id-ID')})
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="col-span-3 text-right text-xs font-mono text-gray-600">
                                Rp {Number(alloc.total_amount || 0).toLocaleString('id-ID')}
                              </div>
                              <div className="col-span-3">
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={alloc.allocated_amount === 0 ? '' : alloc.allocated_amount}
                                  onChange={(e) => handleUpdateSoAllocation(idx, 'allocated_amount', parseFloat(e.target.value) || 0)}
                                  placeholder="0"
                                  className="w-full text-right text-xs font-mono border border-gray-300 rounded px-2 py-1 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 font-semibold text-gray-800"
                                />
                              </div>
                              <div className="col-span-1 text-center">
                                <button
                                  type="button"
                                  onClick={() => handleRemoveSoAllocation(idx)}
                                  className="text-red-500 hover:text-red-700 text-sm font-bold transition p-1"
                                  title="Remove SO"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          ))}

                          <div className="flex items-center justify-between pt-2 border-t border-blue-200 mt-2 text-xs">
                            <div className="flex items-center gap-3">
                              <span>
                                Allocated Total: <strong className="font-mono text-gray-900">Rp {soAllocations.reduce((s, a) => s + (Number(a.allocated_amount) || 0), 0).toLocaleString('id-ID')}</strong>
                              </span>
                              <span>
                                Expense Amount: <strong className="font-mono text-gray-900">Rp {(formData.amount || 0).toLocaleString('id-ID')}</strong>
                              </span>
                            </div>
                            <div>
                              {(() => {
                                const allocSum = soAllocations.reduce((s, a) => s + (Number(a.allocated_amount) || 0), 0);
                                const diff = (formData.amount || 0) - allocSum;
                                if (Math.abs(diff) < 0.01) {
                                  return (
                                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
                                      ✓ 100% Balanced
                                    </span>
                                  );
                                } else if (diff > 0) {
                                  return (
                                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                                      Remaining: Rp {diff.toLocaleString('id-ID')}
                                    </span>
                                  );
                                } else {
                                  return (
                                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-100 text-rose-800 border border-rose-300">
                                      Over-allocated: Rp {Math.abs(diff).toLocaleString('id-ID')}
                                    </span>
                                  );
                                }
                              })()}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {(formData.pph_amount > 0 || !!formData.pph_code_id) && (
                    <div className="my-1.5 flex flex-wrap items-center gap-2 text-xs bg-orange-50 border border-orange-200 rounded px-2.5 py-1 text-orange-900">
                      <span className="font-semibold uppercase tracking-wide text-[10px] text-orange-800">
                        {formData.pph_calculation_regime === 'pasal17_dpp50'
                          ? 'Pasal 17 DPP 50% (Bukan Pegawai / Tenaga Ahli)'
                          : formData.pph_calculation_regime === 'ter_harian_lepas'
                            ? 'TER Harian (Pegawai Tidak Tetap)'
                            : formData.pph_calculation_regime === 'pph_final_4_2'
                              ? 'PPh Final 4(2) 10% (Sewa OP)'
                              : 'PPh Withholding'}
                      </span>
                      <span>•</span>
                      <span>DPP: <strong className="font-mono">{formatCurrency(formData.pph_dpp_amount || Math.round(formData.amount * (formData.pph_dpp_ratio || 1)), expenseFormCurrency)}</strong> ({Math.round((formData.pph_dpp_ratio || 1) * 100)}%)</span>
                      <span>•</span>
                      <span>Effective Rate: <strong className="font-mono">{formData.pph_rate || 0}%</strong></span>
                      <span>•</span>
                      <span>Withheld: <strong className="font-mono text-orange-700">{formatCurrency(formData.pph_amount, expenseFormCurrency)}</strong></span>
                      {formData.is_tax_manual_override && (
                        <span className="ml-auto text-[10px] bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded font-semibold">Manual Override</span>
                      )}
                    </div>
                  )}

                  {/* ── Row E: Description (full width) ── */}
                  <SapRow>
                    <FloatingField label="Invoice Description" span={12} filled={!!formData.description}>
                      <input name="description" aria-label="Describe what this invoice covers..." type="text" value={formData.description}
                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        className={SAP_INPUT} placeholder="Describe what this invoice covers..." />
                    </FloatingField>
                  </SapRow>
                </div>
              );
            })()}

            {/* ── Tax Section (conditional, full width) ── */}
            {(() => {
              const category = expenseCategories.find(c => c.value === formData.expense_category);
              const taxCfg = selectedDocType ? DOCUMENT_TYPE_TAX_CONFIG[selectedDocType as DocumentType] : null;
              const isPib = category?.taxBehavior === 'pib_import';
              const supportsPpn = !!category && !isPib && category.taxBehavior !== 'advance' && category.taxBehavior !== 'salary';
              const supportsPph = !!category && !isPib && category.taxBehavior !== 'advance';
              const supportsStamp = !!category && !isPib && category.taxBehavior !== 'advance' && category.taxBehavior !== 'salary';
              if (!category || (!supportsPpn && !supportsPph && !supportsStamp && !isPib && !taxCfg?.brokerItems)) return null;
              return (
                <div className="py-1 border-b">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Tax</p>

                  {/* PIB Breakdown */}
                  {isPib && (() => {
                    const pibSum = (formData.pib_bm_amount || 0) + (formData.pib_ppn_amount || 0) + (formData.pib_pph_amount || 0);
                    const pibOk = Math.abs(pibSum - (formData.amount || 0)) < 1 && pibSum > 0;
                    return (
                      <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-2.5">
                        <div className="text-xs font-semibold text-amber-800 mb-2">PIB Tax Breakdown — must sum to invoice amount</div>
                        <div className="grid grid-cols-3 gap-2 mb-2">
                          {([
                            { key: 'pib_bm_amount' as const, label: 'Import Duty (BM)', hint: 'DR 5200 Landed Cost' },
                            { key: 'pib_ppn_amount' as const, label: 'PPN Import', hint: 'DR 1150 Input VAT' },
                            { key: 'pib_pph_amount' as const, label: 'PPh 22 Import', hint: 'DR 1155 Prepaid Tax' },
                          ] as const).map(({ key, label, hint }) => (
                            <div key={key}>
                              <label className="block text-[10px] font-semibold text-amber-900 mb-0.5">{label}</label>
                              <MoneyInput value={formData[key]} placeholder="0"
                                onChange={(v) => setFormData({ ...formData, [key]: v })}
                                className="w-full px-2 py-1 border border-amber-300 rounded text-xs bg-white text-right font-mono" />
                              <p className="text-[9px] text-amber-700 mt-0.5">{hint}</p>
                            </div>
                          ))}
                        </div>
                        <div className={`flex items-center justify-between px-2 py-1 rounded text-xs font-medium ${pibOk ? 'bg-green-50 border border-green-300 text-green-800' : pibSum > 0 ? 'bg-red-50 border border-red-300 text-red-800' : 'bg-amber-100 border border-amber-300 text-amber-800'}`}>
                          <span>BM + PPN + PPh = Rp {pibSum.toLocaleString('id-ID')}</span>
                          <span>{pibOk ? '✓ Matches' : formData.amount > 0 ? `Diff: Rp ${Math.abs(pibSum - formData.amount).toLocaleString('id-ID')}` : ''}</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ══════════════════════════════════════════════════════════════
                       BROKER CALCULATION ENGINE — 2026-07-08 spec
                       ══════════════════════════════════════════════════════════════
                       Broker Invoice and every Reimbursement Line are independent
                       payables. DPP and PPN are independent tax-reporting inputs.

                       Line columns (per user brief):
                         # | Supplier | Invoice No | Tax Inv # | Inv Date |
                         Amount | DDP | PPN% | PPN Amount | Total | Delete

                       Per-line formulas:
                         PPN Amount (Auto)  = round(DDP × PPN%)
                         PPN Amount (Manual) = user-typed value; NOT overwritten
                         Line Total          = Amount

                       Auto vs Manual (Excel semantics, per row):
                         • Editing DDP or PPN%   → Auto (recompute PPN Amount).
                         • Editing PPN Amount    → Manual (freeze PPN Amount).
                         • ppn_mode: 'auto' | 'manual' — persisted per line via a
                           dedicated `ppn_treatment` alias to avoid a schema change.

                       Total Payable:
                         Broker Invoice          (actual header payable)
                         + Σ Line.Amount         (actual reimbursement payable)
                         − Broker PPh            (header withholding)
                         + Broker Stamp Duty     (header, independent)

                       DPP and PPN remain independent reporting values and are
                       never added to Invoice Amount.
                     ══════════════════════════════════════════════════════════════ */}
                  {taxCfg?.brokerItems && (() => {
                    // ─── updateLine — pure line mutator, NEVER touches header state.
                    const updateLine = (idx: number, patch: Partial<BrokerItem>) => {
                      setBrokerItems(prev => prev.map((it, i) => {
                        if (i !== idx) return it;
                        // Any user edit promotes the line to the corrected
                        // model. Its stored Invoice Amount (including zero) is
                        // authoritative from this point onward.
                        const merged = { ...it, ...patch, invoice_amount_authoritative: true };
                        const inManualMode = merged.ppn_treatment === 'included'; // 'included' = manual PPN flag (repurposed to avoid new schema field)
                        const explicitPpn = 'ppn_amount' in patch;
                        const dppChanged  = 'dpp_amount' in patch;
                        const rateChanged = 'ppn_rate' in patch;
                        // Rule 1: user typed a PPN Amount directly → flip row to manual.
                        if (explicitPpn) {
                          merged.ppn_treatment = 'included';
                        }
                        // Rule 2: user edited DDP or % → flip row BACK to auto and recompute.
                        else if (dppChanged || rateChanged) {
                          merged.ppn_treatment = 'excluded';
                          const dpp = merged.dpp_amount ?? 0;
                          const rate = merged.ppn_rate ?? 0;
                          merged.ppn_amount = Math.round(dpp * rate / 100);
                        }
                        // Rule 3: auto-mode row with no explicit patch → keep formula alive
                        // if amount changes. We do NOT auto-seed DDP from Amount (they're
                        // independent per the user's brief). Legacy fallback preserved.
                        else if (!inManualMode && 'amount' in patch && merged.dpp_amount == null && merged.ppn_rate == null) {
                          merged.ppn_amount = computeBrokerLinePpn(merged.amount, merged.ppn_treatment);
                        }
                        return merged;
                      }));
                      // NO setFormData here. Header stays put by construction.
                    };
                    const addLine = () => setBrokerItems(prev => [...prev, {
                      type: 'other', description: '', amount: 0,
                      invoice_amount_authoritative: true,
                      supplier_id: null, invoice_number: '',
                      tax_invoice_number: '', invoice_date: '',
                      ppn_treatment: 'excluded', ppn_amount: 0,
                      dpp_amount: 0, ppn_rate: 11,
                    } as BrokerItem]);
                    const removeLine = (idx: number) => setBrokerItems(prev => prev.filter((_, i) => i !== idx));

                    // ─── Read-only derivations — never written back to state ───
                    const brokerTotals = calculateBrokerExpenseTotals({ ...formData, broker_items: brokerItems });
                    const {
                      brokerInvoiceAmount,
                      reimbursementTotal: reimbAmount, reimbursementDpp: reimbDpp,
                      reimbursementPpn: reimbPpn,
                      pphWithheld: parentPph, stampDuty: parentStamp,
                    } = brokerTotals;
                    const fmt = (n: number) => formatCurrency(n, expenseFormCurrency, {
                      minimumFractionDigits: expenseFormCurrency === 'IDR' ? 0 : 2,
                      maximumFractionDigits: expenseFormCurrency === 'IDR' ? 0 : 2,
                    });
                    // Excel density — 10 data cells per row + delete with consistent 28px height & text-[11px].
                    const cellInputCls = 'w-full h-[28px] px-1.5 border-0 focus:ring-1 focus:ring-blue-400 focus:outline-none rounded-none text-[11px] bg-transparent';
                    // # | Supplier | Inv# | Tax Inv# | Inv Date | Amount | DPP | PPN% | PPN Amt | Total | Del
                    const grid = 'grid grid-cols-[28px_minmax(180px,2fr)_minmax(120px,1.2fr)_minmax(140px,1.3fr)_minmax(115px,1.1fr)_minmax(105px,1.1fr)_minmax(105px,1.1fr)_54px_minmax(105px,1.1fr)_minmax(105px,1.1fr)_28px] min-w-[960px]';
                    return (
                      <div className="mb-2">
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-[10px] text-gray-500">
                            <span className="font-semibold text-gray-800 text-xs">Reimbursement Lines</span>
                            <span className="ml-1.5">Sub-suppliers only affect Input PPN report</span>
                          </div>
                          <button type="button" onClick={addLine}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:text-blue-900">
                            <Plus className="w-3.5 h-3.5" /> Add Line
                          </button>
                        </div>

                        {brokerItems.length > 0 && (
                          <div className="border border-gray-300 rounded-md bg-white shadow-sm overflow-x-auto">
                            {/* Header row */}
                            <div className={`${grid} bg-gray-100 border-b border-gray-300 text-[10px] font-semibold text-gray-600 uppercase tracking-wide`}>
                              <div className="px-1 py-1 border-r border-gray-300 text-center flex items-center justify-center">#</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 flex items-center">Supplier</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 flex items-center">Invoice Number</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 flex items-center">Tax Invoice #</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 flex items-center">Invoice Date</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-right flex items-center justify-end">Amount</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-right flex items-center justify-end">DPP</div>
                              <div className="px-1 py-1 border-r border-gray-300 text-center flex items-center justify-center">PPN %</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-right flex items-center justify-end">PPN Amount</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-right flex items-center justify-end">Line Total</div>
                              <div className="px-0.5 py-1 text-center flex items-center justify-center">✕</div>
                            </div>
                            {brokerItems.map((item, idx) => {
                              // Line Total = Invoice Amount. DPP and PPN remain
                              // independent tax-reporting values.
                              const lineTotal = brokerLineTotal(item);
                              const taxBreakdownExceedsAmount = item.invoice_amount_authoritative === true
                                && (Number(item.amount) || 0) < (Number(item.dpp_amount) || 0) + (Number(item.ppn_amount) || 0);
                              const rateDisplay = item.ppn_rate ?? 0;
                              const isManual = item.ppn_treatment === 'included';
                              return (
                                <div key={idx}
                                  className={`${grid} items-stretch border-b border-gray-200 last:border-b-0 hover:bg-blue-50/40 group`}>
                                  <div className="border-r border-gray-200 flex items-center justify-center h-[28px] text-[11px] text-gray-500 font-medium">
                                    {idx + 1}
                                  </div>
                                  {/* Supplier */}
                                  <div className="border-r border-gray-200 [&_button]:!rounded-none [&_button]:!border-0 [&_button]:!shadow-none [&_button]:!bg-transparent [&_button]:!h-[28px] [&_button]:!py-0 [&_button]:!px-1.5 [&_button]:!text-[11px]">
                                    <SearchableSelect
                                      value={item.supplier_id || ''}
                                      onChange={(val) => updateLine(idx, { supplier_id: val || null })}
                                      options={supplierOptions}
                                      placeholder="Search..."
                                    />
                                  </div>
                                  {/* Invoice No */}
                                  <div className="border-r border-gray-200">
                                    <input name="invoice_number" aria-label="Enter invoice number" type="text" value={item.invoice_number || ''}
                                      onChange={(e) => updateLine(idx, { invoice_number: e.target.value })}
                                      className={cellInputCls} placeholder="Enter invoice number" />
                                  </div>
                                  {/* Tax Invoice # (Faktur Pajak) */}
                                  <div className="border-r border-gray-200">
                                    <input name="tax_invoice_number" aria-label="Faktur Pajak #" type="text" value={item.tax_invoice_number || ''}
                                      onChange={(e) => updateLine(idx, { tax_invoice_number: e.target.value })}
                                      className={cellInputCls} placeholder="Faktur Pajak #" title="Faktur Pajak number" />
                                  </div>
                                  {/* Invoice Date */}
                                  <div className="border-r border-gray-200">
                                    <input name="invoice_date" aria-label="Invoice Date" type="date" value={item.invoice_date || ''}
                                      onChange={(e) => updateLine(idx, { invoice_date: e.target.value })}
                                      className={cellInputCls + ' font-mono'} title="Select invoice date" />
                                  </div>
                                  {/* Amount — independent input */}
                                  <div className="border-r border-gray-200">
                                    <MoneyInput value={item.amount} placeholder="0.00"
                                      onChange={(amt) => updateLine(idx, { amount: amt })}
                                      className={cellInputCls + ' text-right font-mono'} />
                                  </div>
                                  {/* DPP — independent input; Auto mode PPN recomputes from this */}
                                  <div className="border-r border-gray-200">
                                    <MoneyInput value={item.dpp_amount ?? 0} placeholder="0.00"
                                      onChange={(v) => updateLine(idx, { dpp_amount: v })}
                                      className={cellInputCls + ' text-right font-mono text-gray-700'} />
                                  </div>
                                  {/* PPN % — typing 11 → PPN Amt = DPP × 11% (Auto) */}
                                  <div className="border-r border-gray-200">
                                    <input name="rate_display" aria-label="0" type="number" min="0" max="100" step="0.5"
                                      value={rateDisplay === 0 ? '' : rateDisplay}
                                      onChange={(e) => {
                                        const rate = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
                                        updateLine(idx, { ppn_rate: rate });
                                      }}
                                      className={cellInputCls + ' text-center font-mono'} placeholder="0" />
                                  </div>
                                  {/* PPN Amount — editing this flips row to Manual mode */}
                                  <div className="border-r border-gray-200 relative">
                                    <MoneyInput value={item.ppn_amount} placeholder="0.00"
                                      onChange={(v) => updateLine(idx, { ppn_amount: v })}
                                      className={cellInputCls + ` text-right font-mono ${isManual ? 'text-amber-700' : 'text-blue-700'}`}
                                      title={isManual ? 'Manual mode — edit DPP or PPN% to return to Auto' : 'Auto = DPP × PPN%'} />
                                    {isManual && (
                                      <span className="absolute right-1 top-0.5 text-[8px] font-bold text-amber-600 uppercase tracking-wide pointer-events-none">M</span>
                                    )}
                                  </div>
                                  {/* Total = Invoice Amount; mismatch is warning-only. */}
                                  <div
                                    className={`border-r border-gray-200 flex items-center justify-end gap-1 px-1.5 h-[28px] font-mono tabular-nums text-[11px] font-semibold ${taxBreakdownExceedsAmount ? 'text-amber-700' : 'text-gray-900'}`}
                                    title={taxBreakdownExceedsAmount ? 'Warning: Invoice Amount is lower than DPP + PPN. Values are preserved without adjustment.' : 'Line Total equals Invoice Amount'}
                                  >
                                    {taxBreakdownExceedsAmount && <AlertCircle className="w-3 h-3 flex-none" />}
                                    {lineTotal ? lineTotal.toLocaleString('id-ID') : ''}
                                  </div>
                                  {/* Delete */}
                                  <div className="flex items-center justify-center h-[28px]">
                                    <button type="button" onClick={() => removeLine(idx)}
                                      className="text-red-500 hover:text-red-700 p-0.5" title="Remove line" tabIndex={-1}>
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                            {/* Footer totals row */}
                            <div className={`${grid} bg-gray-50 border-t border-gray-300 text-[11px] font-semibold text-gray-700 h-[28px] items-center`}>
                              <div className="border-r border-gray-300 px-1 py-1 text-center h-full flex items-center justify-center"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1 h-full flex items-center">Reimbursement Total ({brokerItems.length})</div>
                              <div className="border-r border-gray-300 px-1.5 py-1 h-full flex items-center"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1 h-full flex items-center"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1 h-full flex items-center"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1 text-right font-mono tabular-nums text-gray-900 h-full flex items-center justify-end">{reimbAmount.toLocaleString('id-ID')}</div>
                              <div className="border-r border-gray-300 px-1.5 py-1 text-right font-mono tabular-nums text-gray-900 h-full flex items-center justify-end">{reimbDpp.toLocaleString('id-ID')}</div>
                              <div className="border-r border-gray-300 px-1 py-1 h-full flex items-center justify-center"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1 text-right font-mono tabular-nums text-blue-700 h-full flex items-center justify-end">{reimbPpn.toLocaleString('id-ID')}</div>
                              <div className="border-r border-gray-300 px-1.5 py-1 text-right font-mono tabular-nums text-gray-900 h-full flex items-center justify-end">{reimbAmount.toLocaleString('id-ID')}</div>
                              <div></div>
                            </div>
                          </div>
                        )}

                        {/* Payment Summary */}
                        {(() => {
                          const alreadyPaid = editingBankLines.reduce(
                            (sum, line) => sum + Number(line.allocation_amount ?? line.debit_amount ?? line.credit_amount ?? 0),
                            0,
                          );
                          const balance = Math.max(0, brokerTotals.finalCashPayable - alreadyPaid);
                          type FormulaCell = { label: string; value: number; valueColor: string; op?: string };
                          const cells: FormulaCell[] = [
                            { label: 'Broker Invoice Amount', value: brokerInvoiceAmount, valueColor: 'text-gray-900', op: '+' },
                            { label: 'Reimbursement Total',   value: reimbAmount,         valueColor: 'text-gray-900', op: '+' },
                            { label: 'Stamp Duty',            value: parentStamp,         valueColor: 'text-gray-900', op: '−' },
                            { label: 'PPh Withheld',          value: parentPph,           valueColor: 'text-orange-700' },
                          ];
                          return (
                            <div className="mt-1.5">
                              <div className="flex items-stretch border border-gray-200 rounded-lg bg-white overflow-x-auto">
                                {cells.map((cell, i) => (
                                  <div key={cell.label} className="flex items-stretch min-w-0">
                                    <div className={`flex flex-col justify-center px-2.5 py-1 min-w-[75px] ${i < cells.length - 1 ? 'border-r border-gray-200' : ''}`}>
                                      <span className="text-[9px] text-gray-400 font-medium whitespace-nowrap">{cell.label}</span>
                                      <span className={`text-[11px] font-bold font-mono mt-0.5 ${cell.valueColor}`}>{fmt(cell.value)}</span>
                                    </div>
                                    {cell.op && (
                                      <div className="flex items-center px-1 text-[11px] font-bold text-gray-400 border-r border-gray-200 bg-gray-50 select-none">{cell.op}</div>
                                    )}
                                  </div>
                                ))}
                                <div className="flex items-center px-1 text-[11px] font-bold text-gray-400 bg-gray-50 select-none">=</div>
                                <div className="flex flex-col justify-center px-3 py-1 bg-emerald-50 border-l-2 border-emerald-400 min-w-[100px]">
                                  <span className="text-[9px] font-bold text-emerald-700 uppercase tracking-wide">FINAL CASH PAYABLE</span>
                                  <span className="text-xs font-bold font-mono text-emerald-900 mt-0.5">{fmt(brokerTotals.finalCashPayable)}</span>
                                </div>
                                <div className="flex flex-col justify-center px-2.5 py-1 border-l border-gray-200 min-w-[85px]">
                                  <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wide">PAID</span>
                                  <span className="text-xs font-bold font-mono text-gray-900 mt-0.5">{fmt(alreadyPaid)}</span>
                                </div>
                                <div className="flex flex-col justify-center px-2.5 py-1 border-l border-gray-200 min-w-[85px]">
                                  <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wide">BALANCE</span>
                                  <span className={`text-xs font-bold font-mono mt-0.5 ${balance > 0.01 ? 'text-amber-700' : 'text-green-700'}`}>{fmt(balance)}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()}

                  {/* Non-broker payment summary — horizontal formula bar */}
                  {formData.expense_category !== 'import_broker' && !isPib && (formData.amount > 0 || formData.ppn_amount > 0 || formData.pph_amount > 0 || formData.stamp_duty_amount > 0 || (formData.bank_charges_amount || 0) > 0) && (() => {
                    const totals = calculateExpenseTotals(formData);
                    const bc = totals.bankChargesAmount;
                    const payable = totals.netPayable;
                    const settlementAmount = totals.settlementAmount;
                    const isAdd = formData.pph_treatment === 'add';
                    const pphAmount = Number(formData.pph_amount || 0);
                    const totalCashOutflow = totals.totalCashOutflow;
                    const alreadyPaid = Math.max(
                      editingBankLines.reduce(
                        (sum, line) => sum + Number(line.allocation_amount ?? line.debit_amount ?? line.credit_amount ?? 0),
                        0,
                      ),
                      Number(editingExpense?.paid_amount || 0)
                    );
                    const balance = Math.max(0, payable - alreadyPaid);
                    const fmt = (n: number) => formatCurrency(n, expenseFormCurrency, {
                      minimumFractionDigits: expenseFormCurrency === 'IDR' ? 0 : 2,
                      maximumFractionDigits: expenseFormCurrency === 'IDR' ? 0 : 2,
                    });
                    const isSalary = formData.expense_category === 'salary';
                    const bpjsDeduction = isSalary ? (Number(formData.bpjs_employee_deduction) || salaryCalculation?.bpjs_amount || 0) : 0;
                    type FormulaCell = { label: string; value: number; valueColor: string; op?: string; show: boolean };
                    const rawCells: Array<{ label: string; value: number; valueColor: string; isDeduction?: boolean; show: boolean }> = [
                      { label: isSalary ? 'Gross Salary' : 'Invoice Amount', value: formData.amount || 0, valueColor: 'text-gray-900', show: true },
                      { label: 'PPN', value: formData.ppn_amount || 0, valueColor: 'text-blue-700', show: (formData.ppn_amount || 0) > 0 },
                      { label: 'PPh Withheld', value: pphAmount, valueColor: 'text-orange-700', isDeduction: true, show: !isAdd && pphAmount > 0 },
                      { label: 'BPJS Withheld', value: bpjsDeduction, valueColor: 'text-amber-700', isDeduction: true, show: isSalary && bpjsDeduction > 0 },
                      { label: 'Stamp Duty', value: formData.stamp_duty_amount || 0, valueColor: 'text-gray-900', show: (formData.stamp_duty_amount || 0) > 0 },
                      { label: 'Bank Charges', value: bc, valueColor: 'text-gray-900', show: bc > 0 },
                    ].filter(c => c.show);
                    const cells: FormulaCell[] = rawCells.map((cell, idx) => {
                      const nextCell = rawCells[idx + 1];
                      const op = nextCell ? (nextCell.isDeduction ? '−' : '+') : undefined;
                      return { ...cell, op };
                    });
                    return (
                      <div className="mt-1.5 flex items-stretch border border-gray-200 rounded-lg bg-white overflow-x-auto">
                        {cells.map((cell, i) => (
                          <div key={cell.label} className="flex items-stretch min-w-0">
                            <div className={`flex flex-col justify-center px-2.5 py-1 min-w-[75px] ${i < cells.length - 1 ? 'border-r border-gray-200' : ''}`}>
                              <span className="text-[9px] text-gray-400 font-medium whitespace-nowrap">{cell.label}</span>
                              <span className={`text-[11px] font-bold font-mono mt-0.5 ${cell.valueColor}`}>{fmt(cell.value)}</span>
                            </div>
                            {cell.op && i < cells.length - 1 && (
                              <div className="flex items-center px-1 text-[11px] font-bold text-gray-400 border-r border-gray-200 bg-gray-50 select-none">{cell.op}</div>
                            )}
                          </div>
                        ))}
                        <div className="flex items-center px-1 text-[11px] font-bold text-gray-400 bg-gray-50 select-none">=</div>
                        <div className="flex flex-col justify-center px-3 py-1 bg-emerald-50 border-l-2 border-emerald-400 min-w-[100px]">
                          <span className="text-[9px] font-bold text-emerald-700 uppercase tracking-wide">NET PAYABLE</span>
                          <span className="text-xs font-bold font-mono text-emerald-900 mt-0.5">{fmt(payable)}</span>
                        </div>
                        {pphAmount > 0 && (
                          <div className="flex flex-col justify-center px-2.5 py-1 bg-orange-50 border-l border-orange-200 min-w-[105px]">
                            <span className="text-[9px] font-bold text-orange-700 uppercase tracking-wide">PPH {isAdd ? 'ADD (+)' : 'DEDUCT (-)'}</span>
                            <span className="text-xs font-bold font-mono text-orange-900 mt-0.5">{fmt(pphAmount)}</span>
                          </div>
                        )}
                        <div className="flex flex-col justify-center px-2.5 py-1 bg-purple-50 border-l border-purple-200 min-w-[115px]">
                          <span className="text-[9px] font-bold text-purple-700 uppercase tracking-wide">TOTAL CASH OUTFLOW</span>
                          <span className="text-xs font-bold font-mono text-purple-900 mt-0.5">{fmt(totalCashOutflow)}</span>
                        </div>
                        {bc > 0 && (
                          <div className="flex flex-col justify-center px-2.5 py-1 bg-blue-50 border-l-2 border-blue-400 min-w-[110px]">
                            <span className="text-[9px] font-bold text-blue-700 uppercase tracking-wide">BANK SETTLEMENT</span>
                            <span className="text-xs font-bold font-mono text-blue-900 mt-0.5">{fmt(settlementAmount)}</span>
                          </div>
                        )}
                        <div className="flex flex-col justify-center px-2.5 py-1 border-l border-gray-200 min-w-[85px]">
                          <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wide">PAID</span>
                          <span className="text-xs font-bold font-mono text-gray-900 mt-0.5">{fmt(alreadyPaid)}</span>
                        </div>
                        <div className="flex flex-col justify-center px-2.5 py-1 border-l border-gray-200 min-w-[85px]">
                          <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wide">BALANCE</span>
                          <span className={`text-xs font-bold font-mono mt-0.5 ${balance > 0.01 ? 'text-amber-700' : 'text-green-700'}`}>{fmt(balance)}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* ── Bottom two-column: Payment (L) + Attachments (R) ── */}
            <div className="grid grid-cols-2 items-start gap-x-4 pt-1">
              {/* LEFT: Payment */}
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Payment</p>

                <FloatingField label="Method" required error={fieldErrors.payment_method} span={12} filled={!!formData.payment_method || formData.payment_method === null}>
                  <select name="payment_method" aria-label="Payment Method" value={formData.payment_method ?? 'outstanding'}
                    onChange={(e) => {
                      const val = e.target.value === 'outstanding' ? null : e.target.value;
                      setFieldErrors(prev => ({ ...prev, payment_method: '', bank_account_id: '' }));
                      setFormData(prev => ({ ...prev, payment_method: val, bank_account_id: val ? prev.bank_account_id : '' }));
                      if (!e.target.value || e.target.value === 'outstanding') {
                        setSelectedBankTransactionId('');
                        setSelectedBankAllocationAmount(undefined);
                      }
                    }}
                    className={SAP_INPUT} required>
                    <option value="outstanding">⏳ Outstanding / Pay Later (A/P 2110)</option>
                    <option value="bank_transfer">🏦 Bank Transfer</option>
                    <option value="check">📝 Cheque</option>
                    <option value="giro">📋 Giro</option>
                    <option value="other">📌 Other</option>
                  </select>
                </FloatingField>
                {(formData.payment_method === null || formData.payment_method === 'outstanding') && (
                  <p className="text-[9px] text-amber-700 -mt-1 font-medium">⏳ Unpaid expense: Dr Expense, Cr Accounts Payable (2110). Zero bank credit until actual payment is recorded.</p>
                )}
                {formData.payment_method === 'bank_transfer' && (
                  <p className="text-[9px] text-blue-700 -mt-1 font-medium">🏦 Bank Transfer: Expense payable is recognized to A/P 2110. Bank is credited when reconciled with bank line or payment voucher.</p>
                )}
                {(formData.payment_method === 'check' || formData.payment_method === 'giro') && (
                  <p className="text-[9px] text-purple-700 -mt-1 font-medium">📝 Cheque/Giro: Recognized to A/P 2110. Settled when payment voucher is posted.</p>
                )}
                {formData.payment_method === 'other' && (
                  <p className="text-[9px] text-gray-600 -mt-1 font-medium">📌 Other: Recognized to Accounts Payable (A/P 2110).</p>
                )}
                <p className="text-[9px] text-gray-400 -mt-1">💡 For cash payments: record as Outstanding (A/P 2110), then record disbursement in Petty Cash Manager or Payment Voucher.</p>

                {formData.payment_method !== null && (
                  <FloatingField label="Bank Account" required error={fieldErrors.bank_account_id} span={12} filled={!!formData.bank_account_id}>
                    <select name="bank_account_id" aria-label="Bank Account Id" value={formData.bank_account_id}
                      onChange={(e) => {
                        setFieldErrors(prev => ({ ...prev, bank_account_id: '' }));
                        const bank = bankAccounts.find(item => item.id === e.target.value);
                        const currency = normalizeCurrency(bank?.currency) as 'IDR' | 'USD';
                        setFormData({ ...formData, bank_account_id: e.target.value, transaction_currency: currency,
                          exchange_rate: currency === 'IDR' ? 1 : formData.exchange_rate });
                        setSelectedBankTransactionId('');
                        setSelectedBankAllocationAmount(undefined);
                      }}
                      className={SAP_INPUT} required={formData.payment_method !== null}>
                      <option value="">Select account</option>
                      {bankAccounts.map(bank => <option key={bank.id} value={bank.id}>{bank.bank_name} — {bank.alias || bank.account_number}</option>)}
                    </select>
                  </FloatingField>
                )}

                {formData.payment_method === null && (
                  <FloatingField label="Transaction Currency" required span={12} filled={!!formData.transaction_currency}>
                    <select name="transaction_currency" aria-label="Transaction Currency" value={formData.transaction_currency}
                      onChange={(e) => setFormData({ ...formData,
                        transaction_currency: e.target.value as 'IDR' | 'USD',
                        exchange_rate: e.target.value === 'IDR' ? 1 : formData.exchange_rate })}
                      className={SAP_INPUT}>
                      <option value="IDR">IDR</option>
                      <option value="USD">USD</option>
                    </select>
                  </FloatingField>
                )}

                {formData.payment_method !== null && formData.bank_account_id && (
                  <BankTransactionLinkField
                    bankAccountId={formData.bank_account_id}
                    selectedTransactionId={selectedBankTransactionId}
                    linkedTransaction={editingBankLines[0] || null}
                    linkedTransactions={editingBankLines}
                    currentExpenseId={editingExpense?.id}
                    documentDate={formData.expense_date}
                    documentOutstanding={calculateCanonicalCashPayable({ ...formData, broker_items: brokerItems })}
                    documentTotal={calculateCanonicalCashPayable({ ...formData, broker_items: brokerItems })}
                    documentLabel={editingExpense?.voucher_number || 'Expense'}
                    disabled={editingExpense?.approval_status !== 'approved'}
                    disabledMessage="Bank transaction linking is available after expense approval."
                    canUnlink={canManage}
                    onSelect={async (transaction, confirmedAmount) => {
                      const existingLines = editingBankLines;
                      if (editingExpense && existingLines.length > 0 && !existingLines.some((line) => ((line as any).raw_line_id || line.id) === transaction.id)) {
                        const existingTotal = existingLines.reduce((sum, line) => sum + Number(line.payment_kind === 'pph23' ? 0 : line.allocation_amount ?? line.debit_amount ?? line.credit_amount ?? 0), 0);
                        const outstanding = Math.max(0, calculateCanonicalCashPayable({ ...formData, broker_items: brokerItems }) - existingTotal);
                        const amount = confirmedAmount !== undefined && confirmedAmount > 0.01
                          ? confirmedAmount
                          : Math.min(Number(transaction.remainingAmount ?? transaction.debit_amount ?? transaction.credit_amount ?? 0), outstanding);
                        await linkBankTransaction({ bankStatementLineId: transaction.id, matchedExpenseId: editingExpense.id, allocationAmount: amount });
                        await syncExpenseBankLinks([editingExpense.id]);
                        notifyFinanceReconciliationRefresh();
                        return;
                      }
                      setSelectedBankTransactionId(transaction.id);
                      setFormData(prev => ({
                        ...prev,
                        payment_method: 'bank_transfer',
                        bank_account_id: prev.bank_account_id || (transaction as any).bank_account_id || formData.bank_account_id,
                      }));
                      if (confirmedAmount !== undefined && confirmedAmount > 0.01) {
                        setSelectedBankAllocationAmount(confirmedAmount);
                      } else {
                        const bankRemaining = Number(transaction.remainingAmount ?? transaction.debit_amount ?? transaction.credit_amount ?? 0);
                        const cashPayable = calculateCanonicalCashPayable({ ...formData, broker_items: brokerItems });
                        const existingLinkedTotal = existingLines.reduce(
                          (sum, line) => sum + Number(line.payment_kind === 'pph23' ? 0 : line.allocation_amount ?? line.debit_amount ?? line.credit_amount ?? 0),
                          0,
                        );
                        const docRemaining = existingLines.length > 0
                          ? Math.max(0, cashPayable - existingLinkedTotal)
                          : cashPayable;
                        const calcAmount = Math.min(bankRemaining, docRemaining);
                        setSelectedBankAllocationAmount(calcAmount > 0.01 ? calcAmount : undefined);
                      }
                    }}
                    onUnlink={() => handleUnlinkFromBankStatement(editingExpense!.id)}
                    onUnlinkTransaction={async (line) => {
                      if (!editingExpense) return;
                      if (!confirm('Unlink this bank transaction from the expense?')) return;
                      if (line.allocation_id) {
                        await unlinkBankStatementAllocation(line.allocation_id);
                        await syncExpenseBankLinks([editingExpense.id]);
                        notifyFinanceReconciliationRefresh();
                      } else {
                        const lineId = (line as any).raw_line_id || line.id;
                        await unlinkBankTransaction(lineId);
                        await syncExpenseBankLinks([editingExpense.id]);
                        notifyFinanceReconciliationRefresh();
                      }
                      const updatedLines = await fetchExpenseBankLinks(editingExpense.id);
                      const { data: updatedExp } = await supabase
                        .from('finance_expenses')
                        .select(`
                          *,
                          batches (batch_number),
                          import_containers (container_ref),
                          delivery_challans (challan_number),
                          bank_accounts (bank_name, account_number),
                          salary_advance_applications (
                            id,
                            applied_amount,
                            advance_payment_voucher_id,
                            settlement_payment_voucher_id
                          ),
                          voucher_allocations (
                            id,
                            allocated_amount,
                            payment_kind,
                            payment_vouchers (voucher_number, voucher_date, payment_purpose)
                          )
                        `)
                        .eq('id', editingExpense.id)
                        .single();
                      if (updatedExp) {
                        const merged = { ...updatedExp, bank_statement_lines: updatedLines };
                        setEditingExpense(merged);
                        setExpenses(prev => prev.map(exp => exp.id === editingExpense.id ? merged : exp));
                        if (viewingExpense?.id === editingExpense.id) {
                          setViewingExpense(merged);
                        }
                      }
                    }}
                  />
                )}

                {formData.payment_method === null && formData.due_date && (
                  <div className="p-2 bg-amber-50 border border-amber-200 rounded text-xs">
                    <span className="font-semibold text-amber-800">Due: </span>
                    <span className="text-amber-900">{formatDate(formData.due_date)}</span>
                    <span className="ml-1.5 text-[9px] text-amber-600">Settle via Payment Voucher</span>
                  </div>
                )}

              </div>

              {/* RIGHT: Attachments */}
              <FinanceDocumentAttachments
                documentUrls={formData.document_urls}
                pendingFiles={uploadingFiles}
                onDocumentUrlsChange={(document_urls) => setFormData((previous) => ({ ...previous, document_urls }))}
                onPendingFilesChange={setUploadingFiles}
                active={modalOpen}
                compact
              />
            </div>

          </form>
        </FinanceModal>
      )}

      {/* Quick Add Supplier Modal — redesigned with type, PKP, terms */}
      {showQuickAddSupplier && (
        <Modal isOpen={showQuickAddSupplier} onClose={() => { setShowQuickAddSupplier(false); setQuickAddSupplierName(''); }} title="Quick Add Supplier" size="sm">
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Minimum info. Fill full details in Suppliers Master later.</p>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Company Name <span className="text-red-500">*</span></label>
              <input name="quick_add_supplier_name" aria-label="e.g. PT. Mitra Logistik Indonesia" type="text" value={quickAddSupplierName} autoFocus
                onChange={(e) => setQuickAddSupplierName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleQuickAddSupplier(); } }}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm"
                placeholder="e.g. PT. Mitra Logistik Indonesia" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Supplier Type</label>
              <select name="supplier_type" aria-label="Supplier Type" value={quickAddSupplierType}
                onChange={(e) => {
                  const st = e.target.value;
                  setQuickAddSupplierType(st);
                  const cfg = SUPPLIER_TYPES.find(t => t.value === st);
                  if (cfg) setQuickAddSupplierTerms(cfg.paymentTerms);
                }}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm">
                {SUPPLIER_TYPES.map(st => <option key={st.value} value={st.value}>{st.label}</option>)}
              </select>
              {quickAddSupplierType && (() => {
                const cfg = SUPPLIER_TYPES.find(t => t.value === quickAddSupplierType);
                return cfg ? (
                  <p className="text-[9px] text-gray-500 mt-0.5">→ Tax: {cfg.taxPreference.replace(/_/g,' ')} · Category: {cfg.defaultCategory}</p>
                ) : null;
              })()}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">PKP Registered</label>
                <div className="flex gap-2 mt-1.5">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="radio" name="qs_pkp" checked={quickAddSupplierPKP} onChange={() => setQuickAddSupplierPKP(true)} /> Yes
                  </label>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="radio" name="qs_pkp" checked={!quickAddSupplierPKP} onChange={() => setQuickAddSupplierPKP(false)} /> No
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Payment Terms (days)</label>
                <input name="payment_terms_days" aria-label="Payment Terms (days)" type="number" min="0" value={quickAddSupplierTerms}
                  onChange={(e) => setQuickAddSupplierTerms(parseInt(e.target.value) || 0)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => { setShowQuickAddSupplier(false); setQuickAddSupplierName(''); }}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={handleQuickAddSupplier}
                disabled={!quickAddSupplierName.trim() || quickAddSupplierLoading}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5" />
                {quickAddSupplierLoading ? 'Adding...' : 'Add Supplier'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {!embeddedModalOnly && (
        <>
          {/* Finance Health Check slide-over panel */}
          {healthCheckOpen && (
        <div className="fixed right-0 top-0 h-full w-80 bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-orange-600" />
              <span className="text-sm font-semibold text-gray-800">Finance Health Check</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={loadHealthCheck} className="text-xs text-blue-600 hover:text-blue-800" title="Refresh">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setHealthCheckOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {healthLoading ? (
              <div className="text-sm text-gray-500 text-center py-8">Checking...</div>
            ) : healthIssues.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
                <p className="text-sm text-green-700 font-medium">No issues found</p>
                <p className="text-xs text-gray-400 mt-1">Finance data looks healthy</p>
              </div>
            ) : (
              <div className="space-y-2">
                {healthIssues.map(issue => (
                  <div key={issue.key} className={`flex items-start gap-3 p-2.5 rounded border text-xs ${
                    issue.severity === 'error' ? 'bg-red-50 border-red-200' :
                    issue.severity === 'warning' ? 'bg-amber-50 border-amber-200' :
                    'bg-blue-50 border-blue-200'
                  }`}>
                    <span className={`font-bold text-base leading-none ${
                      issue.severity === 'error' ? 'text-red-600' :
                      issue.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'
                    }`}>{issue.count}</span>
                    <span className={`leading-tight ${
                      issue.severity === 'error' ? 'text-red-800' :
                      issue.severity === 'warning' ? 'text-amber-800' : 'text-blue-800'
                    }`}>{issue.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="px-4 py-3 border-t text-[10px] text-gray-400 text-center">
            Read-only — no data is modified
          </div>
        </div>
      )}

      {viewModalOpen && viewingExpense && (() => {
        const currency = getExpenseCurrency(viewingExpense);
        const fmtMoney = (n: number | null | undefined, decimals: 0 | 2 = 0) => {
          return formatCurrency(n, currency, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          });
        };
        const canonicalExpenseTotal = calculateCanonicalExpenseTotal(viewingExpense);
        const canonicalCashPayable = calculateCanonicalCashPayable(viewingExpense);
        const isBroker = viewingExpense.expense_category === 'import_broker';
        const isSalary = viewingExpense.expense_category === 'salary';
        const salaryAdvanceApplied = isSalary
          ? salaryAdvanceApplications.reduce((sum, application) => sum + Number(application.applied_amount || 0), 0)
          : 0;
        const salaryPaidAmount = Number(viewingExpense.paid_amount || 0);
        const salaryCashPaid = Math.max(salaryPaidAmount - salaryAdvanceApplied, 0);
        const salaryOutstanding = Math.max(canonicalCashPayable - salaryPaidAmount, 0);
        const staffName = (() => {
          const rules = getCategoryFieldRules(viewingExpense.expense_category);
          if (rules.staff !== 'show' || !viewingExpense.staff_id) return null;
          const staff = staffRoster.find(s => s.id === viewingExpense.staff_id);
          return staff?.full_name ?? null;
        })();
        const simplifiedViewingStatus = getSimplifiedExpenseStatus(viewingExpense);
        const approvalBadge = () => {
          if (simplifiedViewingStatus.approval === 'Approved') {
            return (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-50 text-green-700 border border-green-200">
                <CheckCircle className="w-3 h-3" /> Approved
              </span>
            );
          }
          if (viewingExpense.effective_posting_state === 'REJECTED') {
            return (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200">
                <XCircle className="w-3 h-3" /> Rejected
              </span>
            );
          }
          return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
              <AlertCircle className="w-3 h-3" /> Pending
            </span>
          );
        };

        // Tax rows (non-broker)
        const taxRows: Array<{ label: string; value: number; tint: string }> = [];
        if (!isBroker) {
          const isAdd = viewingExpense.pph_treatment === 'add';
          const pphCode = viewingExpense.pph_code_id ? taxCodes.find(t => t.id === viewingExpense.pph_code_id) : null;
          const pphLabel = pphCode
            ? `${isAdd ? 'PPh (Add-on)' : 'PPh Withheld'} · ${pphCode.tax_type}${pphCode.rate ? ` @ ${pphCode.rate}%` : ''}`
            : (isAdd ? 'PPh (Add-on)' : 'PPh Withheld');
          if ((viewingExpense.ppn_amount || 0) > 0) taxRows.push({ label: 'PPN', value: viewingExpense.ppn_amount || 0, tint: 'text-blue-700' });
          if ((viewingExpense.pph_amount || 0) > 0) taxRows.push({ label: pphLabel, value: isAdd ? (viewingExpense.pph_amount || 0) : -(viewingExpense.pph_amount || 0), tint: 'text-orange-700' });
          if ((viewingExpense.stamp_duty_amount || 0) > 0) taxRows.push({ label: 'Stamp Duty', value: viewingExpense.stamp_duty_amount || 0, tint: 'text-gray-700' });
          if ((viewingExpense.bank_charges_amount || 0) > 0) taxRows.push({ label: 'Bank Charges', value: viewingExpense.bank_charges_amount || 0, tint: 'text-gray-700' });
          if ((viewingExpense.pib_bm_amount || 0) > 0) taxRows.push({ label: 'Import Duty (BM)', value: viewingExpense.pib_bm_amount || 0, tint: 'text-gray-700' });
          if ((viewingExpense.pib_ppn_amount || 0) > 0) taxRows.push({ label: 'PPN Import', value: viewingExpense.pib_ppn_amount || 0, tint: 'text-blue-700' });
          if ((viewingExpense.pib_pph_amount || 0) > 0) taxRows.push({ label: 'PPh 22 Import', value: viewingExpense.pib_pph_amount || 0, tint: 'text-orange-700' });
        }
        const expenseTotals = !isBroker ? calculateExpenseTotals(viewingExpense) : null;
        const netPayable = expenseTotals?.netPayable || 0;

        // Broker totals
        const brokerTotals = isBroker ? calculateBrokerExpenseTotals(viewingExpense) : null;

        // Payment breakdown
        const allocs = viewingExpense.voucher_allocations || [];
        const bslLines = normalizeExpenseBankLinks(viewingExpense.bank_statement_lines || []);
        const hasPaymentBreakdown = allocs.length > 0 || bslLines.length > 0;
        const supplierPaid = viewingExpense.paid_amount ?? 0;
        const pphTarget = viewingExpense.pph_amount || 0;
        const pphPaid = viewingExpense.pph_paid_amount ?? 0;
        const balance = canonicalCashPayable - supplierPaid;

        // Related records
        const hasRelated = viewingExpense.batches || viewingExpense.import_containers || viewingExpense.delivery_challans;

        return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-screen items-center justify-center p-4">
            <div className="fixed inset-0 bg-gray-900/50" onClick={() => { setViewModalOpen(false); setViewingExpense(null); setLinkedDCQuickView(null); }} />
            <div className="relative bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
              {/* Floating close button — no header bar */}
              <button
                type="button"
                onClick={() => { setViewModalOpen(false); setViewingExpense(null); setLinkedDCQuickView(null); }}
                className="absolute top-3 right-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/90 border border-gray-200 shadow-sm hover:bg-gray-100 transition"
                title="Close"
                aria-label="Close"
              >
                <X className="w-4 h-4 text-gray-600" />
              </button>

              <div className="flex-1 overflow-y-auto">
          {/* ═══ ONE UNIFIED CONTAINER ═══ */}
          <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">

            {/* ── HEADER (document header — first card) ── */}
            <div className="px-4 pt-4 pb-2.5 bg-gray-50 border-b border-gray-200">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600 text-white">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-[17px] font-semibold text-gray-900 leading-tight">
                      {viewingExpense.voucher_number || 'Expense'}
                    </h2>
                    <p className="text-[11px] text-gray-500 mt-0">
                      {expenseCategories.find(c => c.value === viewingExpense.expense_category)?.label || viewingExpense.expense_category}
                      {viewingExpense.invoice_number && (
                        <span className="ml-1.5 text-gray-400">·</span>
                      )}
                      {viewingExpense.invoice_number && (
                        <span className="ml-1.5 font-mono text-gray-600">{viewingExpense.invoice_number}</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="text-right">
                    <div className="text-[9px] uppercase font-medium text-gray-400 tracking-wide">
                      {isSalary ? 'Gross Salary' : isBroker ? 'Accounting Expense (P&L)' : 'Total'}
                    </div>
                    <div className="text-[19px] font-bold text-gray-900 font-mono leading-tight">
                      {fmtMoney(canonicalExpenseTotal, 2)}
                    </div>
                    {isBroker && (
                      <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                        Cash Payable: <span className="font-semibold text-green-700">{fmtMoney(canonicalCashPayable, 2)}</span>
                      </div>
                    )}
                    <div className="mt-0.5">{approvalBadge()}</div>
                  </div>
                </div>
              </div>
              {/* Header meta row */}
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-0.5">
                <div>
                  <span className="text-[9px] uppercase font-medium text-gray-400">Invoice Date</span>
                  <span className="ml-1.5 text-[12px] font-medium text-gray-800">{formatDate(viewingExpense.expense_date)}</span>
                </div>
                {viewingExpense.due_date && (
                  <div>
                    <span className="text-[9px] uppercase font-medium text-gray-400">Due</span>
                    <span className="ml-1.5 text-[12px] font-medium text-gray-800">{formatDate(viewingExpense.due_date)}</span>
                  </div>
                )}
                {viewingExpense.suppliers && (
                  <div>
                    <span className="text-[9px] uppercase font-medium text-gray-400">Supplier</span>
                    <span className="ml-1.5 text-[12px] font-medium text-gray-800">{viewingExpense.suppliers.company_name}</span>
                  </div>
                )}
                {viewingExpense.payee_id && (
                  <div>
                    <span className="text-[9px] uppercase font-medium text-gray-400">Payee</span>
                    <span className="ml-1.5 text-[12px] font-medium text-purple-800">
                      {payeeRoster.find(p => p.id === viewingExpense.payee_id)?.full_name || (viewingExpense as any).payees?.full_name || 'Individual Payee'}
                    </span>
                  </div>
                )}
                {staffName && (
                  <div>
                    <span className="text-[9px] uppercase font-medium text-gray-400">Employee</span>
                    <span className="ml-1.5 text-[12px] font-medium text-gray-800">{staffName}</span>
                  </div>
                )}
              </div>
              {viewingExpense.posting_lifecycle && (
                <div className="mt-2 rounded border border-gray-200 bg-white px-2.5 py-2 text-[10px] text-gray-600">
                  <div className="font-semibold text-gray-700">Journal / reversal history</div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono">
                    {viewingExpense.posting_lifecycle.active_journal_number && <span>Active: {viewingExpense.posting_lifecycle.active_journal_number}</span>}
                    {viewingExpense.posting_lifecycle.original_journal_number && <span>Original: {viewingExpense.posting_lifecycle.original_journal_number}</span>}
                    {viewingExpense.posting_lifecycle.reversal_journal_id && <span>Reversal ID: {viewingExpense.posting_lifecycle.reversal_journal_id}</span>}
                    {viewingExpense.posting_lifecycle.replacement_journal_number && <span className="text-indigo-700">Effective replacement: {viewingExpense.posting_lifecycle.replacement_journal_number}</span>}
                    {viewingExpense.posting_lifecycle.ambiguity_reason && <span className="text-orange-700">Review: {viewingExpense.posting_lifecycle.ambiguity_reason}</span>}
                  </div>
                </div>
              )}
            </div>

            {/* ── SUMMARY ── */}
            <div className="px-4 py-2 border-b border-gray-100">
              <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                <div>
                  <div className="text-[9px] uppercase font-medium text-gray-400">Category</div>
                  <div className="text-[12px] font-medium text-gray-800">
                    {expenseCategories.find(c => c.value === viewingExpense.expense_category)?.label || viewingExpense.expense_category}
                  </div>
                </div>
                {viewingExpense.suppliers && (
                  <div>
                    <div className="text-[9px] uppercase font-medium text-gray-400">Supplier</div>
                    <div className="text-[12px] font-medium text-gray-800">{viewingExpense.suppliers.company_name}</div>
                  </div>
                )}
                {viewingExpense.payee_id && (
                  <div>
                    <div className="text-[9px] uppercase font-medium text-gray-400">Payee</div>
                    <div className="text-[12px] font-medium text-purple-800">
                      {payeeRoster.find(p => p.id === viewingExpense.payee_id)?.full_name || (viewingExpense as any).payees?.full_name || 'Individual Payee'}
                    </div>
                  </div>
                )}
                {viewingExpense.linked_sales_invoice_id && (
                  <div>
                    <div className="text-[9px] uppercase font-medium text-gray-400">Sales Invoice</div>
                    <div className="text-[12px] font-medium text-blue-800 font-mono">
                      {salesInvoices.find(si => si.id === viewingExpense.linked_sales_invoice_id)?.invoice_number || (viewingExpense as any).sales_invoices?.invoice_number || 'Linked Invoice'}
                    </div>
                  </div>
                )}
                {staffName && (
                  <div>
                    <div className="text-[9px] uppercase font-medium text-gray-400">Employee</div>
                    <div className="text-[12px] font-medium text-gray-800">{staffName}</div>
                  </div>
                )}
                <div>
                  <div className="text-[9px] uppercase font-medium text-gray-400">{isSalary ? 'Gross Salary Amount' : 'Expense Amount'}</div>
                  <div className="text-[12px] font-medium text-gray-800 font-mono">{fmtMoney(viewingExpense.amount, 2)}</div>
                </div>
                {viewingExpense.payment_reference && (
                  <div>
                    <div className="text-[9px] uppercase font-medium text-gray-400">Reference</div>
                    <div className="text-[12px] font-medium text-gray-800 font-mono">{viewingExpense.payment_reference}</div>
                  </div>
                )}
                {viewingExpense.description && (
                  <div className="col-span-2 md:col-span-4">
                    <div className="text-[9px] uppercase font-medium text-gray-400">Description</div>
                    <div className="text-[11px] text-gray-600 whitespace-pre-wrap leading-snug">{viewingExpense.description}</div>
                  </div>
                )}
              </div>
            </div>

            {/* ── BROKER SUMMARY (only for broker) ── */}
            {isBroker && brokerTotals && (() => {
              const rows: Array<[string, number, string]> = [
                ['Broker Invoice (DPP/Fee)', brokerTotals.brokerInvoiceAmount, 'text-gray-900'],
                ['Reimbursements Gross', brokerTotals.reimbursementTotal, 'text-gray-900'],
                ['Reimbursement DPP', brokerTotals.reimbursementDpp, 'text-gray-700'],
                ['Recoverable PPN (Asset)', brokerTotals.recoverableInputPpn, 'text-blue-700 font-semibold'],
                ['PPh 23 Withheld', brokerTotals.pph23Withheld, 'text-orange-700 font-semibold'],
                ['Stamp Duty', brokerTotals.stampDuty, 'text-gray-700'],
                ['Accounting Expense (P&L)', brokerTotals.accountingExpenseTotal, 'text-gray-900 font-bold'],
              ];
              return (
                <div className="px-4 py-2 border-b border-gray-100">
                  <div className="flex items-center justify-between mb-1.5">
                    <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Broker Invoice Summary</h3>
                    <span className="text-[10px] text-gray-400 italic">Accounting expense excludes recoverable PPN Masukan</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                    {rows.map(([label, value, tint]) => (
                      <div key={label}>
                        <div className="text-[9px] uppercase font-medium text-gray-400">{label}</div>
                        <div className={`text-[12px] font-medium font-mono ${tint}`}>{fmtMoney(value)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between border-t border-gray-100 pt-1.5">
                    <div>
                      <span className="text-[10px] font-semibold text-green-700 uppercase tracking-wide">Final Cash Payable (to Supplier)</span>
                      <span className="text-[10px] text-gray-400 ml-2">(Gross − PPh 23 Withheld)</span>
                    </div>
                    <span className="text-[15px] font-bold font-mono text-green-800">{fmtMoney(brokerTotals.finalCashPayable, 2)}</span>
                  </div>
                </div>
              );
            })()}

            {isSalary && (
              <div className="px-4 py-2 border-b border-gray-100 space-y-2">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Salary Settlement Summary</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                  {[
                    ['Gross Salary', Number(viewingExpense.amount || 0)],
                    ['Salary Advance Applied', salaryAdvanceApplied],
                    [viewingExpense.pph_treatment === 'add' ? 'PPh 21 (Add-on)' : 'PPh21 Deduction', Number(viewingExpense.pph_amount || 0)],
                    ['Employee BPJS Deduction', Number(viewingExpense.bpjs_employee_deduction || 0)],
                    ['Net Payable to Employee', Math.max(canonicalCashPayable - salaryAdvanceApplied, 0)],
                    ['Actual Payment', salaryCashPaid],
                    ['Outstanding Balance', salaryOutstanding],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <div className="text-[9px] uppercase font-medium text-gray-400">{label}</div>
                      <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(Number(value))}</div>
                    </div>
                  ))}
                </div>

                {/* Company BPJS Contribution Breakdown (separate from employee deduction) */}
                <div className="mt-2 p-2.5 bg-blue-50/60 border border-blue-200 rounded text-xs">
                  <div className="flex items-center justify-between font-semibold text-blue-900 mb-1">
                    <span>BPJS Ketenagakerjaan Integration</span>
                    <span className="text-[10px] text-blue-700 font-normal">
                      Payroll Period: {viewingExpense.payroll_period_year && viewingExpense.payroll_period_month ? `${viewingExpense.payroll_period_year}-${String(viewingExpense.payroll_period_month).padStart(2, '0')}` : 'Unallocated'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                    <div className="p-1.5 bg-white rounded border border-blue-100">
                      <span className="text-gray-500 block text-[10px]">Employee Deduction (Withheld)</span>
                      <span className="font-mono font-bold text-amber-900">
                        {fmtMoney(Number(viewingExpense.bpjs_employee_deduction || 0))}
                      </span>
                      <span className="block text-[9px] text-gray-400">JHT 2.0% deducted from salary</span>
                    </div>
                    <div className="p-1.5 bg-white rounded border border-blue-100">
                      <span className="text-gray-500 block text-[10px]">Employer Contribution (Company Cost)</span>
                      <span className="font-mono font-bold text-purple-900">
                        {fmtMoney(Math.round(Number(viewingExpense.amount || 0) * 0.0424))}
                      </span>
                      <span className="block text-[9px] text-gray-400">JHT 3.7% + JKK 0.24% + JKM 0.3% (NOT deducted)</span>
                    </div>
                    <div className="p-1.5 bg-white rounded border border-blue-100">
                      <span className="text-gray-500 block text-[10px]">Total BPJS Payable</span>
                      <span className="font-mono font-bold text-emerald-900">
                        {fmtMoney(Number(viewingExpense.bpjs_employee_deduction || 0) + Math.round(Number(viewingExpense.amount || 0) * 0.0424))}
                      </span>
                      <span className="block text-[9px] text-gray-400">Settled via monthly BPJS register</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── TAX SECTION (only if tax rows exist) ── */}
            {taxRows.length > 0 && !isSalary && (
              <div className="px-4 py-2 border-b border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Tax Summary</h3>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] uppercase font-medium text-gray-400">Invoice</span>
                    <span className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(viewingExpense.amount)}</span>
                  </div>
                  {taxRows.map((row) => (
                    <div key={row.label} className="flex items-center gap-1">
                      <span className="text-gray-300 text-sm font-light">{row.value < 0 ? '−' : '+'}</span>
                      <span className="text-[9px] uppercase font-medium text-gray-400">{row.label}</span>
                      <span className={`text-[12px] font-medium font-mono ${row.tint}`}>{fmtMoney(Math.abs(row.value))}</span>
                    </div>
                  ))}
                  <span className="text-gray-300 text-sm font-light">=</span>
                  <div className="flex items-center gap-1.5 px-2 py-0.5 border border-green-200 bg-green-50 rounded">
                    <span className="text-[9px] font-semibold text-green-700 uppercase">Net Payable</span>
                    <span className="text-[12px] font-bold font-mono text-green-800">{fmtMoney(netPayable, 2)}</span>
                  </div>
                  {expenseTotals && expenseTotals.bankChargesAmount > 0 && (
                    <div className="flex items-center gap-1.5 px-2 py-0.5 border border-blue-200 bg-blue-50 rounded">
                      <span className="text-[9px] font-semibold text-blue-700 uppercase">Actual Bank Settlement Amount</span>
                      <span className="text-[12px] font-bold font-mono text-blue-800">{fmtMoney(expenseTotals.settlementAmount, 2)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── SALARY ADVANCE APPLICATIONS (only for salary with advances) ── */}
            {isSalary && salaryAdvanceApplications.length > 0 && (
              <div className="px-4 py-2 border-b border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Salary Advance Applications</h3>
                <div className="space-y-1">
                  {salaryAdvanceApplications.map((application) => (
                    <div key={application.application_id} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-[11px]">
                      <span className="text-gray-700">
                        Advance {application.advance_voucher_number || application.advance_payment_voucher_id} → Settlement {application.settlement_voucher_number || application.settlement_payment_voucher_id}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-gray-900">{fmtMoney(application.applied_amount)}</span>
                        {onViewPaymentVoucher && (
                          <button type="button" onClick={() => onViewPaymentVoucher(application.settlement_payment_voucher_id)} className="text-blue-600 hover:underline text-[11px] font-medium">View Payment</button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── BROKER REIMBURSEMENT TABLE ── */}
            {viewingExpense.broker_items && viewingExpense.broker_items.length > 0 && (
              <div className="px-4 py-2 border-b border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Reimbursement Lines</h3>
                <div className="overflow-x-auto rounded border border-gray-200">
                  <table className="w-full text-[11px]">
                    <thead className="bg-gray-50 text-[9px] uppercase text-gray-500">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">Supplier</th>
                        <th className="px-2 py-1 text-left font-medium">Invoice No</th>
                        <th className="px-2 py-1 text-left font-medium">Tax Invoice</th>
                        <th className="px-2 py-1 text-left font-medium">Date</th>
                        <th className="px-2 py-1 text-right font-medium">Invoice Amount</th>
                        <th className="px-2 py-1 text-right font-medium">DPP</th>
                        <th className="px-2 py-1 text-right font-medium">PPN %</th>
                        <th className="px-2 py-1 text-right font-medium">PPN Amount</th>
                        <th className="px-2 py-1 text-right font-medium">Payable Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingExpense.broker_items.map((item, i) => {
                        const total = brokerLineTotal(item);
                        const supplierName = item.supplier_id ? suppliers.find(s => s.id === item.supplier_id)?.company_name : null;
                        return (
                          <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                            <td className="px-2 py-1 text-gray-700 truncate max-w-[120px]">{supplierName || '—'}</td>
                            <td className="px-2 py-1 text-gray-600 font-mono">{item.invoice_number || '—'}</td>
                            <td className="px-2 py-1 text-gray-600 font-mono">{item.tax_invoice_number || '—'}</td>
                            <td className="px-2 py-1 text-gray-600 font-mono">{formatDate(item.invoice_date || '')}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-900">{fmtMoney(item.amount || 0)}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-700">{fmtMoney(item.dpp_amount ?? 0)}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-600">{Number(item.ppn_rate || 0).toLocaleString('id-ID')}%</td>
                            <td className="px-2 py-1 text-right font-mono text-blue-700">{fmtMoney(item.ppn_amount || 0)}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-900 font-medium">{fmtMoney(total)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-200 bg-gray-50">
                        <td colSpan={8} className="px-2 py-1 text-right text-[10px] font-semibold text-gray-600 uppercase">Total Payable</td>
                        <td className="px-2 py-1 text-right font-mono font-bold text-gray-900">
                          {fmtMoney(viewingExpense.broker_items.reduce((sum, item) => sum + brokerLineTotal(item), 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* ── SALES ORDER ALLOCATION TABLE ── */}
            {viewingExpense.sales_order_allocations && viewingExpense.sales_order_allocations.length > 0 && (
              <div className="px-4 py-2 border-b border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Sales Order Allocations (Multi-SO Profitability)</h3>
                <div className="overflow-x-auto rounded border border-gray-200">
                  <table className="w-full text-[11px]">
                    <thead className="bg-gray-50 text-[9px] uppercase text-gray-500">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">SO Number</th>
                        <th className="px-2 py-1 text-left font-medium">Customer</th>
                        <th className="px-2 py-1 text-right font-medium">SO Total</th>
                        <th className="px-2 py-1 text-right font-medium">Allocated Expense</th>
                        <th className="px-2 py-1 text-right font-medium">% of Expense</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingExpense.sales_order_allocations.map((item, i) => {
                        const pct = viewingExpense.amount > 0 ? ((item.allocated_amount || 0) / viewingExpense.amount) * 100 : 0;
                        return (
                          <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                            <td className="px-2 py-1 font-mono font-medium text-blue-700">{item.so_number || '—'}</td>
                            <td className="px-2 py-1 text-gray-700 truncate max-w-[160px]">{item.customer_name || '—'}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-700">{fmtMoney(item.total_amount || 0)}</td>
                            <td className="px-2 py-1 text-right font-mono font-bold text-gray-900">{fmtMoney(item.allocated_amount || 0)}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-600">{pct.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-200 bg-gray-50">
                        <td colSpan={3} className="px-2 py-1 text-right text-[10px] font-semibold text-gray-600 uppercase">Total Allocated</td>
                        <td className="px-2 py-1 text-right font-mono font-bold text-gray-900">
                          {fmtMoney(viewingExpense.sales_order_allocations.reduce((sum, item) => sum + (Number(item.allocated_amount) || 0), 0))}
                        </td>
                        <td className="px-2 py-1 text-right font-mono font-bold text-gray-900">100%</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* ── PAYMENT + BANK RECONCILIATION (2-col on desktop) ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 border-b border-gray-100">
              {/* Payment */}
              <div className="px-4 py-2 md:border-r border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Payment</h3>
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] uppercase font-medium text-gray-400">Method</span>
                    {viewingExpense.payment_method ? (
                      <span className="text-[12px] font-medium text-gray-800 capitalize">{viewingExpense.payment_method.replace('_', ' ')}</span>
                    ) : bslLines.length > 0 ? (
                      <span className="text-[12px] font-medium text-gray-800 capitalize">Bank Transfer</span>
                    ) : allocs.length > 0 && balance <= 0 ? (
                      <span className="text-[12px] font-medium text-gray-800 capitalize">Voucher Settlement</span>
                    ) : balance <= 0 ? (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold text-green-700 bg-green-50 border border-green-200 rounded">Settled</span>
                    ) : (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded">A/P Outstanding</span>
                    )}
                  </div>
                  {(() => {
                    const bankAcc = viewingExpense.bank_accounts ?? bslLines[0]?.bank_accounts;
                    if (!bankAcc) return null;
                    return (
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] uppercase font-medium text-gray-400">Bank</span>
                        <span className="text-[11px] font-medium text-gray-800">
                          {bankAcc.alias || bankAcc.bank_name} · {bankAcc.account_number}
                          {bankAcc.currency && bankAcc.currency !== 'IDR' && (
                            <span className="ml-1 text-[10px] text-gray-500 font-semibold">({bankAcc.currency})</span>
                          )}
                        </span>
                      </div>
                    );
                  })()}
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] uppercase font-medium text-gray-400">Paid</span>
                    <span className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(supplierPaid)}</span>
                  </div>
                  {canonicalCashPayable > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] uppercase font-medium text-gray-400">Balance</span>
                      <span className={`text-[12px] font-bold font-mono ${balance > 0 ? 'text-red-600' : 'text-green-700'}`}>{fmtMoney(balance)}</span>
                    </div>
                  )}
                </div>

                {/* Payment breakdown lines */}
                {hasPaymentBreakdown && (
                  <div className="mt-1.5 pt-1.5 border-t border-gray-100 space-y-0.5">
                    {(() => {
                      const badge = (paid: number, target: number) => {
                        if (target <= 0) return null;
                        if (paid <= 0) return <span className="text-[9px] px-1 py-0.5 rounded bg-gray-100 text-gray-600">Pending</span>;
                        if (paid >= target - 1) return <span className="text-[9px] px-1 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">Paid</span>;
                        return <span className="text-[9px] px-1 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">Partial</span>;
                      };
                      return (
                        <>
                          {(canonicalCashPayable > 0 || supplierPaid > 0) && (
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-gray-600">Supplier</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-gray-800">{fmtMoney(supplierPaid)} / {fmtMoney(canonicalCashPayable)}</span>
                                {badge(supplierPaid, canonicalCashPayable)}
                              </div>
                            </div>
                          )}
                          {(pphTarget > 0 || pphPaid > 0) && (
                            <div className="flex items-center justify-between text-[11px]">
                              <div>
                                <span className="text-gray-600">PPh Withholding</span>
                                <span className="text-[9px] text-gray-400 ml-1">(Payable to Tax Office)</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-gray-800">{fmtMoney(pphPaid)} / {fmtMoney(pphTarget)}</span>
                                {badge(pphPaid, pphTarget)}
                              </div>
                            </div>
                          )}
                          {(allocs.length > 0 || (allocs.length + bslLines.length) > 1) && (
                            <div className="mt-1 overflow-x-auto">
                              <table className="w-full text-[10px]">
                                <thead className="text-gray-500 text-[9px] uppercase">
                                  <tr className="border-t border-gray-100">
                                    <th className="text-left font-medium py-0.5">Date</th>
                                    <th className="text-left font-medium py-0.5">Ref</th>
                                    <th className="text-right font-medium py-0.5">Amount</th>
                                    <th className="text-right font-medium py-0.5">Kind</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {allocs.map((a) => {
                                    const vDate = a.payment_vouchers?.voucher_date || a.payment_vouchers?.payment_date;
                                    const isSettlement = a.payment_vouchers?.payment_purpose === 'salary_advance_settlement' || a.payment_kind === 'salary_advance_settlement';
                                    const kindLabel = isSettlement ? 'Advance Recovery' : (a.payment_kind || 'supplier');
                                    return (
                                      <tr key={`va-${a.id}`} className="border-t border-gray-100">
                                        <td className="py-0.5 text-gray-700">{vDate ? formatDate(vDate) : '—'}</td>
                                        <td className="py-0.5 text-gray-700 font-mono">{a.payment_vouchers?.voucher_number || 'PV'}</td>
                                        <td className="py-0.5 text-right font-mono">{fmtMoney(a.allocated_amount)}</td>
                                        <td className="py-0.5 text-right text-gray-500 capitalize">{kindLabel}</td>
                                      </tr>
                                    );
                                  })}
                                  {bslLines.map((b) => {
                                    const lineCurrency = b.bank_accounts?.currency ?? currency;
                                    const lineAmount = Number(b.allocation_amount ?? ((b.debit_amount || 0) + (b.credit_amount || 0)));
                                    const fmtLine = (n: number) => formatCurrency(n, lineCurrency, { minimumFractionDigits: lineCurrency === 'IDR' ? 0 : 2, maximumFractionDigits: lineCurrency === 'IDR' ? 0 : 2 });
                                    return (
                                      <tr key={`bsl-${b.id}`} className="border-t border-gray-100">
                                        <td className="py-0.5 text-gray-700">{formatDate(b.transaction_date)}</td>
                                        <td className="py-0.5 text-gray-700 truncate max-w-[100px]">{b.description || 'Bank'}</td>
                                        <td className="py-0.5 text-right font-mono">{fmtLine(lineAmount)}</td>
                                        <td className="py-0.5 text-right text-gray-500 capitalize">{b.payment_kind || 'supplier'}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* Bank Reconciliation */}
              <div className="px-4 py-2 bg-gray-50/50">
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Bank Reconciliation</h3>
                  {(() => {
                    if (simplifiedViewingStatus.isCash) {
                      return (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                          {viewingExpense.payment_method === 'petty_cash' ? 'Petty Cash' : 'Cash Payment'}
                        </span>
                      );
                    }
                    if (bslLines.length > 0) {
                      return (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-50 text-green-700 border border-green-200">
                          <CheckCircle className="w-2.5 h-2.5" /> Linked
                        </span>
                      );
                    }
                    return (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600 border border-gray-200">
                        Unlinked
                      </span>
                    );
                  })()}
                </div>

                {bankLinkError ? (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">
                    <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                    <span>{bankLinkError}</span>
                  </div>
                ) : simplifiedViewingStatus.isCash ? (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-blue-50/50 border border-blue-200 rounded text-[11px] text-blue-800">
                    <Banknote className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                    <span>Settled via {viewingExpense.payment_method === 'petty_cash' ? 'Petty Cash' : 'Cash'} — no bank statement reconciliation required.</span>
                  </div>
                ) : bslLines.length > 0 ? (
                  <div className="space-y-1.5">
                    {bslLines.map((line) => {
                      const lineCurrency = line.bank_accounts?.currency ?? currency;
                      const fmtLine = (n: number) => formatCurrency(n, lineCurrency);
                      const bankAmount = line.debit_amount || line.credit_amount || 0;
                      const linkedAmount = Number(line.allocation_amount ?? bankAmount);
                      const remainingBankAmount = Math.max(0, bankAmount - linkedAmount);
                      const bankAccountName = line.bank_accounts
                        ? `${line.bank_accounts.alias || line.bank_accounts.bank_name}${line.bank_accounts.account_number ? ` · ${line.bank_accounts.account_number}` : ''}`
                        : (viewingExpense.bank_accounts ? `${viewingExpense.bank_accounts.alias || viewingExpense.bank_accounts.bank_name}` : '—');
                      const bankDescRef = [line.reference, line.description].filter(Boolean).join(' · ') || line.description || line.reference || '—';

                      return (
                        <div key={line.id} className="px-2.5 py-2 bg-white border border-gray-200 rounded-md shadow-2xs space-y-1">
                          <div className="flex items-center justify-between border-b border-gray-100 pb-1">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-green-50 text-green-700 border border-green-200">
                              <CheckCircle className="w-2.5 h-2.5" /> Linked
                            </span>
                            <span className="text-[11px] font-medium text-gray-700">
                              {bankAccountName}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] uppercase font-medium text-gray-400">Date</span>
                              <span className="text-gray-800 font-medium">{formatDate(line.transaction_date)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] uppercase font-medium text-gray-400">Allocated Amount</span>
                              <span className="font-mono font-bold text-emerald-700">{fmtLine(linkedAmount)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] uppercase font-medium text-gray-400">Bank Txn Total</span>
                              <span className="font-mono text-gray-700">{fmtLine(bankAmount)}</span>
                            </div>
                            {bankAmount > linkedAmount + 0.01 && (
                              <div className="flex items-center justify-between">
                                <span className="text-[9px] uppercase font-medium text-gray-400">Line Balance</span>
                                <span className="font-mono text-amber-600">{fmtLine(remainingBankAmount)}</span>
                              </div>
                            )}
                            <div className="col-span-2 flex items-start gap-1 pt-0.5">
                              <span className="text-[9px] uppercase font-medium text-gray-400 shrink-0">Ref / Desc:</span>
                              <span className="text-gray-700 break-words font-mono text-[10px] leading-tight">{bankDescRef}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-500">
                    <Link2 className="w-3.5 h-3.5 text-gray-400" />
                    Not linked to a bank transaction
                  </div>
                )}
              </div>
            </div>

            {/* ── DOCUMENTS + RELATED RECORDS (2-col on desktop) ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 border-b border-gray-100">
              {/* Documents */}
              <div className="px-4 py-2 md:border-r border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  Documents {viewingExpense.document_urls && viewingExpense.document_urls.length > 0 && `(${viewingExpense.document_urls.length})`}
                </h3>
                {viewingExpense.document_urls && viewingExpense.document_urls.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2">
                    {viewingExpense.document_urls.map((url, index) => {
                      const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(url);
                      const fileName = url.split('/').pop()?.split('?')[0] || `Document ${index + 1}`;
                      return (
                        <div key={index} className="border border-gray-200 rounded overflow-hidden hover:border-blue-300 hover:shadow-sm transition-all">
                          {isImage ? (
                            <div className="cursor-pointer" onClick={() => openDocument(url)}>
                              <img
                                src={signedUrlCache[url] || url}
                                alt={fileName}
                                className="w-full h-16 object-cover border-b border-gray-200"
                              />
                            </div>
                          ) : (
                            <div className="h-16 flex items-center justify-center bg-gray-50 border-b border-gray-200">
                              <FileText className="w-6 h-6 text-gray-400" />
                            </div>
                          )}
                          <div className="px-1.5 py-1">
                            <p className="text-[10px] text-gray-700 font-medium truncate" title={fileName}>{fileName}</p>
                            <div className="mt-0.5 flex items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => openDocument(url)}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium text-blue-600 hover:bg-blue-50 rounded"
                              >
                                <Eye className="w-2.5 h-2.5" /> View
                              </button>
                              <button
                                type="button"
                                onClick={() => downloadDocument(url, fileName)}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium text-gray-600 hover:bg-gray-100 rounded"
                              >
                                <Download className="w-2.5 h-2.5" /> DL
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded text-[11px] text-gray-500">
                    <FileText className="w-3.5 h-3.5 text-gray-400" />
                    No documents attached
                  </div>
                )}
              </div>

              {/* Related Records */}
              <div className="px-4 py-2 bg-gray-50/50">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Related Records</h3>
                {hasRelated ? (
                  <div className="flex flex-wrap gap-1.5">
                    {viewingExpense.batches && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gray-200 text-[11px] text-gray-700">
                        <Package className="w-3 h-3 text-gray-500" /> Batch {viewingExpense.batches.batch_number}
                      </span>
                    )}
                    {viewingExpense.import_containers && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gray-200 text-[11px] text-gray-700">
                        <Package className="w-3 h-3 text-gray-500" /> {viewingExpense.import_containers.container_ref}
                      </span>
                    )}
                    {viewingExpense.delivery_challans && (
                      <button
                        type="button"
                        onClick={openLinkedDCQuickView}
                        disabled={linkedDCQuickViewLoading}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gray-200 text-[11px] text-blue-600 hover:bg-blue-50 hover:border-blue-300 disabled:opacity-50"
                      >
                        <Truck className="w-3 h-3" /> DC {viewingExpense.delivery_challans.challan_number}
                        {linkedDCQuickViewLoading && ' …'}
                      </button>
                    )}
                    {viewingExpense.voucher_number && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gray-200 text-[11px] text-gray-700">
                        <Clipboard className="w-3 h-3 text-gray-500" /> {viewingExpense.voucher_number}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-500">
                    <Link2 className="w-3.5 h-3.5 text-gray-400" />
                    No related records
                  </div>
                )}
              </div>
            </div>

            {/* ── ACCOUNTING SUMMARY (collapsible, hidden by default) ── */}
            <div className="border-b border-gray-100">
                  <button
                    type="button"
                    onClick={() => setAccountingExpanded(!accountingExpanded)}
                    className="w-full px-4 py-1.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                      <Banknote className="w-3.5 h-3.5 text-gray-400" />
                      Accounting Impact
                    </span>
                    <span className="text-gray-400 text-[10px]">{accountingExpanded ? 'Collapse' : 'Expand'}</span>
                  </button>
                  {accountingExpanded && (
                    (viewingExpense.effective_posting_state === 'ACTIVE' || viewingExpense.effective_posting_state === 'REPLACED') ? (
                    <div className="px-4 pb-2 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                      <div>
                        <div className="text-[9px] uppercase font-medium text-gray-400">Expenses (P&L)</div>
                        <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(canonicalExpenseTotal)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase font-medium text-gray-400">Cash Paid</div>
                        <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(supplierPaid)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase font-medium text-gray-400">Liabilities (A/P)</div>
                        <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(Math.max(0, balance))}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase font-medium text-gray-400">Assets (Recoverable)</div>
                        <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(viewingExpense.ppn_amount || 0)}</div>
                      </div>
                    </div>
                    ) : (
                      <div className="px-4 pb-2 text-[11px] text-gray-600">
                        {viewingExpense.effective_posting_state === 'REVERSED'
                            ? 'The journal for this expense has been reversed. Original and reversal history remain available in the audit views.'
                            : 'Accounting impact is not presented because the effective posting state requires review.'}
                      </div>
                    )
                  )}
                </div>

            {/* ── FOOTER ── */}
            <div className="px-4 py-2 flex justify-end gap-2">
              {canManage && viewingExpense.approval_status !== 'cancelled' && (
                <button
                  onClick={() => { handleEdit(viewingExpense); setViewModalOpen(false); setViewingExpense(null); }}
                  className="px-2.5 py-1 text-[11px] font-medium text-blue-700 bg-white border border-blue-300 rounded hover:bg-blue-50"
                >
                  Edit
                </button>
              )}
              <button
                onClick={() => { setViewModalOpen(false); setViewingExpense(null); setLinkedDCQuickView(null); }}
                className="px-2.5 py-1 text-[11px] font-medium bg-gray-700 text-white rounded hover:bg-gray-800"
              >
                Close
              </button>
            </div>
          </div>

          {/* Linked DC Quick View overlay */}
          {linkedDCQuickView && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-xl bg-white shadow-2xl">
                <div className="flex items-center justify-between border-b px-5 py-3">
                  <h4 className="text-[16px] font-semibold text-gray-900">
                    Delivery Challan {linkedDCQuickView.challan.challan_number}
                  </h4>
                  <button
                    type="button"
                    onClick={() => setLinkedDCQuickView(null)}
                    className="rounded-lg p-1 text-gray-500 hover:bg-gray-100"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="space-y-4 overflow-y-auto p-5 text-sm">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-[11px] uppercase font-medium text-gray-400">Date</div>
                      <div className="text-[15px] font-medium text-gray-800">{formatDate(linkedDCQuickView.challan.challan_date)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase font-medium text-gray-400">Customer</div>
                      <div className="text-[15px] font-medium text-gray-800">{linkedDCQuickView.challan.customers?.company_name || '—'}</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase font-medium text-gray-400 mb-2">Items</div>
                    {linkedDCQuickView.items.length === 0 ? (
                      <div className="text-gray-500 text-sm">No items found.</div>
                    ) : (
                      <div className="overflow-x-auto rounded-lg border border-gray-200">
                        <table className="min-w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-3 py-2 text-left font-semibold text-gray-600">Product</th>
                              <th className="px-3 py-2 text-left font-semibold text-gray-600">Batch</th>
                              <th className="px-3 py-2 text-right font-semibold text-gray-600">Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {linkedDCQuickView.items.map((item) => (
                              <tr key={item.id} className="border-t border-gray-100">
                                <td className="px-3 py-2 text-gray-700">{item.products?.product_name || '—'}</td>
                                <td className="px-3 py-2 text-gray-700">{item.batches?.batch_number || '—'}</td>
                                <td className="px-3 py-2 text-right font-mono text-gray-800">{Number(item.quantity || 0).toLocaleString('id-ID')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          </div>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Unpost / Cancel Posting modal */}
      {cancelPostingModalOpen && cancelPostingTarget && (
        <Modal isOpen={cancelPostingModalOpen} onClose={closeCancelPostingModal} title="Unpost Expense" size="sm">
          <div className="space-y-4">
            <div className={`${cancelPostingBlock ? 'bg-red-50 border-red-200 text-red-800' : 'bg-orange-50 border-orange-200 text-orange-800'} border rounded-lg p-3 text-sm`}>
              <p className="font-semibold mb-1">{cancelPostingTarget.expense_category} — {formatCurrency(calculateCanonicalExpenseTotal(cancelPostingTarget), getExpenseCurrency(cancelPostingTarget))}</p>
              {cancelPostingBlock ? (
                <p>{cancelPostingBlock.message}</p>
              ) : (
                <>
                  <p>This preserves the original journal, creates its auditable reversal journal, and marks the expense cancelled.</p>
                  <p className="mt-1 text-xs flex items-center gap-1"><Lock className="w-3 h-3" /> Available only for unpaid expenses in an open accounting period.</p>
                </>
              )}
            </div>
            {!cancelPostingBlock && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason <span className="text-red-500">*</span></label>
                <textarea name="cancel_posting_reason" aria-label="Reason for unposting..."
                  value={cancelPostingReason}
                  onChange={e => setCancelPostingReason(e.target.value)}
                  rows={3}
                  placeholder="Reason for unposting..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500"
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={closeCancelPostingModal} className="h-7 px-2 text-xs border border-gray-300 rounded hover:bg-gray-50">Back</button>
              {cancelPostingBlock?.paymentVoucherId && onViewPaymentVoucher && (
                <button
                  type="button"
                  onClick={() => { const id = cancelPostingBlock.paymentVoucherId!; closeCancelPostingModal(); onViewPaymentVoucher(id); }}
                  className="h-7 px-2 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50"
                >
                  Open Payment Voucher
                </button>
              )}
              {cancelPostingBlock?.bankStatementLineId && (
                <button
                  type="button"
                  onClick={() => void handleCancelPostingBankUnlink()}
                  disabled={cancelPostingLoading}
                  className="h-7 px-2 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
                >
                  {cancelPostingLoading ? 'Checking...' : 'Unlink Bank Reconciliation'}
                </button>
              )}
              {!cancelPostingBlock && (
                <button
                  onClick={handleCancelPostingConfirm}
                  disabled={!cancelPostingReason.trim() || cancelPostingLoading}
                  className="h-7 px-2 text-xs bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {cancelPostingLoading ? 'Unposting...' : 'Unpost Expense'}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Rejection reason modal */}
      {rejectionModalOpen && (
        <Modal isOpen={rejectionModalOpen} onClose={() => { setRejectionModalOpen(false); setRejectionReason(''); }} title="Reject Expense" size="sm">
          <div className="space-y-4">
            <p className="text-sm text-gray-600">Please provide a reason for rejecting this expense entry.</p>
            <textarea name="rejection_reason" aria-label="Reason for rejection..."
              value={rejectionReason}
              onChange={e => setRejectionReason(e.target.value)}
              rows={3}
              placeholder="Reason for rejection..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setRejectionModalOpen(false); setRejectionReason(''); }} className="h-7 px-2 text-xs border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
              <button
                onClick={handleRejectExpenseConfirm}
                disabled={!rejectionReason.trim() || !!approvalLoading}
                className="h-7 px-2 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        </Modal>
      )}
        </>
      )}
    </div>
  );
}
