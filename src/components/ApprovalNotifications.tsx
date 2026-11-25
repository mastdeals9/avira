import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { X, FileText, Truck, DollarSign, Wallet, Bell } from 'lucide-react';
import { formatCurrency, resolveTransactionCurrency } from '../utils/currency';
import { useSupabaseRealtimeChannel } from '../hooks/useSupabaseRealtimeChannel';
import { getEffectiveExpensePostingStates } from '../services/expensePostingLifecycle';

interface PendingApproval {
  id: string;
  type: 'sales_order' | 'delivery_challan' | 'expense' | 'petty_cash';
  number: string;
  description: string;
  amount?: number;
  currency?: string;
  date: string;
}

interface CompanyRef {
  company_name?: string;
}

export function ApprovalNotifications() {
  const { profile } = useAuth();
  const { setCurrentPage, setNavigationData } = useNavigation();
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  const getOpenStateKey = useCallback(() => `approval_panel_open_${profile?.id ?? 'default'}`, [profile?.id]);
  const getDismissKey = useCallback(() => `approval_popup_dismissed_${profile?.id ?? 'unknown'}`, [profile?.id]);

  const getCompanyName = (rawCustomer: unknown) => {
    if (Array.isArray(rawCustomer)) {
      return (rawCustomer[0] as CompanyRef | undefined)?.company_name || 'Unknown';
    }
    return (rawCustomer as CompanyRef | null)?.company_name || 'Unknown';
  };

  const inFlightRef = useRef<Promise<void> | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const loadPendingApprovals = useCallback(async () => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    const run = (async () => {
      try {
        const approvals: PendingApproval[] = [];

        const [soRes, dcRes, expRes, pcRes] = await Promise.allSettled([
          supabase
            .from('sales_orders')
            .select('id, so_number, so_date, total_amount, currency, customers(company_name)')
            .eq('status', 'pending_approval')
            .order('created_at', { ascending: false })
            .limit(5),

          supabase
            .from('delivery_challans')
            .select('id, challan_number, challan_date, customers(company_name)')
            .eq('approval_status', 'pending_approval')
            .order('created_at', { ascending: false })
            .limit(5),

          supabase
            .from('finance_expenses')
            .select(`
              id, voucher_number, expense_date, amount, description,
              transaction_currency, currency_code, payment_currency,
              bank_account_currency, bank_accounts(currency)
            `)
            .eq('approval_status', 'pending_approval')
            .order('created_at', { ascending: false })
            .limit(5),

          supabase
            .from('petty_cash_transactions')
            .select('id, transaction_number, transaction_date, amount, description')
            .is('fund_transfer_id', null)
            .eq('approval_status', 'pending_approval')
            .order('created_at', { ascending: false })
            .limit(5),
        ]);

        if (soRes.status === 'fulfilled' && !soRes.value.error && soRes.value.data) {
          soRes.value.data.forEach(so => approvals.push({
            id: so.id, type: 'sales_order', number: so.so_number,
            description: getCompanyName(so.customers),
            amount: so.total_amount, currency: so.currency || 'IDR', date: so.so_date,
          }));
        } else if (soRes.status === 'rejected' || (soRes.status === 'fulfilled' && soRes.value.error)) {
          console.warn('[ApprovalNotifications] sales_orders fetch error:', soRes.status === 'rejected' ? soRes.reason : soRes.value.error);
        }

        if (dcRes.status === 'fulfilled' && !dcRes.value.error && dcRes.value.data) {
          dcRes.value.data.forEach(ch => approvals.push({
            id: ch.id, type: 'delivery_challan', number: ch.challan_number,
            description: getCompanyName(ch.customers),
            date: ch.challan_date,
          }));
        } else if (dcRes.status === 'rejected' || (dcRes.status === 'fulfilled' && dcRes.value.error)) {
          console.warn('[ApprovalNotifications] delivery_challans fetch error:', dcRes.status === 'rejected' ? dcRes.reason : dcRes.value.error);
        }

        if (expRes.status === 'fulfilled' && !expRes.value.error && expRes.value.data) {
          const rawExpenses = expRes.value.data;
          const expenseLifecycleMap = rawExpenses.length > 0
            ? await getEffectiveExpensePostingStates(rawExpenses.map(e => e.id)).catch(() => new Map())
            : new Map();

          rawExpenses
            .filter(e => {
              const lifecycle = expenseLifecycleMap.get(e.id);
              if (lifecycle && (lifecycle.effective_posting_state === 'REVERSED' || lifecycle.effective_posting_state === 'REPLACED' || lifecycle.document_approval_status === 'cancelled')) {
                return false;
              }
              return true;
            })
            .slice(0, 5)
            .forEach(e => approvals.push({
              id: e.id, type: 'expense', number: e.voucher_number || '—',
              description: e.description || 'Expense',
              amount: e.amount, currency: resolveTransactionCurrency(e), date: e.expense_date,
            }));
        } else if (expRes.status === 'rejected' || (expRes.status === 'fulfilled' && expRes.value.error)) {
          console.warn('[ApprovalNotifications] finance_expenses fetch error:', expRes.status === 'rejected' ? expRes.reason : expRes.value.error);
        }

        if (pcRes.status === 'fulfilled' && !pcRes.value.error && pcRes.value.data) {
          pcRes.value.data.forEach(pc => approvals.push({
            id: pc.id, type: 'petty_cash', number: pc.transaction_number,
            description: pc.description || 'Petty Cash',
            amount: pc.amount, currency: resolveTransactionCurrency(undefined), date: pc.transaction_date,
          }));
        } else if (pcRes.status === 'rejected' || (pcRes.status === 'fulfilled' && pcRes.value.error)) {
          console.warn('[ApprovalNotifications] petty_cash_transactions fetch error:', pcRes.status === 'rejected' ? pcRes.reason : pcRes.value.error);
        }

        setPendingApprovals(approvals);

        // Broadcast count so header notification controls can stay in sync
        try {
          window.dispatchEvent(
            new CustomEvent('pending-approvals-count-changed', {
              detail: { count: approvals.length },
            })
          );
        } catch {
          // Ignore
        }
      } catch (error) {
        console.error('Error loading pending approvals:', error);
      } finally {
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = run;
    return run;
  }, []);

  const debouncedLoad = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      loadPendingApprovals();
    }, 300);
  }, [loadPendingApprovals]);

  // Initial load & restore persistent open state (closed by default)
  useEffect(() => {
    if (profile?.role !== 'admin') return;

    try {
      const storedOpen = localStorage.getItem(getOpenStateKey());
      // The panel is closed by default. Only restore open if user explicitly opened it earlier.
      setIsOpen(storedOpen === 'open');
    } catch {
      setIsOpen(false);
    }

    loadPendingApprovals();

    // Debounced realtime + on-focus refresh prevents flood on window focus
    const onFocus = () => debouncedLoad();
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('focus', onFocus);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [debouncedLoad, getOpenStateKey, loadPendingApprovals, profile?.role]);

  // Handle explicit open/dismiss/toggle actions
  const handleOpen = useCallback(() => {
    setIsOpen(true);
    try {
      localStorage.setItem(getOpenStateKey(), 'open');
    } catch {
      // Ignore storage failures
    }
  }, [getOpenStateKey]);

  const handleDismiss = useCallback(() => {
    setIsOpen(false);
    try {
      localStorage.setItem(getOpenStateKey(), 'closed');
      localStorage.setItem(getDismissKey(), 'dismissed');
    } catch {
      // Ignore storage failures
    }
  }, [getDismissKey, getOpenStateKey]);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(getOpenStateKey(), next ? 'open' : 'closed');
        if (!next) {
          localStorage.setItem(getDismissKey(), 'dismissed');
        }
      } catch {
        // Ignore storage failures
      }
      return next;
    });
  }, [getDismissKey, getOpenStateKey]);

  // External trigger listeners (e.g. from notification bell)
  useEffect(() => {
    window.addEventListener('open-pending-approvals', handleOpen);
    window.addEventListener('toggle-pending-approvals', handleToggle);
    window.addEventListener('close-pending-approvals', handleDismiss);
    return () => {
      window.removeEventListener('open-pending-approvals', handleOpen);
      window.removeEventListener('toggle-pending-approvals', handleToggle);
      window.removeEventListener('close-pending-approvals', handleDismiss);
    };
  }, [handleDismiss, handleOpen, handleToggle]);

  const approvalEnabled = profile?.role === 'admin';
  const onApprovalEvent = () => { debouncedLoad(); };
  useSupabaseRealtimeChannel({
    channelName: 'approval_popup_sales_orders',
    table: 'sales_orders',
    enabled: approvalEnabled,
    onEvent: onApprovalEvent,
  });
  useSupabaseRealtimeChannel({
    channelName: 'approval_popup_delivery_challans',
    table: 'delivery_challans',
    enabled: approvalEnabled,
    onEvent: onApprovalEvent,
  });
  useSupabaseRealtimeChannel({
    channelName: 'approval_popup_finance_expenses',
    table: 'finance_expenses',
    enabled: approvalEnabled,
    onEvent: onApprovalEvent,
  });
  useSupabaseRealtimeChannel({
    channelName: 'approval_popup_petty_cash',
    table: 'petty_cash_transactions',
    enabled: approvalEnabled,
    onEvent: onApprovalEvent,
  });

  const handleViewItem = (item: PendingApproval) => {
    if (item.type === 'sales_order') setCurrentPage('sales-orders');
    else if (item.type === 'delivery_challan') setCurrentPage('delivery-challan');
    else {
      setNavigationData({
        sourceType: item.type,
        sourceId: item.id,
      });
      setCurrentPage('finance');
    }
  };

  if (profile?.role !== 'admin' || pendingApprovals.length === 0) return null;

  const typeConfig = {
    sales_order:     { label: 'Sales Order',     bg: 'bg-blue-100',   text: 'text-blue-600',   Icon: FileText },
    delivery_challan:{ label: 'Delivery Challan', bg: 'bg-green-100',  text: 'text-green-600',  Icon: Truck },
    expense:         { label: 'Expense',          bg: 'bg-orange-100', text: 'text-orange-600', Icon: DollarSign },
    petty_cash:      { label: 'Petty Cash',       bg: 'bg-yellow-100', text: 'text-yellow-600', Icon: Wallet },
  };

  // Minimized state: notification bell pill with persistent pending approvals badge
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className="fixed bottom-16 sm:bottom-4 right-2 sm:right-4 z-50 flex items-center gap-2 px-3.5 py-2.5 rounded-full bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-xl hover:from-blue-700 hover:to-blue-800 transition-all duration-200 hover:scale-105 active:scale-95 group border border-blue-400/30"
        title={`Pending Approvals (${pendingApprovals.length})`}
        aria-label={`Pending Approvals (${pendingApprovals.length})`}
        data-testid="pending-approvals-trigger"
      >
        <div className="relative flex items-center justify-center">
          <Bell className="w-5 h-5 text-white" />
          <span className="absolute -top-1.5 -right-2 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 shadow border border-white">
            {pendingApprovals.length}
          </span>
        </div>
        <span className="text-xs font-semibold tracking-wide hidden sm:inline pr-1">
          Pending Approvals
        </span>
      </button>
    );
  }

  // Expanded state: full slide-out panel
  return (
    <div className="fixed bottom-16 sm:bottom-4 right-2 sm:right-4 left-2 sm:left-auto sm:w-96 max-w-[calc(100vw-16px)] max-h-[70vh] sm:max-h-[600px] overflow-hidden rounded-xl shadow-2xl bg-white border border-gray-200 animate-slide-up z-50 flex flex-col">
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          <h3 className="font-semibold text-sm sm:text-base">Pending Approvals</h3>
          <span className="bg-white/20 text-xs px-2 py-0.5 rounded-full font-medium">{pendingApprovals.length}</span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-white/80 hover:text-white transition p-1 rounded-lg hover:bg-white/10"
          title="Close panel"
          aria-label="Close panel"
          data-testid="pending-approvals-close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="max-h-[500px] overflow-y-auto flex-1">
        {pendingApprovals.map((item, index) => {
          const cfg = typeConfig[item.type];
          const Icon = cfg.Icon;
          return (
            <div
              key={`${item.type}-${item.id}`}
              className={`p-3.5 border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition ${index === 0 ? 'bg-blue-50/60' : ''}`}
              onClick={() => handleViewItem(item)}
            >
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg shrink-0 ${cfg.bg} ${cfg.text}`}>
                  <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs sm:text-sm font-semibold text-gray-900">{cfg.label}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5 font-mono">{item.number}</p>
                    </div>
                    <span className="text-[11px] text-gray-400 whitespace-nowrap">
                      {new Date(item.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 mt-1 truncate">{item.description}</p>
                  {item.amount !== undefined && (
                    <p className="text-xs font-semibold text-blue-600 mt-1">
                      {formatCurrency(item.amount, item.currency)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-gray-50 px-4 py-2.5 text-center border-t border-gray-100 shrink-0">
        <p className="text-[11px] text-gray-500">Click on an item to review and approve</p>
      </div>

      <style>{`
        @keyframes slide-up {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        .animate-slide-up { animation: slide-up 0.25s ease-out; }
      `}</style>
    </div>
  );
}
