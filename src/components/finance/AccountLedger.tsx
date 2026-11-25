import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useFinance } from '../../contexts/FinanceContext';
import { Search, Printer, Download } from 'lucide-react';
import { formatCurrency } from '../../utils/currency';

interface AccountLedger {
  id: string;
  line_number: number;
  journal_entry_id: string;
  entry_date: string;
  entry_number: string;
  source_module: string | null;
  reference_number: string | null;
  counterpart: string;
  // canonical_number: the human-readable voucher / transaction number that
  // matches what the source module (Expenses / Petty Cash / Vouchers) shows.
  // Falls back to entry_number when no source-side voucher exists.
  canonical_number: string;
  description: string | null;
  debit: number;
  credit: number;
  balance: number;
}

interface Account {
  id: string;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
}

interface AccountLedgerProps {
  initialCode?: string;
  onCodeConsumed?: () => void;
  onOpenJournal?: (journalEntryId: string) => void;
}

export function AccountLedger({ initialCode, onCodeConsumed, onOpenJournal }: AccountLedgerProps = {}) {
  const { dateRange } = useFinance();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [ledgerData, setLedgerData] = useState<AccountLedger[]>([]);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [displayCurrency, setDisplayCurrency] = useState('IDR');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (initialCode && accounts.length > 0) {
      const match = accounts.find(a => a.code === initialCode);
      if (match) {
        setSelectedAccount(match);
        onCodeConsumed?.();
      }
    }
  }, [initialCode, accounts]);

  useEffect(() => {
    if (selectedAccount) {
      loadLedger();
    }
  }, [selectedAccount, dateRange]);

  const loadAccounts = async () => {
    try {
      const { data, error } = await supabase
        .from('chart_of_accounts')
        // perf: projected columns (was select('*'))
        .select('id, code, name, name_id, account_type, account_group, normal_balance, is_header, is_active, parent_id')
        .eq('is_active', true)
        .eq('is_header', false)
        .order('code');

      if (error) throw error;
      setAccounts(data || []);
    } catch (error) {
      console.error('Error loading accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadLedger = async () => {
    if (!selectedAccount) return;

    try {
      setLoading(true);

      const isDebitNormal = selectedAccount.normal_balance === 'debit' ||
        (!selectedAccount.normal_balance && (selectedAccount.account_type === 'asset' || selectedAccount.account_type === 'expense'));

      // Account Ledger is the General Ledger: it always reads posted journal
      // lines. Bank statements remain available in Bank Ledger/Reconciliation
      // as external evidence and must not replace the accounting books here.
      setDisplayCurrency('IDR');

      // Get opening balance (all transactions before start date)
      const { data: openingData, error: openingError } = await supabase
        .from('journal_entry_lines')
        .select('debit, credit, journal_entries!inner(entry_date, is_posted, is_reversed, is_cancelled)')
        .eq('account_id', selectedAccount.id)
        .eq('journal_entries.is_posted', true)
        .eq('journal_entries.is_reversed', false)
        .eq('journal_entries.is_cancelled', false)
        .lt('journal_entries.entry_date', dateRange.startDate);

      if (openingError) throw openingError;

      let opening = 0;
      openingData?.forEach((line: any) => {
        if (isDebitNormal) {
          opening += line.debit - line.credit;
        } else {
          opening += line.credit - line.debit;
        }
      });

      setOpeningBalance(opening);

      // Get transactions in date range
      const { data, error } = await supabase
        .from('journal_entry_lines')
        .select(`
          *,
          journal_entries!inner(
            id,
            entry_number,
            entry_date,
            source_module,
            reference_number,
            is_posted,
            is_reversed,
            is_cancelled
          )
        `)
        .eq('account_id', selectedAccount.id)
        .eq('journal_entries.is_posted', true)
        .eq('journal_entries.is_reversed', false)
        .eq('journal_entries.is_cancelled', false)
        .gte('journal_entries.entry_date', dateRange.startDate)
        .lte('journal_entries.entry_date', dateRange.endDate)
        .order('line_number');

      if (error) {
        console.error('Error loading ledger:', error);
        throw error;
      }

      const sortedData = (data || []).sort((a: any, b: any) => {
        const dateA = new Date(a.journal_entries.entry_date).getTime();
        const dateB = new Date(b.journal_entries.entry_date).getTime();
        if (dateA !== dateB) return dateA - dateB;
        return a.line_number - b.line_number;
      });

      const journalIds = Array.from(new Set(sortedData.map((line: any) => line.journal_entries.id)));
      const counterpartByJournal = new Map<string, string>();
      if (journalIds.length > 0) {
        const { data: counterpartLines, error: counterpartError } = await supabase
          .from('journal_entry_lines')
          .select('journal_entry_id, account_id, chart_of_accounts(code, name)')
          .in('journal_entry_id', journalIds)
          .neq('account_id', selectedAccount.id)
          .order('line_number');
        if (counterpartError) throw counterpartError;

        const namesByJournal = new Map<string, string[]>();
        for (const line of counterpartLines || []) {
          const account = Array.isArray(line.chart_of_accounts) ? line.chart_of_accounts[0] : line.chart_of_accounts;
          if (!account) continue;
          const label = `${account.code} — ${account.name}`;
          const labels = namesByJournal.get(line.journal_entry_id) || [];
          if (!labels.includes(label)) labels.push(label);
          namesByJournal.set(line.journal_entry_id, labels);
        }
        namesByJournal.forEach((labels, journalId) => counterpartByJournal.set(journalId, labels.join(' / ')));
      }

      let runningBalance = opening;
      const baseLedger = sortedData.map((line: any) => {
        const entry = line.journal_entries;

        if (isDebitNormal) {
          runningBalance += (line.debit - line.credit);
        } else {
          runningBalance += (line.credit - line.debit);
        }

        const narration = line.description || entry.reference_number || '-';

        return {
          id: line.id,
          line_number: line.line_number,
          journal_entry_id: entry.id,
          entry_date: entry.entry_date,
          entry_number: entry.entry_number,
          source_module: entry.source_module,
          reference_number: entry.reference_number,
          counterpart: counterpartByJournal.get(entry.id) || '—',
          // Default to entry_number; resolveJournalCanonicalNumbers will
          // upgrade this to the source module's voucher number when one exists.
          canonical_number: entry.entry_number,
          description: narration,
          debit: line.debit,
          credit: line.credit,
          balance: runningBalance,
        };
      });

      const ledgerWithBalance = await resolveJournalCanonicalNumbers(baseLedger);

      setLedgerData(ledgerWithBalance);
    } catch (error) {
      console.error('Error loading ledger:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  // ----- Canonical-number resolution -----
  // Each source module (Expenses, Petty Cash, Vouchers) has its own
  // human-friendly transaction number (EXP/YY-YY/NNN, PC-YYYYMM-NNN, RV-…, PV-…).
  // The journal entry's own entry_number (JE…) is not what users see in those
  // source pages, so the ledger must look up and display the source number
  // for parity with Expenses / Petty Cash / Bank pages.

  // Returns the bank-statement-line ledger with canonical_number filled in
  // from the linked finance_expenses / receipt_vouchers / journal_entries.
  const resolveBankLineCanonicalNumbers = async (rows: any[]): Promise<AccountLedger[]> => {
    const expenseIds = Array.from(new Set(rows.map(r => r._matched_expense_id).filter(Boolean)));
    const receiptIds = Array.from(new Set(rows.map(r => r._matched_receipt_id).filter(Boolean)));
    const paymentIds = Array.from(new Set(rows.map(r => r._matched_payment_id).filter(Boolean)));
    const entryIds = Array.from(new Set(rows.map(r => r._matched_entry_id).filter(Boolean)));

    const [expMap, recMap, payMap, entMap] = await Promise.all([
      expenseIds.length
        ? supabase.from('finance_expenses').select('id, voucher_number').in('id', expenseIds)
            .then(r => Object.fromEntries((r.data || []).map((x: any) => [x.id, x.voucher_number])))
        : Promise.resolve({} as Record<string, string>),
      receiptIds.length
        ? supabase.from('receipt_vouchers').select('id, voucher_number').in('id', receiptIds)
            .then(r => Object.fromEntries((r.data || []).map((x: any) => [x.id, x.voucher_number])))
        : Promise.resolve({} as Record<string, string>),
      paymentIds.length
        ? supabase.from('payment_vouchers').select('id, voucher_number').in('id', paymentIds)
            .then(r => Object.fromEntries((r.data || []).map((x: any) => [x.id, x.voucher_number])))
        : Promise.resolve({} as Record<string, string>),
      entryIds.length
        ? supabase.from('journal_entries').select('id, reference_number, entry_number').in('id', entryIds)
            .then(r => Object.fromEntries((r.data || []).map((x: any) => [x.id, x.reference_number || x.entry_number])))
        : Promise.resolve({} as Record<string, string>),
    ]);

    return rows.map(r => {
      const canonical =
        (r._matched_expense_id && expMap[r._matched_expense_id]) ||
        (r._matched_receipt_id && recMap[r._matched_receipt_id]) ||
        (r._matched_payment_id && payMap[r._matched_payment_id]) ||
        (r._matched_entry_id && entMap[r._matched_entry_id]) ||
        r.canonical_number;
      const { _matched_expense_id, _matched_receipt_id, _matched_payment_id, _matched_entry_id, ...rest } = r;
      return { ...rest, canonical_number: canonical } as AccountLedger;
    });
  };

  // Returns the journal_entry_lines ledger with canonical_number filled in
  // from the source module (finance_expenses.voucher_number /
  // petty_cash_transactions.transaction_number / etc).
  const resolveJournalCanonicalNumbers = async (rows: AccountLedger[]): Promise<AccountLedger[]> => {
    // For 'expenses' rows, reference_number is 'EXP-<uuid>' (the finance_expense id).
    const expenseRefIds = Array.from(new Set(
      rows
        .filter(r => r.source_module === 'expenses' && r.reference_number?.startsWith('EXP-'))
        .map(r => r.reference_number!.substring(4))
    ));

    // For 'petty_cash' rows: reference_number now holds 'PC-YYYYMM-NNN' (after
    // migration + trigger fix). For older entries where reference_number is still
    // NULL, fall back to the reference_id → petty_cash_transactions lookup.
    const pettyEntryIds = Array.from(new Set(
      rows
        .filter(r => r.source_module === 'petty_cash' && !r.reference_number?.startsWith('PC-'))
        .map(r => r.journal_entry_id)
        .filter(Boolean)
    ));

    const [expMap, pettyRefMap] = await Promise.all([
      expenseRefIds.length
        ? supabase.from('finance_expenses').select('id, voucher_number').in('id', expenseRefIds)
            .then(r => Object.fromEntries((r.data || []).map((x: any) => [x.id, x.voucher_number])))
        : Promise.resolve({} as Record<string, string>),
      pettyEntryIds.length
        ? supabase.from('journal_entries').select('id, reference_id').in('id', pettyEntryIds)
            .then(async r => {
              const refIds = (r.data || []).map((x: any) => x.reference_id).filter(Boolean);
              if (!refIds.length) return {} as Record<string, string>;
              const { data: pcs } = await supabase
                .from('petty_cash_transactions')
                .select('id, transaction_number')
                .is('fund_transfer_id', null)
                .in('id', refIds);
              const pcMap = Object.fromEntries((pcs || []).map((x: any) => [x.id, x.transaction_number]));
              return Object.fromEntries(
                (r.data || []).map((x: any) => [x.id, pcMap[x.reference_id]])
              ) as Record<string, string>;
            })
        : Promise.resolve({} as Record<string, string>),
    ]);

    return rows.map(r => {
      let canonical: string | undefined;
      if (r.source_module === 'expenses' && r.reference_number?.startsWith('EXP-')) {
        canonical = expMap[r.reference_number.substring(4)];
      } else if (r.source_module === 'petty_cash') {
        // Use reference_number directly when the backfill/trigger has set it (PC-YYYYMM-NNN)
        canonical = r.reference_number?.startsWith('PC-')
          ? r.reference_number
          : pettyRefMap[r.journal_entry_id];
      } else if (r.reference_number) {
        // fund_transfers / receipt / payment / purchase / sales — reference_number
        // already holds the user-facing voucher number (RV…, PV…, INV…, etc).
        canonical = r.reference_number;
      }
      return { ...r, canonical_number: canonical || r.entry_number };
    });
  };

  const sourceLabel = (mod: string | null): string => {
    switch (mod) {
      case 'expenses': return 'Expense';
      case 'petty_cash': return 'Petty Cash';
      case 'fund_transfers': return 'Fund Transfer';
      case 'receipt': return 'Receipt';
      case 'payment': return 'Payment';
      case 'purchase': return 'Purchase';
      case 'sales': return 'Sales';
      case 'bank': return 'Bank';
      default: return 'Manual';
    }
  };

  const exportToCSV = () => {
    if (!selectedAccount || ledgerData.length === 0) return;

    const headers = ['Date', 'Number', 'Type', 'Account', 'Counterpart', 'Currency', 'Description', 'Debit', 'Credit', 'Balance', 'Linked Ref'];
    const accountLabel = `${selectedAccount.code} - ${selectedAccount.name}`;
    const rows = ledgerData.map(line => [
      line.entry_date,
      line.canonical_number,
      sourceLabel(line.source_module),
      accountLabel,
      line.counterpart,
      displayCurrency,
      line.description || '',
      line.debit ? formatCurrency(line.debit, displayCurrency) : '',
      line.credit ? formatCurrency(line.credit, displayCurrency) : '',
      formatCurrency(line.balance, displayCurrency),
      line.reference_number || '',
    ]);

    const escape = (cell: string) => `"${String(cell).replace(/"/g, '""')}"`;
    const csv = [
      `Account Ledger - ${accountLabel}`,
      `Period: ${dateRange.startDate} to ${dateRange.endDate}`,
      `Currency: ${displayCurrency}`,
      `Opening Balance: ${formatCurrency(openingBalance, displayCurrency)}`,
      '',
      headers.map(escape).join(','),
      ...rows.map(row => row.map(c => escape(String(c))).join(',')),
      '',
      `Closing Balance: ${formatCurrency(closingBalance, displayCurrency)}`,
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `account_ledger_${selectedAccount.code}_${dateRange.startDate}_to_${dateRange.endDate}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const filteredAccounts = accounts.filter(acc =>
    acc.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    acc.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const closingBalance = ledgerData.length > 0 ? ledgerData[ledgerData.length - 1].balance : openingBalance;

  const totals = ledgerData.reduce(
    (acc, line) => ({
      debit: acc.debit + line.debit,
      credit: acc.credit + line.credit,
    }),
    { debit: 0, credit: 0 }
  );

  return (
    <div className="flex flex-col gap-1.5">
      {/* Shared title strip — matches every other Finance page */}
      <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-xs font-bold text-gray-900 truncate">Account Ledger</h1>
          <span className="text-[10px] text-gray-400 truncate">General ledger by account</span>
        </div>
      </div>

      {/* Toolbar — account selector + search */}
      <div className="flex items-center gap-1.5 min-h-8 px-2 py-1 bg-white border border-gray-200 rounded flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 w-3 h-3" />
          <input name="search_term" aria-label="Search account..."
            type="text"
            placeholder="Search account..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ paddingLeft: '1.75rem' }}
            className="w-full h-7 pr-2 text-xs border border-gray-300 rounded"
          />
        </div>
        <select name="account" aria-label="Account"
          value={selectedAccount?.id || ''}
          onChange={(e) => {
            const account = accounts.find(a => a.id === e.target.value);
            setSelectedAccount(account || null);
          }}
          className="h-7 px-2 text-xs border border-gray-300 rounded bg-white min-w-[240px]"
        >
          <option value="">Select Account...</option>
          {filteredAccounts.map(acc => (
            <option key={acc.id} value={acc.id}>
              {acc.code} - {acc.name}
            </option>
          ))}
        </select>

        {selectedAccount && (
          <>
            <button
              onClick={exportToCSV}
              disabled={ledgerData.length === 0}
              className="inline-flex items-center gap-1 h-7 px-2 bg-green-600 text-white rounded text-xs font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Export ledger to CSV"
            >
              <Download className="w-4 h-4" />
              Export
            </button>
            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1 h-7 px-2 bg-gray-600 text-white rounded text-xs font-semibold hover:bg-gray-700"
            >
              <Printer className="w-3 h-3" />
              Print
            </button>
          </>
        )}
      </div>

      {!selectedAccount && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
          <p className="text-blue-800 font-medium mb-2">Select an account to view its ledger</p>
          <p className="text-blue-600 text-sm mb-4">
            Use the dropdown above to choose an account, or search by code or name.
          </p>
          <div className="bg-white border border-blue-200 rounded p-3 text-left max-w-md mx-auto">
            <p className="text-sm text-gray-700 mb-1">
              <span className="font-semibold">Tip:</span> To view all journal entries across all accounts:
            </p>
            <p className="text-sm text-blue-700">
              Go to <span className="font-mono bg-blue-100 px-2 py-0.5 rounded">Journal Register</span> in the Books menu (Ctrl+J)
            </p>
          </div>
        </div>
      )}

      {selectedAccount && (
        <>
          {/* Ledger Header */}
          <div className="bg-white border rounded-lg p-4 print:border-0">
            <div className="text-center mb-4">
              <h2 className="text-sm font-bold">Account Ledger</h2>
              <h3 className="text-lg font-medium mt-1">
                {selectedAccount.code} - {selectedAccount.name}
              </h3>
              <p className="text-sm text-gray-600 mt-1">
                Period: {new Date(dateRange.startDate).toLocaleDateString('id-ID')} to {new Date(dateRange.endDate).toLocaleDateString('id-ID')}
              </p>
            </div>

            {/* Opening Balance */}
            <div className="flex justify-between items-center py-2 border-t border-b font-medium bg-gray-50 px-3">
              <span>Opening Balance:</span>
              <span className={openingBalance >= 0 ? 'text-green-600' : 'text-red-600'}>
                {formatCurrency(Math.abs(openingBalance), displayCurrency)}
                {openingBalance < 0 && ' (Cr)'}
              </span>
            </div>

            {/* Ledger Table */}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b-2 border-gray-200">
                  <tr>
                    <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-700 uppercase">Date</th>
                    <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-700 uppercase">Voucher No</th>
                    <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-700 uppercase">Type</th>
                    <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-700 uppercase">Counterpart</th>
                    <th className="px-1.5 py-1 text-right text-xs font-medium text-gray-700 uppercase">Debit</th>
                    <th className="px-1.5 py-1 text-right text-xs font-medium text-gray-700 uppercase">Credit</th>
                    <th className="px-1.5 py-1 text-right text-xs font-medium text-gray-700 uppercase">Balance</th>
                    <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-700 uppercase">Narration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {ledgerData.map((line) => (
                    <tr key={line.id} className="hover:bg-gray-50">
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        {new Date(line.entry_date).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                      </td>
                      <td className="px-1.5 py-1 whitespace-nowrap font-mono text-blue-600" title={line.entry_number !== line.canonical_number ? `Journal: ${line.entry_number}` : undefined}>
                        {onOpenJournal ? (
                          <button type="button" className="hover:underline" onClick={() => onOpenJournal(line.journal_entry_id)}>
                            {line.canonical_number}
                          </button>
                        ) : line.canonical_number}
                      </td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        <span className="px-2 py-1 text-xs bg-gray-100 rounded">
                          {sourceLabel(line.source_module)}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 text-gray-600 text-xs max-w-xs truncate" title={line.counterpart}>
                        {line.counterpart}
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap text-blue-600">
                        {line.debit > 0 ? formatCurrency(line.debit, displayCurrency) : ''}
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap text-green-600">
                        {line.credit > 0 ? formatCurrency(line.credit, displayCurrency) : ''}
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap font-medium">
                        <span className={line.balance >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {formatCurrency(Math.abs(line.balance), displayCurrency)}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 text-gray-600 text-xs max-w-xs truncate">
                        {line.description || line.reference_number || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-gray-200 font-bold">
                  <tr>
                    <td colSpan={4} className="px-1.5 py-1 text-right">Total:</td>
                    <td className="px-1.5 py-1 text-right text-blue-700">
                      {formatCurrency(totals.debit, displayCurrency)}
                    </td>
                    <td className="px-1.5 py-1 text-right text-green-700">
                      {formatCurrency(totals.credit, displayCurrency)}
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                  <tr>
                    <td colSpan={6} className="px-1.5 py-1 text-right">Closing Balance:</td>
                    <td className="px-1.5 py-1 text-right">
                      <span className={closingBalance >= 0 ? 'text-green-700' : 'text-red-700'}>
                        {formatCurrency(Math.abs(closingBalance), displayCurrency)}
                        {closingBalance < 0 && ' (Cr)'}
                      </span>
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {ledgerData.length === 0 && !loading && (
              <div className="text-center py-8 text-gray-500">
                No transactions found for this account in the selected period.
              </div>
            )}
          </div>
        </>
      )}

      {!selectedAccount && !loading && (
        <div className="text-center py-12 text-gray-500 bg-white rounded-lg border">
          <BookOpen className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p>Select an account to view its ledger</p>
        </div>
      )}
    </div>
  );
}

function BookOpen(props: any) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  );
}
