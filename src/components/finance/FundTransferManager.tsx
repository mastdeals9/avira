import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, ArrowRightLeft, CheckCircle, Clock, RotateCcw, Undo2, Landmark, AlertTriangle, Unlink, Edit3, ShieldAlert } from 'lucide-react';
import { FinancePage } from './FinancePage';
import { FinanceTable } from './FinanceTable';
import { FinanceModal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { F_BTN_PRIMARY, F_BTN_SECONDARY } from './FinanceForm';
import { SapRow, SAP_INPUT } from './SapLayout';
import { FloatingField, FLOAT_INPUT } from './FloatingField';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { useSupabaseRealtimeChannel } from '../../hooks/useSupabaseRealtimeChannel';
import { useLanguage } from '../../contexts/LanguageContext';
import { notifyFinanceReconciliationRefresh } from './bankTransactionLinking';
import { formatCurrency } from '../../utils/currency';
import { FinanceActionButton, FinanceBadge } from './FinanceUI';
import { useFinance } from '../../contexts/FinanceContext';
import { unlinkBankStatementLine } from '../../services/financeCommands';
import { useErpSyncListener, emitErpSync } from '../../utils/erpSyncBus';

interface FundTransfer {
  id: string;
  transfer_number: string;
  transfer_date: string;
  amount: number;
  from_amount: number;
  to_amount: number;
  exchange_rate: number | null;
  from_account_type: string;
  to_account_type: string;
  from_account_name: string;
  to_account_name: string;
  from_currency: string | null;
  to_currency: string | null;
  from_bank_account_id: string | null;
  to_bank_account_id: string | null;
  from_bank_statement_line_id: string | null;
  to_bank_statement_line_id: string | null;
  journal_entry_id: string | null;
  description: string | null;
  status: string;
  posted_at: string | null;
  created_at: string;
  created_by_name: string | null;
}

interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  alias: string | null;
  currency: string;
}

interface BankStatementLine {
  id: string;
  transaction_date: string;
  description: string | null;
  debit_amount: number | null;
  credit_amount: number | null;
  reconciliation_status: string | null;
  isCurrentLink?: boolean;
  isWrongDirection?: boolean;
}

type ReconciliationFilter = 'all' | 'fully_linked' | 'partially_linked' | 'unlinked';
type ReconciliationState = Exclude<ReconciliationFilter, 'all'> | 'not_applicable';

interface FundTransferManagerProps {
  canManage: boolean;
  initialViewTransferId?: string | null;
  onInitialViewHandled?: () => void;
  onOpenBankReconciliation?: (bankAccountId: string, bankStatementLineId: string) => void;
  prefillFromBankReconciliation?: {
    bankAccountId: string;
    statementLineId: string;
    date: string;
    amount: number;
    description: string;
    direction: 'from' | 'to';
  } | null;
  onPrefillConsumed?: () => void;
}

interface BankReconciliationConflict {
  kind: 'bank_reconciliation_conflict';
  bank_statement_line_id: string;
  bank_account_id: string;
  transaction_date: string;
  amount: number;
  currency: string;
  document_type: string;
  document_number: string;
  journal_entry_id: string | null;
  journal_entry_number: string | null;
  is_unexpected_match?: boolean;
}

// Helper function to format date as dd/mm/yy
const formatDateDDMMYY = (dateStr: string): string => {
  const date = new Date(dateStr);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear().toString().slice(-2);
  return `${day}/${month}/${year}`;
};

export function FundTransferManager({
  canManage,
  initialViewTransferId,
  onInitialViewHandled,
  onOpenBankReconciliation,
  prefillFromBankReconciliation,
  onPrefillConsumed,
}: FundTransferManagerProps) {
  const { t } = useLanguage();
  const { dateRange } = useFinance();
  const [transfers, setTransfers] = useState<FundTransfer[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [fromBankStatements, setFromBankStatements] = useState<BankStatementLine[]>([]);
  const [toBankStatements, setToBankStatements] = useState<BankStatementLine[]>([]);
  const [linkedBankStatementIds, setLinkedBankStatementIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTransfer, setEditingTransfer] = useState<FundTransfer | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [reconciliationFilter, setReconciliationFilter] = useState<ReconciliationFilter>('all');
  const [deletingTransferId, setDeletingTransferId] = useState<string | null>(null);
  const [undoingTransferId, setUndoingTransferId] = useState<string | null>(null);
  const [undoReverseTarget, setUndoReverseTarget] = useState<FundTransfer | null>(null);
  const [undoReverseReason, setUndoReverseReason] = useState('');
  const [reconciliationConflict, setReconciliationConflict] = useState<BankReconciliationConflict | null>(null);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [updatingLinks, setUpdatingLinks] = useState(false);
  const [formData, setFormData] = useState({
    transfer_date: new Date().toISOString().split('T')[0],
    from_amount: 0,
    to_amount: 0,
    from_account_type: 'bank' as 'petty_cash' | 'cash_on_hand' | 'bank',
    to_account_type: 'bank' as 'petty_cash' | 'cash_on_hand' | 'bank',
    from_bank_account_id: '',
    to_bank_account_id: '',
    from_bank_statement_line_id: '',
    to_bank_statement_line_id: '',
    description: '',
  });

  useEffect(() => {
    loadData();
  }, [dateRange.startDate, dateRange.endDate]);

  useErpSyncListener(
    ['bank_transactions', 'vouchers'],
    () => {
      loadData();
    }
  );

  useEffect(() => {
    if (!prefillFromBankReconciliation) return;
    resetForm();
    const isFrom = prefillFromBankReconciliation.direction === 'from';
    setFormData(prev => ({
      ...prev,
      transfer_date: prefillFromBankReconciliation.date,
      from_amount: prefillFromBankReconciliation.amount,
      to_amount: prefillFromBankReconciliation.amount,
      ...(isFrom ? {
        from_account_type: 'bank' as const,
        from_bank_account_id: prefillFromBankReconciliation.bankAccountId,
        from_bank_statement_line_id: prefillFromBankReconciliation.statementLineId,
      } : {
        to_account_type: 'bank' as const,
        to_bank_account_id: prefillFromBankReconciliation.bankAccountId,
        to_bank_statement_line_id: prefillFromBankReconciliation.statementLineId,
      }),
      description: prefillFromBankReconciliation.description,
    }));
    void loadBankStatements(prefillFromBankReconciliation.bankAccountId, isFrom ? 'from' : 'to', prefillFromBankReconciliation.statementLineId);
    setModalOpen(true);
    onPrefillConsumed?.();
  }, [prefillFromBankReconciliation, onPrefillConsumed]);

  // Read from/to account IDs and editingTransfer via ref so the realtime channel
  // stays stable-deps ([]) and does not resubscribe on every account change.
  const fundTransferRefsRef = useRef({
    from: '' as string,
    to: '' as string,
    editingFromLine: undefined as string | undefined,
    editingToLine: undefined as string | undefined,
  });
  useEffect(() => {
    fundTransferRefsRef.current = {
      from: formData.from_bank_account_id,
      to: formData.to_bank_account_id,
      editingFromLine: editingTransfer?.from_bank_statement_line_id || undefined,
      editingToLine: editingTransfer?.to_bank_statement_line_id || undefined,
    };
  }, [formData.from_bank_account_id, formData.to_bank_account_id, editingTransfer]);

  const patchBankLineFundTransfer = (payload: any) => {
    const refs = fundTransferRefsRef.current;
    const row = payload.new || payload.old;
    const affectedAccount = row?.bank_account_id;
    // Only refresh loaders that actually match the changed row's account.
    if (refs.from && affectedAccount === refs.from) {
      loadBankStatements(refs.from, 'from', refs.editingFromLine);
    }
    if (refs.to && affectedAccount === refs.to) {
      loadBankStatements(refs.to, 'to', refs.editingToLine);
    }
    void loadData();
  };

  useSupabaseRealtimeChannel({
    channelName: 'bank_lines_fund_transfer',
    table: 'bank_statement_lines',
    onEvent: patchBankLineFundTransfer,
  });

  useSupabaseRealtimeChannel({
    channelName: 'fund_transfers_list',
    table: 'fund_transfers',
    onEvent: () => {
      void loadData();
    },
  });

  const loadData = async () => {
    try {
      console.log('loadData: Starting to load fund transfers...');
      setLoading(true);
      const [transfersRes, banksRes] = await Promise.all([
        supabase
          .from('vw_fund_transfers_detailed')
          // perf: projected columns (was select('*'))
          .select('id, transfer_number, transfer_date, amount, from_amount, to_amount, exchange_rate, from_account_type, to_account_type, from_account_name, to_account_name, from_currency, to_currency, from_bank_account_id, to_bank_account_id, from_bank_statement_line_id, to_bank_statement_line_id, journal_entry_id, description, status, posted_at, created_at, created_by_name')
          .gte('transfer_date', dateRange.startDate)
          .lte('transfer_date', dateRange.endDate)
          .order('transfer_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('bank_accounts')
          .select('id, bank_name, account_number, alias, currency')
          .eq('is_active', true)
          .order('bank_name'),
      ]);

      console.log('loadData: Transfers result:', transfersRes.data?.length, 'records');
      if (transfersRes.error) throw transfersRes.error;
      if (banksRes.error) throw banksRes.error;

      const loadedTransfers = (transfersRes.data || []) as FundTransfer[];
      const statementLineIds = Array.from(new Set(
        loadedTransfers.flatMap((transfer) => [
          transfer.from_bank_statement_line_id,
          transfer.to_bank_statement_line_id,
        ]).filter((id): id is string => Boolean(id)),
      ));

      let validStatementIds = new Set<string>();
      if (statementLineIds.length > 0) {
        const { data: statementRows, error: statementError } = await supabase
          .from('bank_statement_lines')
          .select('id')
          .in('id', statementLineIds);

        if (statementError) throw statementError;
        validStatementIds = new Set((statementRows || []).map((line) => line.id));
      }

      setTransfers(loadedTransfers);
      setLinkedBankStatementIds(validStatementIds);
      setBankAccounts(banksRes.data || []);
    } catch (error: any) {
      console.error('Error loading fund transfers:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load fund transfers' });
    } finally {
      setLoading(false);
    }
  };

  const loadBankStatements = useCallback(async (bankAccountId: string, type: 'from' | 'to', includeLinkedId?: string) => {
    if (!bankAccountId) {
      if (type === 'from') setFromBankStatements([]);
      else setToBankStatements([]);
      return;
    }

    try {
      // Source bank = money leaving the account (DB/debit).
      // Destination bank = money entering the account (CR/credit).
      // Only load lines with the correct transaction side and no legacy links.
      let query = supabase
        .from('bank_statement_lines')
        .select('id, transaction_date, description, debit_amount, credit_amount, reconciliation_status')
        .eq('bank_account_id', bankAccountId)
        .is('matched_fund_transfer_id', null)
        .is('matched_expense_id', null)
        .is('matched_receipt_id', null)
        .is('matched_petty_cash_id', null)
        .is('matched_entry_id', null)
        .is('matched_payment_id', null)
        .is('matched_tax_payment_id', null)
        .order('transaction_date', { ascending: false });

      query = type === 'from'
        ? query.gt('debit_amount', 0.01)
        : query.gt('credit_amount', 0.01);

      const { data, error } = await query;
      if (error) throw error;

      let statements = (data || []) as BankStatementLine[];

      // A line can also be linked canonically even when old match columns were
      // not backfilled. Exclude any existing allocation or Fund Transfer reference.
      const candidateIds = statements.map(line => line.id);
      if (candidateIds.length > 0) {
        const [allocationsRes, fromTransfersRes, toTransfersRes] = await Promise.all([
          supabase
            .from('bank_statement_allocations')
            .select('bank_statement_line_id')
            .in('bank_statement_line_id', candidateIds),
          supabase
            .from('fund_transfers')
            .select('from_bank_statement_line_id')
            .in('from_bank_statement_line_id', candidateIds),
          supabase
            .from('fund_transfers')
            .select('to_bank_statement_line_id')
            .in('to_bank_statement_line_id', candidateIds),
        ]);

        const linkError = allocationsRes.error || fromTransfersRes.error || toTransfersRes.error;
        if (linkError) throw linkError;

        const alreadyUsed = new Set<string>([
          ...(allocationsRes.data || []).map(row => row.bank_statement_line_id).filter((id): id is string => Boolean(id)),
          ...(fromTransfersRes.data || []).map(row => row.from_bank_statement_line_id).filter((id): id is string => Boolean(id)),
          ...(toTransfersRes.data || []).map(row => row.to_bank_statement_line_id).filter((id): id is string => Boolean(id)),
        ]);
        statements = statements.filter(line => !alreadyUsed.has(line.id));
      }

      // When editing, retain this transfer's existing line for safe unlink/replace.
      // If its direction is wrong, show it explicitly as a warning rather than
      // silently losing the current selection; it is not treated as a candidate.
      if (includeLinkedId) {
        const { data: linkedData, error: linkedError } = await supabase
          .from('bank_statement_lines')
          .select('id, transaction_date, description, debit_amount, credit_amount, reconciliation_status')
          .eq('id', includeLinkedId)
          .eq('bank_account_id', bankAccountId)
          .maybeSingle();

        if (linkedError) throw linkedError;
        if (linkedData && !statements.some(line => line.id === linkedData.id)) {
          const isCorrectDirection = type === 'from'
            ? Number(linkedData.debit_amount || 0) > 0.01
            : Number(linkedData.credit_amount || 0) > 0.01;
          statements = [{
            ...linkedData,
            isCurrentLink: true,
            isWrongDirection: !isCorrectDirection,
          }, ...statements];
        }
      }

      if (type === 'from') setFromBankStatements(statements);
      else setToBankStatements(statements);
    } catch (error) {
      console.error('Error loading bank statements:', error);
      showToast({
        type: 'error',
        title: 'Bank statement options unavailable',
        message: 'Could not verify which bank transactions are still unlinked. Please retry; no transfer was changed.',
      });
      if (type === 'from') setFromBankStatements([]);
      else setToBankStatements([]);
    }
  }, []);

  const getFromCurrency = (): string => {
    if (formData.from_account_type === 'bank' && formData.from_bank_account_id) {
      const account = bankAccounts.find(b => b.id === formData.from_bank_account_id);
      return account?.currency || 'IDR';
    }
    return 'IDR';
  };

  const getToCurrency = (): string => {
    if (formData.to_account_type === 'bank' && formData.to_bank_account_id) {
      const account = bankAccounts.find(b => b.id === formData.to_bank_account_id);
      return account?.currency || 'IDR';
    }
    return 'IDR';
  };

  const calculateExchangeRate = (): number | null => {
    const fromCurrency = getFromCurrency();
    const toCurrency = getToCurrency();

    if (formData.from_amount > 0 && formData.to_amount > 0 && fromCurrency !== toCurrency) {
      return fromCurrency === 'USD'
        ? formData.to_amount / formData.from_amount
        : formData.from_amount / formData.to_amount;
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.from_amount <= 0) {
      showToast({ type: 'error', title: 'Error', message: 'From Amount must be greater than 0' });
      return;
    }

    if (formData.to_amount <= 0) {
      showToast({ type: 'error', title: 'Error', message: 'To Amount must be greater than 0' });
      return;
    }

    if (formData.from_account_type === formData.to_account_type) {
      if (formData.from_account_type === 'bank') {
        if (formData.from_bank_account_id === formData.to_bank_account_id) {
          showToast({ type: 'error', title: 'Error', message: 'Cannot transfer to the same bank account' });
          return;
        }
      } else {
        showToast({ type: 'error', title: 'Error', message: 'Cannot transfer to the same account type' });
        return;
      }
    }

    if (formData.from_account_type === 'bank' && !formData.from_bank_account_id) {
      showToast({ type: 'error', title: 'Error', message: 'Please select source bank account' });
      return;
    }

    if (formData.to_account_type === 'bank' && !formData.to_bank_account_id) {
      showToast({ type: 'error', title: 'Error', message: 'Please select destination bank account' });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const exchangeRate = calculateExchangeRate();

      if (editingTransfer) {
        if (editingTransfer.status === 'posted') {
          // POSTED Contra: Only bank statement lines can be linked/unlinked to preserve GL integrity
          setUpdatingLinks(true);
          const oldFromLineId = editingTransfer.from_bank_statement_line_id;
          const newFromLineId = formData.from_bank_statement_line_id || null;
          const oldToLineId = editingTransfer.to_bank_statement_line_id;
          const newToLineId = formData.to_bank_statement_line_id || null;

          // If from-bank line changed or unlinked, unmatch old line first
          if (oldFromLineId && oldFromLineId !== newFromLineId) {
            try {
              await unlinkBankStatementLine(oldFromLineId);
            } catch (err) {
              console.warn('Could not unmatch previous from-statement line:', err);
            }
          }

          // If to-bank line changed or unlinked, unmatch old line first
          if (oldToLineId && oldToLineId !== newToLineId) {
            try {
              await unlinkBankStatementLine(oldToLineId);
            } catch (err) {
              console.warn('Could not unmatch previous to-statement line:', err);
            }
          }

          const { error } = await supabase
            .from('fund_transfers')
            .update({
              from_bank_statement_line_id: newFromLineId,
              to_bank_statement_line_id: newToLineId,
            })
            .eq('id', editingTransfer.id);

          if (error) throw error;

          notifyFinanceReconciliationRefresh();
          showToast({ type: 'success', title: 'Success', message: 'Bank statement links updated successfully!' });
        } else {
          // UPDATE existing draft/pending transfer
          const transferData: any = {
            transfer_date: formData.transfer_date,
            amount: formData.from_amount,  // For backwards compatibility
            from_amount: formData.from_amount,
            to_amount: formData.to_amount,
            exchange_rate: exchangeRate,
            from_account_type: formData.from_account_type,
            to_account_type: formData.to_account_type,
            description: formData.description || null,
            from_bank_account_id: formData.from_account_type === 'bank' ? formData.from_bank_account_id : null,
            to_bank_account_id: formData.to_account_type === 'bank' ? formData.to_bank_account_id : null,
            from_bank_statement_line_id: formData.from_bank_statement_line_id || null,
            to_bank_statement_line_id: formData.to_bank_statement_line_id || null,
          };

          const { error } = await supabase
            .from('fund_transfers')
            .update(transferData)
            .eq('id', editingTransfer.id);

          if (error) throw error;

          showToast({ type: 'success', title: 'Success', message: 'Fund transfer updated successfully!' });
        }
      } else {
        // CREATE new transfer + optional petty cash posting atomically in DB
        const { error } = await supabase.rpc('create_fund_transfer_with_posting', {
          p_transfer_date: formData.transfer_date,
          p_from_amount: formData.from_amount,
          p_to_amount: formData.to_amount,
          p_from_account_type: formData.from_account_type,
          p_to_account_type: formData.to_account_type,
          p_description: formData.description || null,
          p_from_bank_account_id: formData.from_account_type === 'bank' ? formData.from_bank_account_id : null,
          p_to_bank_account_id: formData.to_account_type === 'bank' ? formData.to_bank_account_id : null,
          p_from_bank_statement_line_id: formData.from_bank_statement_line_id || null,
          p_to_bank_statement_line_id: formData.to_bank_statement_line_id || null,
          p_exchange_rate: exchangeRate,
          p_created_by: user.id,
        });

        if (error) throw error;

        notifyFinanceReconciliationRefresh();
        showToast({ type: 'success', title: 'Success', message: 'Fund transfer created and posted successfully!' });
      }

      setModalOpen(false);
      resetForm();
      await loadData();
    } catch (error: any) {
      console.error('Error with fund transfer:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to save fund transfer: ' + error.message });
    } finally {
      setUpdatingLinks(false);
    }
  };

  const resetForm = () => {
    setFormData({
      transfer_date: new Date().toISOString().split('T')[0],
      from_amount: 0,
      to_amount: 0,
      from_account_type: 'bank',
      to_account_type: 'bank',
      from_bank_account_id: '',
      to_bank_account_id: '',
      from_bank_statement_line_id: '',
      to_bank_statement_line_id: '',
      description: '',
    });
    setFromBankStatements([]);
    setToBankStatements([]);
    setEditingTransfer(null);
    setViewOnly(false);
  };

  const handleEdit = async (transfer: FundTransfer) => {
    setEditingTransfer(transfer);
    setViewOnly(false);

    // Populate form with existing data
    setFormData({
      transfer_date: transfer.transfer_date,
      from_amount: transfer.from_amount,
      to_amount: transfer.to_amount,
      from_account_type: transfer.from_account_type as any,
      to_account_type: transfer.to_account_type as any,
      from_bank_account_id: transfer.from_bank_account_id || '',
      to_bank_account_id: transfer.to_bank_account_id || '',
      from_bank_statement_line_id: transfer.from_bank_statement_line_id || '',
      to_bank_statement_line_id: transfer.to_bank_statement_line_id || '',
      description: transfer.description || '',
    });

    // Load bank statements if bank accounts are selected, including the already linked ones
    if (transfer.from_bank_account_id) {
      loadBankStatements(transfer.from_bank_account_id, 'from', transfer.from_bank_statement_line_id || undefined);
    }
    if (transfer.to_bank_account_id) {
      loadBankStatements(transfer.to_bank_account_id, 'to', transfer.to_bank_statement_line_id || undefined);
    }

    setModalOpen(true);
  };

  const handleView = useCallback(async (transfer: FundTransfer) => {
    setEditingTransfer(transfer);
    setViewOnly(true);

    setFormData({
      transfer_date: transfer.transfer_date,
      from_amount: transfer.from_amount,
      to_amount: transfer.to_amount,
      from_account_type: transfer.from_account_type as any,
      to_account_type: transfer.to_account_type as any,
      from_bank_account_id: transfer.from_bank_account_id || '',
      to_bank_account_id: transfer.to_bank_account_id || '',
      from_bank_statement_line_id: transfer.from_bank_statement_line_id || '',
      to_bank_statement_line_id: transfer.to_bank_statement_line_id || '',
      description: transfer.description || '',
    });

    if (transfer.from_bank_account_id) {
      loadBankStatements(transfer.from_bank_account_id, 'from', transfer.from_bank_statement_line_id || undefined);
    }
    if (transfer.to_bank_account_id) {
      loadBankStatements(transfer.to_bank_account_id, 'to', transfer.to_bank_statement_line_id || undefined);
    }

    setModalOpen(true);
  }, [loadBankStatements]);

  useEffect(() => {
    if (!initialViewTransferId || loading) return;

    const openInitialTransfer = async () => {
      let transfer = transfers.find(item => item.id === initialViewTransferId);
      if (!transfer) {
        const { data, error } = await supabase
          .from('vw_fund_transfers_detailed')
          .select('id, transfer_number, transfer_date, amount, from_amount, to_amount, exchange_rate, from_account_type, to_account_type, from_account_name, to_account_name, from_currency, to_currency, from_bank_account_id, to_bank_account_id, from_bank_statement_line_id, to_bank_statement_line_id, journal_entry_id, description, status, posted_at, created_at, created_by_name')
          .eq('id', initialViewTransferId)
          .maybeSingle();
        if (error) {
          console.error('Error loading originating fund transfer:', error);
        }
        transfer = data || undefined;
      }

      if (transfer) {
        await handleView(transfer);
      } else {
        showToast({ type: 'error', title: 'Not Found', message: 'The originating Contra Voucher could not be found.' });
      }
      onInitialViewHandled?.();
    };

    void openInitialTransfer();
  }, [initialViewTransferId, loading, transfers, onInitialViewHandled, handleView]);

  const handleDelete = async (transferId: string) => {
    const transfer = transfers.find(t => t.id === transferId);
    if (!transfer) return;

    const confirmed = await showConfirm({
      title: 'Delete Fund Transfer',
      message: `Delete fund transfer ${transfer.transfer_number} permanently? This will remove all linked journal entries (including any reversal), unlink bank matches, and delete the associated petty cash transaction. This cannot be undone.`,
      variant: 'danger',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;

    setDeletingTransferId(transferId);
    try {
      const { error } = await supabase.rpc('delete_fund_transfer', { p_id: transferId });
      if (error) throw error;
      notifyFinanceReconciliationRefresh();
      showToast({ type: 'success', title: 'Success', message: 'Fund transfer deleted successfully!' });
      await loadData();
    } catch (error: any) {
      console.error('Error deleting fund transfer:', error.message);
      const reason = [error.message, error.details, error.hint]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join(' ');
      showToast({
        type: 'error',
        title: 'Delete Blocked',
        message: reason || 'The fund transfer could not be deleted safely.',
      });
    } finally {
      setDeletingTransferId(null);
    }
  };

  const handleReverse = async (transferId: string) => {
    const transfer = transfers.find(t => t.id === transferId);
    if (!transfer) return;

    const confirmed = await showConfirm({
      title: 'Reverse Fund Transfer',
      message: `Reverse this posted fund transfer ${transfer.transfer_number}? This will post a reversing journal entry and mark the transfer as reversed. The original record will be preserved for audit.`,
      variant: 'danger',
      confirmLabel: 'Reverse',
    });
    if (!confirmed) return;

    try {
      const { error } = await supabase.rpc('reverse_fund_transfer', { p_id: transferId });
      if (error) throw error;
      notifyFinanceReconciliationRefresh();
      showToast({ type: 'success', title: 'Success', message: 'Fund transfer reversed successfully!' });
      loadData();
    } catch (error: any) {
      console.error('Error reversing fund transfer:', error.message);
      showToast({
        type: 'error',
        title: 'Error',
        message: 'Failed to reverse fund transfer: ' + error.message,
      });
    }
  };

  const openUndoReverse = (transfer: FundTransfer) => {
    if (transfer.status !== 'reversed') return;
    setUndoReverseTarget(transfer);
    setUndoReverseReason('');
  };

  const handleUndoReverse = async () => {
    const transfer = undoReverseTarget;
    if (!transfer) return;

    setUndoingTransferId(transfer.id);
    try {
      const { error } = await supabase.rpc('undo_reverse_fund_transfer', {
        p_id: transfer.id,
        p_reason: undoReverseReason.trim() || null,
      });
      if (error) throw error;

      notifyFinanceReconciliationRefresh();
      setUndoReverseTarget(null);
      setUndoReverseReason('');
      setModalOpen(false);
      resetForm();
      await loadData();
      showToast({
        type: 'success',
        title: 'Reversal Undone',
        message: `${transfer.transfer_number} has been restored to Posted.`,
      });
    } catch (error: any) {
      console.error('Error undoing fund transfer reversal:', error.message);
      try {
        const details = JSON.parse(error.details || '');
        if (
          details?.kind === 'bank_reconciliation_conflict'
          && details.bank_account_id
          && details.bank_statement_line_id
        ) {
          setUndoReverseTarget(null);
          setUndoReverseReason('');
          setReconciliationConflict(details as BankReconciliationConflict);
          return;
        }
      } catch {
        // Non-structured database errors continue through the fallback path.
      }

      const errorMsg = error.message || '';
      if (
        errorMsg.includes('unexpected bank statement line') ||
        errorMsg.includes('bank reconciliation dependency') ||
        errorMsg.includes('bank statement line is linked')
      ) {
        try {
          const { data: conflictLines } = await supabase
            .from('bank_statement_lines')
            .select('id, bank_account_id, transaction_date, debit_amount, credit_amount, description, reconciliation_status, matched_fund_transfer_id, matched_entry_id')
            .or(`matched_fund_transfer_id.eq.${transfer.id}${transfer.journal_entry_id ? `,matched_entry_id.eq.${transfer.journal_entry_id}` : ''}`)
            .limit(1);

          if (conflictLines && conflictLines.length > 0) {
            const line = conflictLines[0];
            const amount = Number(line.debit_amount || line.credit_amount || transfer.from_amount);
            const bankAcc = bankAccounts.find(b => b.id === line.bank_account_id);
            setUndoReverseTarget(null);
            setUndoReverseReason('');
            setReconciliationConflict({
              kind: 'bank_reconciliation_conflict',
              bank_statement_line_id: line.id,
              bank_account_id: line.bank_account_id,
              transaction_date: line.transaction_date,
              amount: amount,
              currency: bankAcc?.currency || transfer.from_currency || 'IDR',
              document_type: 'Fund Transfer',
              document_number: transfer.transfer_number,
              journal_entry_id: transfer.journal_entry_id,
              journal_entry_number: line.description || null,
              is_unexpected_match: true,
            });
            return;
          }
        } catch (findErr) {
          console.error('Error finding conflicting bank line:', findErr);
        }
      }

      showToast({
        type: 'error',
        title: 'Undo Reverse Blocked',
        message: error.message || 'The Contra reversal could not be undone safely.',
      });
    } finally {
      setUndoingTransferId(null);
    }
  };

  const getAccountTypeLabel = (type: string) => {
    switch (type) {
      case 'petty_cash': return 'Petty Cash';
      case 'cash_on_hand': return 'Cash on Hand';
      case 'bank': return 'Bank Account';
      default: return type;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'posted':
        return <FinanceBadge status="posted"><CheckCircle className="h-3 w-3" />Posted</FinanceBadge>;
      case 'pending':
        return <FinanceBadge status="pending"><Clock className="h-3 w-3" />Pending</FinanceBadge>;
      case 'reversed':
        return <FinanceBadge status="reversed"><RotateCcw className="h-3 w-3" />Reversed</FinanceBadge>;
      case 'cancelled':
        return <FinanceBadge status="cancelled">Cancelled</FinanceBadge>;
      default:
        return <span className="text-xs text-gray-500">{status}</span>;
    }
  };

  const fmtAmount = (ccy: string, amt: number) => formatCurrency(amt, ccy);

  const isBankSideLinked = (transfer: FundTransfer, side: 'from' | 'to'): boolean => {
    const statementLineId = transfer[`${side}_bank_statement_line_id`];
    return Boolean(statementLineId && linkedBankStatementIds.has(statementLineId));
  };

  const getReconciliationState = (transfer: FundTransfer): ReconciliationState => {
    const bankSides: boolean[] = [];
    if (transfer.from_bank_account_id || transfer.from_bank_statement_line_id) {
      bankSides.push(isBankSideLinked(transfer, 'from'));
    }
    if (transfer.to_bank_account_id || transfer.to_bank_statement_line_id) {
      bankSides.push(isBankSideLinked(transfer, 'to'));
    }

    if (bankSides.length === 0) return 'not_applicable';
    if (bankSides.every(Boolean)) return 'fully_linked';
    if (bankSides.some(Boolean)) return 'partially_linked';
    return 'unlinked';
  };

  const filteredTransfers = transfers.filter((transfer) => (
    reconciliationFilter === 'all'
    || getReconciliationState(transfer) === reconciliationFilter
  ));

  const renderAccountType = (transfer: FundTransfer, side: 'from' | 'to') => {
    const accountType = transfer[`${side}_account_type`];
    const linked = isBankSideLinked(transfer, side);

    if (accountType !== 'bank') {
      return <div className="text-[10px] text-gray-500">{getAccountTypeLabel(accountType)}</div>;
    }

    return (
      <div className="text-[10px] text-gray-500">
        Bank Account ·{' '}
        <span className={linked ? 'font-normal text-gray-600' : 'font-bold text-red-600'}>
          {linked ? 'Linked' : 'Unlinked'}
        </span>
      </div>
    );
  };

  return (
    <>
      <FinancePage
        title="Fund Transfers"
        actions={canManage && (
          <button
            type="button"
            onClick={() => { resetForm(); setModalOpen(true); }}
            className="inline-flex items-center gap-1.5 h-8 px-3 bg-blue-600 text-white rounded-md text-xs font-medium hover:bg-blue-700 transition-colors shadow-xs whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Transfer</span>
          </button>
        )}
        toolbar={(
          <div className="inline-flex items-center bg-gray-100 p-0.5 rounded-md">
            {([
              ['all', 'All'],
              ['fully_linked', 'Fully Linked'],
              ['partially_linked', 'Partially Linked'],
              ['unlinked', 'Unlinked'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setReconciliationFilter(value)}
                className={`h-7 px-2.5 rounded text-xs font-medium transition-colors ${
                  reconciliationFilter === value
                    ? 'bg-white text-blue-700 font-semibold shadow-xs'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      >
        <FinanceTable
          rows={filteredTransfers}
          rowKey={(t) => t.id}
          onRowClick={(transfer) => handleView(transfer)}
          loading={loading}
          empty={reconciliationFilter === 'all' ? 'No fund transfers found' : 'No fund transfers match this reconciliation filter'}
          columns={[
            { header: 'Date',       cell: (t) => formatDateDDMMYY(t.transfer_date) },
            { header: 'Transfer #', cell: (t) => (
              <span className="inline-flex items-center gap-1 font-mono">
                {['partially_linked', 'unlinked'].includes(getReconciliationState(t)) && (
                  <AlertTriangle className="w-3 h-3 text-amber-600" aria-label="Bank reconciliation incomplete" />
                )}
                {t.transfer_number}
              </span>
            ) },
            { header: 'From',       cell: (t) => (
              <div>
                <div className="font-medium">{t.from_account_name}</div>
                {renderAccountType(t, 'from')}
              </div>
            ) },
            { header: '→', align: 'center', cell: () => <ArrowRightLeft className="w-3 h-3 text-blue-600 inline" /> },
            { header: 'To',         cell: (t) => (
              <div>
                <div className="font-medium">{t.to_account_name}</div>
                {renderAccountType(t, 'to')}
              </div>
            ) },
            { header: 'Description', cell: (t) => t.description || '-' },
            { header: 'Amount', align: 'right', cell: (t) => (
              t.from_currency === t.to_currency
                ? <span className="font-medium">{fmtAmount(t.from_currency || 'IDR', t.from_amount)}</span>
                : (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span className="text-red-600">{fmtAmount(t.from_currency || 'IDR', t.from_amount)}</span>
                    <span className="text-gray-400">→</span>
                    <span className="text-green-600">{fmtAmount(t.to_currency || 'IDR', t.to_amount)}</span>
                  </span>
                )
            ) },
            { header: 'Status', align: 'center', cell: (t) => getStatusBadge(t.status) },
            ...(canManage ? [{
              header: 'Actions', align: 'center' as const,
              cell: (t: FundTransfer) => (
                <div className="flex items-center justify-center gap-0.5">
                  {['pending', 'draft'].includes(t.status) && (
                    <FinanceActionButton action="edit" label="Edit Transfer" onClick={(e) => { e.stopPropagation(); handleEdit(t); }} />
                  )}
                  {t.status === 'posted' && (
                    <FinanceActionButton action="edit" label="Edit / Link Statement" onClick={(e) => { e.stopPropagation(); handleEdit(t); }} />
                  )}
                  {t.status === 'posted' && (
                    <FinanceActionButton action="view" label="View Transfer" onClick={(e) => { e.stopPropagation(); handleView(t); }} />
                  )}
                  {t.status === 'posted' && (
                    <FinanceActionButton action="reverse" label="Reverse this posted transfer" onClick={(e) => { e.stopPropagation(); handleReverse(t.id); }} />
                  )}
                  {(t.status === 'reversed' || t.status === 'cancelled') && (
                    <FinanceActionButton action="view" label="View Transfer" onClick={(e) => { e.stopPropagation(); handleView(t); }} />
                  )}
                  {t.status === 'reversed' && (
                    <FinanceActionButton
                      action="reverse"
                      label="Undo Reverse"
                      onClick={(e) => { e.stopPropagation(); openUndoReverse(t); }}
                      disabled={undoingTransferId === t.id}
                    />
                  )}
                  {t.status !== 'posted' && (
                    <FinanceActionButton
                      action="delete"
                      label="Delete permanently"
                      onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
                      disabled={deletingTransferId === t.id}
                    />
                  )}
                </div>
              ),
            }] : []),
          ]}
        />
      </FinancePage>

      {modalOpen && (() => {
        const isAccountingLocked = !viewOnly && editingTransfer?.status === 'posted';
        return (
        <FinanceModal
          isOpen={modalOpen}
          onClose={() => { setModalOpen(false); resetForm(); }}
          title={viewOnly ? "View Fund Transfer" : isAccountingLocked ? `Link Bank Statement (${editingTransfer?.transfer_number})` : editingTransfer ? "Edit Fund Transfer" : "New Fund Transfer"}
          size="md"
          footer={
            <>
              {viewOnly && editingTransfer?.status === 'reversed' && canManage && (
                <button
                  type="button"
                  onClick={() => openUndoReverse(editingTransfer)}
                  disabled={undoingTransferId === editingTransfer.id}
                  className="inline-flex items-center gap-1 h-7 px-2 border border-green-300 text-green-700 bg-green-50 rounded text-xs font-semibold hover:bg-green-100 disabled:opacity-50"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  Undo Reverse
                </button>
              )}
              {viewOnly && editingTransfer?.status === 'posted' && canManage && (
                <button
                  type="button"
                  onClick={() => setViewOnly(false)}
                  className="inline-flex items-center gap-1 h-7 px-2 border border-blue-300 text-blue-700 bg-blue-50 rounded text-xs font-semibold hover:bg-blue-100"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  Edit / Link Statement
                </button>
              )}
              <button type="button" onClick={() => { setModalOpen(false); resetForm(); }} className={F_BTN_SECONDARY}>
                {viewOnly ? 'Close' : 'Cancel'}
              </button>
              {!viewOnly && (
                <button type="submit" form="fund-transfer-form" className={F_BTN_PRIMARY} disabled={updatingLinks}>
                  {updatingLinks ? 'Saving...' : isAccountingLocked ? 'Save Statement Links' : editingTransfer ? 'Update Transfer' : 'Create Transfer'}
                </button>
              )}
            </>
          }
        >
          <form id="fund-transfer-form" onSubmit={handleSubmit} className="flex flex-col gap-1">
            {isAccountingLocked && (
              <div className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded p-2.5 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-blue-900">Posted Voucher Accounting Protection</p>
                  <p className="text-[11px] text-blue-700 mt-0.5">
                    Accounting amounts, dates, and accounts are locked in compliance with accounting controls. You can link, change, or unlink the associated bank statement lines below.
                  </p>
                </div>
              </div>
            )}
            <fieldset disabled={viewOnly} className="contents">
            {/* Row A: Date · From Type · From Bank */}
            <SapRow>
              <FloatingField label="Date" required span={4 as 3|4|6|8|12} filled={!!formData.transfer_date}>
                <input name="transfer_date" aria-label="Transfer Date" type="date" value={formData.transfer_date}
                  onChange={(e) => setFormData({ ...formData, transfer_date: e.target.value })}
                  disabled={viewOnly || isAccountingLocked}
                  className={FLOAT_INPUT} required />
              </FloatingField>
              <FloatingField label="From Type" required span={4 as 3|4|6|8|12} filled={!!formData.from_account_type}>
                <select name="from_account_type" aria-label="From Account Type" value={formData.from_account_type}
                  onChange={(e) => setFormData({
                    ...formData,
                    from_account_type: e.target.value as any,
                    from_bank_account_id: e.target.value === 'bank' ? formData.from_bank_account_id : ''
                  })}
                  disabled={viewOnly || isAccountingLocked}
                  className={FLOAT_INPUT} required>
                  <option value="bank">Bank Account</option>
                  <option value="petty_cash">Petty Cash</option>
                </select>
              </FloatingField>
              {formData.from_account_type === 'bank' && (
                <FloatingField label="From Bank" required span={4 as 3|4|6|8|12} filled={!!formData.from_bank_account_id}>
                  <select name="from_bank_account_id" aria-label="From Bank Account Id" value={formData.from_bank_account_id}
                    onChange={(e) => {
                      setFormData({ ...formData, from_bank_account_id: e.target.value, from_bank_statement_line_id: '' });
                      loadBankStatements(e.target.value, 'from');
                    }}
                    disabled={viewOnly || isAccountingLocked}
                    className={FLOAT_INPUT} required>
                    <option value="">Select</option>
                    {bankAccounts.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.alias || bank.bank_name} - {bank.account_number} ({bank.currency})
                      </option>
                    ))}
                  </select>
                </FloatingField>
              )}
            </SapRow>

            {/* Row B: From Amount · To Type · To Bank */}
            <SapRow>
              <FloatingField label={`From (${getFromCurrency()})`} required span={4 as 3|4|6|8|12} filled={formData.from_amount > 0}>
                <MoneyInput decimal value={formData.from_amount}
                  onChange={(n) => {
                    const newAmount = n;
                    const fromCurrency = getFromCurrency();
                    const toCurrency = getToCurrency();
                    if (fromCurrency === toCurrency) {
                      setFormData({ ...formData, from_amount: newAmount, to_amount: newAmount });
                    } else {
                      setFormData({ ...formData, from_amount: newAmount });
                    }
                  }}
                  disabled={viewOnly || isAccountingLocked}
                  className={FLOAT_INPUT + ' !text-right !font-mono !font-semibold'} required />
              </FloatingField>
              <FloatingField label="To Type" required span={4 as 3|4|6|8|12} filled={!!formData.to_account_type}>
                <select name="to_account_type" aria-label="To Account Type" value={formData.to_account_type}
                  onChange={(e) => setFormData({
                    ...formData,
                    to_account_type: e.target.value as any,
                    to_bank_account_id: e.target.value === 'bank' ? formData.to_bank_account_id : ''
                  })}
                  disabled={viewOnly || isAccountingLocked}
                  className={FLOAT_INPUT} required>
                  <option value="petty_cash">Petty Cash</option>
                  <option value="bank">Bank Account</option>
                </select>
              </FloatingField>
              {formData.to_account_type === 'bank' && (
                <FloatingField label="To Bank" required span={4 as 3|4|6|8|12} filled={!!formData.to_bank_account_id}>
                  <select name="to_bank_account_id" aria-label="To Bank Account Id" value={formData.to_bank_account_id}
                    onChange={(e) => {
                      setFormData({ ...formData, to_bank_account_id: e.target.value, to_bank_statement_line_id: '' });
                      loadBankStatements(e.target.value, 'to');
                    }}
                    disabled={viewOnly || isAccountingLocked}
                    className={FLOAT_INPUT} required>
                    <option value="">Select</option>
                    {bankAccounts.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.alias || bank.bank_name} - {bank.account_number} ({bank.currency})
                      </option>
                    ))}
                  </select>
                </FloatingField>
              )}
            </SapRow>

            {/* Row C: To Amount + optional bank statement links */}
            <SapRow>
              <FloatingField label={`To (${getToCurrency()})`} required span={4 as 3|4|6|8|12} filled={formData.to_amount > 0}
                right={getFromCurrency() !== getToCurrency() && formData.from_amount > 0 && formData.to_amount > 0 ? (
                  <span className="text-[9px] text-gray-500">
                    1 USD = {(getFromCurrency() === 'USD' ? formData.to_amount / formData.from_amount : formData.from_amount / formData.to_amount).toLocaleString('id-ID', { maximumFractionDigits: 2 })}
                  </span>
                ) : null}>
                <MoneyInput decimal value={formData.to_amount}
                  onChange={(n) => setFormData({ ...formData, to_amount: n })}
                  disabled={viewOnly || isAccountingLocked}
                  className={FLOAT_INPUT + ' !text-right !font-mono !font-semibold'} required />
              </FloatingField>
              {formData.from_bank_account_id && (
                <FloatingField label="From Bank Stmt" span={4 as 3|4|6|8|12} filled={!!formData.from_bank_statement_line_id}>
                  <div className="flex items-center gap-1">
                    {fromBankStatements.length > 0 ? (
                      <select name="from_bank_statement_line_id" aria-label="From Bank Statement Line Id" value={formData.from_bank_statement_line_id}
                        onChange={(e) => setFormData({ ...formData, from_bank_statement_line_id: e.target.value })}
                        disabled={viewOnly}
                        className={FLOAT_INPUT}>
                        <option value="">No link</option>
                        {fromBankStatements
                          .filter(stmt => stmt.id === formData.from_bank_statement_line_id || stmt.id !== formData.to_bank_statement_line_id)
                          .map((stmt) => {
                            const actualSide = Number(stmt.debit_amount || 0) > 0.01 ? 'DB' : 'CR';
                            const labelPrefix = stmt.isWrongDirection
                              ? `⚠ Current link · wrong side (${actualSide}; expected DB) · `
                              : stmt.isCurrentLink ? 'Current link · DB · ' : 'DB · ';
                            const amount = stmt.isWrongDirection
                              ? Number(stmt.debit_amount || stmt.credit_amount || 0)
                              : Number(stmt.debit_amount || 0);
                            return (
                              <option key={stmt.id} value={stmt.id}>
                                {labelPrefix}{formatDateDDMMYY(stmt.transaction_date)} · {stmt.description?.substring(0, 30)} · {fmtAmount(getFromCurrency(), amount)}
                              </option>
                            );
                          })}
                      </select>
                    ) : (
                      <div className={FLOAT_INPUT + ' !bg-gray-50 !text-gray-400 italic flex items-center'}>No unlinked txn</div>
                    )}
                    {!viewOnly && formData.from_bank_statement_line_id && (
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, from_bank_statement_line_id: '' })}
                        className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded shrink-0"
                        title="Unlink statement line"
                      >
                        <Unlink className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </FloatingField>
              )}
              {formData.to_bank_account_id && (
                <FloatingField label="To Bank Stmt" span={4 as 3|4|6|8|12} filled={!!formData.to_bank_statement_line_id}>
                  <div className="flex items-center gap-1">
                    {toBankStatements.length > 0 ? (
                      <select name="to_bank_statement_line_id" aria-label="To Bank Statement Line Id" value={formData.to_bank_statement_line_id}
                        onChange={(e) => setFormData({ ...formData, to_bank_statement_line_id: e.target.value })}
                        disabled={viewOnly}
                        className={FLOAT_INPUT}>
                        <option value="">No link</option>
                        {toBankStatements
                          .filter(stmt => stmt.id === formData.to_bank_statement_line_id || stmt.id !== formData.from_bank_statement_line_id)
                          .map((stmt) => {
                            const actualSide = Number(stmt.credit_amount || 0) > 0.01 ? 'CR' : 'DB';
                            const labelPrefix = stmt.isWrongDirection
                              ? `⚠ Current link · wrong side (${actualSide}; expected CR) · `
                              : stmt.isCurrentLink ? 'Current link · CR · ' : 'CR · ';
                            const amount = stmt.isWrongDirection
                              ? Number(stmt.debit_amount || stmt.credit_amount || 0)
                              : Number(stmt.credit_amount || 0);
                            return (
                              <option key={stmt.id} value={stmt.id}>
                                {labelPrefix}{formatDateDDMMYY(stmt.transaction_date)} · {stmt.description?.substring(0, 30)} · {fmtAmount(getToCurrency(), amount)}
                              </option>
                            );
                          })}
                      </select>
                    ) : (
                      <div className={FLOAT_INPUT + ' !bg-gray-50 !text-gray-400 italic flex items-center'}>No unlinked txn</div>
                    )}
                    {!viewOnly && formData.to_bank_statement_line_id && (
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, to_bank_statement_line_id: '' })}
                        className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded shrink-0"
                        title="Unlink statement line"
                      >
                        <Unlink className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </FloatingField>
              )}
            </SapRow>

            <SapRow>
              <FloatingField label="Description" span={12 as 3|4|6|8|12} filled={!!formData.description}>
                <input name="description" aria-label="Purpose of transfer (optional)" type="text" value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  disabled={viewOnly || isAccountingLocked}
                  className={FLOAT_INPUT} placeholder="Purpose of transfer (optional)" />
              </FloatingField>
            </SapRow>

            {!viewOnly && !isAccountingLocked && (
              <p className="text-[10px] text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1">
                <ArrowRightLeft className="w-3 h-3 inline mr-1" />
                Journal entry will be posted automatically when the transfer is saved. Both accounts update immediately.
              </p>
            )}
          </fieldset>

          </form>
        </FinanceModal>
        );
      })()}

      {undoReverseTarget && (
        <FinanceModal
          isOpen
          onClose={() => {
            if (undoingTransferId) return;
            setUndoReverseTarget(null);
            setUndoReverseReason('');
          }}
          title="Undo Contra Reversal"
          size="sm"
          footer={
            <>
              <button
                type="button"
                onClick={() => {
                  setUndoReverseTarget(null);
                  setUndoReverseReason('');
                }}
                disabled={Boolean(undoingTransferId)}
                className={F_BTN_SECONDARY}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleUndoReverse}
                disabled={Boolean(undoingTransferId)}
                className={F_BTN_PRIMARY}
              >
                <Undo2 className="w-3.5 h-3.5" />
                {undoingTransferId ? 'Restoring...' : 'Undo Reverse'}
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p className="text-gray-700">
              Restore <span className="font-mono font-semibold">{undoReverseTarget.transfer_number}</span> to Posted?
              The original journal will become active and the preserved reversing journal will be marked inactive.
            </p>
            <p className="text-xs text-amber-700">
              The operation will be blocked if accounting periods, journal integrity, or bank reconciliation dependencies are no longer safe.
            </p>
            <label className="block">
              <span className="block mb-1 text-xs font-medium text-gray-700">Reason (optional)</span>
              <textarea name="undo_reverse_reason" aria-label="Reason for restoring this Contra Voucher"
                value={undoReverseReason}
                onChange={(event) => setUndoReverseReason(event.target.value)}
                rows={3}
                maxLength={500}
                disabled={Boolean(undoingTransferId)}
                className={`${SAP_INPUT} h-auto py-2 resize-none`}
                placeholder="Reason for restoring this Contra Voucher"
              />
            </label>
          </div>
        </FinanceModal>
      )}
      {reconciliationConflict && (
        <FinanceModal
          isOpen
          onClose={() => setReconciliationConflict(null)}
          title="Bank Reconciliation Conflict"
          size="sm"
          footer={
            <>
              <button
                type="button"
                onClick={() => setReconciliationConflict(null)}
                className={F_BTN_SECONDARY}
              >
                Close
              </button>
              {reconciliationConflict.is_unexpected_match && (
                <button
                  type="button"
                  onClick={async () => {
                    setResolvingConflict(true);
                    try {
                      await unlinkBankStatementLine(reconciliationConflict.bank_statement_line_id);
                      notifyFinanceReconciliationRefresh();
                      showToast({
                        type: 'success',
                        title: 'Statement Line Unlinked',
                        message: 'Unlinked bank statement line. Restoring Contra voucher...',
                      });
                      const targetTransfer = transfers.find((t) => t.transfer_number === reconciliationConflict.document_number);
                      if (targetTransfer) {
                        const { error: undoErr } = await supabase.rpc('undo_reverse_fund_transfer', {
                          p_id: targetTransfer.id,
                          p_reason: 'Resolved unexpected statement line dependency',
                        });
                        if (undoErr) throw undoErr;
                        showToast({
                          type: 'success',
                          title: 'Reversal Undone',
                          message: `${reconciliationConflict.document_number} restored to Posted successfully.`,
                        });
                        await loadData();
                      }
                      setReconciliationConflict(null);
                    } catch (err: any) {
                      showToast({
                        type: 'error',
                        title: 'Resolution Failed',
                        message: err.message || 'Could not unlink statement line or undo reversal.',
                      });
                    } finally {
                      setResolvingConflict(false);
                    }
                  }}
                  disabled={resolvingConflict}
                  className="inline-flex items-center gap-1 h-8 px-3 bg-green-600 text-white rounded text-xs font-semibold hover:bg-green-700 disabled:opacity-50"
                >
                  <Unlink className="w-3.5 h-3.5" />
                  {resolvingConflict ? 'Restoring...' : 'Unlink Line & Restore Contra'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  onOpenBankReconciliation?.(
                    reconciliationConflict.bank_account_id,
                    reconciliationConflict.bank_statement_line_id,
                  );
                  setReconciliationConflict(null);
                }}
                className={F_BTN_PRIMARY}
              >
                <Landmark className="w-3.5 h-3.5" />
                Open Bank Reconciliation
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              Undo Reverse remains blocked because the original bank statement line is linked to another transaction.
            </p>
            <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt className="text-gray-500">Bank Statement ID</dt>
              <dd className="font-mono font-medium text-gray-900 break-all">
                {reconciliationConflict.bank_statement_line_id}
              </dd>
              <dt className="text-gray-500">Bank Statement Date</dt>
              <dd className="font-medium text-gray-900">
                {new Date(`${reconciliationConflict.transaction_date}T00:00:00`).toLocaleDateString('id-ID')}
              </dd>
              <dt className="text-gray-500">Amount</dt>
              <dd className="font-medium text-gray-900">
                {formatCurrency(reconciliationConflict.amount, reconciliationConflict.currency)}
              </dd>
              <dt className="text-gray-500">Current Document Type</dt>
              <dd className="font-medium text-gray-900">{reconciliationConflict.document_type}</dd>
              <dt className="text-gray-500">Current Document Number</dt>
              <dd className="font-mono font-medium text-gray-900 break-all">
                {reconciliationConflict.document_number}
              </dd>
              <dt className="text-gray-500">Current Journal Entry</dt>
              <dd className="font-mono font-medium text-gray-900 break-all">
                {reconciliationConflict.journal_entry_number || 'None'}
              </dd>
            </dl>
            <div className="border-t border-gray-200 pt-2 space-y-2 text-xs text-gray-700">
              <p>
                <span className="font-semibold text-gray-900">Why this is unsafe:</span>{' '}
                Undo Reverse must reactivate the Contra journal and restore this statement line to the Contra.
                Continuing while another document owns the same line would create conflicting reconciliation
                ownership and could make one bank movement appear linked to two documents.
              </p>
              <div>
                <p className="font-semibold text-gray-900 mb-1">Safe resolution</p>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>Open Bank Reconciliation and unlink the current document from this statement line.</li>
                  <li>Return to the Contra Voucher and run Undo Reverse again.</li>
                  <li>
                    Verify the restored Contra owns the statement line. Undo Reverse re-links it automatically;
                    manually re-link only if the line remains unmatched.
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </FinanceModal>
      )}
    </>
  );
}
