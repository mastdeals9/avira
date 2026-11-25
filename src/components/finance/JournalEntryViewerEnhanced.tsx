import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useLanguage } from '../../contexts/LanguageContext';
import { Search, Landmark, Link2, CheckCircle2 } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { formatCurrency } from '../../utils/currency';
import { FinanceActionButton } from './FinanceUI';
import { useFinance } from '../../contexts/FinanceContext';
import { linkBankStatementLine } from '../../services/financeCommands';
import {
  loadUnmatchedDebitBankTransactions,
  notifyFinanceReconciliationRefresh,
} from './bankTransactionLinking';

interface JournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  source_module: string | null;
  reference_id?: string | null;
  reference_number: string | null;
  description: string | null;
  total_debit: number;
  total_credit: number;
  is_posted: boolean;
  is_reversed?: boolean;
  is_cancelled?: boolean;
  cancellation_reason?: string | null;
  cancellation_group_id?: string | null;
  replacement_journal_id?: string | null;
  cancellation_source_reference?: string | null;
  cancelled_at?: string | null;
  posted_at: string;
  transaction_currency?: string | null;
  functional_currency?: string | null;
  exchange_rate?: number | null;
  amounts_are_functional?: boolean | null;
}

interface JournalEntryLine {
  id: string;
  line_number: number;
  account_id: string;
  description: string | null;
  debit: number;
  credit: number;
  transaction_currency?: string | null;
  transaction_debit?: number | null;
  transaction_credit?: number | null;
  chart_of_accounts?: {
    code: string;
    name: string;
  };
  customers?: { company_name: string } | null;
  suppliers?: { company_name: string } | null;
  payees?: { full_name: string } | null;
  staff?: { full_name: string } | null;
}

interface LinkedBankAllocation {
  id: string;
  allocation_amount: number;
  payment_kind: string;
  created_at: string;
  totalLineAmount?: number;
  totalAllocated?: number;
  remainingUnallocated?: number;
  bank_statement_lines: {
    id: string;
    transaction_date: string;
    description: string;
    reference: string | null;
    debit_amount: number;
    credit_amount: number;
    reconciliation_status: string;
    matching_status: string;
    bank_account_id: string;
    bank_accounts: {
      id: string;
      bank_name: string;
      account_name: string;
      account_number: string;
      currency: string;
      coa_id: string;
    } | null;
  } | null;
}

interface VoucherJournalEntry {
  journal_entry_id: string;
  date: string;
  voucher_no: string;
  voucher_type: string;
  debit_account: string;
  credit_account: string;
  amount: number;
  narration: string;
  reference_number: string | null;
  source_module: string | null;
  reference_id?: string | null;
  is_posted: boolean;
  is_reversed: boolean;
  is_cancelled?: boolean;
  cancellation_reason?: string | null;
  line_count: number;
  is_multi_line: boolean;
  transaction_currency?: string | null;
  transaction_amount?: number | null;
  has_bank_gl?: boolean;
}

interface JournalEntryViewerEnhancedProps {
  canManage: boolean;
  onEditEntry?: (entryId: string) => void;
  initialViewEntryId?: string | null;
  onInitialViewHandled?: () => void;
  onOpenSource?: (sourceModule: string, referenceId: string) => void;
}

const sourceModuleKey: Record<string, string> = {
  sales_invoice: 'journalSales',
  sales_invoice_cogs: 'journalSales',
  sales_invoice_cogs_adjustment: 'journalSales',
  purchase_invoice: 'purchase',
  receipt: 'receipt',
  payment: 'payment',
  petty_cash: 'journalPettyCash',
  fund_transfer: 'journalFundTransfer',
  fund_transfers: 'journalFundTransfer',
  bank_reconciliation: 'journalBankReconciliation',
  tax_payment: 'journalTax',
  expense: 'journalExpense',
  expenses: 'journalExpense',
  manual: 'journalManual',
};

const sourceFilters = [
  { value: 'all', label: 'All Sources' },
  { value: 'sales_invoice', label: 'Sales Invoices' },
  { value: 'sales_invoice_cogs', label: 'COGS' },
  { value: 'sales_invoice_cogs_adjustment', label: 'COGS Adjustments' },
  { value: 'purchase_invoice', label: 'Purchase Invoices' },
  { value: 'receipt', label: 'Receipts' },
  { value: 'payment', label: 'Payments' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'petty_cash', label: 'Petty Cash' },
  { value: 'fund_transfers', label: 'Fund Transfers' },
  { value: 'bank_reconciliation', label: 'Bank Reconciliation' },
  { value: 'tax_payment', label: 'Tax Payments' },
  { value: 'loans', label: 'Loans' },
  { value: 'loan_transactions', label: 'Loan Repayments' },
  { value: 'capital_contribution', label: 'Capital Contributions' },
  { value: 'manual', label: 'Manual' },
];
export function JournalEntryViewerEnhanced({
  canManage,
  onEditEntry,
  initialViewEntryId,
  onInitialViewHandled,
  onOpenSource,
}: JournalEntryViewerEnhancedProps) {
  const { t, language } = useLanguage();
  const { dateRange } = useFinance();
  const [voucherEntries, setVoucherEntries] = useState<VoucherJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);
  const [entryLines, setEntryLines] = useState<JournalEntryLine[]>([]);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [sourceSummary, setSourceSummary] = useState<string | null>(null);
  const [filterModule, setFilterModule] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'posted' | 'all' | 'draft' | 'reversed' | 'cancelled'>('posted');
  const [bankAllocations, setBankAllocations] = useState<LinkedBankAllocation[]>([]);
  const [loadingBankAllocations, setLoadingBankAllocations] = useState(false);
  const [showLinkBankModal, setShowLinkBankModal] = useState(false);
  const [candidateBankLines, setCandidateBankLines] = useState<any[]>([]);
  const [loadingCandidateBankLines, setLoadingCandidateBankLines] = useState(false);
  const [selectedCandidateBankLineId, setSelectedCandidateBankLineId] = useState('');
  const [linkingBankAllocationAmount, setLinkingBankAllocationAmount] = useState(0);
  const [submittingBankLink, setSubmittingBankLink] = useState(false);
  const [allBankAccounts, setAllBankAccounts] = useState<any[]>([]);
  const [candidateSearchTerm, setCandidateSearchTerm] = useState('');
  const sourceLabel = (sourceModule: string | null | undefined) => {
    if (!sourceModule) return t.finance.journalManual;
    const key = sourceModuleKey[sourceModule];
    return key ? t(`finance.${key}`) : sourceModule.replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
  };

  useEffect(() => {
    loadVoucherJournal();
  }, [filterModule, statusFilter, language, dateRange.startDate, dateRange.endDate]);

  const loadVoucherJournal = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      // The unified register reads the journal table directly so every source
      // module (including bank reconciliation and tax) shares one visibility
      // contract. Draft/reversed rows are opt-in through the status filter.
      const entryPageSize = 500;
      const entries: JournalEntry[] = [];
      for (let from = 0; ; from += entryPageSize) {
        let query = supabase
          .from('journal_entries')
          .select('id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, is_cancelled, cancellation_reason, cancellation_group_id, replacement_journal_id, cancellation_source_reference, cancelled_at, posted_at, transaction_currency, functional_currency, exchange_rate, amounts_are_functional')
          .gte('entry_date', dateRange.startDate)
          .lte('entry_date', dateRange.endDate)
          .order('entry_date', { ascending: false })
          .order('entry_number', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + entryPageSize - 1);
        if (statusFilter === 'posted') query = query.eq('is_posted', true).or('is_reversed.eq.false,is_reversed.is.null');
        if (statusFilter === 'draft') query = query.eq('is_posted', false).or('is_reversed.eq.false,is_reversed.is.null');
        if (statusFilter === 'reversed') query = query.eq('is_reversed', true);
        if (statusFilter === 'cancelled') query = query.eq('is_cancelled', true);
        const { data: entryPage, error } = await query;
        if (error) throw error;
        entries.push(...(entryPage || []));
        if (!entryPage || entryPage.length < entryPageSize) break;
      }

      // In active 'posted' view, explicitly exclude cancelled journals from financial register
      const filteredEntries = statusFilter === 'posted'
        ? entries.filter(e => !e.is_cancelled)
        : statusFilter === 'reversed'
        ? entries.filter(e => !e.is_cancelled)
        : entries;

      const entryIds = filteredEntries.map(e => e.id);
      // PostgREST encodes `.in(...)` values in the request URL. Loading every
      // journal ID in one request eventually exceeds the URL limit and makes
      // the master register fail with HTTP 400. Batching also keeps each line
      // result below the API's per-request row cap.
      const lineBatchSize = 100;
      const lineBatches: string[][] = [];
      for (let index = 0; index < entryIds.length; index += lineBatchSize) {
        lineBatches.push(entryIds.slice(index, index + lineBatchSize));
      }
      const lineResults = await Promise.all(lineBatches.map(batch =>
        supabase
          .from('journal_entry_lines')
          .select('journal_entry_id, account_id, debit, credit, transaction_debit, transaction_credit, chart_of_accounts(code, name)')
          .in('journal_entry_id', batch)
          .order('line_number')
      ));
      const failedLineBatch = lineResults.find(result => result.error);
      if (failedLineBatch?.error) throw failedLineBatch.error;
      const lines = lineResults.flatMap(result => result.data || []);
      const linesByEntry = new Map<string, Array<{ account_id: string; debit: number; credit: number; transaction_debit: number; transaction_credit: number; chart_of_accounts?: { code: string; name: string } | null }>>();
      (lines || []).forEach((line: any) => {
        const list = linesByEntry.get(line.journal_entry_id) || [];
        list.push({ account_id: line.account_id, debit: Number(line.debit || 0), credit: Number(line.credit || 0),
          transaction_debit: Number(line.transaction_debit || 0), transaction_credit: Number(line.transaction_credit || 0),
          chart_of_accounts: line.chart_of_accounts });
        linesByEntry.set(line.journal_entry_id, list);
      });
      // Resolve canonical voucher references for receipt and payment vouchers
      const receiptRefIds = Array.from(new Set(
        entries
          .filter(e => (e.source_module === 'receipt' || e.source_module === 'receipt_voucher' || e.source_module === 'customer_receipt') && Boolean(e.reference_id))
          .map(e => e.reference_id as string)
      ));
      const paymentRefIds = Array.from(new Set(
        entries
          .filter(e => (e.source_module === 'payment' || e.source_module === 'payment_voucher' || e.source_module === 'supplier_payment') && Boolean(e.reference_id))
          .map(e => e.reference_id as string)
      ));

      const canonicalRefMap = new Map<string, string>();

      if (receiptRefIds.length > 0) {
        for (let i = 0; i < receiptRefIds.length; i += 100) {
          const chunk = receiptRefIds.slice(i, i + 100);
          const { data: rvData } = await supabase
            .from('receipt_vouchers')
            .select('id, voucher_number')
            .in('id', chunk);
          (rvData || []).forEach((rv: any) => {
            if (rv.voucher_number) {
              canonicalRefMap.set(`receipt:${rv.id}`, rv.voucher_number);
            }
          });
        }
      }

      if (paymentRefIds.length > 0) {
        for (let i = 0; i < paymentRefIds.length; i += 100) {
          const chunk = paymentRefIds.slice(i, i + 100);
          const { data: pvData } = await supabase
            .from('payment_vouchers')
            .select('id, voucher_number')
            .in('id', chunk);
          (pvData || []).forEach((pv: any) => {
            if (pv.voucher_number) {
              canonicalRefMap.set(`payment:${pv.id}`, pv.voucher_number);
            }
          });
        }
      }

      setVoucherEntries(filteredEntries.map(entry => {
        const entryLines = linesByEntry.get(entry.id) || [];
        const debitLine = entryLines.find(line => line.debit > 0);
        const creditLine = entryLines.find(line => line.credit > 0);
        const isReceipt = entry.source_module === 'receipt' || entry.source_module === 'receipt_voucher' || entry.source_module === 'customer_receipt';
        const isPayment = entry.source_module === 'payment' || entry.source_module === 'payment_voucher' || entry.source_module === 'supplier_payment';
        const canonicalRef = isReceipt && entry.reference_id
          ? canonicalRefMap.get(`receipt:${entry.reference_id}`)
          : isPayment && entry.reference_id
          ? canonicalRefMap.get(`payment:${entry.reference_id}`)
          : null;

        const hasBankGl = entryLines.some((l) =>
          allBankAccounts.some((b) => b.coa_id === l.account_id)
        );

        return {
          journal_entry_id: entry.id,
          date: entry.entry_date,
          voucher_no: entry.entry_number,
          voucher_type: sourceLabel(entry.source_module),
          debit_account: debitLine?.chart_of_accounts ? `${debitLine.chart_of_accounts.code} - ${debitLine.chart_of_accounts.name}` : '',
          credit_account: creditLine?.chart_of_accounts ? `${creditLine.chart_of_accounts.code} - ${creditLine.chart_of_accounts.name}` : '',
          amount: Number(entry.total_debit || 0),
          transaction_currency: entry.transaction_currency,
          transaction_amount: entry.transaction_currency && entry.transaction_currency !== 'IDR'
            ? entryLines.reduce((sum, line) => sum + line.transaction_debit, 0) : null,
          narration: entry.description || '',
          reference_number: canonicalRef || entry.reference_number,
          source_module: entry.source_module,
          reference_id: entry.reference_id,
          is_posted: Boolean(entry.is_posted),
          is_reversed: Boolean(entry.is_reversed),
          is_cancelled: Boolean(entry.is_cancelled),
          cancellation_reason: entry.cancellation_reason,
          line_count: entryLines.length,
          is_multi_line: entryLines.length > 2,
          has_bank_gl: hasBankGl,
        };
      }));
    } catch (error) {
      console.error('Error loading voucher journal:', error);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const loadEntryLines = async (entryId: string) => {
    try {
      const { data, error } = await supabase
        .from('journal_entry_lines')
        .select('*, chart_of_accounts(code, name), customers(company_name), suppliers(company_name), payees:payee_id(full_name), staff:staff_id(full_name)')
        .eq('journal_entry_id', entryId)
        .order('line_number');

      if (error) throw error;
      setEntryLines(data || []);
    } catch (error) {
      console.error('Error loading lines:', error);
    }
  };

  useEffect(() => {
    supabase
      .from('bank_accounts')
      .select('id, bank_name, account_name, account_number, currency, coa_id')
      .eq('is_active', true)
      .then(({ data }) => {
        if (data) setAllBankAccounts(data);
      });
  }, []);

  const loadBankAllocationsForJournal = async (entryId: string) => {
    setLoadingBankAllocations(true);
    try {
      const { data, error } = await supabase
        .from('bank_statement_allocations')
        .select(`
          id,
          allocation_amount,
          payment_kind,
          created_at,
          bank_statement_lines (
            id,
            transaction_date,
            description,
            reference,
            debit_amount,
            credit_amount,
            reconciliation_status,
            matching_status,
            bank_account_id,
            bank_accounts (
              id,
              bank_name,
              account_name,
              account_number,
              currency,
              coa_id
            )
          )
        `)
        .or(`journal_entry_id.eq.${entryId},and(document_type.eq.journal,document_id.eq.${entryId})`);

      if (error) throw error;
      const rawAllocs = (data as unknown as LinkedBankAllocation[]) || [];

      // Fetch all allocations on these statement lines to compute exact remaining unallocated amounts
      const bslIds = [...new Set(rawAllocs.map((a) => a.bank_statement_lines?.id).filter((id): id is string => Boolean(id)))];
      const lineTotalsMap = new Map<string, number>();
      if (bslIds.length > 0) {
        const { data: allLineAllocs } = await supabase
          .from('bank_statement_allocations')
          .select('bank_statement_line_id, allocation_amount, journal_entries(is_posted, is_reversed, is_cancelled)')
          .in('bank_statement_line_id', bslIds);

        (allLineAllocs || []).forEach((item: any) => {
          const je = Array.isArray(item.journal_entries) ? item.journal_entries[0] : item.journal_entries;
          if (je && (!je.is_posted || je.is_reversed || je.is_cancelled)) return;
          lineTotalsMap.set(
            item.bank_statement_line_id,
            (lineTotalsMap.get(item.bank_statement_line_id) || 0) + Number(item.allocation_amount || 0)
          );
        });
      }

      const enriched = rawAllocs.map((alloc) => {
        const line = alloc.bank_statement_lines;
        const totalLineAmount = line
          ? Number(line.debit_amount || 0) > 0
            ? Number(line.debit_amount)
            : Number(line.credit_amount || 0)
          : 0;
        const totalAllocated = line ? lineTotalsMap.get(line.id) || Number(alloc.allocation_amount || 0) : 0;
        const remainingUnallocated = Math.max(0, totalLineAmount - totalAllocated);
        return {
          ...alloc,
          totalLineAmount,
          totalAllocated,
          remainingUnallocated,
        };
      });

      setBankAllocations(enriched);
    } catch (err) {
      console.error('Error loading bank allocations:', err);
      setBankAllocations([]);
    } finally {
      setLoadingBankAllocations(false);
    }
  };

  const eligibleBankLine = useMemo(() => {
    if (!selectedEntry || !selectedEntry.is_posted || selectedEntry.is_reversed) return null;
    if (bankAllocations.length > 0) return null;
    const isManual =
      !selectedEntry.source_module ||
      ['manual', 'journal', 'general_journal', 'general'].includes(selectedEntry.source_module);
    if (!isManual) return null;

    for (const line of entryLines) {
      const bank = allBankAccounts.find((b) => b.coa_id === line.account_id);
      if (bank) {
        const isCredit = Number(line.credit || 0) > 0;
        const amount = isCredit ? Number(line.credit) : Number(line.debit || 0);
        if (amount > 0.01) {
          return { bankAccount: bank, isCredit, amount };
        }
      }
    }
    return null;
  }, [selectedEntry, entryLines, bankAllocations, allBankAccounts]);

  const rankCandidateLines = (
    lines: any[],
    targetAmount: number,
    targetDate?: string | null
  ): any[] => {
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
  };

  const openLinkBankModal = async () => {
    if (!eligibleBankLine || !selectedEntry) return;
    setLoadingCandidateBankLines(true);
    setShowLinkBankModal(true);
    setSelectedCandidateBankLineId('');
    setCandidateSearchTerm('');
    try {
      const direction = eligibleBankLine.isCredit ? 'debit' : 'credit';
      const rawCandidates = await loadUnmatchedDebitBankTransactions({
        bankAccountId: eligibleBankLine.bankAccount.id,
        direction,
        includeLinked: false,
      });
      const ranked = rankCandidateLines(rawCandidates, eligibleBankLine.amount, selectedEntry.entry_date);
      setCandidateBankLines(ranked);
      if (ranked.length > 0) {
        const best = ranked[0];
        setSelectedCandidateBankLineId(best.id);
        const maxAlloc = Math.min(best.remainingAmount ?? 0, eligibleBankLine.amount);
        setLinkingBankAllocationAmount(maxAlloc);
      }
    } catch (err) {
      console.error('Error loading candidate bank lines:', err);
      setCandidateBankLines([]);
    } finally {
      setLoadingCandidateBankLines(false);
    }
  };

  const handleOpenBankLinkForVoucher = async (voucher: VoucherJournalEntry) => {
    try {
      const { data: entry, error: entryError } = await supabase
        .from('journal_entries')
        .select('*')
        .eq('id', voucher.journal_entry_id)
        .single();

      if (entryError) throw entryError;
      setSelectedEntry(entry);

      const { data: lines, error: linesError } = await supabase
        .from('journal_entry_lines')
        .select('*, chart_of_accounts(code, name), customers(company_name), suppliers(company_name), payees:payee_id(full_name), staff:staff_id(full_name)')
        .eq('journal_entry_id', voucher.journal_entry_id)
        .order('line_number');

      if (linesError) throw linesError;
      setEntryLines(lines || []);

      await loadBankAllocationsForJournal(voucher.journal_entry_id);

      // Find eligible bank line
      let eligible = null;
      for (const line of lines || []) {
        const bank = allBankAccounts.find((b) => b.coa_id === line.account_id);
        if (bank) {
          const isCredit = Number(line.credit || 0) > 0;
          const amount = isCredit ? Number(line.credit) : Number(line.debit || 0);
          if (amount > 0.01) {
            eligible = { bankAccount: bank, isCredit, amount };
            break;
          }
        }
      }

      if (!eligible) {
        showToast({ type: 'info', title: 'No Bank Line', message: 'No active bank account movement detected on this journal entry.' });
        return;
      }

      setLoadingCandidateBankLines(true);
      setShowLinkBankModal(true);
      setSelectedCandidateBankLineId('');
      setCandidateSearchTerm('');

      const direction = eligible.isCredit ? 'debit' : 'credit';
      const rawCandidates = await loadUnmatchedDebitBankTransactions({
        bankAccountId: eligible.bankAccount.id,
        direction,
        includeLinked: false,
      });

      const ranked = rankCandidateLines(rawCandidates, eligible.amount, entry.entry_date);
      setCandidateBankLines(ranked);
      if (ranked.length > 0) {
        const best = ranked[0];
        setSelectedCandidateBankLineId(best.id);
        const maxAlloc = Math.min(best.remainingAmount ?? 0, eligible.amount);
        setLinkingBankAllocationAmount(maxAlloc);
      }
    } catch (err: any) {
      console.error('Error opening bank link for voucher:', err);
      showToast({ type: 'error', title: 'Error', message: err?.message || 'Could not load bank statement lines' });
    } finally {
      setLoadingCandidateBankLines(false);
    }
  };

  const filteredCandidateBankLines = useMemo(() => {
    if (!candidateSearchTerm.trim()) return candidateBankLines;
    const term = candidateSearchTerm.trim().toLowerCase();
    return candidateBankLines.filter((l) => {
      const desc = (l.description || '').toLowerCase();
      const ref = (l.reference || '').toLowerCase();
      const date = (l.transaction_date || '').toLowerCase();
      const amountStr = String(l.debit_amount || l.credit_amount || '');
      const remStr = String(l.remainingAmount || '');
      return (
        desc.includes(term) ||
        ref.includes(term) ||
        date.includes(term) ||
        amountStr.includes(term) ||
        remStr.includes(term)
      );
    });
  }, [candidateBankLines, candidateSearchTerm]);

  const handleConfirmBankLink = async () => {
    if (!selectedCandidateBankLineId || !selectedEntry || linkingBankAllocationAmount <= 0.01) return;
    setSubmittingBankLink(true);
    try {
      await linkBankStatementLine(
        selectedCandidateBankLineId,
        'journal',
        selectedEntry.id,
        'other',
        linkingBankAllocationAmount
      );
      setShowLinkBankModal(false);
      await loadBankAllocationsForJournal(selectedEntry.id);
      await loadVoucherJournal();
      notifyFinanceReconciliationRefresh();
      showToast({ type: 'success', title: 'Bank Linked', message: 'Bank statement linked successfully' });
    } catch (err: any) {
      console.error('Error linking bank statement:', err);
      showToast({ type: 'error', title: 'Link Failed', message: err?.message || 'Unknown error linking bank statement' });
    } finally {
      setSubmittingBankLink(false);
    }
  };

  const handleViewVoucher = async (voucherEntry: VoucherJournalEntry) => {
    try {
      const { data: entry, error: entryError } = await supabase
        .from('journal_entries')
        .select('*')
        .eq('id', voucherEntry.journal_entry_id)
        .single();

      if (entryError) throw entryError;

      setSelectedEntry(entry);
      setSourceSummary(null);
      if (entry.reference_id && entry.source_module === 'loans') {
        const { data } = await supabase.from('loans')
          .select('loan_number, counterparty_name, principal_amount, currency, status')
          .eq('id', entry.reference_id).maybeSingle();
        if (data) setSourceSummary(`${data.loan_number} — ${data.counterparty_name} — ${formatCurrency(data.principal_amount, data.currency)} — ${data.status}`);
      } else if (entry.reference_id && entry.source_module === 'loan_transactions') {
        const { data } = await supabase.from('loan_transactions')
          .select('transaction_number, amount, transaction_currency, status, loans(loan_number, counterparty_name)')
          .eq('id', entry.reference_id).maybeSingle();
        if (data) {
          const loan = Array.isArray(data.loans) ? data.loans[0] : data.loans;
          setSourceSummary(`${data.transaction_number} — ${loan?.loan_number || ''} ${loan?.counterparty_name || ''} — ${formatCurrency(data.amount, data.transaction_currency || 'IDR')} — ${data.status}`);
        }
      } else if (entry.reference_id && entry.source_module === 'capital_contribution') {
        const { data } = await supabase.from('capital_contributions')
          .select('voucher_number, amount, transaction_currency, exchange_rate')
          .eq('id', entry.reference_id).maybeSingle();
        if (data) setSourceSummary(`${data.voucher_number} — ${formatCurrency(data.amount, data.transaction_currency || 'IDR')} — rate ${data.exchange_rate || 'manual review required'}`);
      } else if (entry.reference_id && (entry.source_module === 'receipt' || entry.source_module === 'receipt_voucher' || entry.source_module === 'customer_receipt')) {
        const { data } = await supabase.from('receipt_vouchers')
          .select('voucher_number, total_amount, currency')
          .eq('id', entry.reference_id).maybeSingle();
        if (data?.voucher_number) {
          setSourceSummary(`${data.voucher_number} — ${formatCurrency(data.total_amount, data.currency || 'IDR')}`);
          entry.reference_number = data.voucher_number;
        }
      } else if (entry.reference_id && (entry.source_module === 'payment' || entry.source_module === 'payment_voucher' || entry.source_module === 'supplier_payment')) {
        const { data } = await supabase.from('payment_vouchers')
          .select('voucher_number, total_amount, currency')
          .eq('id', entry.reference_id).maybeSingle();
        if (data?.voucher_number) {
          setSourceSummary(`${data.voucher_number} — ${formatCurrency(data.total_amount, data.currency || 'IDR')}`);
          entry.reference_number = data.voucher_number;
        }
      }
      await loadEntryLines(voucherEntry.journal_entry_id);
      await loadBankAllocationsForJournal(voucherEntry.journal_entry_id);
      setViewModalOpen(true);
    } catch (error) {
      console.error('Error loading voucher details:', error);
    }
  };

  useEffect(() => {
    if (!initialViewEntryId || loading) return;
    const entry = voucherEntries.find(voucher => voucher.journal_entry_id === initialViewEntryId);
    if (entry) void handleViewVoucher(entry);
    onInitialViewHandled?.();
  }, [initialViewEntryId, loading, voucherEntries, onInitialViewHandled]);

  const handleDeleteJournal = async (journalId: string) => {
    const confirmed = await showConfirm({
      title: 'Delete Journal Entry',
      message: 'Are you sure you want to delete this manual journal entry? This action cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });

    if (!confirmed) return;

    try {
      const [{ data: bankLinks, error: checkError }, { data: canonicalAllocations, error: allocationError }] = await Promise.all([
        supabase
        .from('bank_statement_lines')
        .select('id')
        .eq('matched_entry_id', journalId)
        .limit(1),
        supabase
          .from('bank_statement_allocations')
          .select('id')
          .eq('journal_entry_id', journalId)
          .limit(1),
      ]);

      if (checkError) throw checkError;
      if (allocationError) throw allocationError;

      if ((bankLinks && bankLinks.length > 0) || (canonicalAllocations && canonicalAllocations.length > 0)) {
        showToast({ type: 'error', title: 'Cannot Delete', message: t.finance.journalLinkedBankError });
        return;
      }

      const { error: linesError } = await supabase
        .from('journal_entry_lines')
        .delete()
        .eq('journal_entry_id', journalId);

      if (linesError) throw linesError;

      const { error: entryError } = await supabase
        .from('journal_entries')
        .delete()
        .eq('id', journalId)
        .eq('source_module', 'manual');

      if (entryError) throw entryError;

      showToast({ type: 'success', title: 'Success', message: 'Journal entry deleted successfully' });
      loadVoucherJournal();
    } catch (error: unknown) {
      console.error('Error deleting journal:', error);
      showToast({ type: 'error', title: 'Error', message: 'Error deleting journal entry: ' + (error instanceof Error ? error.message : 'Unknown error') });
    }
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredVouchers = voucherEntries.filter(v => {
    const source = v.source_module || '';
    const moduleMatch = filterModule === 'all'
      || (filterModule === 'expenses' && (source === 'expense' || source === 'expenses'))
      || (filterModule === 'fund_transfers' && (source === 'fund_transfer' || source === 'fund_transfers'))
      || source === filterModule;
    if (!moduleMatch) return false;
    if (!normalizedSearch) return true;
    return [v.voucher_no, v.reference_number, v.reference_id, v.source_module, v.voucher_type,
      v.date, v.narration, v.debit_account, v.credit_account]
      .some(value => String(value || '').toLowerCase().includes(normalizedSearch));
  });

  const totals = {
    debit: filteredVouchers.reduce((sum, v) => sum + v.amount, 0),
    credit: filteredVouchers.reduce((sum, v) => sum + v.amount, 0),
  };

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className="space-y-2">
      {loadError && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
          {t.finance.journalLoadError.replace('{error}', loadError)}
        </div>
      )}
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input name="search_term" aria-label="Search voucher, accounts, narration..."
            type="text"
            placeholder="Search voucher, accounts, narration..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg"
          />
        </div>

        <select name="module" aria-label="Module"
          value={filterModule}
          onChange={(e) => setFilterModule(e.target.value)}
          className="px-1.5 py-1 border border-gray-300 rounded-lg"
        >
          {sourceFilters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
        </select>
        <select name="status_filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="px-1.5 py-1 border border-gray-300 rounded-lg"
          aria-label={t.finance.journalStatusFilter}
        >
          <option value="posted">{t.finance.journalPostedActive}</option>
          <option value="all">{t.finance.journalAllStatuses}</option>
          <option value="draft">{t.finance.journalDraft}</option>
          <option value="reversed">{t.finance.journalReversed}</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
        <span>{statusFilter === 'posted' ? t.finance.journalRegisterPosted : t.finance.journalRegisterStatus.replace('{status}', statusFilter)}</span>
        <span>All accounting dates</span>
      </div>

      {/* Journal Voucher View (Tally Style) - One row per voucher */}
      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Date</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Type</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">{t.finance.journalNumber}</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">{t.finance.journalSourceDocument}</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Debit Account</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Credit Account</th>
                <th className="px-1.5 py-1 text-right text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Amount</th>
                <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">Narration</th>
                <th className="px-1.5 py-1 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {filteredVouchers.map((voucher) => (
                <tr key={voucher.journal_entry_id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-1.5 py-1 whitespace-nowrap text-gray-900 border-r">
                    <div className="text-xs">
                      {new Date(voucher.date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 whitespace-nowrap border-r">
                    <span className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded">
                      {voucher.voucher_type}
                    </span>
                  </td>
                  <td className="px-1.5 py-1 whitespace-nowrap border-r font-mono text-xs">
                    <button type="button" onClick={() => handleViewVoucher(voucher)} className="text-blue-700 hover:underline">
                      {voucher.voucher_no}
                    </button>
                    {voucher.is_cancelled && (
                      <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-rose-100 text-rose-800 rounded border border-rose-200" title={voucher.cancellation_reason || 'Cancelled'}>
                        Cancelled
                      </span>
                    )}
                    {voucher.is_reversed && !voucher.is_cancelled && (
                      <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 rounded border border-amber-200">
                        Reversed
                      </span>
                    )}
                  </td>
                  <td className="px-1.5 py-1 border-r text-xs text-gray-600">
                    {voucher.reference_number || voucher.reference_id || '-'}
                  </td>
                  <td className="px-1.5 py-1 border-r">
                    <div className="text-xs text-gray-900 max-w-xs truncate">
                      {voucher.debit_account || '-'}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 border-r">
                    <div className="text-xs text-gray-900 max-w-xs truncate">
                      {voucher.credit_account || '-'}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 text-right whitespace-nowrap border-r">
                    <span className="text-gray-900 font-medium text-xs">
                      {formatCurrency(voucher.amount, 'IDR')}
                    </span>
                    {voucher.transaction_currency && voucher.transaction_currency !== 'IDR' && voucher.transaction_amount != null && (
                      <div className="text-[10px] text-blue-600">
                        {formatCurrency(voucher.transaction_amount, voucher.transaction_currency)}
                      </div>
                    )}
                  </td>
                  <td className="px-1.5 py-1 text-gray-600 text-xs border-r">
                    <div className="max-w-md truncate">
                      {voucher.narration || '-'}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <FinanceActionButton action="view" label="View detailed breakdown" onClick={() => handleViewVoucher(voucher)} />
                      {canManage && voucher.source_module === 'manual' && (
                        <>
                          <FinanceActionButton
                            action="edit"
                            label={voucher.is_posted ? "Posted journal cannot be edited" : "Edit manual entry"}
                            disabled={voucher.is_posted}
                            onClick={() => !voucher.is_posted && onEditEntry?.(voucher.journal_entry_id)}
                          />
                          <FinanceActionButton
                            action="delete"
                            label={voucher.is_posted ? "Posted journal cannot be deleted" : "Delete manual entry"}
                            disabled={voucher.is_posted}
                            onClick={() => !voucher.is_posted && handleDeleteJournal(voucher.journal_entry_id)}
                          />
                        </>
                      )}
                      {canManage && voucher.is_posted && !voucher.is_reversed && voucher.has_bank_gl && (
                        <FinanceActionButton
                          action="bankLink"
                          label="Link Bank Statement"
                          onClick={() => handleOpenBankLinkForVoucher(voucher)}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredVouchers.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No journal entries found
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-gray-50 font-bold">
              <tr>
                <td colSpan={6} className="px-1.5 py-1 text-right">Total:</td>
                <td className="px-1.5 py-1 text-right text-gray-900 border-r">
                  {formatCurrency(totals.debit, 'IDR')}
                </td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Voucher Detail Modal */}
      <Modal isOpen={viewModalOpen} onClose={() => setViewModalOpen(false)} title={`Journal Entry: ${selectedEntry?.entry_number}`}>
        {selectedEntry && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Date:</span>
                <span className="ml-2 font-medium">{new Date(selectedEntry.entry_date).toLocaleDateString('id-ID')}</span>
              </div>
              <div>
                <span className="text-gray-500">Source:</span>
                <span className="ml-2">{sourceLabel(selectedEntry.source_module)}</span>
              </div>
              <div>
                <span className="text-gray-500">Reference:</span>
                <span className="ml-2 font-mono">{selectedEntry.reference_number || '-'}</span>
              </div>
              <div>
                <span className="text-gray-500">Posted:</span>
                <span className="ml-2">{selectedEntry.posted_at ? new Date(selectedEntry.posted_at).toLocaleString('id-ID') : '-'}</span>
              </div>
              <div>
                <span className="text-gray-500">Currency:</span>
                <span className="ml-2 font-medium">{selectedEntry.transaction_currency || 'IDR'} → {selectedEntry.functional_currency || 'IDR'}</span>
              </div>
              <div>
                <span className="text-gray-500">Exchange Rate:</span>
                <span className="ml-2 font-mono">{selectedEntry.exchange_rate || (selectedEntry.transaction_currency === 'IDR' ? 1 : 'Manual review required')}</span>
              </div>
            </div>

            {selectedEntry.is_cancelled && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs space-y-1">
                <div className="font-semibold text-rose-800 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-rose-600 inline-block"></span>
                  <span>Entry Cancelled</span>
                </div>
                {selectedEntry.cancellation_reason && (
                  <p className="text-rose-900 font-mono text-[11px] pt-1">
                    <strong>Reason:</strong> {selectedEntry.cancellation_reason}
                  </p>
                )}
                {selectedEntry.cancellation_source_reference && (
                  <p className="text-rose-700 text-[11px]">
                    <strong>Source Reference:</strong> {selectedEntry.cancellation_source_reference}
                  </p>
                )}
                {selectedEntry.replacement_journal_id && (
                  <p className="text-rose-700 text-[11px]">
                    <strong>Replacement Journal ID:</strong> {selectedEntry.replacement_journal_id}
                  </p>
                )}
              </div>
            )}

            {selectedEntry.description && (
              <div className="p-3 bg-gray-50 rounded-lg text-sm">
                {selectedEntry.description}
              </div>
            )}

            {sourceSummary && (
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-sm">
                <span className="text-blue-700 font-medium">Source document:</span>{' '}{sourceSummary}
              </div>
            )}

            {selectedEntry.source_module && selectedEntry.reference_id && onOpenSource
              && ['expense','expenses','receipt','payment','petty_cash','fund_transfer','fund_transfers','bank_reconciliation','purchase','purchase_invoice','purchase_invoices','sales','sales_invoice','sales_invoices','sales_invoice_cogs'].includes(selectedEntry.source_module) && (
              <button
                type="button"
                onClick={() => onOpenSource(selectedEntry.source_module || '', selectedEntry.reference_id || '')}
                className="text-sm text-blue-700 hover:underline"
              >
                Open source document
              </button>
            )}

            {/* Bank Reconciliation Section */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                  <Landmark className="w-4 h-4 text-blue-600" />
                  <span>Bank Reconciliation</span>
                </div>
                {bankAllocations.length > 0 ? (
                  <span className="px-2 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-800 text-[11px] flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Linked to Bank Statement ({bankAllocations.length})
                  </span>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full font-medium bg-slate-200 text-slate-700 text-[11px]">
                      Not Linked
                    </span>
                    {eligibleBankLine && canManage && (
                      <button
                        type="button"
                        onClick={openLinkBankModal}
                        className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded text-xs flex items-center gap-1 shadow-sm transition-colors"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        Link Bank Statement
                      </button>
                    )}
                  </div>
                )}
              </div>

              {loadingBankAllocations ? (
                <div className="text-slate-500 text-[11px] py-1">Loading bank reconciliation details...</div>
              ) : bankAllocations.length > 0 ? (
                <div className="space-y-2 pt-1 border-t border-slate-200">
                  {bankAllocations.map((alloc) => {
                    const line = alloc.bank_statement_lines;
                    const bank = line?.bank_accounts;
                    const totalStatementAmount = alloc.totalLineAmount ?? (line
                      ? Number(line.debit_amount || 0) > 0
                        ? Number(line.debit_amount)
                        : Number(line.credit_amount || 0)
                      : 0);
                    const remaining = alloc.remainingUnallocated ?? Math.max(0, totalStatementAmount - Number(alloc.allocation_amount || 0));
                    const currency = bank?.currency || 'IDR';

                    return (
                      <div key={alloc.id} className="bg-white p-3 rounded border border-slate-200 space-y-2 shadow-2xs">
                        <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Bank Account</span>
                            <div className="font-semibold text-slate-900">
                              {bank ? `${bank.bank_name} - ${bank.account_name} (${bank.account_number})` : 'Bank Account'}
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Statement Date</span>
                            <div className="font-medium text-slate-900">
                              {line?.transaction_date ? new Date(line.transaction_date).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'}
                            </div>
                          </div>
                        </div>

                        <div>
                          <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Statement Narration & Reference</span>
                          <div className="text-slate-800 font-mono text-[11px] bg-slate-50 p-2 rounded mt-0.5 border border-slate-100 flex items-start justify-between gap-2">
                            <span className="break-words">{line?.description || '-'}</span>
                            {line?.reference && (
                              <span className="shrink-0 bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-[10px] font-semibold border border-blue-200">
                                Ref: {line.reference}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-slate-100 text-[11px]">
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase font-medium">Statement Total</span>
                            <div className="font-mono font-semibold text-slate-800">
                              {formatCurrency(totalStatementAmount, currency)}
                            </div>
                          </div>
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase font-medium">Allocated to Journal</span>
                            <div className="font-mono font-semibold text-emerald-700">
                              {formatCurrency(alloc.allocation_amount, currency)}
                            </div>
                          </div>
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase font-medium">Remaining Unallocated</span>
                            <div className={`font-mono font-semibold ${remaining <= 0.01 ? 'text-emerald-600' : 'text-amber-600'}`}>
                              {remaining <= 0.01 ? `${formatCurrency(0, currency)} (Fully Reconciled)` : formatCurrency(remaining, currency)}
                            </div>
                          </div>
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase font-medium">Reconciliation Status</span>
                            <div>
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  line?.reconciliation_status === 'matched'
                                    ? 'bg-green-100 text-green-800 border border-green-200'
                                    : 'bg-amber-100 text-amber-800 border border-amber-200'
                                }`}
                              >
                                {line?.reconciliation_status === 'matched' ? 'Matched' : 'Partially Reconciled'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {line?.id && (
                          <div className="text-[10px] text-slate-400 flex items-center justify-between pt-1 border-t border-slate-50">
                            <span>Transaction Line ID: <code className="text-slate-600 font-mono">{line.id}</code></span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-slate-500 text-[11px]">
                  {eligibleBankLine
                    ? `Contains bank movement for ${eligibleBankLine.bankAccount.bank_name} (${formatCurrency(eligibleBankLine.amount, eligibleBankLine.bankAccount.currency)}). Click "Link Bank Statement" to reconcile.`
                    : 'No bank account movement in this journal entry.'}
                </div>
              )}
            </div>

            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-1.5 py-1 text-left">Account</th>
                    <th className="px-1.5 py-1 text-left">Description</th>
                    <th className="px-1.5 py-1 text-right">Debit</th>
                    <th className="px-1.5 py-1 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entryLines.map(line => (
                    <tr key={line.id}>
                      <td className="px-1.5 py-1">
                        <div className="font-mono text-xs text-gray-500">{line.chart_of_accounts?.code}</div>
                        <div>{line.chart_of_accounts?.name}</div>
                        {line.customers && <div className="text-xs text-blue-600">{line.customers.company_name}</div>}
                        {line.suppliers && <div className="text-xs text-orange-600">{line.suppliers.company_name}</div>}
                        {line.payees && <div className="text-xs text-amber-700 font-medium">Payee: {line.payees.full_name}</div>}
                        {line.staff && <div className="text-xs text-emerald-700 font-medium">Employee: {line.staff.full_name}</div>}
                      </td>
                      <td className="px-1.5 py-1 text-gray-600">{line.description || '-'}</td>
                      <td className="px-1.5 py-1 text-right text-blue-600">
                        {line.debit > 0 ? formatCurrency(line.debit, 'IDR') : ''}
                        {line.transaction_currency && line.transaction_currency !== 'IDR' && Number(line.transaction_debit || 0) > 0 && (
                          <div className="text-[10px]">{formatCurrency(Number(line.transaction_debit), line.transaction_currency)}</div>
                        )}
                      </td>
                      <td className="px-1.5 py-1 text-right text-green-600">
                        {line.credit > 0 ? formatCurrency(line.credit, 'IDR') : ''}
                        {line.transaction_currency && line.transaction_currency !== 'IDR' && Number(line.transaction_credit || 0) > 0 && (
                          <div className="text-[10px]">{formatCurrency(Number(line.transaction_credit), line.transaction_currency)}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-medium">
                  <tr>
                    <td colSpan={2} className="px-1.5 py-1 text-right">Total:</td>
                    <td className="px-1.5 py-1 text-right text-blue-700">
                      {formatCurrency(selectedEntry.total_debit, 'IDR')}
                    </td>
                    <td className="px-1.5 py-1 text-right text-green-700">
                      {formatCurrency(selectedEntry.total_credit, 'IDR')}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {selectedEntry.total_debit !== selectedEntry.total_credit && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                Warning: Debit and Credit totals do not match!
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Link Bank Statement Line Modal for Manual Journals */}
      <Modal
        isOpen={showLinkBankModal}
        onClose={() => setShowLinkBankModal(false)}
        title="Link Bank Statement Line"
      >
        <div className="space-y-3 text-xs">
          {eligibleBankLine && (
            <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="font-semibold text-blue-900">
                {eligibleBankLine.bankAccount.bank_name} - {eligibleBankLine.bankAccount.account_name} ({eligibleBankLine.bankAccount.account_number})
              </div>
              <div className="text-gray-600 mt-1">
                Journal Bank Amount: <strong className="font-mono">{formatCurrency(eligibleBankLine.amount, eligibleBankLine.bankAccount.currency)}</strong> ({eligibleBankLine.isCredit ? 'Credit / Outflow' : 'Debit / Inflow'})
              </div>
            </div>
          )}

          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search candidate lines by description, reference, date, or amount..."
              value={candidateSearchTerm}
              onChange={(e) => setCandidateSearchTerm(e.target.value)}
              className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div className="text-gray-600 font-medium">Select an unmatched or partially reconciled bank statement line:</div>

          {loadingCandidateBankLines ? (
            <div className="p-4 text-center text-gray-500">Loading bank statement lines...</div>
          ) : filteredCandidateBankLines.length === 0 ? (
            <div className="p-4 text-center text-gray-500 bg-gray-50 rounded-lg border">
              {candidateBankLines.length === 0
                ? 'No available unlinked bank statement lines found for this bank account.'
                : 'No statement lines match your search filter.'}
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto border rounded-lg divide-y">
              {filteredCandidateBankLines.map((line) => {
                const isSelected = selectedCandidateBankLineId === line.id;
                const isExact = eligibleBankLine && Math.abs(line.remainingAmount - eligibleBankLine.amount) < 0.01;
                return (
                  <div
                    key={line.id}
                    onClick={() => {
                      setSelectedCandidateBankLineId(line.id);
                      if (eligibleBankLine) {
                        setLinkingBankAllocationAmount(Math.min(line.remainingAmount, eligibleBankLine.amount));
                      }
                    }}
                    className={`p-2.5 cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50 border-l-4 border-blue-600' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-gray-900 font-mono text-[11px]">{line.description}</span>
                          {isExact && (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                              Exact Match
                            </span>
                          )}
                        </div>
                        <div className="text-gray-500 text-[10px]">
                          {new Date(line.transaction_date).toLocaleDateString('id-ID')}
                          {line.reference ? ` • Ref: ${line.reference}` : ''}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono font-semibold text-gray-900">
                          {formatCurrency(line.debit_amount || line.credit_amount, eligibleBankLine?.bankAccount.currency || 'IDR')}
                        </div>
                        <div className="text-[10px] text-amber-700 font-medium">
                          Rem: {formatCurrency(line.remainingAmount, eligibleBankLine?.bankAccount.currency || 'IDR')}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {selectedCandidateBankLineId && eligibleBankLine && (
            <div className="p-2.5 bg-gray-50 border rounded-lg space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-medium text-gray-700">Allocation Amount:</span>
                <span className="text-gray-500 text-[11px]">
                  Max: <strong className="font-mono text-blue-700">
                    {(() => {
                      const sel = candidateBankLines.find((l) => l.id === selectedCandidateBankLineId);
                      return formatCurrency(Math.min(sel?.remainingAmount || 0, eligibleBankLine.amount), eligibleBankLine.bankAccount.currency);
                    })()}
                  </strong>
                </span>
              </div>
              <input
                type="number"
                min="1"
                step="any"
                value={linkingBankAllocationAmount || ''}
                onChange={(e) => {
                  const sel = candidateBankLines.find((l) => l.id === selectedCandidateBankLineId);
                  const max = Math.min(sel?.remainingAmount || 0, eligibleBankLine.amount);
                  setLinkingBankAllocationAmount(Math.min(parseFloat(e.target.value) || 0, max));
                }}
                className="w-full px-2.5 py-1.5 border rounded text-xs font-mono font-medium"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowLinkBankModal(false)}
              className="px-3 py-1.5 border rounded text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={submittingBankLink || !selectedCandidateBankLineId || linkingBankAllocationAmount <= 0.01}
              onClick={handleConfirmBankLink}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded font-medium shadow-sm"
            >
              {submittingBankLink ? 'Linking…' : 'Link Statement'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
