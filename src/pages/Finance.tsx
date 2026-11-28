import { useCallback, useEffect, useState, useMemo, lazy, Suspense } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import type { TFunction } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { ChevronDown, ChevronRight, Menu, X, Loader } from 'lucide-react';
import { supabase } from '../lib/supabase';

const PurchaseInvoiceManager = lazy(() => import('../components/finance/PurchaseInvoiceManager').then(m => ({ default: m.PurchaseInvoiceManager })));
const ReceiptVoucherManager = lazy(() => import('../components/finance/ReceiptVoucherManager').then(m => ({ default: m.ReceiptVoucherManager })));
const PaymentVoucherManager = lazy(() => import('../components/finance/PaymentVoucherManager').then(m => ({ default: m.PaymentVoucherManager })));
const ExpenseManager = lazy(() => import('../components/finance/ExpenseManager').then(m => ({ default: m.ExpenseManager })));
const PettyCashManager = lazy(() => import('../components/finance/PettyCashManager').then(m => ({ default: m.PettyCashManager })));
const FundTransferManager = lazy(() => import('../components/finance/FundTransferManager').then(m => ({ default: m.FundTransferManager })));
const JournalEntryViewer = lazy(() => import('../components/finance/JournalEntryViewerEnhanced').then(m => ({ default: m.JournalEntryViewerEnhanced })));
const AccountLedger = lazy(() => import('../components/finance/AccountLedger').then(m => ({ default: m.AccountLedger })));
const PartyLedger = lazy(() => import('../components/finance/PartyLedger'));
const BankLedger = lazy(() => import('../components/finance/BankLedger'));
const FinancialReports = lazy(() => import('../components/finance/FinancialReports').then(m => ({ default: m.FinancialReports })));
const ReceivablesManager = lazy(() => import('../components/finance/ReceivablesManager').then(m => ({ default: m.ReceivablesManager })));
const PayablesManager = lazy(() => import('../components/finance/PayablesManager').then(m => ({ default: m.PayablesManager })));
const AgeingReport = lazy(() => import('./reports/AgeingReport').then(m => ({ default: m.AgeingReport })));
const BankReconciliation = lazy(() => import('../components/finance/BankReconciliationEnhanced').then(m => ({ default: m.BankReconciliationEnhanced })));
const ChartOfAccountsManager = lazy(() => import('../components/finance/ChartOfAccountsManager').then(m => ({ default: m.ChartOfAccountsManager })));
const SuppliersManager = lazy(() => import('../components/finance/SuppliersManager').then(m => ({ default: m.SuppliersManager })));
const BankAccountsManager = lazy(() => import('../components/finance/BankAccountsManager').then(m => ({ default: m.BankAccountsManager })));
const StaffMasterManager = lazy(() => import('../components/finance/StaffMasterManager').then(m => ({ default: m.StaffMasterManager })));
const UtilityMasterManager = lazy(() => import('../components/finance/UtilityMasterManager').then(m => ({ default: m.UtilityMasterManager })));
const ExpenseCategoryManager = lazy(() => import('../components/finance/ExpenseCategoryManager').then(m => ({ default: m.ExpenseCategoryManager })));
const TaxComplianceCentre = lazy(() => import('../components/finance/TaxComplianceCentre').then(m => ({ default: m.TaxComplianceCentre })));
const CAReports = lazy(() => import('../components/finance/CAReports').then(m => ({ default: m.CAReports })));
const GeneralJournalEntry = lazy(() => import('../components/finance/GeneralJournalEntry').then(m => ({ default: m.GeneralJournalEntry })));
const IntegrityMonitor = lazy(() => import('../components/finance/IntegrityMonitor').then(m => ({ default: m.IntegrityMonitor })));
const FinanceExceptionCorrectionDashboard = lazy(() => import('../components/finance/FinanceExceptionCorrectionDashboard').then(m => ({ default: m.FinanceExceptionCorrectionDashboard })));
import { PayeeMasterManager } from '../components/finance/PayeeMasterManager';
import type { BankReconciliationExpensePrefill } from '../components/finance/ExpenseManager';
import type { BankReconciliationReceiptPrefill } from '../components/finance/ReceiptVoucherManager';
const FXReport = lazy(() => import('../components/finance/FXReport').then(m => ({ default: m.FXReport })));
const FXBusinessDashboard = lazy(() => import('../components/finance/FXBusinessDashboard').then(m => ({ default: m.FXBusinessDashboard })));
const BpjsRegisterManager = lazy(() => import('../components/finance/BpjsRegisterManager').then(m => ({ default: m.BpjsRegisterManager })));

type FinanceTab =
  | 'purchase' | 'receipt' | 'payment' | 'journal' | 'contra' | 'expenses' | 'petty_cash'
  | 'ledger' | 'journal_register' | 'bank_ledger' | 'party_ledger' | 'bank_recon' | 'bpjs_register'
  | 'trial_balance' | 'pnl' | 'balance_sheet' | 'receivables' | 'payables' | 'ageing' | 'tax' | 'ca_reports' | 'fx_dashboard' | 'fx_report' | 'integrity_monitor' | 'exception_correction'
  | 'coa' | 'expense_categories' | 'customers' | 'suppliers' | 'products' | 'banks' | 'staff_master' | 'utility_master' | 'payee_master';

const FINANCE_TABS: readonly FinanceTab[] = [
  'purchase', 'receipt', 'payment', 'journal', 'contra', 'expenses', 'petty_cash',
  'ledger', 'journal_register', 'bank_ledger', 'party_ledger', 'bank_recon', 'bpjs_register',
  'trial_balance', 'pnl', 'balance_sheet', 'receivables', 'payables', 'ageing', 'tax', 'ca_reports', 'fx_dashboard', 'fx_report', 'integrity_monitor', 'exception_correction',
  'coa', 'expense_categories', 'customers', 'suppliers', 'products', 'banks', 'staff_master', 'utility_master', 'payee_master',
];
const DEFAULT_FINANCE_TAB: FinanceTab = 'purchase';

const FINANCE_ROUTE_BY_TAB: Record<FinanceTab, string> = {
  purchase: 'purchase', receipt: 'receipt', payment: 'payment', journal: 'journal', contra: 'fund-transfer',
  expenses: 'expenses', petty_cash: 'petty-cash', ledger: 'ledger', journal_register: 'journal-register',
  bank_ledger: 'bank-ledger', party_ledger: 'party-ledger', bank_recon: 'bank-reconciliation', bpjs_register: 'bpjs-register',
  trial_balance: 'trial-balance', pnl: 'profit-and-loss', balance_sheet: 'balance-sheet', receivables: 'receivables',
  payables: 'payables', ageing: 'ageing', tax: 'tax', ca_reports: 'ca-reports', fx_dashboard: 'fx-dashboard', fx_report: 'fx-report', integrity_monitor: 'integrity-monitor',
  exception_correction: 'exception-correction', coa: 'chart-of-accounts', customers: 'customers', suppliers: 'suppliers',
  products: 'products', banks: 'banks', staff_master: 'staff-master', utility_master: 'utility-master', expense_categories: 'expense-categories',
  payee_master: 'payees',
};

const FINANCE_TAB_BY_ROUTE = Object.fromEntries(
  Object.entries(FINANCE_ROUTE_BY_TAB).map(([tab, route]) => [route, tab as FinanceTab]),
) as Record<string, FinanceTab>;

interface MenuItem {
  id: FinanceTab;
  label: string;
  shortcut?: string;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
  collapsible?: boolean;
}

const getFinanceMenu = (t: TFunction): MenuGroup[] => [
  {
    label: t.finance.vouchers,
    collapsible: true,
    items: [
      { id: 'purchase', label: t.finance.purchase, shortcut: 'F9' },
      { id: 'receipt', label: t.finance.receipt, shortcut: 'F6' },
      { id: 'payment', label: t.finance.payment, shortcut: 'F5' },
      { id: 'journal', label: t.finance.journal, shortcut: 'F7' },
      { id: 'contra', label: t.finance.contra, shortcut: 'F4' },
      { id: 'expenses', label: t.finance.expenses, shortcut: 'F8' },
      { id: 'petty_cash', label: t.finance.pettyCash },
    ]
  },
  {
    label: t.finance.books,
    collapsible: true,
    items: [
      { id: 'ledger', label: t.finance.ledger, shortcut: 'Ctrl+L' },
      { id: 'journal_register', label: t.finance.journalRegister, shortcut: 'Ctrl+J' },
      { id: 'bank_ledger', label: t.finance.bankLedger },
      { id: 'party_ledger', label: t.finance.partyLedger },
      { id: 'bank_recon', label: t.finance.bankReconciliation },
      { id: 'bpjs_register', label: 'BPJS Register' },
    ]
  },
  {
    label: t.finance.reports,
    collapsible: true,
    items: [
      { id: 'ca_reports', label: t.finance.caReports, shortcut: 'Ctrl+R' },
      { id: 'trial_balance', label: t.finance.trialBalance },
      { id: 'pnl', label: t.finance.profitLoss },
      { id: 'balance_sheet', label: t.finance.balanceSheet },
      { id: 'receivables', label: t.finance.receivables },
      { id: 'payables', label: t.finance.payables },
      { id: 'ageing', label: t.finance.ageing },
      { id: 'tax', label: t.finance.taxCompliance ?? t.finance.taxReports },
      { id: 'fx_dashboard', label: 'FX Management & Reports' },
      { id: 'integrity_monitor', label: 'Integrity Monitor' },
      { id: 'exception_correction', label: 'Exception Correction' },
    ]
  },
  {
    label: t.finance.masters,
    collapsible: true,
    items: [
      { id: 'coa', label: t.finance.chartOfAccounts },
      { id: 'expense_categories', label: 'Expense Categories' },
      { id: 'suppliers', label: t.finance.suppliers },
      { id: 'banks', label: t.finance.banks },
      { id: 'staff_master', label: 'Staff Master' },
      { id: 'payee_master', label: 'Payee Master' },
      { id: 'utility_master', label: 'Utility Master' },
    ]
  }
];

function FinanceContent() {
  const { profile, accessibleModules } = useAuth();
  const { t } = useLanguage();
  const { navigationData, clearNavigationData, setNavigationData, setCurrentPage } = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Active Finance sub-page is derived from the URL so browser refresh and
  // back/forward restore the exact tab the user was on.
  const activeTab: FinanceTab = useMemo(() => {
    const segment = location.pathname.split('/')[2];
    if (!segment) return DEFAULT_FINANCE_TAB;
    return FINANCE_TAB_BY_ROUTE[segment]
      ?? ((FINANCE_TABS as readonly string[]).includes(segment) ? segment as FinanceTab : DEFAULT_FINANCE_TAB);
  }, [location.pathname]);
  const setActiveTab = useCallback((tab: FinanceTab, query?: URLSearchParams) => {
    const search = query && query.toString() ? `?${query.toString()}` : '';
    navigate(`/finance/${FINANCE_ROUTE_BY_TAB[tab]}${search}`);
  }, [navigate]);

  const openFinanceTarget = useCallback((tab: FinanceTab, key: string, id: string) => {
    const query = new URLSearchParams();
    query.set(key, id);
    setActiveTab(tab, query);
  }, [setActiveTab]);
  // Persist Finance sidebar state so the user's choice survives page navigation.
  const SIDEBAR_KEY = 'anzen.finance.sidebarCollapsed';
  const GROUPS_KEY  = 'anzen.finance.collapsedGroups';
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const [sidebarCollapsed, setSidebarCollapsedRaw] = useState<boolean>(() => {
    if (typeof window === 'undefined') return isMobile;
    const saved = window.localStorage.getItem(SIDEBAR_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
    return isMobile;
  });
  const setSidebarCollapsed = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setSidebarCollapsedRaw(prev => {
      const value = typeof next === 'function' ? (next as (p: boolean) => boolean)(prev) : next;
      if (typeof window !== 'undefined') window.localStorage.setItem(SIDEBAR_KEY, value ? '1' : '0');
      return value;
    });
  }, []);
  const [collapsedGroups, setCollapsedGroupsRaw] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const saved = window.localStorage.getItem(GROUPS_KEY);
      if (!saved) return new Set();
      const arr = JSON.parse(saved);
      return Array.isArray(arr) ? new Set<string>(arr) : new Set();
    } catch { return new Set(); }
  });
  const setCollapsedGroups = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setCollapsedGroupsRaw(prev => {
      const next = typeof updater === 'function' ? (updater as (p: Set<string>) => Set<string>)(prev) : updater;
      if (typeof window !== 'undefined') window.localStorage.setItem(GROUPS_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  }, []);
  const [editJournalEntryId, setEditJournalEntryId] = useState<string | null>(null);
  const [payInvoice, setPayInvoice] = useState<{ id: string; invoice_number: string; supplier_id: string; balance_amount: number } | null>(null);
  const [payExpenseBill, setPayExpenseBill] = useState<{ id: string; supplier_id: string | null; staff_id?: string | null; balance_amount: number } | null>(null);
  const [focusExpenseId, setFocusExpenseId] = useState<string | null>(null);
  const [focusPurchaseInvoiceId, setFocusPurchaseInvoiceId] = useState<string | null>(null);
  const [focusReceiptId, setFocusReceiptId] = useState<string | null>(null);
  const [focusPaymentId, setFocusPaymentId] = useState<string | null>(null);
  const [focusJournalId, setFocusJournalId] = useState<string | null>(null);
  const [focusPettyCashId, setFocusPettyCashId] = useState<string | null>(null);
  const [focusFundTransferId, setFocusFundTransferId] = useState<string | null>(null);
  const [focusBankAccountId, setFocusBankAccountId] = useState<string | null>(null);
  const [focusBankStatementLineId, setFocusBankStatementLineId] = useState<string | null>(null);
  const [contraPrefill, setContraPrefill] = useState<{
    bankAccountId: string; statementLineId: string; date: string; amount: number; description: string; direction: 'from' | 'to';
  } | null>(null);
  const [paymentReconPrefill, setPaymentReconPrefill] = useState<{
    bankAccountId: string; statementLineId: string; date: string; amount: number; currency: 'IDR' | 'USD'; reference: string; description: string;
  } | null>(null);
  const [expenseReconPrefill, setExpenseReconPrefill] = useState<BankReconciliationExpensePrefill | null>(null);
  const [receiptReconPrefill, setReceiptReconPrefill] = useState<BankReconciliationReceiptPrefill | null>(null);
  const handleOpenBankReconciliation = useCallback((bankAccountId?: string, bankStatementLineId?: string) => {
    const params: Record<string, string> = {};
    if (bankAccountId) params.bank = bankAccountId;
    if (bankStatementLineId) params.bankLine = bankStatementLineId;
    const query = new URLSearchParams(params);
    setActiveTab('bank_recon', query);
  }, [setActiveTab]);
  const handleBankReconciliationFocusHandled = useCallback(() => {
    setFocusBankAccountId(null);
    setFocusBankStatementLineId(null);
  }, []);
  const [ledgerDrillCode, setLedgerDrillCode] = useState<string | null>(null);
  const hasFullFinance = accessibleModules.has('finance');
  const hasPurchaseInvoices = hasFullFinance || accessibleModules.has('purchase-invoices');
  const hasTaxCompliance = hasFullFinance || accessibleModules.has('tax-compliance');
  const allowedTabs = useMemo<Set<FinanceTab>>(() => {
    if (hasFullFinance) return new Set(FINANCE_TABS);
    const tabs = new Set<FinanceTab>();
    if (hasPurchaseInvoices) tabs.add('purchase');
    if (hasTaxCompliance) tabs.add('tax');
    return tabs;
  }, [hasFullFinance, hasPurchaseInvoices, hasTaxCompliance]);
  const canManage = profile?.role === 'admin' || profile?.role === 'accounts';
  const canManagePurchaseInvoices = canManage || accessibleModules.has('purchase-invoices');

  // Deep links are intentionally URL-driven so refresh, right-click, middle
  // click and Cmd/Ctrl-click all restore the same Finance record in a new tab.
  useEffect(() => {
    const documentId = searchParams.get('document');
    const journalId = searchParams.get('journal');
    const bankId = searchParams.get('bank');
    const bankLineId = searchParams.get('bankLine');
    const accountCode = searchParams.get('account');
    if (activeTab === 'expenses') setFocusExpenseId(documentId);
    if (activeTab === 'purchase') setFocusPurchaseInvoiceId(documentId);
    if (activeTab === 'receipt') setFocusReceiptId(documentId);
    if (activeTab === 'payment') setFocusPaymentId(documentId);
    if (activeTab === 'petty_cash') setFocusPettyCashId(documentId);
    if (activeTab === 'contra') setFocusFundTransferId(documentId);
    if (activeTab === 'journal_register') setFocusJournalId(journalId);
    if (activeTab === 'bank_recon') {
      setFocusBankAccountId(bankId);
      setFocusBankStatementLineId(bankLineId);
    }
    if (activeTab === 'ledger') setLedgerDrillCode(accountCode);
  }, [activeTab, searchParams]);

  const handlePayInvoice = (invoice: { id: string; invoice_number: string; supplier_id: string; balance_amount: number }) => {
    setPayInvoice(invoice);
    setActiveTab('payment');
  };

  const handleSettleExpenseBill = (bill: { id: string; supplier_id: string | null; staff_id?: string | null; balance_amount: number }) => {
    setPayExpenseBill(bill);
    setActiveTab('payment');
  };

  const handleEditJournalEntry = (entryId: string) => {
    setEditJournalEntryId(entryId);
    setActiveTab('journal');
  };

  const handleOpenJournal = useCallback((entryId: string) => {
    openFinanceTarget('journal_register', 'journal', entryId);
  }, [openFinanceTarget]);

  const handleOpenJournalSource = useCallback(async (sourceModule: string, referenceId: string) => {
    if (sourceModule === 'expense' || sourceModule === 'expenses') {
      openFinanceTarget('expenses', 'document', referenceId);
    } else if (sourceModule === 'receipt') {
      openFinanceTarget('receipt', 'document', referenceId);
    } else if (sourceModule === 'payment') {
      openFinanceTarget('payment', 'document', referenceId);
    } else if (sourceModule === 'petty_cash') {
      openFinanceTarget('petty_cash', 'document', referenceId);
    } else if (sourceModule === 'fund_transfer' || sourceModule === 'fund_transfers') {
      openFinanceTarget('contra', 'document', referenceId);
    } else if (sourceModule === 'bank_reconciliation') {
      const { data } = await supabase.from('bank_statement_lines').select('bank_account_id').eq('id', referenceId).maybeSingle();
      if (data?.bank_account_id) handleOpenBankReconciliation(data.bank_account_id, referenceId);
    } else if (sourceModule === 'purchase' || sourceModule === 'purchase_invoice' || sourceModule === 'purchase_invoices') {
      openFinanceTarget('purchase', 'document', referenceId);
    } else if (sourceModule === 'sales' || sourceModule === 'sales_invoice' || sourceModule === 'sales_invoices' || sourceModule === 'sales_invoice_cogs') {
      setNavigationData({ sourceType: 'sales_invoice', invoiceId: referenceId });
      setCurrentPage('sales');
    }
  }, [handleOpenBankReconciliation, openFinanceTarget, setCurrentPage, setNavigationData]);

  const financeMenu = useMemo(() => {
    if (!t || !t.finance) return [];
    return getFinanceMenu(t)
      .map(group => ({ ...group, items: group.items.filter(item => allowedTabs.has(item.id)) }))
      .filter(group => group.items.length > 0);
  }, [t, allowedTabs]);

  const toggleGroup = (groupLabel: string) => {
    setCollapsedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupLabel)) {
        newSet.delete(groupLabel);
      } else {
        newSet.add(groupLabel);
      }
      return newSet;
    });
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      if (e.key === 'F2') {
        e.preventDefault();
        const input = document.querySelector('input[type="date"]') as HTMLInputElement;
        if (input) input.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        setActiveTab('contra');
      } else if (e.key === 'F5') {
        e.preventDefault();
        setActiveTab('payment');
      } else if (e.key === 'F6') {
        e.preventDefault();
        setActiveTab('receipt');
      } else if (e.key === 'F7') {
        e.preventDefault();
        setActiveTab('journal');
      } else if (e.key === 'F8') {
        e.preventDefault();
        setActiveTab('expenses');
      } else if (e.key === 'F9') {
        e.preventDefault();
        setActiveTab('purchase');
      } else if (e.key === 'F10') {
        e.preventDefault();
        // Navigate to Sales page instead
        window.location.hash = 'sales';
      } else if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        setActiveTab('ledger');
      } else if (e.ctrlKey && e.key === 'j') {
        e.preventDefault();
        setActiveTab('journal_register');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTab]);

  useEffect(() => {
    if (!navigationData?.sourceType || !navigationData?.sourceId) return;

    if (navigationData.sourceType === 'expense') {
      setActiveTab('expenses');
      setFocusExpenseId(String(navigationData.sourceId));
      setFocusPettyCashId(null);
      clearNavigationData();
      return;
    }

    if (navigationData.sourceType === 'petty_cash') {
      setActiveTab('petty_cash');
      setFocusPettyCashId(String(navigationData.sourceId));
      setFocusExpenseId(null);
      clearNavigationData();
    }
  }, [navigationData, clearNavigationData, setActiveTab]);

  const renderContent = () => {
    switch (activeTab) {
      case 'purchase':
        if (!hasPurchaseInvoices) return <div className="p-8 text-center text-gray-500">Access denied</div>;
        return <PurchaseInvoiceManager canManage={canManagePurchaseInvoices} initialViewInvoiceId={focusPurchaseInvoiceId} onInitialViewHandled={() => setFocusPurchaseInvoiceId(null)} />;
      case 'receipt':
        return <ReceiptVoucherManager canManage={canManage} initialViewVoucherId={focusReceiptId} onInitialViewHandled={() => setFocusReceiptId(null)} prefillFromBankReconciliation={receiptReconPrefill} onBankReconciliationPrefillConsumed={() => setReceiptReconPrefill(null)} onOpenBankReconciliation={handleOpenBankReconciliation} />;
      case 'payment':
        return <PaymentVoucherManager canManage={canManage} initialViewVoucherId={focusPaymentId} onInitialViewHandled={() => setFocusPaymentId(null)} prefillInvoice={payInvoice} onPrefillConsumed={() => setPayInvoice(null)} prefillExpenseBill={payExpenseBill} onPrefillExpenseBillConsumed={() => setPayExpenseBill(null)} onViewInvoice={(invoiceId) => openFinanceTarget('purchase', 'document', invoiceId)} onViewExpense={(expenseId) => openFinanceTarget('expenses', 'document', expenseId)} prefillFromBankReconciliation={paymentReconPrefill} onBankReconciliationPrefillConsumed={() => setPaymentReconPrefill(null)} onOpenBankReconciliation={handleOpenBankReconciliation} />;
      case 'journal':
        return <GeneralJournalEntry
          canManage={canManage}
          onNavigateToLedger={() => setActiveTab('ledger')}
          initialEditEntryId={editJournalEntryId}
          onEditComplete={() => setEditJournalEntryId(null)}
        />;
      case 'contra':
        return (
          <FundTransferManager
            canManage={canManage}
            initialViewTransferId={focusFundTransferId}
            onInitialViewHandled={() => setFocusFundTransferId(null)}
            onOpenBankReconciliation={handleOpenBankReconciliation}
            prefillFromBankReconciliation={contraPrefill}
            onPrefillConsumed={() => setContraPrefill(null)}
          />
        );
      case 'expenses':
        return (
          <ExpenseManager
            canManage={canManage}
            initialViewExpenseId={focusExpenseId}
            onInitialViewHandled={() => setFocusExpenseId(null)}
            onSettleBill={handleSettleExpenseBill}
            onViewPaymentVoucher={(paymentVoucherId) => openFinanceTarget('payment', 'document', paymentVoucherId)}
            prefillFromBankReconciliation={expenseReconPrefill}
            onBankReconciliationPrefillConsumed={() => setExpenseReconPrefill(null)}
          />
        );
      case 'petty_cash':
        return (
          <PettyCashManager
            canManage={canManage}
            onNavigateToFundTransfer={(fundTransferId) => {
              if (fundTransferId) openFinanceTarget('contra', 'document', fundTransferId);
            }}
            initialViewTransactionId={focusPettyCashId}
            onInitialViewHandled={() => setFocusPettyCashId(null)}
          />
        );
      case 'ledger':
        return <AccountLedger initialCode={ledgerDrillCode ?? undefined} onCodeConsumed={() => setLedgerDrillCode(null)} onOpenJournal={handleOpenJournal} />;
      case 'journal_register':
        return <JournalEntryViewer canManage={canManage} onEditEntry={handleEditJournalEntry}
          initialViewEntryId={focusJournalId} onInitialViewHandled={() => setFocusJournalId(null)} onOpenSource={handleOpenJournalSource} />;
      case 'bank_ledger':
        return <BankLedger />;
      case 'party_ledger':
        return <PartyLedger />;
      case 'bank_recon':
        return (
          <BankReconciliation
            canManage={canManage}
            initialBankAccountId={focusBankAccountId}
            initialStatementLineId={focusBankStatementLineId}
            onInitialFocusHandled={handleBankReconciliationFocusHandled}
            onRecordContra={(prefill) => {
              setContraPrefill(prefill);
              setActiveTab('contra');
            }}
            onRecordPayment={(prefill) => {
              setPaymentReconPrefill(prefill);
              setActiveTab('payment');
            }}
            onRecordExpense={(prefill) => {
              setExpenseReconPrefill(prefill);
              setActiveTab('expenses');
            }}
            onRecordReceipt={(prefill) => {
              setReceiptReconPrefill(prefill);
              setActiveTab('receipt');
            }}
            onOpenJournal={handleOpenJournal}
          />
        );
      case 'trial_balance':
        return <FinancialReports initialReport="trial_balance" onDrillDown={(code) => openFinanceTarget('ledger', 'account', code)} />;
      case 'pnl':
        return <FinancialReports initialReport="pnl" onDrillDown={(code) => openFinanceTarget('ledger', 'account', code)} />;
      case 'balance_sheet':
        return <FinancialReports initialReport="balance_sheet" onDrillDown={(code) => openFinanceTarget('ledger', 'account', code)} />;
      case 'receivables':
        return <ReceivablesManager canManage={canManage} />;
      case 'payables':
        return <PayablesManager canManage={canManage} />;
      case 'ageing':
        return <AgeingReport />;
      case 'tax':
        if (!hasTaxCompliance) return <div className="p-8 text-center text-gray-500">Access denied</div>;
        return <TaxComplianceCentre
          onOpenExpense={(expenseId) => openFinanceTarget('expenses', 'document', expenseId)}
          onOpenPayment={(paymentId) => openFinanceTarget('payment', 'document', paymentId)}
          onOpenJournal={handleOpenJournal}
        />;
      case 'ca_reports':
        return <CAReports
          onOpenJournal={handleOpenJournal}
          onDrillDown={(code) => openFinanceTarget('ledger', 'account', code)}
        />;
      case 'fx_dashboard':
        return (
          <FXBusinessDashboard
            onSwitchToAccountingReport={() => setActiveTab('fx_report')}
            onViewInvoice={(invoiceId) => openFinanceTarget('purchase', 'document', invoiceId)}
            onViewPayment={(paymentId) => openFinanceTarget('payment', 'document', paymentId)}
          />
        );
      case 'fx_report':
        return <FXReport
          onViewInvoice={(invoiceId) => openFinanceTarget('purchase', 'document', invoiceId)}
          onViewJournal={handleOpenJournal}
          onSwitchToCommercialDashboard={() => setActiveTab('fx_dashboard')}
        />;
      case 'integrity_monitor':
        return <IntegrityMonitor />;
      case 'exception_correction':
        return <FinanceExceptionCorrectionDashboard canManage={canManage} />;
      case 'coa':
        return <ChartOfAccountsManager canManage={canManage} />;
      case 'expense_categories':
        return <ExpenseCategoryManager canManage={canManage} />;
      case 'suppliers':
        return <SuppliersManager canManage={canManage} />;
      case 'banks':
        return <BankAccountsManager canManage={canManage} />;
      case 'bpjs_register':
        return <BpjsRegisterManager canManage={canManage} />;
      case 'staff_master':
        return <StaffMasterManager canManage={canManage} />;
      case 'payee_master':
        return <PayeeMasterManager canManage={canManage} />;
      case 'utility_master':
        return <UtilityMasterManager canManage={canManage} />;
      default:
        return <div className="text-center p-8 text-gray-500">{t?.common?.noData || 'No data available'}</div>;
    }
  };

  return (
    <Layout>
      <div className="flex min-h-[calc(100dvh-3.5rem)] bg-gray-50 min-w-0 print:h-auto print:bg-white print:block">
        {/* Left Sidebar - Compact Menu */}
        {!sidebarCollapsed && (
          <div className="fixed inset-0 z-40 bg-black/30 md:hidden print:hidden" onClick={() => setSidebarCollapsed(true)} />
        )}
        {/*
          Sidebar root-cause fix (Priority 7 #5):
          Previously `md:translate-x-0` unconditionally cancelled the collapse
          transform on desktop, so the hamburger did nothing above md. Now the
          collapsed state slides the panel off-screen at every breakpoint and
          shrinks the takeaway width to 0 on desktop so the content pane
          reclaims the space. Persistence + group toggle already work; this
          was the missing piece for the hamburger to be reliably effective.
        */}
        <div
          className={`fixed inset-y-0 left-0 z-50 bg-white border-r border-gray-200 flex flex-col md:relative md:z-auto overflow-hidden transition-[width,transform] duration-300 print:hidden ${
            sidebarCollapsed
              ? '-translate-x-full md:translate-x-0 md:w-0 md:border-r-0 w-40'
              : 'translate-x-0 w-40 md:w-40'
          }`}
        >
            {/* Menu Groups */}
            <div className="flex-1 overflow-y-auto">
              {financeMenu.map((group, groupIdx) => {
                const isCollapsed = collapsedGroups.has(group.label);
                const isCollapsible = group.collapsible;

                return (
                  <div key={group.label} className={groupIdx > 0 ? 'border-t border-gray-200' : ''}>
                    {isCollapsible ? (
                      <button
                        onClick={() => toggleGroup(group.label)}
                        className="w-full px-2 py-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-between hover:bg-gray-100 bg-gray-50/60"
                      >
                        <span>{group.label}</span>
                        {isCollapsed ? (
                          <ChevronRight className="w-3 h-3" />
                        ) : (
                          <ChevronDown className="w-3 h-3" />
                        )}
                      </button>
                    ) : (
                      <div className="px-2 py-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center bg-gray-50/60">
                        {group.label}
                      </div>
                    )}

                    {!isCollapsed && (
                      <div>
                        {group.items.map((item) => (
                          <Link
                            key={item.id}
                            to={`/finance/${FINANCE_ROUTE_BY_TAB[item.id]}${location.search}`}
                            onClick={() => { if (window.innerWidth < 768) setSidebarCollapsed(true); }}
                            className={`relative w-full text-left px-2 py-1.5 text-xs font-medium transition-colors flex items-center ${
                              activeTab === item.id
                                ? 'bg-blue-50 text-blue-600'
                                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                            }`}
                          >
                            {activeTab === item.id && (
                              <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-blue-500 rounded-r" />
                            )}
                            <div className="flex items-center justify-between w-full">
                              <span className="truncate">{item.label}</span>
                              {item.shortcut && (
                                <span className="text-[10px] text-gray-400 ml-1 shrink-0">{item.shortcut}</span>
                              )}
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 min-w-0 flex flex-col print:overflow-visible">
          {/* Slim top strip — hamburger + active sub-tab breadcrumb only */}
          <div className="bg-white border-b border-gray-200 px-2 py-1 flex items-center gap-1.5 min-h-[30px] print:hidden">
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="no-compact p-1 hover:bg-gray-100 rounded transition-colors"
              title={sidebarCollapsed ? 'Show Menu' : 'Hide Menu'}
              aria-label={sidebarCollapsed ? 'Show finance menu' : 'Hide finance menu'}
            >
              {sidebarCollapsed ? <Menu className="w-4 h-4 text-gray-600" /> : <X className="w-4 h-4 text-gray-600" />}
            </button>
            <span className="text-xs font-semibold text-gray-700 truncate">
              {financeMenu.flatMap(g => g.items).find(i => i.id === activeTab)?.label ?? t.finance.title}
            </span>
          </div>

          {/* Content Area — single natural document scroll on mobile/tablet, clean horizontal containment */}
          <div className="flex-1 min-w-0 bg-white print:overflow-visible">
            <div className="finance-ui px-1.5 py-1.5 sm:px-2.5 sm:py-2 print:p-0 min-w-0">
              <Suspense fallback={
                <div className="flex items-center justify-center py-12">
                  <Loader className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              }>
                {renderContent()}
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

export function Finance() {
  return <FinanceContent />;
}
