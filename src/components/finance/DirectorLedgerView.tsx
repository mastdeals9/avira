import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { formatCurrency } from '../../utils/currency';
import { getDirectorRelatedPartyBalanceSummary, type DirectorBalanceSummary } from '../../services/financeCommands';
import { UserCheck, ArrowDownLeft, ArrowUpRight, Scale, Clock, RefreshCw, Calendar, FileText, CheckCircle2 } from 'lucide-react';

interface DirectorTransaction {
  id: string;
  entry_date: string;
  entry_number: string;
  journal_id: string;
  source_module: string;
  reference_number: string | null;
  description: string;
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  net_amount: number;
  running_balance?: number;
  classification: string;
}

export default function DirectorLedgerView() {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<DirectorBalanceSummary | null>(null);
  const [transactions, setTransactions] = useState<DirectorTransaction[]>([]);
  const [directorName, setDirectorName] = useState('Vijay Lunkad');
  const [accountFilter, setAccountFilter] = useState<'all' | '2105' | '1310'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Fetch balance summary via canonical RPC
      const summaryData = await getDirectorRelatedPartyBalanceSummary(directorName);
      setSummary(summaryData);

      // 2. Fetch all journal lines on 1310 & 2105
      const { data: lines, error } = await supabase
        .from('journal_entry_lines')
        .select(`
          id,
          debit,
          credit,
          description,
          account:chart_of_accounts!inner (
            id,
            code,
            name
          ),
          journal:journal_entries!inner (
            id,
            entry_number,
            entry_date,
            source_module,
            reference_number,
            description,
            is_posted,
            is_reversed,
            is_cancelled
          )
        `)
        .in('account.code', ['1310', '2105'])
        .eq('journal.is_posted', true)
        .eq('journal.is_reversed', false)
        .eq('journal.is_cancelled', false)
        .order('journal(entry_date)', { ascending: true });

      if (error) throw error;

      if (lines) {
        let running = 0;
        const mapped: DirectorTransaction[] = lines.map((item: any) => {
          const debit = Number(item.debit || 0);
          const credit = Number(item.credit || 0);
          const accountCode = item.account?.code || '';
          const accountName = item.account?.name || '';
          const sourceModule = item.journal?.source_module || '';
          const lineDesc = item.description || item.journal?.description || '';
          const ref = item.journal?.reference_number || '';

          // Determine business classification in plain operational language
          let classification = 'Director Balance Adjustment';
          if (accountCode === '2105') {
            if (sourceModule === 'petty_cash') {
              classification = 'Paid personally by Director';
            } else if (sourceModule === 'loans') {
              classification = 'Director Funding (Company Borrowing)';
            } else if (sourceModule === 'loan_transactions') {
              classification = 'Repayment to Director (Settlement)';
            } else if (sourceModule === 'fund_transfers') {
              classification = 'Director Advance Reclassification';
            } else if (credit > 0) {
              classification = 'Director Funding';
            } else {
              classification = 'Repayment to Director';
            }
          } else if (accountCode === '1310') {
            if (sourceModule === 'loans' || debit > 0) {
              classification = 'Money Given to Director (Receivable)';
            } else if (sourceModule === 'loan_transactions' || credit > 0) {
              classification = 'Director Repayment to Company (Settlement)';
            }
          }

          // Net calculation from Director's perspective:
          // Company payable to Director increases on 2105 Credit, decreases on 2105 Debit.
          // Company receivable from Director increases on 1310 Debit, decreases on 1310 Credit.
          // Overall net payable to Director = (2105 Credit - 2105 Debit) - (1310 Debit - 1310 Credit).
          let netEffect = 0;
          if (accountCode === '2105') {
            netEffect = credit - debit;
          } else if (accountCode === '1310') {
            netEffect = -(debit - credit);
          }

          running += netEffect;

          return {
            id: item.id,
            entry_date: item.journal?.entry_date || '',
            entry_number: item.journal?.entry_number || '',
            journal_id: item.journal?.id || '',
            source_module: sourceModule,
            reference_number: ref,
            description: lineDesc,
            account_code: accountCode,
            account_name: accountName,
            debit,
            credit,
            net_amount: netEffect,
            running_balance: running,
            classification,
          };
        });

        // Most recent first for display, while running balance was computed chronologically
        setTransactions(mapped.reverse());
      }
    } catch (err: any) {
      console.error('Error loading director ledger:', err);
    } finally {
      setLoading(false);
    }
  }, [directorName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filteredTransactions = transactions.filter((tx) => {
    if (accountFilter !== 'all' && tx.account_code !== accountFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchText = `${tx.entry_number} ${tx.reference_number || ''} ${tx.description} ${tx.classification}`.toLowerCase();
      if (!matchText.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Top Header & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-50 text-indigo-700 rounded-lg">
            <UserCheck className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              Director / Related Party Balance: {directorName}
            </h2>
            <p className="text-xs text-gray-500">
              Unified operational view across Accounts 2105 (Payable) and 1310 (Receivable) with zero accounting overlap.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 border border-gray-300 rounded-lg transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Due TO Director (2105) */}
        <div className="bg-white p-4 rounded-xl border border-rose-200 shadow-sm">
          <div className="flex items-center justify-between text-xs font-semibold text-rose-700 mb-1">
            <span>Due TO Director (Account 2105)</span>
            <ArrowDownLeft className="w-4 h-4 text-rose-600" />
          </div>
          <div className="text-2xl font-bold text-rose-900 font-mono">
            {formatCurrency(summary?.due_to_director || 0, 'IDR')}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Company liability (funding, out-of-pocket expenses)
          </p>
        </div>

        {/* Due FROM Director (1310) */}
        <div className="bg-white p-4 rounded-xl border border-blue-200 shadow-sm">
          <div className="flex items-center justify-between text-xs font-semibold text-blue-700 mb-1">
            <span>Due FROM Director (Account 1310)</span>
            <ArrowUpRight className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-2xl font-bold text-blue-900 font-mono">
            {formatCurrency(summary?.due_from_director || 0, 'IDR')}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Company asset (advances/disbursements to director)
          </p>
        </div>

        {/* Net Position */}
        <div className="bg-white p-4 rounded-xl border border-purple-200 shadow-sm">
          <div className="flex items-center justify-between text-xs font-semibold text-purple-700 mb-1">
            <span>Net Position</span>
            <Scale className="w-4 h-4 text-purple-600" />
          </div>
          <div className="text-2xl font-bold text-purple-900 font-mono">
            {formatCurrency(Math.abs(summary?.net_position || 0), 'IDR')}
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-[11px] font-medium">
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                summary?.net_status === 'payable'
                  ? 'bg-rose-100 text-rose-800'
                  : summary?.net_status === 'receivable'
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-emerald-100 text-emerald-800'
              }`}
            >
              {summary?.net_status === 'payable'
                ? 'Net Payable to Director'
                : summary?.net_status === 'receivable'
                ? 'Net Receivable from Director'
                : 'Fully Settled (Zero Balance)'}
            </span>
          </div>
        </div>

        {/* Active Open Loans */}
        <div className="bg-white p-4 rounded-xl border border-amber-200 shadow-sm">
          <div className="flex items-center justify-between text-xs font-semibold text-amber-700 mb-1">
            <span>Active Formal Loans</span>
            <Clock className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-lg font-bold text-amber-900">
            {summary?.active_loans?.length || 0} Active
          </div>
          <div className="text-xs text-gray-600 mt-1">
            {summary?.active_loans && summary.active_loans.length > 0 ? (
              summary.active_loans.map((l) => (
                <div key={l.id} className="font-mono text-[11px] truncate">
                  {l.loan_number}: {formatCurrency(l.outstanding_balance, l.currency)} open
                </div>
              ))
            ) : (
              <span className="text-gray-400 italic">No open loan balances</span>
            )}
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white p-3 rounded-xl border border-gray-200 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-700">Account Filter:</span>
          <button
            type="button"
            onClick={() => setAccountFilter('all')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium ${
              accountFilter === 'all'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            All Accounts ({transactions.length})
          </button>
          <button
            type="button"
            onClick={() => setAccountFilter('2105')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium ${
              accountFilter === '2105'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            2105 Due TO Director ({transactions.filter(t => t.account_code === '2105').length})
          </button>
          <button
            type="button"
            onClick={() => setAccountFilter('1310')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium ${
              accountFilter === '1310'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            1310 Due FROM Director ({transactions.filter(t => t.account_code === '1310').length})
          </button>
        </div>

        <div className="w-full sm:w-64">
          <input
            type="text"
            placeholder="Search description, reference, JE..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Transaction History Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <h3 className="text-xs font-bold text-gray-800 uppercase tracking-wider">
            Chronological Transaction History ({filteredTransactions.length} items)
          </h3>
          <span className="text-[11px] text-gray-500">
            Positive running balance indicates Net Payable to Director
          </span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500 text-sm">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-600" />
            Loading director transaction ledger...
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">
            No transactions match the selected filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600 border-b">
                <tr>
                  <th className="py-2.5 px-3 text-left font-semibold">Date</th>
                  <th className="py-2.5 px-3 text-left font-semibold">Document / Journal</th>
                  <th className="py-2.5 px-3 text-left font-semibold">Operational Classification</th>
                  <th className="py-2.5 px-3 text-left font-semibold">Particulars / Description</th>
                  <th className="py-2.5 px-3 text-center font-semibold">Account</th>
                  <th className="py-2.5 px-3 text-right font-semibold">Money In (Cr)</th>
                  <th className="py-2.5 px-3 text-right font-semibold">Money Out (Dr)</th>
                  <th className="py-2.5 px-3 text-right font-semibold">Net Running Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredTransactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-gray-50/80 transition">
                    <td className="py-2 px-3 whitespace-nowrap text-gray-700">
                      {new Date(tx.entry_date).toLocaleDateString('id-ID')}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <div className="font-mono text-indigo-700 font-medium">{tx.entry_number}</div>
                      {tx.reference_number && (
                        <div className="text-[10px] text-gray-500 font-mono">{tx.reference_number}</div>
                      )}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                          tx.classification.includes('Paid personally')
                            ? 'bg-amber-100 text-amber-900 border border-amber-200'
                            : tx.classification.includes('Repayment') || tx.classification.includes('Settlement')
                            ? 'bg-emerald-100 text-emerald-900 border border-emerald-200'
                            : tx.classification.includes('Given')
                            ? 'bg-blue-100 text-blue-900 border border-blue-200'
                            : 'bg-indigo-100 text-indigo-900 border border-indigo-200'
                        }`}
                      >
                        {tx.classification}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-gray-800 max-w-xs truncate" title={tx.description}>
                      {tx.description}
                    </td>
                    <td className="py-2 px-3 text-center whitespace-nowrap font-mono text-gray-600">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${tx.account_code === '2105' ? 'bg-rose-50 text-rose-700' : 'bg-blue-50 text-blue-700'}`}>
                        {tx.account_code}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-green-700 font-medium">
                      {tx.credit > 0 ? formatCurrency(tx.credit, 'IDR') : '—'}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-red-700 font-medium">
                      {tx.debit > 0 ? formatCurrency(tx.debit, 'IDR') : '—'}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-gray-900">
                      {formatCurrency(tx.running_balance || 0, 'IDR')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
