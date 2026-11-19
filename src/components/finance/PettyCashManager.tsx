import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, ArrowDownCircle, ArrowUpCircle, Upload, X, FileText, Image, Eye, Pencil as Edit2, Trash2, ExternalLink, Download, DollarSign, Package, Truck, Building2, CheckCircle, XCircle, Clock, Lock, RotateCcw, Search, ChevronDown } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { FinanceModal } from './FinanceModal';
import { F_BTN_PRIMARY, F_BTN_SECONDARY } from './FinanceForm';
import { FinanceActionButton, FinanceBadge } from './FinanceUI';
import { SapRow } from './SapLayout';
import { FloatingField, FLOAT_INPUT } from './FloatingField';
import { useFinance } from '../../contexts/FinanceContext';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { formatDate } from '../../utils/dateFormat';
import { resolveStorageUrlCached } from '../../utils/signedUrlCache';
import { useSupabaseRealtimeChannel } from '../../hooks/useSupabaseRealtimeChannel';
import { BankTransactionLinkField } from './BankTransactionLinkField';
import {
  type BankTransactionLine,
  notifyFinanceReconciliationRefresh,
  unlinkBankTransaction,
} from './bankTransactionLinking';
import { formatCurrency } from '../../utils/currency';
import { useExpenseCategories } from './useExpenseCategories';
import { getPostedJournalsForExport, writeReconciliationWorkbook, type ReconciliationSummaryRow } from './reconciliationExport';
import { ExpenseCategorySelect, groupExpenseCategories } from './ExpenseCategorySelect';
import { useErpSyncListener, emitErpSync } from '../../utils/erpSyncBus';
import { uploadOptimizedFile } from '../../services/storage/uploadOptimizationService';

interface PettyCashDocument {
  id: string;
  file_type: string;
  file_name: string;
  file_url: string;
  file_size: number | null;
  uploaded_at?: string;
  created_at?: string;
}

interface PettyCashTransaction {
  id: string;
  transaction_number: string;
  transaction_date: string;
  transaction_type: 'withdraw' | 'expense';
  amount: number;
  // Stored generated column on petty_cash_transactions; synthetic fund-transfer
  // activity does not have a source-table settlement amount and falls back to amount.
  settlement_amount?: number | null;
  description: string;
  expense_category: string | null;
  bank_account_id: string | null;
  paid_to: string | null;
  paid_by_staff_id: string | null;
  paid_by_staff_name: string | null;
  source: string | null;
  received_by_staff_id: string | null;
  received_by_staff_name: string | null;
  import_container_id: string | null;
  delivery_challan_id: string | null;
  voucher_number: string | null;
  source_account_id: string | null;
  bank_statement_line_id: string | null;
  fund_transfer_id?: string | null;
  fund_transfer_status?: string | null;
  source_account_name?: string | null;
  approval_status: 'pending_approval' | 'approved' | 'rejected';
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  bank_accounts?: { account_name: string; bank_name: string; alias: string | null; currency: string } | null;
  import_containers?: { container_ref: string } | null;
  delivery_challans?: { challan_number: string } | null;
  created_at: string;
  petty_cash_documents?: PettyCashDocument[];
  bank_statement_lines?: BankTransactionLine | null;
  payment_voucher_id?: string | null;
  petty_cash_book_id?: string | null;
  petty_cash_books?: {
    id: string;
    name: string;
    float_amount?: number;
    current_balance?: number;
  } | null;
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

interface PostingAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

interface PettyCashExportAccount {
  transaction_id: string;
  coa_code: string | null;
  coa_name: string | null;
}

interface FundTransferActivityRow {
  id: string;
  transfer_number: string;
  transfer_date: string;
  from_amount: number;
  to_amount: number;
  from_account_type: string;
  to_account_type: string;
  from_account_name: string;
  to_account_name: string;
  from_bank_account_id: string | null;
  to_bank_account_id: string | null;
  description: string | null;
  status: string;
  created_at: string;
}

interface PettyCashManagerProps {
  canManage: boolean;
  onNavigateToFundTransfer?: (fundTransferId?: string) => void;
  initialViewTransactionId?: string | null;
  onInitialViewHandled?: () => void;
}

export function PettyCashManager({ canManage, onNavigateToFundTransfer, initialViewTransactionId, onInitialViewHandled }: PettyCashManagerProps) {
  const { categories: expenseCategories } = useExpenseCategories();
  const { t } = useLanguage();
  const [approvalLoading, setApprovalLoading] = useState<string | null>(null);
  const [pcRejectionModalOpen, setPcRejectionModalOpen] = useState(false);
  const [pcRejectionTarget, setPcRejectionTarget] = useState<string | null>(null);
  const [pcRejectionReason, setPcRejectionReason] = useState('');
  const [cancelPostingModalOpen, setCancelPostingModalOpen] = useState(false);
  const [cancelPostingTarget, setCancelPostingTarget] = useState<PettyCashTransaction | null>(null);
  const [cancelPostingReason, setCancelPostingReason] = useState('');
  const [cancelPostingLoading, setCancelPostingLoading] = useState(false);
  const [transactions, setTransactions] = useState<PettyCashTransaction[]>([]);
  const [containers, setContainers] = useState<ImportContainer[]>([]);
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [postingAccounts, setPostingAccounts] = useState<PostingAccount[]>([]);
  const [selectedBankTransaction, setSelectedBankTransaction] = useState<BankTransactionLine | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTransactions, setExpandedTransactions] = useState<Set<string>>(new Set());

  const toggleTransactionExpand = (id: string) => {
    setExpandedTransactions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewingTransaction, setViewingTransaction] = useState<PettyCashTransaction | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<PettyCashTransaction | null>(null);
  const [signedUrlCache, setSignedUrlCache] = useState<Record<string, string>>({});
  const [cashBalance, setCashBalance] = useState(0);
  const [pettyCashBooks, setPettyCashBooks] = useState<{ id: string; name: string; float_amount: number; current_balance: number }[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);
  const [existingDocuments, setExistingDocuments] = useState<PettyCashDocument[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [showPasteHint, setShowPasteHint] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'import' | 'sales' | 'staff' | 'operations' | 'admin' | 'assets'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const { dateRange } = useFinance();
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const startDate = dateRange.startDate;
  const endDate = dateRange.endDate;

  const [formData, setFormData] = useState({
    transaction_type: 'expense' as 'withdraw' | 'expense',
    transaction_date: new Date().toISOString().split('T')[0],
    amount: 0,
    description: '',
    expense_category: '',
    bank_account_id: '',
    paid_to: '',
    paid_by_staff_name: '',
    paid_by: 'cash' as 'cash' | 'bank',
    inflow_source_type: 'account' as 'bank' | 'account',
    source_account_id: '',
    bank_statement_line_id: '',
    source: '',
    received_by_staff_name: '',
    import_container_id: '',
    delivery_challan_id: '',
  });

  const loadData = useCallback(async () => {
    try {
      const [txRes, transfersRes, containersRes, challansRes, bankRes, accountsRes, pvRes, glBalanceRes, booksRes] = await Promise.all([
        supabase
          .from('petty_cash_transactions')
          .select(`
            *,
            bank_accounts:bank_account_id (
              account_name,
              bank_name,
              alias,
              currency
            ),
            import_containers:import_container_id (
              container_ref
            ),
            delivery_challans:delivery_challan_id (
              challan_number
            ),
            petty_cash_documents (*),
            bank_statement_lines:bank_statement_line_id (
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
              matched_petty_cash_id,
              matched_fund_transfer_id,
              matched_tax_payment_id,
              bank_accounts (
                bank_name,
                account_name,
                account_number,
                alias,
                currency
              )
            )
          `)
          .is('fund_transfer_id', null)
          .gte('transaction_date', startDate)
          .lte('transaction_date', endDate)
          .order('transaction_date', { ascending: false })
          .order('transaction_number', { ascending: false }),
        supabase
          .from('vw_fund_transfers_detailed')
          .select('id, transfer_number, transfer_date, from_amount, to_amount, from_account_type, to_account_type, from_account_name, to_account_name, from_bank_account_id, to_bank_account_id, description, status, created_at')
          .or('from_account_type.eq.petty_cash,to_account_type.eq.petty_cash')
          .gte('transfer_date', startDate)
          .lte('transfer_date', endDate),
        supabase
          .from('import_containers')
          .select('id, container_ref')
          .order('container_ref', { ascending: false }),

        supabase
          .from('delivery_challans')
          .select(`
            id,
            challan_number,
            challan_date,
            customers:customer_id (
              company_name
            )
          `)
          .order('challan_date', { ascending: false }),

        supabase
          .from('bank_accounts')
          // perf: projected columns (was select('*'))
          .select('id, account_number, bank_name, alias, currency')
          .order('bank_name', { ascending: true }),
        supabase
          .from('chart_of_accounts')
          .select('id, code, name, account_type')
          .eq('is_active', true)
          .eq('is_header', false)
          .neq('code', '1102')
          .neq('code', '1101')
          .order('code'),
        supabase
          .from('payment_vouchers')
          .select(`
            id,
            voucher_number,
            voucher_date,
            amount,
            description,
            payment_method,
            bank_account_id,
            coa_account_id,
            is_posted,
            party_type,
            supplier_id,
            staff_id,
            suppliers (company_name),
            finance_staff_master (full_name)
          `)
          .in('payment_method', ['cash', 'petty_cash'])
          .eq('is_posted', true)
          .gte('voucher_date', startDate)
          .lte('voucher_date', endDate)
          .order('voucher_date', { ascending: false }),
        supabase.rpc('get_petty_cash_balance'),
        supabase
          .from('petty_cash_books')
          .select('id, name, float_amount, current_balance')
          .eq('is_active', true)
          .order('name'),
      ]);

      if (txRes.error) throw txRes.error;
      if (transfersRes.error) throw transfersRes.error;
      if (containersRes.error) throw containersRes.error;
      if (challansRes.error) throw challansRes.error;
      if (bankRes.error) throw bankRes.error;
      if (accountsRes.error) throw accountsRes.error;
      if (pvRes.error) console.warn('Could not load cash payment vouchers:', pvRes.error);

      const loadedBooks = (booksRes?.data || []) as { id: string; name: string; float_amount: number; current_balance: number }[];
      setPettyCashBooks(loadedBooks);
      const bookMap = new Map(loadedBooks.map(b => [b.id, b]));

      const rawTransactions = (txRes.data || []) as any[];
      const pettyCashTransactions: PettyCashTransaction[] = rawTransactions.map((tx) => ({
        ...tx,
        petty_cash_books: tx.petty_cash_book_id ? bookMap.get(tx.petty_cash_book_id) || null : null,
      }));

      const fundTransferActivity: PettyCashTransaction[] = ((transfersRes.data || []) as FundTransferActivityRow[]).map((transfer) => {
        const isInflow = transfer.to_account_type === 'petty_cash';
        const approvalStatus: PettyCashTransaction['approval_status'] =
          transfer.status === 'posted'
            ? 'approved'
            : transfer.status === 'pending'
              ? 'pending_approval'
              : 'rejected';

        return {
          id: transfer.id,
          transaction_number: transfer.transfer_number,
          transaction_date: transfer.transfer_date,
          transaction_type: isInflow ? 'withdraw' : 'expense',
          amount: Number(isInflow ? transfer.to_amount : transfer.from_amount),
          description: transfer.description || (isInflow ? 'Fund Transfer into Petty Cash' : 'Fund Transfer from Petty Cash'),
          expense_category: null,
          bank_account_id: isInflow ? transfer.from_bank_account_id : transfer.to_bank_account_id,
          paid_to: null,
          paid_by_staff_id: null,
          paid_by_staff_name: null,
          source: `${isInflow ? 'From' : 'To'} ${isInflow ? transfer.from_account_name : transfer.to_account_name}`,
          received_by_staff_id: null,
          received_by_staff_name: null,
          import_container_id: null,
          delivery_challan_id: null,
          voucher_number: null,
          source_account_id: null,
          bank_statement_line_id: null,
          fund_transfer_id: transfer.id,
          fund_transfer_status: transfer.status,
          source_account_name: isInflow ? transfer.from_account_name : transfer.to_account_name,
          approval_status: approvalStatus,
          approved_by: null,
          approved_at: null,
          rejection_reason: transfer.status === 'reversed' ? 'Reversed from Contra' : null,
          created_at: transfer.created_at,
          petty_cash_documents: [],
          bank_statement_lines: null,
        };
      });

      const linkedPvIds = new Set(
        pettyCashTransactions
          .map((t) => t.payment_voucher_id)
          .filter(Boolean)
      );

      const cashPvActivity: PettyCashTransaction[] = ((pvRes.data || []) as any[])
        .filter((pv) => {
          // If this payment voucher already has an authoritative petty_cash_transactions record,
          // do NOT add a synthetic duplicate row.
          if (linkedPvIds.has(pv.id)) {
            return false;
          }
          // Cash paid from Cash in Hand must reduce Cash in Hand, NOT Petty Cash.
          // Only include payment vouchers that are funded from Petty Cash (Account 1102).
          return (
            pv.payment_method === 'petty_cash' ||
            pv.coa_account_id === '5b7f4b18-d751-4f47-b49b-117214bf0ba5' ||
            (pv.description && /petty\s*cash/i.test(pv.description))
          );
        })
        .map((pv) => {
        const party = pv.suppliers?.company_name || pv.finance_staff_master?.full_name || pv.party_type || 'Payee';
        return {
          id: pv.id,
          transaction_number: pv.voucher_number,
          transaction_date: pv.voucher_date ? String(pv.voucher_date).split('T')[0] : '',
          transaction_type: 'expense' as const,
          amount: Number(pv.amount),
          description: pv.description ? pv.description.trim() : `Payment Voucher: ${pv.voucher_number}`,
          expense_category: null,
          bank_account_id: null,
          paid_to: party,
          paid_by_staff_id: pv.staff_id || null,
          paid_by_staff_name: pv.finance_staff_master?.full_name || null,
          source: `Payment Voucher (${pv.voucher_number})`,
          received_by_staff_id: null,
          received_by_staff_name: null,
          import_container_id: null,
          delivery_challan_id: null,
          voucher_number: pv.voucher_number,
          source_account_id: null,
          bank_statement_line_id: null,
          fund_transfer_id: null,
          fund_transfer_status: null,
          source_account_name: 'Petty Cash',
          approval_status: 'approved' as const,
          approved_by: null,
          approved_at: null,
          rejection_reason: null,
          created_at: pv.voucher_date,
          petty_cash_documents: [],
          bank_statement_lines: null,
        };
      });

      // Cash movement reporting follows the petty-cash transaction/transfer
      // date. Prefer live posted GL balance for Account 1102 to maintain complete
      // consistency with Trial Balance and General Ledger.
      let balance = 0;
      if (!glBalanceRes.error && glBalanceRes.data !== null && glBalanceRes.data !== undefined) {
        balance = Number(glBalanceRes.data);
      } else {
        const balanceRes = await supabase.rpc('get_petty_cash_balance_by_transaction_date', {
          start_date: startDate,
          end_date: endDate,
        });
        if (balanceRes.error) throw balanceRes.error;
        balance = Number(balanceRes.data || 0);
      }

      setTransactions([...pettyCashTransactions, ...fundTransferActivity, ...cashPvActivity] as PettyCashTransaction[]);
      setCashBalance(balance);
      setContainers(containersRes.data || []);
      setChallans((challansRes.data || []).map((challan) => ({
        ...challan,
        customers: Array.isArray(challan.customers) ? challan.customers[0] || null : challan.customers,
      })) as DeliveryChallan[]);
      setBankAccounts(bankRes.data || []);
      setPostingAccounts(accountsRes.data || []);
    } catch (error: any) {
      console.error('Error loading petty cash data:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load petty cash data: ' + error.message });
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Realtime subscription lives in a stable-deps effect so it does not
  // resubscribe on every date-range/loadData identity change. Patch state
  // from the payload row instead of reloading everything.
  const loadDataRef = useRef(loadData);
  useEffect(() => { loadDataRef.current = loadData; }, [loadData]);

  const patchPettyCashRow = (payload: any) => {
    const evt = payload.eventType;
    if (evt === 'INSERT') {
      // Row lacks joined relations (bank_accounts, documents); do a targeted refresh
      // to keep the list shape identical to loadData's shape.
      loadDataRef.current();
    } else if (evt === 'UPDATE') {
      setTransactions((prev: any[]) =>
        prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t)),
      );
    } else if (evt === 'DELETE') {
      setTransactions((prev: any[]) => prev.filter((t) => t.id !== payload.old.id));
    }
  };

  useErpSyncListener(
    ['petty_cash', 'expenses', 'vouchers'],
    () => {
      loadDataRef.current();
    }
  );

  useSupabaseRealtimeChannel({
    channelName: 'petty_cash_changes',
    table: 'petty_cash_transactions',
    onEvent: patchPettyCashRow,
  });

  useSupabaseRealtimeChannel({
    channelName: 'petty_cash_fund_transfer_changes',
    table: 'fund_transfers',
    onEvent: () => loadDataRef.current(),
  });

  useEffect(() => {
    if (!initialViewTransactionId) return;

    const openTransaction = async () => {
      const openByData = async (transaction: PettyCashTransaction) => {
        setViewingTransaction(transaction);
        setViewModalOpen(true);
        const docs = transaction.petty_cash_documents || [];
        if (docs.length) {
          const entries = await Promise.all(
            docs.map(async (doc) => [doc.file_url, await getSignedUrl(doc.file_url)] as [string, string])
          );
          setSignedUrlCache(prev => ({ ...prev, ...Object.fromEntries(entries) }));
        }
      };

      const existing = transactions.find(tx => tx.id === initialViewTransactionId);
      if (existing) {
        await openByData(existing);
        onInitialViewHandled?.();
        return;
      }

      const { data, error } = await supabase
        .from('petty_cash_transactions')
        .select(`
          *,
          bank_accounts:bank_account_id (
            account_name,
            bank_name,
            alias,
            currency
          ),
          import_containers:import_container_id (
            container_ref
          ),
          delivery_challans:delivery_challan_id (
            challan_number
          ),
          petty_cash_documents (*)
        `)
        .eq('id', initialViewTransactionId)
        .is('fund_transfer_id', null)
        .maybeSingle();

      if (!error && data) {
        await openByData(data as PettyCashTransaction);
      }
      onInitialViewHandled?.();
    };

    openTransaction();
  }, [initialViewTransactionId, transactions, onInitialViewHandled]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadingFiles(prev => [...prev, ...files]);
    // Reset input so the same file(s) can be selected again if needed
    e.target.value = '';
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));

    if (imageItems.length > 0) {
      e.preventDefault();
      const files = await Promise.all(
        imageItems.map(item => {
          const blob = item.getAsFile();
          if (blob) {
            return new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type });
          }
          return null;
        })
      );

      const validFiles = files.filter((f): f is File => f !== null);
      if (validFiles.length > 0) {
        setUploadingFiles(prev => [...prev, ...validFiles]);
      }
    }
  };

  const removeUploadingFile = (index: number) => {
    setUploadingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const deleteExistingDocument = async (documentId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this document?', variant: 'danger', confirmLabel: 'Delete' })) {
      return;
    }

    try {
      const { error } = await supabase
        .from('petty_cash_documents')
        .delete()
        .eq('id', documentId);

      if (error) throw error;

      setExistingDocuments(prev => prev.filter(doc => doc.id !== documentId));
      showToast({ type: 'success', title: 'Success', message: 'Document deleted successfully!' });
    } catch (error) {
      console.error('Error deleting document:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete document' });
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingTransaction(null);
    setExistingDocuments([]);
    setUploadingFiles([]);
    setSelectedBankTransaction(null);
  };

  const openAddModal = () => {
    setEditingTransaction(null);
    setFormData({
      transaction_type: 'expense',
      transaction_date: new Date().toISOString().split('T')[0],
      amount: 0,
      description: '',
      expense_category: '',
      bank_account_id: '',
      paid_to: '',
      paid_by_staff_name: '',
      paid_by: 'cash',
      inflow_source_type: 'account',
      source_account_id: '',
      bank_statement_line_id: '',
      source: '',
      received_by_staff_name: '',
      import_container_id: '',
      delivery_challan_id: '',
    });
    setExistingDocuments([]);
    setUploadingFiles([]);
    setSelectedBankTransaction(null);
    setModalOpen(true);
  };

  const openEditModal = (transaction: PettyCashTransaction) => {
    if (transaction.fund_transfer_id) {
      onNavigateToFundTransfer?.(transaction.fund_transfer_id);
      return;
    }
    if (transaction.approval_status === 'approved') {
      showToast({ type: 'error', title: 'Posted', message: 'This transaction is posted. Cancel Posting first to make changes.' });
      return;
    }
    setEditingTransaction(transaction);
    setFormData({
      transaction_type: transaction.transaction_type,
      transaction_date: transaction.transaction_date,
      amount: transaction.amount,
      description: transaction.description,
      expense_category: transaction.expense_category || '',
      bank_account_id: transaction.bank_account_id || '',
      paid_to: transaction.paid_to || '',
      paid_by_staff_name: transaction.paid_by_staff_name || '',
      paid_by: 'cash',
      inflow_source_type: transaction.bank_account_id ? 'bank' : 'account',
      source_account_id: transaction.source_account_id || '',
      bank_statement_line_id: transaction.bank_statement_line_id || '',
      source: transaction.source || '',
      received_by_staff_name: transaction.received_by_staff_name || '',
      import_container_id: transaction.import_container_id || '',
      delivery_challan_id: transaction.delivery_challan_id || '',
    });
    const docs = transaction.petty_cash_documents || [];
    setExistingDocuments(docs);
    setUploadingFiles([]);
    setSelectedBankTransaction(transaction.bank_statement_lines || null);
    setModalOpen(true);
    if (docs.length) {
      Promise.all(docs.map(async (doc) => [doc.file_url, await getSignedUrl(doc.file_url)] as [string, string]))
        .then(entries => setSignedUrlCache(prev => ({ ...prev, ...Object.fromEntries(entries) })));
    }
  };

  const getSignedUrl = (fileUrl: string): Promise<string> =>
    resolveStorageUrlCached(fileUrl, 3600);

  const openDocument = async (url: string) => {
    const signed = await getSignedUrl(url);
    window.open(signed, '_blank', 'noopener,noreferrer');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.transaction_type === 'expense' && !formData.expense_category) {
      showToast({ type: 'error', title: 'Error', message: 'Please select an expense category' });
      return;
    }

    if (formData.transaction_type === 'withdraw') {
      if (formData.inflow_source_type === 'bank' && !formData.bank_account_id) {
        showToast({ type: 'error', title: 'Error', message: 'Please select the source bank account' });
        return;
      }
      if (formData.inflow_source_type === 'account' && !formData.source_account_id) {
        showToast({ type: 'error', title: 'Error', message: 'Please select the offset GL account' });
        return;
      }
    }

    const selectedCategory = expenseCategories.find(c => c.value === formData.expense_category);
    if (selectedCategory?.requiresContainer && !formData.import_container_id) {
      showToast({ type: 'error', title: 'Error', message: `${selectedCategory.label} requires linking to an import container` });
      return;
    }

    try {
      const payload = {
        transaction_type: formData.transaction_type,
        transaction_date: formData.transaction_date,
        amount: formData.amount,
        description: formData.description,
        expense_category: formData.transaction_type === 'expense' ? formData.expense_category : null,
        bank_account_id:
          formData.transaction_type === 'withdraw' && formData.inflow_source_type === 'bank'
            ? formData.bank_account_id
            : null,
        source_account_id:
          formData.transaction_type === 'withdraw' && formData.inflow_source_type === 'account'
            ? formData.source_account_id
            : null,
        bank_statement_line_id:
          formData.transaction_type === 'withdraw' && formData.inflow_source_type === 'bank'
            ? formData.bank_statement_line_id || null
            : null,
        paid_to: formData.transaction_type === 'expense' ? formData.paid_to : null,
        paid_by_staff_name: formData.transaction_type === 'expense' ? formData.paid_by_staff_name : null,
        source: formData.transaction_type === 'withdraw' ? formData.source : null,
        received_by_staff_name: formData.transaction_type === 'withdraw' ? formData.received_by_staff_name : null,
        import_container_id: formData.import_container_id || null,
        delivery_challan_id: formData.delivery_challan_id || null,
      };

      let transactionId: string;

      if (editingTransaction) {
        const { error } = await supabase
          .from('petty_cash_transactions')
          .update(payload)
          .eq('id', editingTransaction.id);

        if (error) throw error;
        transactionId = editingTransaction.id;
      } else {
        const { data, error } = await supabase
          .from('petty_cash_transactions')
          .insert([payload])
          .select('id')
          .single();

        if (error) throw error;
        if (!data) throw new Error('Failed to create transaction');
        transactionId = data.id;
      }

      // Upload documents if any
      if (uploadingFiles.length > 0) {
        const uploadPromises = uploadingFiles.map(async (file) => {
          const fileExt = file.name.split('.').pop();
          const fileName = `${transactionId}_${Date.now()}.${fileExt}`;
          const filePath = `${fileName}`;

          const { error: uploadError, optimization } = await uploadOptimizedFile(
            supabase,
            'petty-cash-receipts',
            filePath,
            file
          );

          if (uploadError) throw uploadError;

          const { data: { publicUrl } } = supabase.storage
            .from('petty-cash-receipts')
            .getPublicUrl(filePath);

          // Map MIME type to database-allowed file types
          let fileType = 'proof'; // default
          const effectiveMime = optimization.mimeType || file.type;
          if (effectiveMime.startsWith('image/')) {
            fileType = 'photo';
          } else if (effectiveMime === 'application/pdf') {
            fileType = 'invoice';
          }

          // Save document record with optimized file size
          const { error: docError } = await supabase
            .from('petty_cash_documents')
            .insert([{
              petty_cash_transaction_id: transactionId,
              file_type: fileType,
              file_name: file.name,
              file_url: publicUrl,
              file_size: optimization.optimizedSize,
              uploaded_by: profile?.id,
            }]);

          if (docError) throw docError;
        });

        await Promise.all(uploadPromises);
      }

      showToast({ type: 'success', title: 'Success', message: editingTransaction ? 'Petty cash transaction updated successfully!' : 'Petty cash transaction added successfully!' });
      notifyFinanceReconciliationRefresh();
      closeModal();
      await loadData();
    } catch (error: any) {
      console.error('Error saving petty cash transaction:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to save transaction: ' + error.message });
    }
  };

  const handleDelete = async (id: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this transaction?', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { data: docs } = await supabase
        .from('petty_cash_documents')
        .select('file_url')
        .eq('petty_cash_transaction_id', id);

      const { data: linkedBankLines } = await supabase
        .from('bank_statement_lines')
        .select('id')
        .eq('matched_petty_cash_id', id);

      if (linkedBankLines && linkedBankLines.length > 0) {
        await supabase
          .from('bank_statement_lines')
          .update({
            matched_petty_cash_id: null,
            reconciliation_status: 'unmatched',
            matched_at: null,
            matched_by: null,
          })
          .eq('matched_petty_cash_id', id);
      }

      const { data: linkedJournals } = await supabase
        .from('journal_entries')
        .select('id')
        .eq('source_module', 'petty_cash')
        .ilike('reference_number', `%${id}%`);

      if (linkedJournals && linkedJournals.length > 0) {
        const journalIds = linkedJournals.map(j => j.id);

        await supabase
          .from('bank_statement_lines')
          .update({
            matched_entry_id: null,
            reconciliation_status: 'unmatched',
            matched_at: null,
            matched_by: null,
          })
          .in('matched_entry_id', journalIds);

        for (const jId of journalIds) {
          await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', jId);
          await supabase.from('journal_entries').delete().eq('id', jId);
        }
      }

      const { error } = await supabase
        .from('petty_cash_transactions')
        .delete()
        .eq('id', id);

      if (error) throw error;

      if (docs && docs.length > 0) {
        const filePaths = docs.map(doc => {
          const url = doc.file_url;
          const fileName = url.split('/').pop();
          return fileName || '';
        }).filter(Boolean);

        if (filePaths.length > 0) {
          await supabase.storage
            .from('petty-cash-receipts')
            .remove(filePaths);
        }
      }

      showToast({ type: 'success', title: 'Success', message: 'Transaction deleted successfully!' });
      await loadData();
    } catch (error: any) {
      console.error('Error deleting transaction:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete transaction: ' + error.message });
    }
  };

  const handleApprovePettyCash = async (id: string) => {
    if (!isAdmin) return;
    setApprovalLoading(id);
    try {
      const { error } = await supabase
        .from('petty_cash_transactions')
        .update({ approval_status: 'approved', approved_by: profile?.id, approved_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      notifyFinanceReconciliationRefresh();
      setViewModalOpen(false);
      await loadData();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message });
    } finally {
      setApprovalLoading(null);
    }
  };

  const handleRejectPettyCashConfirm = async () => {
    if (!pcRejectionTarget || !pcRejectionReason.trim()) return;
    setApprovalLoading(pcRejectionTarget);
    try {
      const { error } = await supabase
        .from('petty_cash_transactions')
        .update({ approval_status: 'rejected', approved_by: profile?.id, approved_at: new Date().toISOString(), rejection_reason: pcRejectionReason })
        .eq('id', pcRejectionTarget);
      if (error) throw error;
      setTransactions(prev => prev.map(t => t.id === pcRejectionTarget ? { ...t, approval_status: 'rejected', rejection_reason: pcRejectionReason } : t));
      setViewingTransaction(prev => prev?.id === pcRejectionTarget ? { ...prev, approval_status: 'rejected', rejection_reason: pcRejectionReason } : prev);
      setPcRejectionModalOpen(false);
      setPcRejectionTarget(null);
      setPcRejectionReason('');
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message });
    } finally {
      setApprovalLoading(null);
    }
  };

  const handleCancelPostingConfirm = async () => {
    if (!cancelPostingTarget || !cancelPostingReason.trim()) return;
    setCancelPostingLoading(true);
    try {
      const { error } = await supabase.rpc('cancel_petty_cash_posting', {
        p_pct_id: cancelPostingTarget.id,
        p_cancelled_by: profile?.id,
        p_reason: cancelPostingReason,
      });
      if (error) throw error;
      showToast({ type: 'success', title: 'Posting Cancelled', message: `${cancelPostingTarget.transaction_number} is now in draft. Edit and re-approve to repost.` });
      setCancelPostingModalOpen(false);
      setCancelPostingTarget(null);
      setCancelPostingReason('');
      setViewModalOpen(false);
      notifyFinanceReconciliationRefresh();
      await loadData();
    } catch (err: any) {
      const msg: string = err.message || '';
      if (msg.includes('closed')) {
        showToast({ type: 'error', title: 'Period Closed', message: msg });
      } else {
        showToast({ type: 'error', title: 'Error', message: msg });
      }
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const openCancelPostingModal = (tx: PettyCashTransaction) => {
    setCancelPostingTarget(tx);
    setCancelPostingReason('');
    setCancelPostingModalOpen(true);
  };

  const handleUnlinkBankTransaction = async (transaction: PettyCashTransaction) => {
    const linkedLineId = transaction.bank_statement_line_id || transaction.bank_statement_lines?.id;
    if (!linkedLineId) return;

    const confirmed = await showConfirm({
      title: 'Unlink Bank Transaction',
      message: `Unlink the bank transaction from ${transaction.transaction_number}? The bank statement line will return to Unmatched.`,
      variant: 'danger',
      confirmLabel: 'Unlink',
    });
    if (!confirmed) return;

    try {
      await unlinkBankTransaction(linkedLineId);
      const { error } = await supabase
        .from('petty_cash_transactions')
        .update({ bank_statement_line_id: null })
        .eq('id', transaction.id);
      if (error) throw error;

      setFormData(prev => ({ ...prev, bank_statement_line_id: '' }));
      setSelectedBankTransaction(null);
      notifyFinanceReconciliationRefresh();
      await loadData();
      showToast({ type: 'success', title: 'Unlinked', message: 'Bank transaction unlinked successfully.' });
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: 'Failed to unlink bank transaction: ' + error.message });
    }
  };

  const exportToCSV = async () => {
    if (filteredTransactions.length === 0) {
      showToast({ type: 'info', title: 'Notice', message: 'No transactions to export' });
      return;
    }

    const pettyCashTransactionIds = filteredTransactions
      .filter(transaction => !transaction.fund_transfer_id)
      .map(transaction => transaction.id);
    let exportAccountRows: PettyCashExportAccount[] = [];
    try {
      const exportAccountsRes = pettyCashTransactionIds.length > 0
        ? await supabase.rpc('get_petty_cash_export_accounts', { p_transaction_ids: pettyCashTransactionIds })
        : { data: [], error: null };
      if (exportAccountsRes.error) throw exportAccountsRes.error;
      exportAccountRows = (exportAccountsRes.data || []) as PettyCashExportAccount[];
    } catch (error) {
      console.error('Error resolving Petty Cash export accounts:', error);
      showToast({
        type: 'error',
        title: 'Export failed',
        message: 'Unable to resolve Chart of Account details. Please try again after the accounting export setup is available.',
      });
      return;
    }

    const exportAccounts = Object.fromEntries(
      exportAccountRows.map(account => [account.transaction_id, account]),
    );
    const documentNumbers = Object.fromEntries(filteredTransactions.map((transaction) => [transaction.id, transaction.transaction_number]));
    const bankAccounts = Object.fromEntries(filteredTransactions.map((transaction) => [
      transaction.id,
      transaction.bank_accounts?.alias || transaction.bank_accounts?.bank_name || transaction.bank_statement_lines?.bank_accounts?.alias || transaction.bank_statement_lines?.bank_accounts?.bank_name || '',
    ]));
    let postedJournals;
    try {
      postedJournals = await getPostedJournalsForExport(
        filteredTransactions.map((transaction) => transaction.id), ['petty_cash'], documentNumbers, 'Petty Cash', bankAccounts,
      );
    } catch (error) {
      console.error('Error resolving Petty Cash journal lines:', error);
      showToast({ type: 'error', title: 'Export failed', message: 'Unable to resolve posted journal lines for this export.' });
      return;
    }
    const rows: ReconciliationSummaryRow[] = filteredTransactions.map(tx => {
      const category = tx.expense_category ? getCategoryInfo(tx.expense_category) : null;
      const account = exportAccounts[tx.id];
      const journal = postedJournals.get(tx.id);
      const actualBankAmount = tx.bank_statement_lines
        ? Math.abs(Number(tx.bank_statement_lines.debit_amount || 0) - Number(tx.bank_statement_lines.credit_amount || 0))
        : 0;
      return {
        'Source Module': 'Petty Cash',
        'Document Type': tx.fund_transfer_id
          ? (tx.transaction_type === 'withdraw' ? 'Contra Inflow' : 'Contra Outflow')
          : (tx.transaction_type === 'withdraw' ? 'Cash In' : 'Expense'),
        'Document Number': tx.transaction_number,
        'Document Date': tx.transaction_date,
        'Posting Date': journal?.date || '',
        'Journal Number': journal?.number || '',
        'Journal Status': journal?.status || 'Not posted',
        'Approval Status': tx.approval_status || '',
        'Payment Status': tx.transaction_type === 'expense' ? 'Paid' : '',
        'Reconciliation Status': tx.bank_statement_lines ? 'Linked' : 'Unlinked',
        'Party Type': tx.paid_to ? 'Payee' : '',
        'Party Name': tx.paid_to || tx.received_by_staff_name || '',
        'Category Parent': category?.group || '',
        'Leaf Category': category?.label || tx.expense_category || '',
        Currency: 'IDR',
        'Exchange Rate': 1,
        'Gross Amount': Number(tx.amount || 0),
        Discount: '',
        'DPP / Tax Base': tx.transaction_type === 'expense' ? Number(tx.amount || 0) : '',
        PPN: '', PPh21: '', PPh22: '', PPh23: '', 'PPh4(2)': '', 'Other Taxes': '', 'Bank Charges': '', 'Salary Advance': '', 'Other Deductions': '',
        'Net Settlement Amount': Number(tx.settlement_amount ?? tx.amount ?? 0),
        'Actual Bank Amount': actualBankAmount || '',
        'Settlement Difference': actualBankAmount ? actualBankAmount - Number(tx.settlement_amount ?? tx.amount ?? 0) : '',
        'Primary COA Code': account?.coa_code || category?.coaCode || '',
        'Primary COA Name': account?.coa_name || category?.coaName || '',
        'Bank Account': bankAccounts[tx.id],
        'Bank Statement Reference': tx.bank_statement_lines?.reference || '',
        'Tax Period': '',
        'Tax Reference / NTPN (where applicable)': tx.voucher_number || '',
        Remarks: [tx.source || '', tx.description || ''].filter(Boolean).join(' — '),
      };
    });
    writeReconciliationWorkbook(rows, [...postedJournals.values()].flatMap((journal) => journal.lines), `petty_cash_reconciliation_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`);
  };

  const viewTransaction = async (transaction: PettyCashTransaction) => {
    if (transaction.fund_transfer_id) {
      onNavigateToFundTransfer?.(transaction.fund_transfer_id);
      return;
    }
    setViewingTransaction(transaction);
    setViewModalOpen(true);
    const docs = transaction.petty_cash_documents || [];
    if (docs.length) {
      const entries = await Promise.all(
        docs.map(async (doc) => [doc.file_url, await getSignedUrl(doc.file_url)] as [string, string])
      );
      setSignedUrlCache(prev => ({ ...prev, ...Object.fromEntries(entries) }));
    }
  };

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const sortedTransactions = [...transactions].sort((a, b) => {
    if (!sortConfig) return 0;

    const aValue = a[sortConfig.key as keyof PettyCashTransaction];
    const bValue = b[sortConfig.key as keyof PettyCashTransaction];

    if (aValue === null || aValue === undefined) return 1;
    if (bValue === null || bValue === undefined) return -1;

    if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
    if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredTransactions = sortedTransactions.filter(tx => {
    if (filterType !== 'all' && tx.transaction_type === 'expense') {
      const category = expenseCategories.find(c => c.value === tx.expense_category);
      if (!category || category.type !== filterType) return false;
    }

    if (categoryFilter !== 'all' && tx.expense_category !== categoryFilter) {
      return false;
    }

    if (normalizedSearch) {
      const category = expenseCategories.find(c => c.value === tx.expense_category);
      const searchableValues = [
        tx.transaction_number,
        tx.voucher_number,
        tx.description,
        tx.paid_to,
        tx.paid_by_staff_name,
        tx.received_by_staff_name,
        tx.source,
        tx.source_account_name,
        tx.expense_category,
        category?.label,
        category?.group,
      ];
      if (!searchableValues.some(value => String(value ?? '').toLocaleLowerCase().includes(normalizedSearch))) {
        return false;
      }
    }

    return true;
  });

  const getCategoryInfo = (value: string) => {
    return expenseCategories.find(c => c.value === value);
  };

  const selectedCategory = getCategoryInfo(formData.expense_category);

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading petty cash data...</div>;
  }

  const postedActivity = filteredTransactions.filter(t =>
    t.fund_transfer_id ? t.fund_transfer_status === 'posted' : t.approval_status === 'approved'
  );

  const totalOutflow = postedActivity
    .filter(t => t.transaction_type === 'expense')
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const totalInflow = postedActivity
    .filter(t => t.transaction_type === 'withdraw')
    .reduce((sum, t) => sum + Number(t.amount), 0);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Shared title strip — matches every other Finance page */}
      <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-xs font-bold text-gray-900 truncate">Petty Cash</h1>
          <span className="text-[10px] text-gray-400 truncate">Operational activity reconciled to GL 1102</span>
        </div>
        {canManage && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onNavigateToFundTransfer?.()}
              className="inline-flex items-center gap-1 h-7 px-2 border border-blue-300 text-blue-700 bg-blue-50 rounded text-xs font-semibold hover:bg-blue-100"
            >
              <ArrowDownCircle className="w-3 h-3" /> Fund Petty Cash
            </button>
            <button
              onClick={openAddModal}
              className="inline-flex items-center gap-1 h-7 px-2 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700"
            >
              <Plus className="w-3 h-3" /> New
            </button>
          </div>
        )}
      </div>

      {/* KPI strip — same shape as other Finance pages */}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${3 + (pettyCashBooks.length > 0 ? 1 : 0)}, minmax(0, 1fr))` }}>
        <div className="border border-gray-200 rounded bg-white px-2 py-1.5">
          <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">GL 1102 Balance</div>
          <div className="text-xs font-mono font-bold text-green-600">{formatCurrency(cashBalance, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
        </div>
        {pettyCashBooks.length > 0 && (
          <div className="border border-gray-200 rounded bg-white px-2 py-1.5">
            <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
              Book: {pettyCashBooks[0].name} (Float: {formatCurrency(pettyCashBooks[0].float_amount, 'IDR')})
            </div>
            <div className={`text-xs font-mono font-bold ${pettyCashBooks[0].current_balance < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
              {formatCurrency(pettyCashBooks[0].current_balance, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </div>
          </div>
        )}
        <div className="border border-gray-200 rounded bg-white px-2 py-1.5">
          <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Cash In</div>
          <div className="text-xs font-mono font-bold text-blue-600">{formatCurrency(totalInflow, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
        </div>
        <div className="border border-gray-200 rounded bg-white px-2 py-1.5">
          <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Cash Out</div>
          <div className="text-xs font-mono font-bold text-red-600">{formatCurrency(totalOutflow, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
        </div>
      </div>

      {/* Toolbar — same rhythm as Expenses */}
      <div className="flex items-center gap-2 flex-wrap min-h-8 px-2 py-1 bg-white border border-gray-200 rounded">
        <div className="flex gap-0.5">
          {[
            { value: 'all', label: 'All' },
            { value: 'import', label: 'Import' },
            { value: 'sales', label: 'Sales' },
            { value: 'staff', label: 'Staff' },
            { value: 'operations', label: 'Ops' },
            { value: 'admin', label: 'Admin' },
            { value: 'assets', label: 'Assets' },
          ].map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilterType(tab.value as any)}
              className={`h-6 px-2 rounded text-[11px] font-medium transition-colors ${
                filterType === tab.value ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-gray-300"></div>

        <select name="category_filter" aria-label="Category Filter"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-6 px-1.5 border border-gray-300 rounded text-[11px] bg-white"
        >
            <option value="all">All Categories</option>
            {groupExpenseCategories(expenseCategories).map(([parent, categories]) => (
              <optgroup key={parent} label={parent}>
                {categories.map(cat => (
                  <option key={cat.value} value={cat.value}>{cat.label}</option>
                ))}
              </optgroup>
            ))}
        </select>

        <div className="relative">
          <Search className="absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
          <input name="search_query"
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search petty cash"
            aria-label="Search petty cash"
            style={{ paddingLeft: '1.75rem' }}
            className="h-6 w-44 rounded border border-gray-300 bg-white pr-2 text-[11px]"
          />
        </div>

        <button
          onClick={exportToCSV}
          disabled={filteredTransactions.length === 0}
          className="ml-auto inline-flex items-center gap-1 h-6 px-2 bg-green-600 text-white rounded text-[11px] font-medium hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          <Download className="w-3 h-3" />
          Export ({filteredTransactions.length})
        </button>
      </div>

      {/* Desktop Table View (>= 768px) */}
      <div className="hidden md:block bg-white rounded border border-gray-200 overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th
                onClick={() => handleSort('transaction_date')}
                className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Date
                  {sortConfig?.key === 'transaction_date' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('transaction_number')}
                className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Number
                  {sortConfig?.key === 'transaction_number' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600">Type</th>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600">Category</th>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600">Description</th>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600">Linked To</th>
              <th
                onClick={() => handleSort('amount')}
                className="px-2 py-1.5 text-right text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center justify-end gap-1">
                  Amount
                  {sortConfig?.key === 'amount' && (
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
                <td colSpan={canManage ? 9 : 8} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : filteredTransactions.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 9 : 8} className="px-6 py-8 text-center text-gray-500">
                  No transactions found
                </td>
              </tr>
            ) : (
              filteredTransactions.map((tx) => {
                const categoryInfo = tx.expense_category ? getCategoryInfo(tx.expense_category) : null;

                return (
                  <tr
                    key={`${tx.fund_transfer_id ? 'fund-transfer' : 'petty-cash'}-${tx.id}`}
                    onClick={tx.fund_transfer_id ? () => viewTransaction(tx) : undefined}
                    className={`hover:bg-gray-50 ${tx.fund_transfer_id ? 'cursor-pointer' : ''} ${
                      tx.fund_transfer_status === 'reversed' || tx.fund_transfer_status === 'cancelled'
                        ? 'text-gray-400 bg-gray-50/60'
                        : ''
                    }`}
                  >
                    <td className="px-2 py-1.5 whitespace-nowrap text-sm text-gray-900">
                      {formatDate(tx.transaction_date)}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${tx.fund_transfer_id ? 'text-indigo-600 underline decoration-dotted underline-offset-2' : 'text-blue-600'}`}>
                          {tx.transaction_number}
                        </span>
                        {tx.voucher_number && (
                          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                            {tx.voucher_number}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                        tx.transaction_type === 'withdraw'
                          ? 'bg-blue-100 text-blue-800'
                          : tx.payment_voucher_id
                            ? (tx.expense_category === null ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800')
                            : 'bg-red-100 text-red-800'
                      }`}>
                        {tx.fund_transfer_id ? (
                          <>
                            <ArrowDownCircle className={`h-3 w-3 ${tx.transaction_type === 'withdraw' ? '' : 'rotate-180'}`} />
                            Contra {tx.transaction_type === 'withdraw' ? 'Inflow' : 'Outflow'}
                          </>
                        ) : tx.payment_voucher_id ? (
                          <>
                            <ArrowUpCircle className="h-3 w-3" />
                            {tx.expense_category === null ? 'Staff Advance' : 'Voucher Outflow'}
                          </>
                        ) : tx.transaction_type === 'withdraw' ? (
                          <>
                            <ArrowDownCircle className="h-3 w-3" />
                            Cash In
                          </>
                        ) : (
                          <>
                            <ArrowUpCircle className="h-3 w-3" />
                            Expense
                          </>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {categoryInfo ? (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-gray-900">{categoryInfo.label}</span>
                        </div>
                      ) : tx.payment_voucher_id ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                          {tx.expense_category ? tx.expense_category : 'Balance Sheet (Advance)'}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 text-sm text-gray-600">
                      <div className="max-w-xs truncate">
                        {tx.description}
                        {tx.paid_to && <div className="text-xs text-gray-500">To: {tx.paid_to}</div>}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-sm">
                      <div className="space-y-1">
                        {tx.import_containers && (
                          <div className="flex items-center gap-1 text-purple-600">
                            <Package className="h-3 w-3" />
                            <span className="text-xs">{tx.import_containers.container_ref}</span>
                          </div>
                        )}
                        {tx.delivery_challans && (
                          <div className="flex items-center gap-1 text-green-600">
                            <Truck className="h-3 w-3" />
                            <span className="text-xs">{tx.delivery_challans.challan_number}</span>
                          </div>
                        )}
                        {tx.source && (
                          <div className={`flex items-center gap-1 ${tx.fund_transfer_id ? 'text-indigo-600' : tx.payment_voucher_id ? 'text-amber-700' : 'text-gray-600'}`}>
                            {tx.fund_transfer_id ? <ArrowDownCircle className="h-3 w-3" /> : <Building2 className="h-3 w-3" />}
                            <span className="text-xs">{tx.source}</span>
                          </div>
                        )}
                        {tx.petty_cash_books?.name && (
                          <div className="flex items-center gap-1 text-teal-700 font-medium">
                            <Building2 className="h-3 w-3" />
                            <span className="text-xs">Book: {tx.petty_cash_books.name}</span>
                          </div>
                        )}
                        {tx.bank_statement_line_id && (
                          <div className="flex items-center gap-1 text-green-700">
                            <CheckCircle className="h-3 w-3" />
                            <span className="text-xs">Bank transaction linked</span>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-right">
                      <span className={`text-sm font-medium ${
                        tx.transaction_type === 'withdraw' ? 'text-blue-600' : 'text-red-600'
                      }`}>
                        {tx.transaction_type === 'withdraw' ? '+' : '-'} {formatCurrency(tx.amount, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      {tx.fund_transfer_id ? (
                        <FinanceBadge status={tx.fund_transfer_status === 'posted' ? 'posted' : tx.fund_transfer_status === 'pending' ? 'pending' : tx.fund_transfer_status === 'reversed' ? 'reversed' : 'cancelled'}>
                          {tx.fund_transfer_status === 'posted' ? <CheckCircle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                          {tx.fund_transfer_status === 'posted' ? 'Posted' : tx.fund_transfer_status === 'pending' ? 'Pending' : tx.fund_transfer_status === 'reversed' ? 'Reversed' : 'Cancelled'}
                        </FinanceBadge>
                      ) : tx.approval_status === 'approved' ? (
                        <FinanceBadge status="approved"><CheckCircle className="h-3 w-3" />Approved</FinanceBadge>
                      ) : tx.approval_status === 'rejected' ? (
                        <FinanceBadge status="rejected" title={tx.rejection_reason || ''}><XCircle className="h-3 w-3" />Rejected</FinanceBadge>
                      ) : (
                        <FinanceBadge status="pending"><Clock className="h-3 w-3" />Pending</FinanceBadge>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-right text-sm">
                      <div className="flex items-center justify-end gap-2">
                        <FinanceActionButton
                          action="view"
                          label={tx.fund_transfer_id ? 'Open Contra Voucher' : 'View Details'}
                          onClick={(event) => { event.stopPropagation(); viewTransaction(tx); }}
                        />
                        {!tx.fund_transfer_id && canManage && tx.approval_status !== 'approved' && (
                          <FinanceActionButton action="edit" onClick={(event) => { event.stopPropagation(); openEditModal(tx); }} />
                        )}
                        {!tx.fund_transfer_id && isAdmin && tx.approval_status === 'pending_approval' && (
                          <>
                            <FinanceActionButton
                              action="approve"
                              onClick={(event) => { event.stopPropagation(); handleApprovePettyCash(tx.id); }}
                              disabled={approvalLoading === tx.id}
                            />
                            <FinanceActionButton
                              action="reject"
                              onClick={(event) => { event.stopPropagation(); setPcRejectionTarget(tx.id); setPcRejectionModalOpen(true); }}
                              disabled={approvalLoading === tx.id}
                            />
                          </>
                        )}
                        {!tx.fund_transfer_id && isAdmin && tx.approval_status === 'approved' && (
                          <FinanceActionButton
                            action="reverse"
                            label="Cancel Posting"
                            onClick={(event) => { event.stopPropagation(); openCancelPostingModal(tx); }}
                          />
                        )}
                        {!tx.fund_transfer_id && canManage && tx.approval_status !== 'approved' && (
                          <FinanceActionButton action="delete" onClick={(event) => { event.stopPropagation(); handleDelete(tx.id); }} />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
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
        ) : filteredTransactions.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-xs text-gray-500">
            No petty cash transactions found
          </div>
        ) : (
          filteredTransactions.map((tx) => {
            const isExpanded = expandedTransactions.has(tx.id);
            const isWithdraw = tx.transaction_type === 'withdraw';

            return (
              <div
                key={tx.id}
                onClick={() => toggleTransactionExpand(tx.id)}
                className="bg-white rounded-xl border border-slate-200/90 p-2.5 space-y-1 shadow-2xs hover:border-slate-300 transition active:scale-[0.99] cursor-pointer"
              >
                {/* Line 1: Transaction Number + In/Out Badge + Quick Actions */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="font-mono font-bold text-xs text-gray-900 truncate">
                      {tx.transaction_number || '—'}
                    </span>
                    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold rounded shrink-0 ${
                      isWithdraw ? 'bg-blue-100 text-blue-700' : 'bg-rose-100 text-rose-700'
                    }`}>
                      {isWithdraw ? 'In' : 'Out'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <FinanceActionButton
                      action="view"
                      label={tx.fund_transfer_id ? 'Contra' : 'View'}
                      onClick={() => viewTransaction(tx)}
                    />
                    {!tx.fund_transfer_id && canManage && tx.approval_status !== 'approved' && (
                      <FinanceActionButton action="edit" onClick={() => openEditModal(tx)} />
                    )}
                    <button
                      type="button"
                      onClick={() => toggleTransactionExpand(tx.id)}
                      className="p-1 text-slate-400 hover:text-slate-600 rounded active:bg-slate-100"
                      title={isExpanded ? 'Collapse' : 'Expand'}
                    >
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                </div>

                {/* Line 2: Category + Transaction Date */}
                <div className="flex items-center justify-between text-xs text-gray-600 gap-2">
                  <div className="font-medium text-gray-800 truncate min-w-0 flex-1">
                    {tx.expense_category || 'Petty Cash'}
                  </div>
                  <div className="text-[11px] text-gray-400 font-normal shrink-0">
                    {formatDate(tx.transaction_date)}
                  </div>
                </div>

                {/* Line 3: Amount + Approval Status Pill */}
                <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-xs gap-2">
                  <div className={`font-mono font-bold text-xs truncate ${
                    isWithdraw ? 'text-blue-600' : 'text-red-600'
                  }`}>
                    {isWithdraw ? '+' : '-'} {formatCurrency(tx.amount, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </div>
                  <div className="shrink-0 text-xs font-semibold">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded capitalize ${
                      tx.approval_status === 'approved' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60' : 'bg-amber-50 text-amber-700 border border-amber-200/60'
                    }`}>
                      {tx.approval_status || 'Pending'}
                    </span>
                  </div>
                </div>

                {/* Expandable Drawer */}
                {isExpanded && (
                  <div
                    className="pt-2 mt-1 border-t border-dashed border-slate-200 bg-slate-50/70 p-2 rounded-lg text-xs space-y-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {tx.description && (
                      <div>
                        <span className="text-[10px] font-semibold text-gray-400 block uppercase tracking-wider">Description</span>
                        <p className="text-gray-700 text-[11px] mt-0.5">{tx.description}</p>
                      </div>
                    )}
                    {tx.fund_transfer_id && (
                      <div className="text-[11px]">
                        <span className="text-[10px] text-purple-600 font-semibold uppercase tracking-wider block">Contra Link</span>
                        <span className="text-purple-700 font-medium">Auto-generated via Fund Transfer</span>
                      </div>
                    )}
                    {!tx.fund_transfer_id && canManage && tx.approval_status !== 'approved' && (
                      <div className="flex justify-end pt-1 border-t border-slate-200">
                        <FinanceActionButton action="delete" onClick={() => handleDelete(tx.id)} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <FinanceModal
        isOpen={modalOpen}
        onClose={closeModal}
        title={editingTransaction ? 'Edit Transaction' : 'Add Petty Cash Transaction'}
        size="lg"
        footer={
          <>
            <button type="button" onClick={closeModal} className={F_BTN_SECONDARY}>
              Cancel
            </button>
            <button type="submit" form="petty-cash-form" className={F_BTN_PRIMARY}>
              {editingTransaction ? 'Update' : 'Save'} Transaction
            </button>
          </>
        }
      >
        <form id="petty-cash-form" onSubmit={handleSubmit} className="flex flex-col gap-1" onPaste={handlePaste}>
          <SapRow>
            <FloatingField label="Type" required span={4} filled={!!formData.transaction_type}>
              <select name="transaction_type" aria-label="Transaction Type" value={formData.transaction_type}
                onChange={(e) => {
                  const transactionType = e.target.value as 'withdraw' | 'expense';
                  setFormData(prev => ({
                    ...prev,
                    transaction_type: transactionType,
                    bank_account_id: transactionType === 'withdraw' ? prev.bank_account_id : '',
                    source_account_id: transactionType === 'withdraw' ? prev.source_account_id : '',
                    bank_statement_line_id: transactionType === 'withdraw' ? prev.bank_statement_line_id : '',
                  }));
                  if (transactionType === 'expense') setSelectedBankTransaction(null);
                }}
                className={FLOAT_INPUT} required>
                <option value="expense">Expense (Cash Out)</option>
                <option value="withdraw">Refund / Cash Return (Cash In)</option>
              </select>
            </FloatingField>
            <FloatingField label="Date" required span={4} filled={!!formData.transaction_date}>
              <input name="transaction_date" aria-label="Transaction Date" type="date" value={formData.transaction_date}
                onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
                className={FLOAT_INPUT} required />
            </FloatingField>
            <FloatingField label="Amount (Rp)" required span={4}
              right={formData.amount > 0 && formData.amount < 100 ? (
                <span className="text-[9px] text-amber-700 font-semibold">? Rp {(formData.amount * 1000).toLocaleString('id-ID')}?</span>
              ) : null}
              filled={!!formData.amount}>
              <MoneyInput value={formData.amount}
                onChange={(n) => setFormData({ ...formData, amount: n })}
                className={FLOAT_INPUT + ' !text-right !font-mono !font-semibold'} required />
            </FloatingField>
          </SapRow>

          {formData.transaction_type === 'expense' && (
            <>
              <SapRow>
                <FloatingField label="Category" required span={12} filled={!!formData.expense_category}>
                  <ExpenseCategorySelect
                    value={formData.expense_category}
                    onChange={(expense_category) => setFormData({ ...formData, expense_category })}
                    categories={expenseCategories}
                    className={FLOAT_INPUT}
                    required
                  />
                </FloatingField>
              </SapRow>

              {selectedCategory?.requiresContainer && (
                <p className="text-[10px] text-orange-800 bg-orange-50 border border-orange-200 rounded px-2 py-1">
                  <Package className="w-3 h-3 inline mr-1" />
                  Import Container required for proper cost allocation.
                </p>
              )}

              <SapRow>
                <FloatingField label="Container" span={6} required={!!selectedCategory?.requiresContainer} filled={!!formData.import_container_id}>
                  <select name="import_container_id" aria-label="Import Container Id" value={formData.import_container_id}
                    onChange={(e) => setFormData({ ...formData, import_container_id: e.target.value })}
                    className={FLOAT_INPUT} required={selectedCategory?.requiresContainer}>
                    <option value="">None</option>
                    {containers.map((c) => (
                      <option key={c.id} value={c.id}>{c.container_ref}</option>
                    ))}
                  </select>
                </FloatingField>
                <FloatingField label="DC (Sales)" span={6} filled={!!formData.delivery_challan_id}>
                  <select name="delivery_challan_id" aria-label="Delivery Challan Id" value={formData.delivery_challan_id}
                    onChange={(e) => setFormData({ ...formData, delivery_challan_id: e.target.value })}
                    className={FLOAT_INPUT}>
                    <option value="">None</option>
                    {challans.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.challan_number} - {c.customers?.company_name} ({formatDate(c.challan_date)})
                      </option>
                    ))}
                  </select>
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label="Paid To" span={6} filled={!!formData.paid_to}>
                  <input name="paid_to" aria-label="Vendor/Supplier name" type="text" value={formData.paid_to}
                    onChange={(e) => setFormData({ ...formData, paid_to: e.target.value })}
                    className={FLOAT_INPUT} placeholder="Vendor/Supplier name" />
                </FloatingField>
                <FloatingField label="Paid By" span={6} filled={!!formData.paid_by_staff_name}>
                  <input name="paid_by_staff_name" aria-label="Staff member name" type="text" value={formData.paid_by_staff_name}
                    onChange={(e) => setFormData({ ...formData, paid_by_staff_name: e.target.value })}
                    className={FLOAT_INPUT} placeholder="Staff member name" />
                </FloatingField>
              </SapRow>
            </>
          )}

          {formData.transaction_type === 'withdraw' && (
            <>
              <SapRow>
                <FloatingField label="Source Type" required span={4} filled={!!formData.inflow_source_type}>
                  <select name="inflow_source_type" aria-label="Inflow Source Type"
                    value={formData.inflow_source_type}
                    onChange={(e) => {
                      const sourceType = e.target.value as 'bank' | 'account';
                      setFormData(prev => ({
                        ...prev,
                        inflow_source_type: sourceType,
                        bank_account_id: sourceType === 'bank' ? prev.bank_account_id : '',
                        bank_statement_line_id: sourceType === 'bank' ? prev.bank_statement_line_id : '',
                        source_account_id: sourceType === 'account' ? prev.source_account_id : '',
                      }));
                      if (sourceType === 'account') setSelectedBankTransaction(null);
                    }}
                    className={FLOAT_INPUT}
                    required
                  >
                    <option value="account">GL Account</option>
                    <option value="bank">Bank Account</option>
                  </select>
                </FloatingField>
                {formData.inflow_source_type === 'bank' ? (
                  <FloatingField label="Source Bank" required span={8} filled={!!formData.bank_account_id}>
                    <select name="bank_account_id" aria-label="Bank Account Id"
                      value={formData.bank_account_id}
                      onChange={(e) => {
                        setFormData(prev => ({
                          ...prev,
                          bank_account_id: e.target.value,
                          bank_statement_line_id: '',
                        }));
                        setSelectedBankTransaction(null);
                      }}
                      className={FLOAT_INPUT}
                      required
                    >
                      <option value="">Select bank account</option>
                      {bankAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.alias || acc.bank_name} - {acc.account_number} ({acc.currency})
                        </option>
                      ))}
                    </select>
                  </FloatingField>
                ) : (
                  <FloatingField label="Offset GL Account" required span={8} filled={!!formData.source_account_id}>
                    <select name="source_account_id" aria-label="Source Account Id"
                      value={formData.source_account_id}
                      onChange={(e) => setFormData(prev => ({ ...prev, source_account_id: e.target.value }))}
                      className={FLOAT_INPUT}
                      required
                    >
                      <option value="">Select source account</option>
                      {postingAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code === '2105'
                            ? `${account.code} - Paid personally by Director (Payable to Director)`
                            : `${account.code} - ${account.name}`}
                        </option>
                      ))}
                    </select>
                    {postingAccounts.find(a => a.id === formData.source_account_id)?.code === '2105' && (
                      <p className="text-[11px] text-indigo-700 mt-1">
                        Paid personally by Director: Creates a payable to the director. When SAPJ reimburses the director via Bank Reconciliation, Dr 2105 / Cr Bank will settle it.
                      </p>
                    )}
                  </FloatingField>
                )}
              </SapRow>

              {formData.inflow_source_type === 'bank' && formData.bank_account_id && (
                <BankTransactionLinkField
                  bankAccountId={formData.bank_account_id}
                  selectedTransactionId={formData.bank_statement_line_id}
                  linkedTransaction={selectedBankTransaction}
                  currentPettyCashId={editingTransaction?.id}
                  canUnlink={!!selectedBankTransaction}
                  onSelect={(transaction) => {
                    setSelectedBankTransaction(transaction);
                    setFormData(prev => ({ ...prev, bank_statement_line_id: transaction.id }));
                  }}
                  onUnlink={() => {
                    if (editingTransaction?.bank_statement_line_id) {
                      return handleUnlinkBankTransaction(editingTransaction);
                    }
                    setSelectedBankTransaction(null);
                    setFormData(prev => ({ ...prev, bank_statement_line_id: '' }));
                  }}
                />
              )}

              <SapRow>
                <FloatingField label="Source Ref" span={6} filled={!!formData.source}>
                  <input name="source" aria-label="Check number, transfer ref" type="text" value={formData.source}
                    onChange={(e) => setFormData({ ...formData, source: e.target.value })}
                    className={FLOAT_INPUT} placeholder="Check number, transfer ref" />
                </FloatingField>
                <FloatingField label="Received By" span={6} filled={!!formData.received_by_staff_name}>
                  <input name="received_by_staff_name" aria-label="Staff member name" type="text" value={formData.received_by_staff_name}
                    onChange={(e) => setFormData({ ...formData, received_by_staff_name: e.target.value })}
                    className={FLOAT_INPUT} placeholder="Staff member name" />
                </FloatingField>
              </SapRow>
            </>
          )}

          <SapRow>
            <FloatingField label="Description" span={12} required filled={!!formData.description}>
              <input name="description" aria-label="Enter transaction details" type="text" value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className={FLOAT_INPUT} required placeholder="Enter transaction details" />
            </FloatingField>
          </SapRow>

          {/* Existing Documents (Edit Mode) */}
          {editingTransaction && existingDocuments.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Existing Documents ({existingDocuments.length})
              </label>
              <div className="grid grid-cols-2 gap-3 mb-4">
                {existingDocuments.map((doc) => (
                  <div
                    key={doc.id}
                    className="group relative border border-gray-200 rounded-lg overflow-hidden hover:border-red-500 transition-colors"
                  >
                    {doc.file_type === 'photo' ? (
                      <div className="aspect-square bg-gray-100 relative">
                        <img
                          src={signedUrlCache[doc.file_url] || doc.file_url}
                          alt={doc.file_name}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="aspect-square bg-red-50 flex flex-col items-center justify-center p-3">
                        <FileText className="h-10 w-10 text-red-600 mb-2" />
                        <p className="text-xs text-center text-gray-700 line-clamp-2 px-2">{doc.file_name}</p>
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs px-2 py-1.5 flex items-center justify-between">
                      <span>{(Number(doc.file_size) / 1024).toFixed(0)} KB</span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openDocument(doc.file_url); }}
                          className="p-1 hover:bg-white hover:bg-opacity-20 rounded"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteExistingDocument(doc.id)}
                          className="p-1 hover:bg-red-500 rounded"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {editingTransaction ? 'Upload Additional Documents/Receipts' : 'Upload Documents/Receipts'}
            </label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-blue-500 transition-colors">
              <input
                type="file"
                onChange={handleFileUpload}
                accept="image/*,.pdf"
                multiple
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <Upload className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                <p className="text-sm text-gray-600">Click to upload or drag and drop</p>
                <p className="text-xs text-gray-500 mt-1">Images or PDF files</p>
              </label>
              {!showPasteHint && uploadingFiles.length === 0 && (
                <button
                  type="button"
                  onClick={() => setShowPasteHint(true)}
                  className="text-xs text-blue-600 hover:text-blue-700 mt-2"
                >
                  💡 You can also paste images here
                </button>
              )}
            </div>

            {uploadingFiles.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-sm font-medium text-gray-700">{uploadingFiles.length} file(s) ready:</p>
                <div className="space-y-1">
                  {uploadingFiles.map((file, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-gray-50 px-3 py-2 rounded">
                      <div className="flex items-center gap-2">
                        {file.type.startsWith('image/') ? (
                          <Image className="h-4 w-4 text-blue-600" />
                        ) : (
                          <FileText className="h-4 w-4 text-red-600" />
                        )}
                        <span className="text-sm text-gray-700">{file.name}</span>
                        <span className="text-xs text-gray-500">({(file.size / 1024).toFixed(1)} KB)</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUploadingFile(idx)}
                        className="text-red-600 hover:text-red-800"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        </form>
      </FinanceModal>

      <Modal
        isOpen={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        title="Petty Cash Receipt"
        size="sm"
      >
        {viewingTransaction && (
          <div className="space-y-2 text-sm">
            {/* Compact Header Bar */}
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-3 py-2 rounded -mt-1 -mx-1">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs opacity-90">Transaction #</p>
                  <p className="text-base font-bold">{viewingTransaction.transaction_number}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs opacity-90">Date</p>
                  <p className="text-base font-semibold">
                    {new Date(viewingTransaction.transaction_date).toLocaleDateString('id-ID', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric'
                    })}
                  </p>
                </div>
              </div>
            </div>

            {/* Type, Category, Amount - All in one line */}
            <div className="py-2 border-b border-gray-200">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-4">
                  <div>
                    <p className="text-xs text-gray-500 mb-0.5">Type</p>
                    <div className="flex items-center gap-1">
                      {viewingTransaction.transaction_type === 'withdraw' ? (
                        <>
                          <ArrowDownCircle className="h-3.5 w-3.5 text-blue-600" />
                          <span className="text-sm font-medium text-blue-900">Withdrawal</span>
                        </>
                      ) : (
                        <>
                          <ArrowUpCircle className="h-3.5 w-3.5 text-red-600" />
                          <span className="text-sm font-medium text-red-900">Expense</span>
                        </>
                      )}
                    </div>
                  </div>

                  {viewingTransaction.expense_category && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Category</p>
                      <div className="flex items-center gap-1.5">
                        {(() => {
                          const categoryInfo = getCategoryInfo(viewingTransaction.expense_category);
                          return (
                            <>
                              <span className="text-sm font-medium text-gray-900">{categoryInfo?.label}</span>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-xs text-gray-500 mb-0.5">Amount</p>
                  <p className="text-lg font-bold text-gray-900">
                    {viewingTransaction.transaction_type === 'withdraw' ? '+' : '-'} {formatCurrency(viewingTransaction.amount, 'IDR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </p>
                </div>
              </div>
            </div>

            {/* Approval Status */}
            <div className="py-2 border-b border-gray-200 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-gray-500 mb-1">Approval Status</p>
                {viewingTransaction.approval_status === 'approved' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 rounded-full">
                    <CheckCircle className="w-3 h-3" />Posted
                  </span>
                ) : viewingTransaction.approval_status === 'rejected' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-full" title={viewingTransaction.rejection_reason || ''}>
                    <XCircle className="w-3 h-3" />Rejected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-full">
                    <Clock className="w-3 h-3" />Draft
                  </span>
                )}
                {viewingTransaction.approval_status === 'approved' && (
                  <p className="mt-1 text-xs text-gray-500 flex items-center gap-1">
                    <Lock className="w-3 h-3" />Journal entry posted — fields are locked
                  </p>
                )}
                {viewingTransaction.rejection_reason && (
                  <p className="mt-1 text-xs text-red-700">{viewingTransaction.rejection_reason}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && viewingTransaction.approval_status === 'pending_approval' && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleApprovePettyCash(viewingTransaction.id)}
                      disabled={approvalLoading === viewingTransaction.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-50"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPcRejectionTarget(viewingTransaction.id); setPcRejectionModalOpen(true); }}
                      disabled={approvalLoading === viewingTransaction.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  </>
                )}
                {isAdmin && viewingTransaction.approval_status === 'approved' && (
                  <button
                    type="button"
                    onClick={() => openCancelPostingModal(viewingTransaction)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded hover:bg-orange-100"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Cancel Posting
                  </button>
                )}
              </div>
            </div>

            {/* Description */}
            <div className="py-2 border-b border-gray-200">
              <p className="text-xs text-gray-500 mb-1">Description</p>
              <p className="text-sm font-semibold text-gray-900">{viewingTransaction.description}</p>
            </div>

            {/* Payment Details - Compact */}
            <div className="py-2 border-b border-gray-200 space-y-1.5">
              {(viewingTransaction.paid_to || viewingTransaction.paid_by_staff_name) && (
                <div className="flex items-center gap-4 flex-wrap">
                  {viewingTransaction.paid_to && (
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-gray-500">Paid To:</p>
                      <p className="text-sm font-medium text-gray-900">{viewingTransaction.paid_to}</p>
                    </div>
                  )}
                  {viewingTransaction.paid_by_staff_name && (
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-gray-500">Paid By:</p>
                      <p className="text-sm font-medium text-gray-900">{viewingTransaction.paid_by_staff_name}</p>
                    </div>
                  )}
                </div>
              )}
              {viewingTransaction.received_by_staff_name && (
                <div className="flex items-center gap-1.5">
                  <p className="text-xs text-gray-500">Received By:</p>
                  <p className="text-sm font-medium text-gray-900">{viewingTransaction.received_by_staff_name}</p>
                </div>
              )}
              {viewingTransaction.source && (
                <div className="flex items-center gap-1.5">
                  <p className="text-xs text-gray-500">Source:</p>
                  <p className="text-sm font-medium text-gray-900">{viewingTransaction.source}</p>
                </div>
              )}
              {viewingTransaction.petty_cash_books?.name && (
                <div className="flex items-center gap-1.5 text-teal-700">
                  <Building2 className="w-3.5 h-3.5" />
                  <p className="text-xs text-gray-500">Petty Cash Book:</p>
                  <p className="text-sm font-semibold text-teal-800">{viewingTransaction.petty_cash_books.name}</p>
                </div>
              )}
              {viewingTransaction.payment_voucher_id && (
                <div className="flex items-center gap-1.5 text-indigo-700">
                  <ExternalLink className="w-3.5 h-3.5" />
                  <p className="text-xs text-gray-500">Origin Payment Voucher:</p>
                  <p className="text-sm font-semibold text-indigo-800">{viewingTransaction.voucher_number || viewingTransaction.payment_voucher_id}</p>
                </div>
              )}
            </div>

            {viewingTransaction.bank_account_id && viewingTransaction.bank_statement_lines && (
              <div className="py-2 border-b border-gray-200">
                <BankTransactionLinkField
                  bankAccountId={viewingTransaction.bank_account_id}
                  linkedTransaction={viewingTransaction.bank_statement_lines}
                  currentPettyCashId={viewingTransaction.id}
                  disabled
                  canUnlink={canManage}
                  onSelect={() => undefined}
                  onUnlink={() => handleUnlinkBankTransaction(viewingTransaction)}
                />
              </div>
            )}

            {/* Linked References - Compact */}
            {(viewingTransaction.import_containers || viewingTransaction.delivery_challans || viewingTransaction.bank_accounts || viewingTransaction.source_account_id) && (
              <div className="py-2 border-b border-gray-200">
                <p className="text-xs text-gray-500 mb-1.5">Linked To</p>
                <div className="space-y-1">
                  {viewingTransaction.import_containers && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Package className="h-3.5 w-3.5 text-purple-600" />
                      <span className="text-gray-600">Container:</span>
                      <span className="font-medium text-gray-900">{viewingTransaction.import_containers.container_ref}</span>
                    </div>
                  )}
                  {viewingTransaction.delivery_challans && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Truck className="h-3.5 w-3.5 text-green-600" />
                      <span className="text-gray-600">Challan:</span>
                      <span className="font-medium text-gray-900">{viewingTransaction.delivery_challans.challan_number}</span>
                    </div>
                  )}
                  {viewingTransaction.bank_accounts && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Building2 className="h-3.5 w-3.5 text-blue-600" />
                      <span className="text-gray-600">Bank:</span>
                      <span className="font-medium text-gray-900">
                        {viewingTransaction.bank_accounts.alias || viewingTransaction.bank_accounts.bank_name}
                      </span>
                    </div>
                  )}
                  {viewingTransaction.source_account_id && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Building2 className="h-3.5 w-3.5 text-indigo-600" />
                      <span className="text-gray-600">Offset account:</span>
                      <span className="font-medium text-gray-900">
                        {(() => {
                          const account = postingAccounts.find(item => item.id === viewingTransaction.source_account_id);
                          if (!account) return viewingTransaction.source_account_id;
                          return account.code === '2105'
                            ? '2105 - Paid personally by Director (Payable to Director)'
                            : `${account.code} - ${account.name}`;
                        })()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Attached Documents with Thumbnails */}
            {viewingTransaction.petty_cash_documents && viewingTransaction.petty_cash_documents.length > 0 && (
              <div className="pt-2">
                <p className="text-xs text-gray-500 mb-2">Attachments ({viewingTransaction.petty_cash_documents.length})</p>
                <div className="grid grid-cols-2 gap-2">
                  {viewingTransaction.petty_cash_documents.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => openDocument(doc.file_url)}
                      className="group relative border border-gray-200 rounded overflow-hidden hover:border-blue-500 transition-colors text-left"
                    >
                      {doc.file_type === 'photo' ? (
                        <div className="aspect-square bg-gray-100 relative">
                          <img
                            src={signedUrlCache[doc.file_url] || doc.file_url}
                            alt={doc.file_name}
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-opacity flex items-center justify-center">
                            <ExternalLink className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </div>
                      ) : (
                        <div className="aspect-square bg-red-50 flex flex-col items-center justify-center p-3">
                          <FileText className="h-8 w-8 text-red-600 mb-2" />
                          <p className="text-xs text-center text-gray-700 line-clamp-2">{doc.file_name}</p>
                        </div>
                      )}
                      {doc.file_size && (
                        <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs px-2 py-0.5">
                          {(doc.file_size / 1024).toFixed(0)} KB
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="pt-3 border-t border-gray-200 flex justify-end">
              <button
                type="button"
                onClick={() => setViewModalOpen(false)}
                className="h-7 px-2 text-xs text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <FileText className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-blue-900 mb-2">Recording Fixed Assets</h4>
            <div className="text-sm text-blue-800 space-y-2">
              <p><strong>For Equipment/Asset Purchases:</strong></p>
              <ol className="list-decimal list-inside space-y-1 ml-2">
                <li>Use category "Fixed Assets / Equipment"</li>
                <li>Record the purchase here with full details</li>
                <li>This creates a debit to "Fixed Assets" account</li>
                <li>Assets are CAPITALIZED (not expensed immediately)</li>
                <li>Later: Finance team will set up depreciation schedule</li>
              </ol>
              <p className="text-xs mt-2 bg-blue-100 p-2 rounded">
                💡 Examples: Computers, machinery, furniture, vehicles, AC units, shelving
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Cancel Posting modal */}
      {cancelPostingModalOpen && cancelPostingTarget && (
        <Modal
          isOpen={cancelPostingModalOpen}
          onClose={() => { setCancelPostingModalOpen(false); setCancelPostingTarget(null); setCancelPostingReason(''); }}
          title="Cancel Posting"
        >
          <div className="space-y-2">
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-sm text-orange-800">
              <p className="font-semibold mb-1">{cancelPostingTarget.transaction_number}</p>
              <p>This will delete the posted journal entry and return the transaction to Draft. You can then edit and re-approve to repost.</p>
              <p className="mt-1 text-xs">This action cannot be done if the accounting period is closed.</p>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Reason for cancelling posting <span className="text-red-500">*</span></label>
              <textarea name="cancel_posting_reason" aria-label="Reason (e.g. wrong amount entered, incorrect category)..."
                value={cancelPostingReason}
                onChange={e => setCancelPostingReason(e.target.value)}
                rows={3}
                placeholder="Reason (e.g. wrong amount entered, incorrect category)..."
                className="w-full h-8 px-2 text-[11px] border border-gray-300 rounded bg-white focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setCancelPostingModalOpen(false); setCancelPostingTarget(null); setCancelPostingReason(''); }}
                className="h-7 px-2 text-xs border border-gray-300 rounded hover:bg-gray-50"
              >
                Back
              </button>
              <button
                onClick={handleCancelPostingConfirm}
                disabled={!cancelPostingReason.trim() || cancelPostingLoading}
                className="h-7 px-2 text-xs bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {cancelPostingLoading ? 'Cancelling...' : 'Cancel Posting'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Petty cash rejection modal */}
      {pcRejectionModalOpen && (
        <Modal isOpen={pcRejectionModalOpen} onClose={() => { setPcRejectionModalOpen(false); setPcRejectionReason(''); }} title="Reject Petty Cash Entry">
          <div className="space-y-2">
            <p className="text-sm text-gray-600">Please provide a reason for rejecting this petty cash entry.</p>
            <textarea name="pc_rejection_reason" aria-label="Reason for rejection..."
              value={pcRejectionReason}
              onChange={e => setPcRejectionReason(e.target.value)}
              rows={3}
              placeholder="Reason for rejection..."
              className="w-full h-8 px-2 text-[11px] border border-gray-300 rounded bg-white focus:ring-2 focus:ring-red-500 focus:border-red-500"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setPcRejectionModalOpen(false); setPcRejectionReason(''); }} className="h-7 px-2 text-xs border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
              <button
                onClick={handleRejectPettyCashConfirm}
                disabled={!pcRejectionReason.trim() || !!approvalLoading}
                className="h-7 px-2 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
