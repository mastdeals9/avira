import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { BookOpen, ChevronDown, Download, FileSpreadsheet, RefreshCw, Search } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { useFinance } from '../../contexts/FinanceContext';
import { getSignedUrlCached } from '../../utils/signedUrlCache';
import { formatCurrency } from '../../utils/currency';
import { fetchInBatches } from '../../utils/batchQuery';
import { exportBankLedgerCsv, exportBankLedgerExcel } from '../../utils/bankLedgerExport';

interface BankAccount {
  id: string;
  coa_id: string | null;
  bank_name: string;
  account_number: string;
  currency: string;
  opening_balance: number;
  opening_balance_date: string;
}

interface LedgerEntry {
  id: string;
  entry_date: string;
  particulars: string;
  reference: string;
  canonical_reference?: string;
  debit: number;
  credit: number;
  running_balance: number;
  statement_debit?: number;
  statement_credit?: number;
  ledger_debit?: number;
  ledger_credit?: number;
  reconciliation_difference?: number | null;
}

interface BankLedgerProps {
  selectedBank?: string;
}

export default function BankLedger({ selectedBank: propSelectedBank }: BankLedgerProps) {
  const { dateRange: globalDateRange } = useFinance();

  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>('');
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [showUnreconciledOnly, setShowUnreconciledOnly] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<any | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [, setExpenseDocuments] = useState<string[]>([]);
  const [, setLoadingDocs] = useState(false);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [glClosingBalance, setGlClosingBalance] = useState<number | null>(null);
  const [showOpeningBalanceModal, setShowOpeningBalanceModal] = useState(false);
  const [openingBalanceForm, setOpeningBalanceForm] = useState({
    balance: 0,
    date: '2025-01-01'
  });

  useEffect(() => {
    loadBanks();
  }, []);

  useEffect(() => {
    if (propSelectedBank) {
      setSelectedBank(propSelectedBank);
    }
  }, [propSelectedBank]);

  useEffect(() => {
    if (selectedBank) {
      loadLedgerEntries();
    }
  }, [selectedBank, globalDateRange.startDate, globalDateRange.endDate]);

  useEffect(() => {
    if (showDetailModal && selectedEntry && selectedEntry.type === 'expense') {
      loadExpenseDocuments();
    }
  }, [showDetailModal, selectedEntry]);

  const loadExpenseDocuments = async () => {
    if (!selectedEntry || selectedEntry.type !== 'expense') return;

    setLoadingDocs(true);
    try {
      const { data: files } = await supabase.storage
        .from('expense-documents')
        .list(`${selectedEntry.id}/`);

      if (files && files.length > 0) {
        const signedUrls = await Promise.all(
          files.map(file =>
            getSignedUrlCached('expense-documents', `${selectedEntry.id}/${file.name}`, 3600)
          )
        );
        setExpenseDocuments(signedUrls.filter((u): u is string => Boolean(u)));
      } else {
        setExpenseDocuments([]);
      }
    } catch (err) {
      console.error('Error loading expense documents:', err);
      setExpenseDocuments([]);
    } finally {
      setLoadingDocs(false);
    }
  };

  const loadBanks = async () => {
    const { data } = await supabase
      .from('bank_accounts')
      // perf: projected columns (was select('*'))
      .select('id, coa_id, bank_name, account_number, currency, opening_balance, opening_balance_date')
      .order('bank_name');
    if (data) setBanks(data);
  };

  const loadLedgerEntries = async () => {
    if (!selectedBank) return;

    setLoading(true);
    try {
      const selectedBankData = banks.find(b => b.id === selectedBank);
      const storedOpeningBalance = selectedBankData?.opening_balance || 0;
      const openingBalanceDate = selectedBankData?.opening_balance_date || '2025-01-01';

      // Calculate the effective opening balance for the filtered period
      let effectiveOpeningBalance = storedOpeningBalance;

      // Get all bank statement lines before filter start date (from opening balance date onwards)
      if (globalDateRange.startDate > openingBalanceDate) {
        const { data: priorLines } = await supabase
          .from('bank_statement_lines')
          .select('debit_amount, credit_amount')
          .eq('bank_account_id', selectedBank)
          .gte('transaction_date', openingBalanceDate)
          .lt('transaction_date', globalDateRange.startDate);

        if (priorLines) {
          priorLines.forEach(line => {
            effectiveOpeningBalance += Number(line.credit_amount || 0) - Number(line.debit_amount || 0);
          });
        }
      }

      setOpeningBalance(effectiveOpeningBalance);

      // Use canonical dynamic bank balance from vw_bank_ledger_effective
      if (selectedBankData?.coa_id) {
        const { data: bookBal, error: bookBalErr } = await supabase
          .rpc('calculate_bank_account_book_balance', {
            p_bank_account_id: selectedBank,
            p_as_of_date: globalDateRange.endDate,
          });
        if (!bookBalErr && bookBal !== null && bookBal !== undefined) {
          setGlClosingBalance(Number(bookBal));
        } else {
          setGlClosingBalance(null);
        }
      } else {
        setGlClosingBalance(null);
      }

      const entries: any[] = [];

      // Calculate next day for inclusive end date filtering
      const endDatePlusOne = new Date(globalDateRange.endDate);
      endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
      const endDateStr = endDatePlusOne.toISOString().split('T')[0];

      // Get bank statement lines (source of truth for Bank Ledger)
      const { data: rawBankLines } = await supabase
        .from('bank_statement_lines')
        .select('id, transaction_hash, transaction_date, description, reference, debit_amount, credit_amount, matched_expense_id, matched_receipt_id, matched_payment_id, matched_entry_id, notes')
        .eq('bank_account_id', selectedBank)
        .gte('transaction_date', globalDateRange.startDate)
        .lt('transaction_date', endDateStr)
        .order('transaction_date');

      // bank_statement_lines has primary key id. Ensure distinct lines by id so legitimate
      // repeated transactions (e.g. identical salary payments or fees) are never collapsed.
      const bankLines = Array.from(new Map((rawBankLines || []).map((line: any) => [line.id, line])).values());
      if (bankLines) {
        bankLines.forEach(line => {
          entries.push({
            id: line.id,
            entry_date: line.transaction_date,
            particulars: line.notes?.trim() || line.description || 'Bank Transaction',
            bank_narration: line.description || '',
            reference: line.reference || '-',
            canonical_reference: line.reference || '-',
            debit: Number(line.debit_amount || 0),
            credit: Number(line.credit_amount || 0),
            statement_debit: Number(line.debit_amount || 0),
            statement_credit: Number(line.credit_amount || 0),
            ledger_debit: null,
            ledger_credit: null,
            reconciliation_difference: null,
            type: 'bank',
            matched_expense_id: line.matched_expense_id || null,
            matched_receipt_id: line.matched_receipt_id || null,
            matched_payment_id: line.matched_payment_id || null,
            matched_entry_id: line.matched_entry_id || null,
            linkedId: line.matched_expense_id || line.matched_receipt_id || line.matched_payment_id || line.matched_entry_id,
            notes: line.notes
          });
        });
      }

      // Canonical allocations are authoritative. Legacy matched_* columns are
      // retained only as a compatibility fallback for genuinely unallocated
      // statement lines.
      const lineIds = (bankLines || []).map((line: any) => line.id);
      const allocations = lineIds.length
        ? await fetchInBatches<any>(
            lineIds,
            batch => supabase.from('bank_statement_allocations')
              .select('bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind')
              .in('bank_statement_line_id', batch)
          )
        : [];
      const allocationRows = allocations || [];
      const allocationJournalIds = Array.from(new Set(allocationRows.map((a: any) => a.journal_entry_id).filter(Boolean)));
      const linkedBankLines = allocationJournalIds.length
        ? await fetchInBatches<any>(
            allocationJournalIds,
            batch => supabase.from('journal_entry_lines')
              .select('journal_entry_id, debit, credit, transaction_debit, transaction_credit')
              .eq('account_id', selectedBankData?.coa_id || '')
              .in('journal_entry_id', batch)
          )
        : [];
      const ledgerByJournal = new Map<string, { debit: number; credit: number }>();
      (linkedBankLines || []).forEach((line: any) => {
        const useTransaction = selectedBankData?.currency === 'USD';
        const debit = Number(useTransaction ? (line.transaction_debit ?? line.debit) : line.debit || 0);
        const credit = Number(useTransaction ? (line.transaction_credit ?? line.credit) : line.credit || 0);
        const current = ledgerByJournal.get(line.journal_entry_id) || { debit: 0, credit: 0 };
        current.debit += debit;
        current.credit += credit;
        ledgerByJournal.set(line.journal_entry_id, current);
      });
      const allocationExpenseIds = allocationRows.filter((a: any) => a.document_type === 'expense').map((a: any) => a.document_id);
      const allocationReceiptIds = allocationRows.filter((a: any) => a.document_type === 'receipt').map((a: any) => a.document_id);
      const allocationPaymentIds = allocationRows.filter((a: any) => a.document_type === 'payment').map((a: any) => a.document_id);
      const allocationEntryIds = allocationRows.filter((a: any) => ['journal', 'journal_entry', 'entry'].includes(a.document_type)).map((a: any) => a.document_id || a.journal_entry_id);
      const allocationFundIds = allocationRows.filter((a: any) => a.document_type === 'fund_transfer').map((a: any) => a.document_id);
      const allocationPettyIds = allocationRows.filter((a: any) => a.document_type === 'petty_cash').map((a: any) => a.document_id);
      const allocationTaxIds = allocationRows.filter((a: any) => a.document_type === 'tax_payment').map((a: any) => a.document_id);
      const [canonicalExp, canonicalRec, canonicalPay, canonicalEntry, canonicalFund, canonicalPetty, canonicalTax] = await Promise.all([
        allocationExpenseIds.length
          ? fetchInBatches<any>(allocationExpenseIds, b => supabase.from('finance_expenses').select('id, voucher_number, description').in('id', b))
              .then(rows => Object.fromEntries(rows.map((x: any) => [x.id, { ref: x.voucher_number, remark: x.description }])))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        allocationReceiptIds.length
          ? fetchInBatches<any>(allocationReceiptIds, b => supabase.from('receipt_vouchers').select('id, voucher_number, notes, customers(company_name)').in('id', b))
              .then(rows => Object.fromEntries(rows.map((x: any) => {
                const cust = Array.isArray(x.customers) ? x.customers[0]?.company_name : x.customers?.company_name;
                const remark = x.notes?.trim() || (cust ? `Customer payment – ${cust}` : '');
                return [x.id, { ref: x.voucher_number, remark }];
              })))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        allocationPaymentIds.length
          ? fetchInBatches<any>(allocationPaymentIds, b => supabase.from('payment_vouchers').select('id, voucher_number, notes, suppliers(company_name)').in('id', b))
              .then(rows => Object.fromEntries(rows.map((x: any) => {
                const sup = Array.isArray(x.suppliers) ? x.suppliers[0]?.company_name : x.suppliers?.company_name;
                const remark = x.notes?.trim() || (sup ? `Supplier payment – ${sup}` : '');
                return [x.id, { ref: x.voucher_number, remark }];
              })))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        allocationEntryIds.length
          ? fetchInBatches<any>(allocationEntryIds.filter(Boolean), b => supabase.from('journal_entries').select('id, reference_number, entry_number, description').in('id', b))
              .then(rows => Object.fromEntries(rows.map((x: any) => [x.id, { ref: x.reference_number || x.entry_number, remark: x.description }])))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        allocationFundIds.length
          ? fetchInBatches<any>(allocationFundIds, b => supabase.from('fund_transfers').select('id, transfer_number, notes').in('id', b))
              .then(rows => Object.fromEntries(rows.map((x: any) => [x.id, { ref: x.transfer_number, remark: x.notes?.trim() || 'Fund transfer' }])))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        allocationPettyIds.length
          ? fetchInBatches<any>(allocationPettyIds, b => supabase.from('petty_cash_transactions').select('id, transaction_number, description').in('id', b))
              .then(rows => Object.fromEntries(rows.map((x: any) => [x.id, { ref: x.transaction_number || 'Petty Cash', remark: x.description }])))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        allocationTaxIds.length
          ? fetchInBatches<any>(allocationTaxIds, b => supabase.from('tax_payments').select('id, tax_type, payment_date').in('id', b))
              .then(rows => Object.fromEntries(rows.map((x: any) => [x.id, { ref: `${x.tax_type} ${x.payment_date}`, remark: `Tax payment – ${x.tax_type}` }])))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
      ]);
      const canonicalDocInfo = (a: any) => a.document_type === 'expense' ? canonicalExp[a.document_id]
        : a.document_type === 'receipt' ? canonicalRec[a.document_id]
        : a.document_type === 'payment' ? canonicalPay[a.document_id]
        : a.document_type === 'fund_transfer' ? canonicalFund[a.document_id]
        : a.document_type === 'petty_cash' ? canonicalPetty[a.document_id]
        : a.document_type === 'tax_payment' ? canonicalTax[a.document_id]
        : canonicalEntry[a.document_id || a.journal_entry_id];
      const byLine = new Map<string, any[]>();
      allocationRows.forEach((a: any) => {
        const info = canonicalDocInfo(a);
        const list = byLine.get(a.bank_statement_line_id) || [];
        list.push({ ...a, reference: info?.ref || a.document_id, remark: info?.remark || '', amount: Number(a.allocation_amount || 0) });
        byLine.set(a.bank_statement_line_id, list);
      });
      entries.forEach((e: any) => {
        const docs = byLine.get(e.id) || [];
        const bankAmount = Math.abs(Number(e.debit || 0) - Number(e.credit || 0));
        const allocated = docs.reduce((sum, doc) => sum + Number(doc.amount || 0), 0);
        e.allocated_amount = Math.min(bankAmount, allocated);
        e.unreconciled_amount = Math.max(0, bankAmount - allocated);
        if (docs.length) {
          e.allocations = docs;
          e.canonical_reference = docs.map(d => `${d.reference} (${formatAmount(d.amount, selectedBankData?.currency || 'IDR')})`).join(' + ');
          const voucherRemarks = Array.from(new Set(docs.map((d: any) => String(d.remark || '').trim()).filter(Boolean))).join('; ');
          if (voucherRemarks) {
            e.particulars = voucherRemarks;
          }
          e.linkedId = docs[0].document_id;
          const journals = Array.from(new Set(docs.map((doc: any) => doc.journal_entry_id).filter(Boolean)));
          const ledger = journals.reduce((sum: any, journalId: any) => {
            const movement = ledgerByJournal.get(journalId);
            if (!movement) return sum;
            sum.debit += movement.debit;
            sum.credit += movement.credit;
            return sum;
          }, { debit: 0, credit: 0 });
          e.ledger_debit = ledger.debit;
          e.ledger_credit = ledger.credit;
          e.reconciliation_difference = (Number(e.statement_credit || 0) - Number(e.statement_debit || 0))
            - (ledger.debit - ledger.credit);
        }
      });

      // Resolve canonical reference & voucher remarks for legacy matched entries
      const expenseIds = Array.from(new Set(entries.map(e => e.matched_expense_id).filter(Boolean)));
      const receiptIds = Array.from(new Set(entries.map(e => e.matched_receipt_id).filter(Boolean)));
      const paymentIds = Array.from(new Set(entries.map(e => e.matched_payment_id).filter(Boolean)));
      const entryIds = Array.from(new Set(entries.map(e => e.matched_entry_id).filter(Boolean)));

      const [expMap, recMap, payMap, entMap] = await Promise.all([
        expenseIds.length
          ? supabase.from('finance_expenses').select('id, voucher_number, description').in('id', expenseIds)
              .then(r => Object.fromEntries((r.data || []).map((x: any) => [x.id, { ref: x.voucher_number, remark: x.description }])))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        receiptIds.length
          ? supabase.from('receipt_vouchers').select('id, voucher_number, notes, customers(company_name)').in('id', receiptIds)
              .then(r => Object.fromEntries((r.data || []).map((x: any) => {
                const cust = Array.isArray(x.customers) ? x.customers[0]?.company_name : x.customers?.company_name;
                return [x.id, { ref: x.voucher_number, remark: x.notes?.trim() || (cust ? `Customer payment – ${cust}` : '') }];
              })))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        paymentIds.length
          ? supabase.from('payment_vouchers').select('id, voucher_number, notes, suppliers(company_name)').in('id', paymentIds)
              .then(r => Object.fromEntries((r.data || []).map((x: any) => {
                const sup = Array.isArray(x.suppliers) ? x.suppliers[0]?.company_name : x.suppliers?.company_name;
                return [x.id, { ref: x.voucher_number, remark: x.notes?.trim() || (sup ? `Supplier payment – ${sup}` : '') }];
              })))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
        entryIds.length
          ? supabase.from('journal_entries').select('id, reference_number, entry_number, description').in('id', entryIds)
              .then(r => Object.fromEntries((r.data || []).map((x: any) => [x.id, { ref: x.reference_number || x.entry_number, remark: x.description }])))
          : Promise.resolve({} as Record<string, { ref: string; remark?: string }>),
      ]);

      entries.forEach(e => {
        if ((byLine.get(e.id) || []).length) return;
        const resolved =
          (e.matched_expense_id && expMap[e.matched_expense_id]) ||
          (e.matched_receipt_id && recMap[e.matched_receipt_id]) ||
          (e.matched_payment_id && payMap[e.matched_payment_id]) ||
          (e.matched_entry_id && entMap[e.matched_entry_id]);
        if (resolved) {
          e.canonical_reference = resolved.ref;
          if (resolved.remark?.trim()) {
            e.particulars = resolved.remark.trim();
          }
        }
      });

      // Sort by date
      entries.sort((a, b) => {
        const dateCompare = new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime();
        if (dateCompare !== 0) return dateCompare;
        const aIsCredit = a.credit > 0;
        const bIsCredit = b.credit > 0;
        if (aIsCredit && !bIsCredit) return -1;
        if (!aIsCredit && bIsCredit) return 1;
        return 0;
      });

      let runningBalance = effectiveOpeningBalance;
      const ledger: LedgerEntry[] = entries.map((entry: any) => {
        const debit = entry.debit || 0;
        const credit = entry.credit || 0;
        runningBalance += credit - debit;
        return {
          id: entry.id,
          entry_date: entry.entry_date,
          particulars: entry.particulars,
          reference: entry.reference,
          canonical_reference: entry.canonical_reference,
          debit,
          credit,
          running_balance: runningBalance,
          allocated_amount: entry.allocated_amount || 0,
          unreconciled_amount: entry.unreconciled_amount || 0,
          statement_debit: entry.statement_debit,
          statement_credit: entry.statement_credit,
          ledger_debit: entry.ledger_debit,
          ledger_credit: entry.ledger_credit,
          reconciliation_difference: entry.reconciliation_difference,
        };
      });

      setLedgerEntries(ledger);
    } catch (err) {
      console.error('Error loading ledger:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateOpeningBalance = async () => {
    if (!selectedBank) return;

    try {
      const { error } = await supabase
        .from('bank_accounts')
        .update({
          opening_balance: openingBalanceForm.balance,
          opening_balance_date: openingBalanceForm.date
        })
        .eq('id', selectedBank);

      if (error) throw error;

      setShowOpeningBalanceModal(false);
      await loadBanks();
      await loadLedgerEntries();
    } catch (err: any) {
      alert('Failed to update opening balance: ' + err.message);
    }
  };

  const openEditOpeningBalance = () => {
    const selectedBankData = banks.find(b => b.id === selectedBank);
    if (selectedBankData) {
      setOpeningBalanceForm({
        balance: selectedBankData.opening_balance,
        date: selectedBankData.opening_balance_date || '2025-01-01'
      });
      setShowOpeningBalanceModal(true);
    }
  };

  const formatAmount = (amount: number, currency: string) => {
    return formatCurrency(amount, currency, { zeroAsDash: true });
  };

  const getExportParams = () => {
    const bank = banks.find(b => b.id === selectedBank);
    if (!bank) return null;
    return {
      bankName: bank.bank_name,
      accountNumber: bank.account_number,
      currency: bank.currency,
      startDate: globalDateRange.startDate,
      endDate: globalDateRange.endDate,
      openingBalance,
      totalDebit,
      totalCredit,
      closingBalance,
      entries: visibleLedgerEntries,
    };
  };

  const handleExportExcel = async () => {
    const params = getExportParams();
    if (!params) return;
    await exportBankLedgerExcel(params);
  };

  const handleExportCsv = () => {
    const params = getExportParams();
    if (!params) return;
    exportBankLedgerCsv(params);
  };

  const selectedBankData = banks.find(b => b.id === selectedBank);

  const totalDebit = ledgerEntries.reduce((sum, e) => sum + Number(e.statement_debit || 0), 0);
  const totalCredit = ledgerEntries.reduce((sum, e) => sum + Number(e.statement_credit || 0), 0);
  const ledgerDebit = ledgerEntries.reduce((sum, e) => sum + Number(e.ledger_debit || 0), 0);
  const ledgerCredit = ledgerEntries.reduce((sum, e) => sum + Number(e.ledger_credit || 0), 0);
  const statementMovement = totalCredit - totalDebit;
  const ledgerMovement = ledgerDebit - ledgerCredit;
  const reconciliationDifference = statementMovement - ledgerMovement;
  const reconciledAmount = ledgerEntries.reduce((sum, e) => sum + Number(e.allocated_amount || 0), 0);
  const unreconciledAmount = ledgerEntries.reduce((sum, e) => sum + Number(e.unreconciled_amount || 0), 0);
  const visibleLedgerEntries = ledgerEntries.filter(entry => {
    if (showUnreconciledOnly && Number(entry.unreconciled_amount || 0) <= 0.01) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const matchesDesc = String(entry.particulars || '').toLowerCase().includes(q);
      const matchesBankNarration = String(entry.bank_narration || '').toLowerCase().includes(q);
      const matchesRef = String(entry.canonical_reference || entry.reference || '').toLowerCase().includes(q);
      return matchesDesc || matchesBankNarration || matchesRef;
    }
    return true;
  });
  const closingBalance = openingBalance + totalCredit - totalDebit;
  const glDifference = glClosingBalance === null ? null : glClosingBalance - closingBalance;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Shared title strip — matches every other Finance page */}
      <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-xs font-bold text-gray-900 truncate flex items-center gap-1.5">
            <BookOpen className="w-3 h-3 text-blue-600" /> Bank Ledger
          </h1>
          <span className="text-[10px] text-gray-400 truncate">Bank Book</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={loadLedgerEntries}
            disabled={!selectedBank || loading}
            className="inline-flex items-center gap-1 h-7 px-2.5 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => void handleExportExcel()}
            disabled={!selectedBank || ledgerEntries.length === 0}
            className="inline-flex items-center gap-1 h-7 px-2.5 bg-emerald-600 text-white rounded text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export formatted Excel (.xlsx)"
          >
            <FileSpreadsheet className="w-3 h-3" />
            Export Excel
          </button>
          <button
            onClick={handleExportCsv}
            disabled={!selectedBank || ledgerEntries.length === 0}
            className="inline-flex items-center gap-1 h-7 px-2.5 bg-white text-gray-700 border border-gray-300 rounded text-xs font-semibold hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export standards-compliant CSV"
          >
            <Download className="w-3 h-3" />
            CSV
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="flex-1 max-w-md">
            <label className="block text-xs font-semibold text-gray-700 mb-1">Bank Account</label>
            <select name="bank_account" aria-label="Bank Account"
              value={selectedBank}
              onChange={(e) => setSelectedBank(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white"
            >
              <option value="">Select Bank Account</option>
              {banks.map(bank => (
                <option key={bank.id} value={bank.id}>
                  {bank.bank_name} - {bank.account_number} ({bank.currency})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-64">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search description or ref..."
                aria-label="Search description or reference"
                style={{ paddingLeft: '2rem' }}
                className="w-full pl-8 pr-2.5 py-1.5 text-xs border border-gray-300 rounded-lg bg-white focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <p className="text-xs text-gray-500">
              Period: <span className="font-medium text-gray-700">{new Date(globalDateRange.startDate).toLocaleDateString('id-ID')} – {new Date(globalDateRange.endDate).toLocaleDateString('id-ID')}</span>
            </p>
          </div>
        </div>

        {/* Simplified 4-Figure Bank Ledger Summary */}
        {selectedBankData && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Opening Balance</span>
                <button
                  type="button"
                  onClick={openEditOpeningBalance}
                  className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
                >
                  Update
                </button>
              </div>
              <p className="text-sm sm:text-base font-bold text-gray-900 mt-1 tabular-nums">
                {formatAmount(openingBalance, selectedBankData.currency)}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">
                As of {new Date(globalDateRange.startDate).toLocaleDateString('id-ID')}
              </p>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wide block">Total Debit (Dr)</span>
              <p className="text-sm sm:text-base font-bold text-red-600 mt-1 tabular-nums">
                {formatAmount(totalDebit, selectedBankData.currency)}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">Outgoing</p>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wide block">Total Credit (Cr)</span>
              <p className="text-sm sm:text-base font-bold text-emerald-700 mt-1 tabular-nums">
                {formatAmount(totalCredit, selectedBankData.currency)}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">Incoming</p>
            </div>

            <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
              <span className="text-[11px] font-semibold text-blue-900 uppercase tracking-wide block">Closing Balance</span>
              <p className="text-sm sm:text-base font-extrabold text-blue-900 mt-1 tabular-nums">
                {formatAmount(closingBalance, selectedBankData.currency)}
              </p>
              <p className="text-[10px] text-blue-700 mt-0.5">
                As of {new Date(globalDateRange.endDate).toLocaleDateString('id-ID')}
              </p>
            </div>
          </div>
        )}

        {/* Separated Expandable Reconciliation Diagnostics */}
        {selectedBankData && (
          <div className="border-t border-gray-100 pt-2">
            <button
              type="button"
              onClick={() => setShowDiagnostics(v => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900"
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDiagnostics ? 'rotate-180' : ''}`} />
              <span>Reconciliation Diagnostics</span>
              {showUnreconciledOnly && (
                <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold">
                  Unreconciled Filter Active
                </span>
              )}
            </button>

            {showDiagnostics && (
              <div className="mt-2.5 space-y-2.5">
                {glClosingBalance !== null && (
                  <div className={`rounded-lg border p-2.5 text-xs ${Math.abs(glDifference || 0) <= 0.01 ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
                    <div>Statement / Ledger / Difference: <strong>{formatAmount(statementMovement, selectedBankData.currency)} / {formatAmount(ledgerMovement, selectedBankData.currency)} / {formatAmount(reconciliationDifference, selectedBankData.currency)}</strong></div>
                    <div className="mt-1">GL closing balance: <strong>{formatAmount(glClosingBalance, selectedBankData.currency)}</strong> · Bank closing balance: <strong>{formatAmount(closingBalance, selectedBankData.currency)}</strong></div>
                    <div className="mt-1 text-[10px]">{Math.abs(glDifference || 0) <= 0.01 ? 'No bank-vs-GL difference.' : 'Difference explanation: opening balance / posting cut-off / statement population. This does not classify canonically allocated bank lines as unreconciled.'}</div>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
                  <div className="rounded border border-emerald-200 bg-emerald-50 p-2.5">
                    <div className="text-emerald-700">Reconciled Bank Movement</div>
                    <strong className="text-emerald-900">{formatAmount(reconciledAmount, selectedBankData.currency)}</strong>
                  </div>
                  <div className={`rounded border p-2.5 ${Math.abs(reconciliationDifference) <= 0.01 ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
                    <div className="text-slate-600">Statement / Ledger Diff</div>
                    <strong className="text-slate-900">{formatAmount(reconciliationDifference, selectedBankData.currency)}</strong>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowUnreconciledOnly(value => !value)}
                    className={`rounded border p-2.5 text-left ${showUnreconciledOnly ? 'border-amber-400 bg-amber-100' : 'border-amber-200 bg-amber-50'}`}
                  >
                    <div className="text-amber-700 underline">Unreconciled Bank Transactions</div>
                    <strong className="text-amber-900">{formatAmount(unreconciledAmount, selectedBankData.currency)}</strong>
                    <div className="text-[10px] text-amber-700">{showUnreconciledOnly ? 'Showing unreconciled · click to show all' : 'Click to filter statement lines'}</div>
                  </button>
                  {glClosingBalance !== null && (
                    <div className="rounded border border-violet-200 bg-violet-50 p-2.5">
                      <div className="text-violet-700">Bank vs GL Difference</div>
                      <strong className="text-violet-900">{formatAmount(Math.abs(glDifference || 0), selectedBankData.currency)}</strong>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedBank && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-auto max-h-[calc(100vh-260px)]">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 sticky top-0 z-10 shadow-[0_1px_0_0_rgba(229,231,235,1)]">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">Date</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-700 uppercase tracking-wider">Description / Remarks</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">Reference No.</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">Debit (Dr)</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">Credit (Cr)</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">Balance</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                <tr className="bg-blue-50/70 font-semibold">
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900">
                    {new Date(globalDateRange.startDate).toLocaleDateString('id-ID')}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-900" colSpan={2}>
                    Opening Balance
                    {globalDateRange.startDate > (selectedBankData?.opening_balance_date || '') && (
                      <span className="ml-2 text-[11px] font-normal text-gray-500">(adjusted for date filter)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900 text-right tabular-nums"></td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900 text-right tabular-nums"></td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900 text-right font-bold tabular-nums">
                    {selectedBankData && formatAmount(openingBalance, selectedBankData.currency)}
                  </td>
                </tr>

                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-xs text-gray-500">Loading entries...</td>
                  </tr>
                ) : visibleLedgerEntries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-xs text-gray-500">
                      No recorded transactions found for this period
                    </td>
                  </tr>
                ) : (
                  visibleLedgerEntries.map(entry => (
                    <tr
                      key={entry.id}
                      className="hover:bg-blue-50/50 cursor-pointer transition-colors"
                      onClick={() => {
                        setSelectedEntry(entry);
                        setShowDetailModal(true);
                      }}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900">
                        {new Date(entry.entry_date).toLocaleDateString('id-ID')}
                      </td>
                      <td
                        className="px-3 py-2 text-xs text-gray-900 break-words whitespace-normal max-w-md"
                        title={entry.bank_narration && entry.bank_narration !== entry.particulars ? `Bank narration: ${entry.bank_narration}` : undefined}
                      >
                        <div>{entry.particulars}</div>
                        {entry.bank_narration && entry.bank_narration !== entry.particulars && (
                          <div className="text-[10px] text-gray-400 mt-0.5 truncate" title={entry.bank_narration}>
                            Bank: {entry.bank_narration}
                          </div>
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-xs text-gray-600 font-mono whitespace-nowrap"
                        title={entry.canonical_reference && entry.canonical_reference !== entry.reference ? `Bank statement ref: ${entry.reference}` : undefined}
                      >
                        {entry.canonical_reference || entry.reference}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-red-600 text-right font-medium tabular-nums">
                        {selectedBankData && entry.debit > 0 ? formatAmount(entry.debit, selectedBankData.currency) : ''}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-emerald-700 text-right font-medium tabular-nums">
                        {selectedBankData && entry.credit > 0 ? formatAmount(entry.credit, selectedBankData.currency) : ''}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900 text-right font-semibold tabular-nums">
                        {selectedBankData && formatAmount(entry.running_balance, selectedBankData.currency)}
                      </td>
                    </tr>
                  ))
                )}

                {ledgerEntries.length > 0 && (
                  <tr className="bg-gray-100 font-semibold border-t-2 border-gray-300">
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900" colSpan={3}>
                      Closing Balance
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-red-600 text-right font-bold tabular-nums">
                      {selectedBankData && formatAmount(totalDebit, selectedBankData.currency)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-emerald-700 text-right font-bold tabular-nums">
                      {selectedBankData && formatAmount(totalCredit, selectedBankData.currency)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900 text-right font-bold tabular-nums">
                      {selectedBankData && formatAmount(closingBalance, selectedBankData.currency)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showDetailModal && selectedEntry && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowDetailModal(false)}>
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900">Transaction Details</h3>
              <button onClick={() => setShowDetailModal(false)} className="text-gray-400 hover:text-gray-600">
                <span className="text-2xl">&times;</span>
              </button>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Date</p>
                  <p className="font-medium">{new Date(selectedEntry.entry_date).toLocaleDateString('id-ID')}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Reference</p>
                  <p className="font-medium font-mono">{selectedEntry.reference}</p>
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-600">Particulars</p>
                <p className="font-medium">{selectedEntry.particulars}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Debit</p>
                  <p className="font-medium text-red-600">
                    {selectedBankData && (selectedEntry.debit > 0 ? formatAmount(selectedEntry.debit, selectedBankData.currency) : '-')}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Credit</p>
                  <p className="font-medium text-green-600">
                    {selectedBankData && (selectedEntry.credit > 0 ? formatAmount(selectedEntry.credit, selectedBankData.currency) : '-')}
                  </p>
                </div>
              </div>

              {selectedEntry.notes && (
                <div>
                  <p className="text-sm text-gray-600">Notes</p>
                  <p className="font-medium">{selectedEntry.notes}</p>
                </div>
              )}

              {selectedEntry.allocations?.length > 0 && (
                <div className="bg-emerald-50 p-3 rounded-lg">
                  <p className="text-sm text-emerald-900 font-medium mb-1">Canonical allocations</p>
                  {selectedEntry.allocations.map((allocation: any, index: number) => (
                    <div key={`${allocation.document_id}-${index}`} className="flex justify-between text-sm text-emerald-800">
                      <span>{allocation.reference}</span>
                      <span>{selectedBankData && formatAmount(allocation.amount, selectedBankData.currency)}</span>
                    </div>
                  ))}
                </div>
              )}

              {selectedEntry.linkedId && (
                <div className="bg-blue-50 p-3 rounded-lg">
                  <p className="text-sm text-blue-900 font-medium">
                    This transaction is matched to a system entry
                  </p>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button onClick={() => setShowDetailModal(false)} className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal
        isOpen={showOpeningBalanceModal}
        onClose={() => setShowOpeningBalanceModal(false)}
        title="Update Opening Balance"
      >
        <div className="space-y-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Opening Balance Amount *
            </label>
            <MoneyInput
              decimal
              value={openingBalanceForm.balance}
              onChange={(n) => setOpeningBalanceForm({ ...openingBalanceForm, balance: n })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Opening Balance Date *
            </label>
            <input name="opening_balance_date" aria-label="Opening Balance Date"
              type="date"
              value={openingBalanceForm.date}
              onChange={(e) => setOpeningBalanceForm({ ...openingBalanceForm, date: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Set the date when this opening balance is effective.
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => setShowOpeningBalanceModal(false)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={updateOpeningBalance}
              className="h-7 px-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Update
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
