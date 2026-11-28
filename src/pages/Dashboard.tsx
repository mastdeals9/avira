import { useEffect, useState, type ElementType } from 'react';
import { Layout } from '../components/Layout';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import { TodaysActionsDashboard } from '../components/commandCenter/TodaysActionsDashboard';
import { RevenueChart } from '../components/dashboard/RevenueChart';
import { SalesPipelineChart } from '../components/dashboard/SalesPipelineChart';
import { PaymentOverview } from '../components/dashboard/PaymentOverview';
import { SalesDashboard } from '../components/dashboard/SalesDashboard';
import { WarehouseDeliveryDashboard } from '../components/dashboard/WarehouseDeliveryDashboard';
import { AlertTriangle, Clock, TrendingUp, FileText, ClipboardCheck, ClipboardList, Zap, CircleUser as UserCircle, ArrowRight } from 'lucide-react';
import { fetchSalesOrderDeliveryAlerts, summarizeDeliveryAlerts } from '../utils/salesOrderDeliveryAlerts';
import { TaxComplianceDashboardCards } from '../components/finance/tax/TaxComplianceDashboardCards';
import { formatCurrency } from '../utils/currency';
import { OwnerAttentionDashboard } from '../components/dashboard/OwnerAttentionDashboard';
import { useErpSyncListener } from '../utils/erpSyncBus';

interface DashboardStats {
  totalProducts: number;
  lowStockItems: number;
  nearExpiryBatches: number;
  totalCustomers: number;
  salesThisMonth: number;
  revenueThisMonth: number;
  profitThisMonth: number;
  pendingFollowUps: number;
  pendingSalesOrders: number;
  pendingDeliveryChallans: number;
  pendingExpenses: number;
  pendingPettyCash: number;
  pendingInvoices: number;
  overdueInvoicesCount: number;
  overdueInvoicesAmount: number;
  deliveryDueSoon: number;
  deliveryOverdue: number;
}

export function Dashboard() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const { setCurrentPage } = useNavigation();
  const [stats, setStats] = useState<DashboardStats>({
    totalProducts: 0,
    lowStockItems: 0,
    nearExpiryBatches: 0,
    totalCustomers: 0,
    salesThisMonth: 0,
    revenueThisMonth: 0,
    profitThisMonth: 0,
    pendingFollowUps: 0,
    pendingSalesOrders: 0,
    pendingDeliveryChallans: 0,
    pendingExpenses: 0,
    pendingPettyCash: 0,
    pendingInvoices: 0,
    overdueInvoicesCount: 0,
    overdueInvoicesAmount: 0,
    deliveryDueSoon: 0,
    deliveryOverdue: 0,
  });
  const [sharedAttentionData, setSharedAttentionData] = useState<{
    arOverdueAmount?: number;
    arOverdueCount?: number;
    pendingSalesOrdersCount?: number;
    pendingDeliveryChallansCount?: number;
    pendingExpensesCount?: number;
    pendingPettyCashCount?: number;
  } | undefined>(undefined);
  const [rawDeliveryAlerts, setRawDeliveryAlerts] = useState<any[] | undefined>(undefined);
  const [showSecondary, setShowSecondary] = useState(false);
  const [mobileChartsOpen, setMobileChartsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboardData();
  }, []);

  useErpSyncListener(
    ['sales_orders', 'inventory', 'sales_invoices', 'delivery_challans', 'expenses', 'dashboard'],
    () => {
      loadDashboardData();
    }
  );

  const loadDashboardData = async () => {
    // Sales role has its own dedicated dashboard; skip all generic queries.
    if (profile?.role === 'sales' || profile?.role === 'warehouse') { setLoading(false); return; }
    try {
      setError(null);
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      const startOfMonthStr = startOfMonth.toISOString().split('T')[0];
      const endOfMonthStr = endOfMonth.toISOString().split('T')[0];
      const in30Days = new Date();
      in30Days.setDate(in30Days.getDate() + 30);
      const in30DaysStr = in30Days.toISOString().split('T')[0];

      const [
        productsResult,
        productsWithStockResult,
        customersResult,
        invoicesResult,
        activitiesResult,
        pendingSalesOrdersResult,
        pendingDCResult,
        pendingExpensesResult,
        pendingPettyCashResult,
        pendingInvoicesResult,
        overdueInvoicesResult,
        batchesResult,
        overdueBalancesResult,
        deliveryAlerts,
      ] = await Promise.all([
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase
          .from('inventory_v1_stock_summary')
          .select('product_id, min_stock_level, total_current_stock, available_quantity')
          .gt('min_stock_level', 0),
        supabase.from('customers').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase
          .from('sales_invoices')
          .select('id', { count: 'exact', head: true })
          .gte('invoice_date', startOfMonthStr)
          .lte('invoice_date', endOfMonthStr),
        supabase
          .from('crm_activities')
          .select('id', { count: 'exact', head: true })
          .eq('is_completed', false)
          .not('follow_up_date', 'is', null),
        supabase
          .from('sales_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending_approval'),
        supabase
          .from('delivery_challans')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending_approval'),
        supabase
          .from('effective_expense_posting_state')
          .select('expense_id', { count: 'exact', head: true })
          .eq('effective_posting_state', 'PENDING'),
        supabase
          .from('petty_cash_transactions')
          .select('id', { count: 'exact', head: true })
          .is('fund_transfer_id', null)
          .eq('approval_status', 'pending_approval'),
        supabase
          .from('sales_invoices')
          .select('id', { count: 'exact', head: true })
          .in('payment_status', ['pending', 'partial']),
        supabase
          .from('sales_invoices')
          .select('id', { count: 'exact', head: true })
          .in('payment_status', ['pending', 'partial'])
          .lt('due_date', todayStr),
        supabase
          .from('batches')
          .select('id', { count: 'exact', head: true })
          .eq('is_active', true)
          .gt('current_stock', 0)
          .gte('expiry_date', todayStr)
          .lte('expiry_date', in30DaysStr),
        supabase.rpc('get_overdue_balances'),
        fetchSalesOrderDeliveryAlerts(),
      ]);

      const lowStockCount = productsWithStockResult.data?.filter(p =>
        (Number(p.min_stock_level) || 0) > 0 &&
        Number(p.available_quantity ?? p.total_current_stock ?? 0) < Number(p.min_stock_level)
      ).length || 0;

      const overdueAmount = (overdueBalancesResult.data || []).reduce(
        (sum: number, row: { balance_due: number }) => sum + (Number(row.balance_due) || 0), 0
      );
      const deliveryAlertSummary = summarizeDeliveryAlerts(deliveryAlerts);

      setStats({
        totalProducts: productsResult.count || 0,
        lowStockItems: lowStockCount,
        nearExpiryBatches: batchesResult.count || 0,
        totalCustomers: customersResult.count || 0,
        salesThisMonth: invoicesResult.count || 0,
        revenueThisMonth: 0,
        profitThisMonth: 0,
        pendingFollowUps: activitiesResult.count || 0,
        pendingSalesOrders: pendingSalesOrdersResult.count || 0,
        pendingDeliveryChallans: pendingDCResult.count || 0,
        pendingExpenses: pendingExpensesResult.count || 0,
        pendingPettyCash: pendingPettyCashResult.count || 0,
        pendingInvoices: pendingInvoicesResult.count || 0,
        overdueInvoicesCount: overdueInvoicesResult.count || 0,
        overdueInvoicesAmount: overdueAmount,
        deliveryDueSoon: deliveryAlertSummary.dueSoon.length,
        deliveryOverdue: deliveryAlertSummary.overdue.length,
      });

      setSharedAttentionData({
        arOverdueAmount: overdueAmount,
        arOverdueCount: overdueInvoicesResult.count || 0,
        pendingSalesOrdersCount: pendingSalesOrdersResult.count || 0,
        pendingDeliveryChallansCount: pendingDCResult.count || 0,
        pendingExpensesCount: pendingExpensesResult.count || 0,
        pendingPettyCashCount: pendingPettyCashResult.count || 0,
      });
      setRawDeliveryAlerts(deliveryAlerts);
    } catch (err) {
      setError('Failed to load dashboard data. Please try again.');
    } finally {
      setLoading(false);
      setTimeout(() => setShowSecondary(true), 50);
    }
  };

  const role = profile?.role;
  const isAdmin = role === 'admin';
  const isAccounts = role === 'accounts';
  const isSales = role === 'sales';
  const isWarehouse = role === 'warehouse';
  const isManager = role === 'manager';
  const isAuditor = role === 'auditor_ca';

  interface StatCard {
    title: string;
    value: number;
    subtitle?: string;
    icon: ElementType;
    color: string;
    link?: string;
  }
  const statCards: StatCard[] = [];

  if (isAdmin || isAccounts || isAuditor) {
    statCards.push({
      title: 'Overdue Invoices',
      value: stats.overdueInvoicesCount,
      subtitle: formatCurrency(stats.overdueInvoicesAmount, 'IDR'),
      icon: AlertTriangle,
      color: 'red-gradient',
      link: 'sales'
    });
    statCards.push({
      title: 'Pending Invoices',
      value: stats.pendingInvoices,
      subtitle: 'Awaiting collection',
      icon: FileText,
      color: 'yellow',
      link: 'sales',
    });
  }
  if (isAdmin || isSales || isWarehouse || isManager) {
    const totalDeliveryAlerts = stats.deliveryDueSoon + stats.deliveryOverdue;
    if (totalDeliveryAlerts > 0) {
      statCards.push({
        title: 'Delivery Alerts',
        value: totalDeliveryAlerts,
        subtitle: [
          stats.deliveryOverdue ? `${stats.deliveryOverdue} overdue` : '',
          stats.deliveryDueSoon ? `${stats.deliveryDueSoon} due soon` : '',
        ].filter(Boolean).join(', '),
        icon: AlertTriangle,
        color: stats.deliveryOverdue ? 'red' : 'yellow',
        link: 'sales-orders'
      });
    }
    const totalApprovals = stats.pendingSalesOrders + stats.pendingDeliveryChallans + stats.pendingExpenses + stats.pendingPettyCash;
    const parts = [
      stats.pendingSalesOrders ? `${stats.pendingSalesOrders} SO` : '',
      stats.pendingDeliveryChallans ? `${stats.pendingDeliveryChallans} DC` : '',
      stats.pendingExpenses ? `${stats.pendingExpenses} Exp` : '',
      stats.pendingPettyCash ? `${stats.pendingPettyCash} PC` : '',
    ].filter(Boolean);
    statCards.push({
      title: 'Approvals Pending',
      value: totalApprovals,
      subtitle: parts.length ? parts.join(', ') : 'All clear',
      icon: ClipboardCheck,
      color: 'yellow',
      link: 'sales-orders'
    });
  }
  if (isAdmin || isAccounts || isAuditor) {
    statCards.push({
      title: t('dashboard.salesThisMonth'),
      value: stats.salesThisMonth,
      icon: TrendingUp,
      color: 'blue',
      link: 'sales',
    });
  }
  if (isAdmin || isWarehouse) {
    statCards.push({
      title: t('dashboard.lowStock'),
      value: stats.lowStockItems,
      icon: AlertTriangle,
      color: 'orange',
      link: 'stock',
    });
    statCards.push({
      title: t('dashboard.nearExpiry'),
      value: stats.nearExpiryBatches,
      icon: Clock,
      color: 'red',
      link: 'batches',
    });
  }
  if (isSales) {
    statCards.push({
      title: 'Pending Follow-ups',
      value: stats.pendingFollowUps,
      icon: Clock,
      color: 'orange',
      link: 'crm',
    });
    statCards.push({
      title: 'Total Customers',
      value: stats.totalCustomers,
      icon: UserCircle,
      color: 'blue',
      link: 'customers',
    });
  }

  if (isWarehouse) {
    return (
      <Layout>
        <WarehouseDeliveryDashboard />
      </Layout>
    );
  }

  const colorClasses: Record<string, { bg: string; text: string; icon: string }> = {
    blue: { bg: 'bg-blue-50', text: 'text-blue-600', icon: 'bg-blue-100' },
    orange: { bg: 'bg-orange-50', text: 'text-orange-600', icon: 'bg-orange-100' },
    red: { bg: 'bg-red-50', text: 'text-red-600', icon: 'bg-red-100' },
    'red-gradient': { bg: 'bg-gradient-to-br from-red-500 to-orange-500', text: 'text-white', icon: 'bg-white/20' },
    green: { bg: 'bg-green-50', text: 'text-green-600', icon: 'bg-green-100' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600', icon: 'bg-emerald-100' },
    yellow: { bg: 'bg-yellow-50', text: 'text-yellow-600', icon: 'bg-yellow-100' },
  };

  const quickLinks: { label: string; page: string; icon: ElementType; color: string }[] = [];
  if (isAdmin || isSales) {
    quickLinks.push({ label: 'Go to Command Center', page: 'command-center', icon: Zap, color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' });
    quickLinks.push({ label: 'View All Inquiries', page: 'crm', icon: UserCircle, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
    quickLinks.push({ label: 'Sales Orders', page: 'sales-orders', icon: FileText, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
  }
  if (isAccounts) {
    quickLinks.push({ label: 'Finance Module', page: 'finance', icon: FileText, color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' });
    quickLinks.push({ label: 'Receivables', page: 'finance', icon: TrendingUp, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
    quickLinks.push({ label: 'Sales Invoices', page: 'sales', icon: FileText, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
  }
  if (isWarehouse) {
    quickLinks.push({ label: 'Stock Management', page: 'stock', icon: ClipboardCheck, color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' });
    quickLinks.push({ label: 'Delivery Challans', page: 'delivery-challan', icon: FileText, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
    quickLinks.push({ label: 'Inventory', page: 'inventory', icon: AlertTriangle, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
  }
  if (isAuditor) {
    quickLinks.push({ label: 'Sales Invoices', page: 'sales', icon: FileText, color: 'bg-blue-50 hover:bg-blue-100 text-blue-700' });
    quickLinks.push({ label: 'Finance Module', page: 'finance', icon: FileText, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
    quickLinks.push({ label: 'Purchase Orders', page: 'purchase-orders', icon: ClipboardList, color: 'bg-gray-50 hover:bg-gray-100 text-gray-700' });
  }

  // Sales role gets a dedicated CRM action dashboard instead of the generic layout.
  if (isSales) {
    return (
      <Layout>
        <SalesDashboard />
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-3 xl:space-y-4 min-w-0">
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-3 xl:p-4 border border-blue-100">
          <h1 className="text-lg sm:text-xl 2xl:text-2xl font-bold text-gray-900 leading-tight">
            Welcome, {profile?.full_name || profile?.username || 'User'}!
          </h1>
          <p className="text-xs sm:text-sm text-gray-600 mt-0.5 sm:mt-1">Here’s what needs attention today.</p>
        </div>

        {(isAdmin || isAccounts || isManager || isAuditor) && (
          <OwnerAttentionDashboard sharedData={sharedAttentionData} />
        )}

        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
            <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-3" />
            <p className="text-red-700 font-medium">{error}</p>
            <button
              onClick={loadDashboardData}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
            >
              Try Again
            </button>
          </div>
        ) : loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-white rounded-lg shadow p-4 animate-pulse">
                <div className="h-10 bg-gray-200 rounded mb-3" />
                <div className="h-5 bg-gray-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2 md:gap-3">
              {statCards.map((card: StatCard, index) => {
                const Icon = card.icon;
                const colors = colorClasses[card.color];
                const isClickable = !!card.link;
                return (
                  <div
                    key={index}
                    className={`${colors.bg} rounded-lg shadow-sm border border-gray-100/50 p-2.5 transition-all hover:shadow-md hover:-translate-y-0.5 ${isClickable ? 'cursor-pointer' : ''}`}
                    onClick={() => card.link && setCurrentPage(card.link)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className={`text-[10px] font-medium ${card.color === 'red-gradient' ? 'text-white/80' : 'text-gray-600'} truncate`}>{card.title}</p>
                        <p className={`text-lg md:text-xl font-bold ${colors.text} mt-0.5`}>
                          {card.value}
                        </p>
                        {card.subtitle && (
                          <p className={`text-[10px] mt-0.5 ${card.color === 'red-gradient' ? 'text-white/90' : 'text-gray-500'} truncate`}>
                            {card.subtitle}
                          </p>
                        )}
                      </div>
                      <div className={`${colors.icon} p-1.5 rounded-full flex-shrink-0 ml-1.5`}>
                        <Icon className={`w-3.5 h-3.5 ${colors.text}`} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {showSecondary && (isAdmin || isAccounts) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between md:hidden">
                  <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Analytics & Tax Overview
                  </span>
                  <button
                    type="button"
                    onClick={() => setMobileChartsOpen(prev => !prev)}
                    className="no-compact text-xs font-semibold text-blue-600 px-2 py-1 rounded hover:bg-blue-50"
                  >
                    {mobileChartsOpen ? 'Hide' : 'Show'}
                  </button>
                </div>
                <div className={`${mobileChartsOpen ? 'grid' : 'hidden md:grid'} grid-cols-1 lg:grid-cols-2 gap-3 xl:gap-4`}>
                  <RevenueChart />
                  <SalesPipelineChart />
                </div>
                <div className={`${mobileChartsOpen ? 'block' : 'hidden md:block'}`}>
                  <TaxComplianceDashboardCards />
                </div>
              </div>
            )}
          </>
        )}

        <div className={`grid grid-cols-1 ${(isAdmin || isAccounts) ? 'md:grid-cols-2 lg:grid-cols-3' : 'md:grid-cols-2'} gap-3 xl:gap-4`}>
          {showSecondary && (isAdmin || isAccounts) && (
            <div className="md:col-span-1 lg:col-span-1 min-w-0">
              <PaymentOverview />
            </div>
          )}
          {(isAdmin || isWarehouse || isManager) && (
            <div className="md:col-span-1 lg:col-span-1 min-w-0">
              <TodaysActionsDashboard
                initialDeliveryAlerts={rawDeliveryAlerts}
                initialPendingSalesOrders={stats.pendingSalesOrders}
                initialPendingDeliveryChallans={stats.pendingDeliveryChallans}
              />
            </div>
          )}
          {quickLinks.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 sm:p-4 2xl:p-6 min-w-0">
              <h3 className="text-sm sm:text-base font-semibold text-gray-900 mb-2.5 sm:mb-4">Quick Links</h3>
              <div className="space-y-2">
                {quickLinks.map((link, index) => {
                  const LinkIcon = link.icon;
                  return (
                    <button
                      key={index}
                      onClick={() => setCurrentPage(link.page)}
                      className={`w-full flex items-center justify-between p-3 ${link.color} rounded-lg transition font-medium text-sm group`}
                    >
                      <div className="flex items-center gap-2">
                        <LinkIcon className="w-4 h-4" />
                        <span>{link.label}</span>
                      </div>
                      <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
