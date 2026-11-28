import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useNavigation } from '../../contexts/NavigationContext';
import { formatCurrency } from '../../utils/currency';
import {
  Wallet,
  AlertTriangle,
  Clock,
  ArrowRight,
  Boxes,
  FileCheck,
  Ship,
  TrendingDown,
  Landmark,
  CheckCircle2,
  RefreshCw,
  Calendar,
  CreditCard,
  Building2,
} from 'lucide-react';

interface AttentionData {
  bcaIdrBalance: number;
  bcaUsdBalance: number;
  pettyCashBalance: number;
  arOverdueCount: number;
  arOverdueAmount: number;
  apDueCount: number;
  apDueAmount: number;
  inventoryValuation: number;
  expiring90dCount: number;
  openImportReqsCount: number;
  dcWaitingForInvoiceCount: number;
  unreconciledBankLinesCount: number;
  pendingSalesOrdersCount: number;
  pendingDeliveryChallansCount: number;
  pendingExpensesCount: number;
  pendingPettyCashCount: number;
  pendingMaterialReturnsCount: number;
}

export interface OwnerAttentionSharedData {
  arOverdueAmount?: number;
  arOverdueCount?: number;
  pendingSalesOrdersCount?: number;
  pendingDeliveryChallansCount?: number;
  pendingExpensesCount?: number;
  pendingPettyCashCount?: number;
}

interface OwnerAttentionDashboardProps {
  sharedData?: OwnerAttentionSharedData;
}

export const OwnerAttentionDashboard: React.FC<OwnerAttentionDashboardProps> = ({ sharedData }) => {
  const { setCurrentPage } = useNavigation();
  const [data, setData] = useState<AttentionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async (forceRefresh = false) => {
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      const ninetyDaysFromNow = new Date();
      ninetyDaysFromNow.setDate(ninetyDaysFromNow.getDate() + 90);
      const ninetyDaysStr = ninetyDaysFromNow.toISOString().split('T')[0];

      const useShared = !forceRefresh && sharedData !== undefined;

      const [
        bankBalancesRes,
        pettyCashRes,
        arOverdueBalancesRes,
        arOverdueInvoicesRes,
        apInvoicesRes,
        inventoryValuationRes,
        expiringBatchesRes,
        importReqsRes,
        dcInvoicingRes,
        unmatchedBankLinesRes,
        pendingSoRes,
        pendingDcRes,
        pendingExpensesRes,
        pendingPettyCashRes,
        pendingReturnsRes,
      ] = await Promise.all([
        supabase.rpc('get_bank_account_balances', { p_as_of_date: todayStr }),
        supabase.rpc('get_petty_cash_balance'),
        useShared && sharedData.arOverdueAmount !== undefined
          ? Promise.resolve({ data: null })
          : supabase.rpc('get_overdue_balances'),
        useShared && sharedData.arOverdueCount !== undefined
          ? Promise.resolve({ count: sharedData.arOverdueCount })
          : supabase
              .from('sales_invoices')
              .select('id', { count: 'exact', head: true })
              .in('payment_status', ['pending', 'partial'])
              .lt('due_date', todayStr),
        supabase
          .from('purchase_invoices')
          .select('id, balance_amount, total_amount, paid_amount')
          .gt('balance_amount', 0)
          .neq('status', 'paid'),
        supabase
          .from('batches')
          .select('current_stock, landed_cost_per_unit, cost_per_unit')
          .gt('current_stock', 0),
        supabase
          .from('batches')
          .select('id', { count: 'exact', head: true })
          .gt('current_stock', 0)
          .lte('expiry_date', ninetyDaysStr)
          .gte('expiry_date', todayStr),
        supabase
          .from('import_requirements')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase
          .from('dc_invoicing_summary')
          .select('challan_id', { count: 'exact', head: true })
          .neq('dc_status', 'fully_invoiced'),
        supabase
          .from('bank_statement_lines')
          .select('id', { count: 'exact', head: true })
          .eq('reconciliation_status', 'unmatched'),
        useShared && sharedData.pendingSalesOrdersCount !== undefined
          ? Promise.resolve({ count: sharedData.pendingSalesOrdersCount })
          : supabase
              .from('sales_orders')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'pending_approval'),
        useShared && sharedData.pendingDeliveryChallansCount !== undefined
          ? Promise.resolve({ count: sharedData.pendingDeliveryChallansCount })
          : supabase
              .from('delivery_challans')
              .select('id', { count: 'exact', head: true })
              .eq('approval_status', 'pending_approval'),
        useShared && sharedData.pendingExpensesCount !== undefined
          ? Promise.resolve({ count: sharedData.pendingExpensesCount })
          : supabase
              .from('effective_expense_posting_state')
              .select('expense_id', { count: 'exact', head: true })
              .eq('effective_posting_state', 'PENDING'),
        useShared && sharedData.pendingPettyCashCount !== undefined
          ? Promise.resolve({ count: sharedData.pendingPettyCashCount })
          : supabase
              .from('petty_cash_transactions')
              .select('id', { count: 'exact', head: true })
              .is('fund_transfer_id', null)
              .eq('approval_status', 'pending_approval'),
        supabase
          .from('material_returns')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
      ]);

      // Calculate Bank Balances
      let bcaIdr = 0;
      let bcaUsd = 0;
      if (bankBalancesRes.data) {
        for (const b of bankBalancesRes.data) {
          if (b.coa_code === '111101' || b.currency === 'IDR') {
            bcaIdr += Number(b.book_balance) || 0;
          } else if (b.coa_code === '111102' || b.currency === 'USD') {
            bcaUsd += Number(b.book_balance) || 0;
          }
        }
      }

      // Calculate Petty Cash
      const pettyCash = Number(pettyCashRes.data) || 0;

      // Calculate AR Overdue
      const arOverdueAmount = (useShared && sharedData.arOverdueAmount !== undefined)
        ? sharedData.arOverdueAmount
        : (arOverdueBalancesRes.data || []).reduce(
            (sum: number, row: { balance_due: number }) => sum + (Number(row.balance_due) || 0),
            0
          );

      // Calculate AP Due
      const apDueAmount = (apInvoicesRes.data || []).reduce(
        (sum: number, row: any) => sum + (Number(row.balance_amount) || (Number(row.total_amount) - Number(row.paid_amount || 0))),
        0
      );

      // Calculate Inventory Value
      const totalInventoryVal = (inventoryValuationRes.data || []).reduce(
        (sum: number, b: any) =>
          sum + (Number(b.current_stock) || 0) * (Number(b.landed_cost_per_unit) || Number(b.cost_per_unit) || 0),
        0
      );

      setData({
        bcaIdrBalance: bcaIdr,
        bcaUsdBalance: bcaUsd,
        pettyCashBalance: pettyCash,
        arOverdueCount: (useShared && sharedData.arOverdueCount !== undefined) ? sharedData.arOverdueCount : (arOverdueInvoicesRes.count || 0),
        arOverdueAmount,
        apDueCount: apInvoicesRes.data?.length || 0,
        apDueAmount,
        inventoryValuation: totalInventoryVal,
        expiring90dCount: expiringBatchesRes.count || 0,
        openImportReqsCount: importReqsRes.count || 0,
        dcWaitingForInvoiceCount: dcInvoicingRes.count || 0,
        unreconciledBankLinesCount: unmatchedBankLinesRes.count || 0,
        pendingSalesOrdersCount: (useShared && sharedData.pendingSalesOrdersCount !== undefined) ? sharedData.pendingSalesOrdersCount : (pendingSoRes.count || 0),
        pendingDeliveryChallansCount: (useShared && sharedData.pendingDeliveryChallansCount !== undefined) ? sharedData.pendingDeliveryChallansCount : (pendingDcRes.count || 0),
        pendingExpensesCount: (useShared && sharedData.pendingExpensesCount !== undefined) ? sharedData.pendingExpensesCount : (pendingExpensesRes.count || 0),
        pendingPettyCashCount: (useShared && sharedData.pendingPettyCashCount !== undefined) ? sharedData.pendingPettyCashCount : (pendingPettyCashRes.count || 0),
        pendingMaterialReturnsCount: pendingReturnsRes.count || 0,
      });
    } catch (err) {
      console.error('Error loading owner attention dashboard:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [sharedData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData(true);
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm mb-6 animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-64 mb-4" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-gray-100 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const totalPendingActions =
    data.pendingSalesOrdersCount +
    data.pendingDeliveryChallansCount +
    data.pendingExpensesCount +
    data.pendingPettyCashCount +
    data.pendingMaterialReturnsCount;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 mb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
          <h2 className="text-sm sm:text-base font-bold text-slate-900 tracking-tight uppercase">
            What Needs Attention
          </h2>
        </div>

        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Primary KPI Grid: 4 Core Financial & Asset Pillars */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3.5 mb-3 sm:mb-5">
        {/* 1. Cash & Bank Balances */}
        <div
          onClick={() => setCurrentPage('finance')}
          className="cursor-pointer group relative bg-gradient-to-br from-slate-50 to-emerald-50/40 p-2.5 sm:p-4 rounded-xl border border-emerald-100/80 hover:border-emerald-300 hover:shadow-md transition"
        >
          <div className="flex items-center justify-between text-[11px] sm:text-xs font-semibold text-emerald-900 mb-1.5 sm:mb-2">
            <span className="flex items-center gap-1 sm:gap-1.5 truncate">
              <Wallet className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0" />
              <span className="truncate">Cash & Bank</span>
            </span>
            <ArrowRight className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-slate-400 group-hover:text-emerald-700 transition group-hover:translate-x-0.5 shrink-0" />
          </div>
          <div className="space-y-0.5 sm:space-y-1">
            <div className="flex items-baseline justify-between gap-1">
              <span className="text-[10px] sm:text-[11px] text-slate-500 truncate">BCA IDR:</span>
              <span className="font-mono font-bold text-xs sm:text-sm text-slate-900 truncate">
                {formatCurrency(data.bcaIdrBalance, 'IDR')}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-1">
              <span className="text-[10px] sm:text-[11px] text-slate-500 truncate">BCA USD:</span>
              <span className="font-mono font-bold text-[11px] sm:text-xs text-blue-800 truncate">
                ${data.bcaUsdBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex items-baseline justify-between pt-1 border-t border-emerald-100/60 text-[9px] sm:text-[10px]">
              <span className="text-slate-500 truncate">Petty Cash:</span>
              <span className="font-mono font-medium text-slate-700 truncate">
                {formatCurrency(data.pettyCashBalance, 'IDR')}
              </span>
            </div>
          </div>
        </div>

        {/* 2. AR Overdue (Receivables) */}
        <div
          onClick={() => setCurrentPage('finance')}
          className={`cursor-pointer group relative p-2.5 sm:p-4 rounded-xl border transition ${
            data.arOverdueCount > 0
              ? 'bg-gradient-to-br from-rose-50/50 to-amber-50/40 border-rose-200 hover:border-rose-400 hover:shadow-md'
              : 'bg-slate-50 border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-[11px] sm:text-xs font-semibold mb-1.5 sm:mb-2">
            <span className={`flex items-center gap-1 sm:gap-1.5 truncate ${data.arOverdueCount > 0 ? 'text-rose-900' : 'text-slate-700'}`}>
              <AlertTriangle className={`w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0 ${data.arOverdueCount > 0 ? 'text-rose-600' : 'text-slate-400'}`} />
              <span className="truncate">A/R Overdue</span>
            </span>
            <span
              className={`text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded-full shrink-0 ${
                data.arOverdueCount > 0 ? 'bg-rose-100 text-rose-800' : 'bg-slate-200 text-slate-600'
              }`}
            >
              {data.arOverdueCount} inv
            </span>
          </div>
          <div className="mt-1 sm:mt-2">
            <div className="text-sm sm:text-lg font-bold font-mono text-slate-900 truncate">
              {formatCurrency(data.arOverdueAmount, 'IDR')}
            </div>
            <div className="text-[10px] sm:text-[11px] text-slate-500 mt-0.5 sm:mt-1 flex items-center justify-between">
              <span className="truncate">Past due</span>
              <ArrowRight className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-slate-400 group-hover:text-rose-600 transition group-hover:translate-x-0.5 shrink-0" />
            </div>
          </div>
        </div>

        {/* 3. A/P Outstanding (Payables) */}
        <div
          onClick={() => setCurrentPage('finance')}
          className="cursor-pointer group relative bg-gradient-to-br from-slate-50 to-blue-50/40 p-2.5 sm:p-4 rounded-xl border border-blue-100 hover:border-blue-300 hover:shadow-md transition"
        >
          <div className="flex items-center justify-between text-[11px] sm:text-xs font-semibold text-blue-900 mb-1.5 sm:mb-2">
            <span className="flex items-center gap-1 sm:gap-1.5 truncate">
              <CreditCard className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600 shrink-0" />
              <span className="truncate">A/P Due</span>
            </span>
            <span className="text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 shrink-0">
              {data.apDueCount} bills
            </span>
          </div>
          <div className="mt-1 sm:mt-2">
            <div className="text-sm sm:text-lg font-bold font-mono text-slate-900 truncate">
              {formatCurrency(data.apDueAmount, 'IDR')}
            </div>
            <div className="text-[10px] sm:text-[11px] text-slate-500 mt-0.5 sm:mt-1 flex items-center justify-between">
              <span className="truncate">Unpaid bills</span>
              <ArrowRight className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-slate-400 group-hover:text-blue-600 transition group-hover:translate-x-0.5 shrink-0" />
            </div>
          </div>
        </div>

        {/* 4. Total Inventory Value */}
        <div
          onClick={() => setCurrentPage('batches')}
          className="cursor-pointer group relative bg-gradient-to-br from-slate-50 to-indigo-50/40 p-2.5 sm:p-4 rounded-xl border border-indigo-100 hover:border-indigo-300 hover:shadow-md transition"
        >
          <div className="flex items-center justify-between text-[11px] sm:text-xs font-semibold text-indigo-900 mb-1.5 sm:mb-2">
            <span className="flex items-center gap-1 sm:gap-1.5 truncate">
              <Boxes className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-600 shrink-0" />
              <span className="truncate">Stock Value</span>
            </span>
            <ArrowRight className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-slate-400 group-hover:text-indigo-600 transition group-hover:translate-x-0.5 shrink-0" />
          </div>
          <div className="mt-1 sm:mt-2">
            <div className="text-sm sm:text-lg font-bold font-mono text-slate-900 truncate">
              {formatCurrency(data.inventoryValuation, 'IDR')}
            </div>
            <div className="text-[10px] sm:text-[11px] text-slate-500 mt-0.5 sm:mt-1 flex items-center justify-between">
              <span className="truncate">Landed Cost</span>
              <span className="text-[9px] sm:text-[10px] font-semibold text-indigo-700 bg-indigo-50 px-1 py-0.5 rounded shrink-0">
                Active
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Secondary Operational Bottlenecks: 4 Operational Alert Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 mb-3 sm:mb-5">
        {/* Expiring Stock < 90 Days */}
        <div
          onClick={() => setCurrentPage('batches')}
          className="cursor-pointer group p-3 rounded-lg border border-slate-200 bg-white hover:border-amber-300 hover:bg-amber-50/20 transition flex items-center justify-between"
        >
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-lg ${data.expiring90dCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
              <Calendar className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-800">Expiring Stock &lt; 90d</div>
              <div className="text-[11px] text-slate-500">Batches needing quick liquidation</div>
            </div>
          </div>
          <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded-full ${data.expiring90dCount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
            {data.expiring90dCount}
          </span>
        </div>

        {/* Open Import Requirements */}
        <div
          onClick={() => setCurrentPage('import-requirements')}
          className="cursor-pointer group p-3 rounded-lg border border-slate-200 bg-white hover:border-cyan-300 hover:bg-cyan-50/20 transition flex items-center justify-between"
        >
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-cyan-100 text-cyan-700">
              <Ship className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-800">Open Import Reqs</div>
              <div className="text-[11px] text-slate-500">Pending procurement pipeline</div>
            </div>
          </div>
          <span className="text-xs font-bold font-mono px-2 py-0.5 rounded-full bg-cyan-50 text-cyan-800 border border-cyan-200">
            {data.openImportReqsCount}
          </span>
        </div>

        {/* DC Waiting for Sales Invoice */}
        <div
          onClick={() => setCurrentPage('delivery-challans')}
          className="cursor-pointer group p-3 rounded-lg border border-slate-200 bg-white hover:border-purple-300 hover:bg-purple-50/20 transition flex items-center justify-between"
        >
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-lg ${data.dcWaitingForInvoiceCount > 0 ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-500'}`}>
              <FileCheck className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-800">DC Waiting for Invoice</div>
              <div className="text-[11px] text-slate-500">Dispatched goods unbilled</div>
            </div>
          </div>
          <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded-full ${data.dcWaitingForInvoiceCount > 0 ? 'bg-purple-100 text-purple-800' : 'bg-slate-100 text-slate-600'}`}>
            {data.dcWaitingForInvoiceCount}
          </span>
        </div>

        {/* Unreconciled Bank Statement Lines */}
        <div
          onClick={() => setCurrentPage('finance')}
          className="cursor-pointer group p-3 rounded-lg border border-slate-200 bg-white hover:border-amber-300 hover:bg-amber-50/20 transition flex items-center justify-between"
        >
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-lg ${data.unreconciledBankLinesCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
              <Landmark className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-800">Unreconciled Bank Lines</div>
              <div className="text-[11px] text-slate-500">Bank transactions to match</div>
            </div>
          </div>
          <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded-full ${data.unreconciledBankLinesCount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
            {data.unreconciledBankLinesCount}
          </span>
        </div>
      </div>

      {/* Tertiary Row: Pending Approvals Action Strip */}
      <div className="p-3.5 bg-slate-50/80 border border-slate-200 rounded-xl flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-600" />
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">
            Pending Approvals & Sign-offs ({totalPendingActions})
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={() => setCurrentPage('sales-orders')}
            className={`px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1.5 ${
              data.pendingSalesOrdersCount > 0
                ? 'bg-blue-100 text-blue-800 hover:bg-blue-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            <span>Sales Orders:</span>
            <strong className="font-mono">{data.pendingSalesOrdersCount}</strong>
          </button>

          <button
            onClick={() => setCurrentPage('delivery-challans')}
            className={`px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1.5 ${
              data.pendingDeliveryChallansCount > 0
                ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            <span>Delivery Challans:</span>
            <strong className="font-mono">{data.pendingDeliveryChallansCount}</strong>
          </button>

          <button
            onClick={() => setCurrentPage('finance')}
            className={`px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1.5 ${
              data.pendingExpensesCount > 0
                ? 'bg-purple-100 text-purple-800 hover:bg-purple-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            <span>Expenses:</span>
            <strong className="font-mono">{data.pendingExpensesCount}</strong>
          </button>

          <button
            onClick={() => setCurrentPage('finance')}
            className={`px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1.5 ${
              data.pendingPettyCashCount > 0
                ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            <span>Petty Cash:</span>
            <strong className="font-mono">{data.pendingPettyCashCount}</strong>
          </button>

          <button
            onClick={() => setCurrentPage('material-returns')}
            className={`px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1.5 ${
              data.pendingMaterialReturnsCount > 0
                ? 'bg-rose-100 text-rose-800 hover:bg-rose-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            <span>Sales Returns:</span>
            <strong className="font-mono">{data.pendingMaterialReturnsCount}</strong>
          </button>
        </div>
      </div>
    </div>
  );
};
