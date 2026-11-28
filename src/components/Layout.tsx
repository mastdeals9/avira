import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { FALLBACK_COMPANY } from '../types/company';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useFinance } from '../contexts/FinanceContext';
import { NotificationDropdown } from './NotificationDropdown';
import { ApprovalNotifications } from './ApprovalNotifications';
import {
  LayoutDashboard, UsersRound, UserRound, ClipboardCheck, Truck, ReceiptText,
  Package, Boxes, Warehouse, ClipboardList, FileInput, Container, Landmark,
  Calculator, BadgeDollarSign, BarChart3, ListChecks, Zap, Settings,
  LogOut, Menu, X, Globe, Calendar, Search, MoreHorizontal, ChevronRight, FolderArchive,
} from 'lucide-react';
import logo from '../assets/Untitled-1.svg';

export interface Quote {
  content: string;
  author: string;
}

export const fallbackQuotes: Quote[] = [
  { content: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
  { content: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { content: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
  { content: "Excellence is not a skill, it's an attitude.", author: "Ralph Marston" },
  { content: "Quality is not an act, it is a habit.", author: "Aristotle" },
  { content: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese Proverb" },
  { content: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
  { content: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { content: "The future depends on what you do today.", author: "Mahatma Gandhi" },
  { content: "Strive not to be a success, but rather to be of value.", author: "Albert Einstein" },
  { content: "The harder you work for something, the greater you'll feel when you achieve it.", author: "Unknown" },
  { content: "Dream bigger. Do bigger.", author: "Unknown" },
  { content: "Don't stop when you're tired. Stop when you're done.", author: "Unknown" },
  { content: "Wake up with determination. Go to bed with satisfaction.", author: "Unknown" },
  { content: "Do something today that your future self will thank you for.", author: "Sean Patrick Flanery" },
  { content: "Little things make big days.", author: "Unknown" },
  { content: "It's going to be hard, but hard does not mean impossible.", author: "Unknown" },
  { content: "Don't wait for opportunity. Create it.", author: "Unknown" },
  { content: "Sometimes we're tested not to show our weaknesses, but to discover our strengths.", author: "Unknown" },
  { content: "The key to success is to focus on goals, not obstacles.", author: "Unknown" },
  { content: "Dream it. Believe it. Build it.", author: "Unknown" },
  { content: "Success doesn't just find you. You have to go out and get it.", author: "Unknown" },
  { content: "Great things never come from comfort zones.", author: "Unknown" },
  { content: "Opportunities don't happen. You create them.", author: "Chris Grosser" },
  { content: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { content: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
  { content: "Action is the foundational key to all success.", author: "Pablo Picasso" },
  { content: "Your limitation—it's only your imagination.", author: "Unknown" },
  { content: "Push yourself, because no one else is going to do it for you.", author: "Unknown" },
  { content: "Sometimes later becomes never. Do it now.", author: "Unknown" },
];

export const getRandomFallbackQuote = (): Quote => {
  const randomIndex = Math.floor(Math.random() * fallbackQuotes.length);
  return fallbackQuotes[randomIndex];
};

interface LayoutProps {
  children: React.ReactNode;
}

interface MenuItem {
  id: string;
  label: string;
  icon: React.ElementType;
  path?: string;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
}

// Tooltip for collapsed sidebar
function NavTooltip({ label }: { label: string }) {
  return (
    <span className="absolute left-full ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-[60]">
      {label}
    </span>
  );
}

export function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const [currentCompanyName, setCurrentCompanyName] = useState(FALLBACK_COMPANY.company_name);
  const [setupMode, setSetupMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ kind: string; id: string; label: string; detail: string; page: string }>>([]);
  const [searching, setSearching] = useState(false);
  const datePickerRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { profile, accessibleModules, signOut } = useAuth();
  const { language, setLanguage, t } = useLanguage();
  const { currentPage, setCurrentPage, setNavigationData, sidebarCollapsed, setSidebarCollapsed } = useNavigation();
  const { dateRange, setDateRange, activePreset, applyPreset } = useFinance();

  useEffect(() => {
    supabase
      .from('company_profiles')
      .select('company_name')
      .lte('effective_from', new Date().toISOString().split('T')[0])
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data?.company_name) setCurrentCompanyName(data.company_name); });

    // Setup Mode banner — read once per session; refreshes on page reload.
    // The flag lives on app_settings and is fully server-authoritative;
    // this state is UX-only so users see the banner while they navigate.
    supabase
      .from('app_settings')
      .select('setup_mode')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data) setSetupMode(Boolean((data as { setup_mode?: boolean }).setup_mode)); });
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  useEffect(() => {
    const term = searchTerm.trim();
    if (term.length < 2) { setSearchResults([]); return; }
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const pattern = `%${term}%`;
      const [invoices, orders, challans, customers, batches, purchases] = await Promise.all([
        supabase.from('sales_invoices').select('id, invoice_number, customer_id, customers(company_name)').ilike('invoice_number', pattern).limit(8),
        supabase.from('sales_orders').select('id, so_number, customer_id, customers(company_name)').ilike('so_number', pattern).limit(8),
        supabase.from('delivery_challans').select('id, challan_number, customer_id, customers(company_name)').ilike('challan_number', pattern).limit(8),
        supabase.from('customers').select('id, company_name').ilike('company_name', pattern).limit(8),
        supabase.from('batches').select('id, batch_number, product_id, products(product_name)').ilike('batch_number', pattern).limit(8),
        supabase.from('purchase_invoices').select('id, invoice_number, supplier_id, suppliers(company_name)').ilike('invoice_number', pattern).limit(8),
      ]);
      const customerName = (row: any) => Array.isArray(row.customers) ? row.customers[0]?.company_name : row.customers?.company_name;
      setSearchResults([
        ...(invoices.data || []).map((r: any) => ({ kind: 'Invoice', id: r.id, label: r.invoice_number, detail: customerName(r) || '', page: 'sales' })),
        ...(orders.data || []).map((r: any) => ({ kind: 'Sales Order', id: r.id, label: r.so_number, detail: customerName(r) || '', page: 'sales-orders' })),
        ...(challans.data || []).map((r: any) => ({ kind: 'Delivery Challan', id: r.id, label: r.challan_number, detail: customerName(r) || '', page: 'delivery-challan' })),
        ...(customers.data || []).map((r: any) => ({ kind: 'Customer', id: r.id, label: r.company_name, detail: '', page: 'customers' })),
        ...(batches.data || []).map((r: any) => ({ kind: 'Batch', id: r.id, label: r.batch_number, detail: Array.isArray(r.products) ? r.products[0]?.product_name || '' : r.products?.product_name || '', page: 'batches' })),
        ...(purchases.data || []).map((r: any) => ({ kind: 'Purchase Invoice', id: r.id, label: r.invoice_number, detail: Array.isArray(r.suppliers) ? r.suppliers[0]?.company_name || '' : r.suppliers?.company_name || '', page: 'finance' })),
      ].slice(0, 30));
      setSearching(false);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (datePickerRef.current && !datePickerRef.current.contains(e.target as Node)) {
        setDatePickerOpen(false);
      }
    };
    if (datePickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [datePickerOpen]);

  // Viewport breakpoint classification & responsive auto-collapse
  // >= 1440px: Expanded allowed (default expanded)
  // Auto collapse/expand based on page route and viewport:
  // - Large desktop (>=1440px) on Dashboard = sidebar OPEN / full menu
  // - Compact laptop (1024-1439px) or non-Dashboard routes = sidebar COLLAPSED / icon-only
  useEffect(() => {
    if (currentPage === 'dashboard' && (typeof window === 'undefined' || window.innerWidth >= 1440)) {
      setSidebarCollapsed(false);
    } else {
      setSidebarCollapsed(true);
    }
  }, [currentPage, setSidebarCollapsed]);

  // Close mobile drawer on desktop resize
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 1024) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleToggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
    setHoverExpanded(false);
  };

  const isCollapsed = sidebarCollapsed && !hoverExpanded;

  const handleSidebarMouseEnter = () => {
    if (!sidebarCollapsed) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoverExpanded(true), 80);
  };

  const handleSidebarMouseLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoverExpanded(false), 120);
  };

  // Module-level menu items with semantic Lucide icons matching user specification
  const allItems: MenuItem[] = [
    { id: 'dashboard',           label: t('nav.dashboard'),           icon: LayoutDashboard },
    { id: 'crm',                 label: t('nav.crm'),                  icon: UsersRound },
    { id: 'customers',           label: t('nav.customers'),            icon: UserRound },
    { id: 'document-bank',       label: t('nav.documentBank', 'Document Bank'), icon: FolderArchive },
    { id: 'sales-orders',        label: t('nav.salesOrders'),          icon: ClipboardCheck },
    { id: 'delivery-challan',    label: t('nav.deliveryChallan'),      icon: Truck },
    { id: 'sales',               label: t('nav.sales'),                icon: ReceiptText },
    { id: 'products',            label: t('nav.products'),             icon: Package },
    { id: 'batches',             label: t('nav.batches'),              icon: Boxes },
    { id: 'stock',               label: t('nav.stock'),                icon: Warehouse },
    { id: 'inventory',           label: t('nav.inventory'),            icon: Warehouse },
    { id: 'purchase-orders',     label: t('nav.purchaseOrders'),       icon: ClipboardList },
    { id: 'import-requirements', label: t('nav.importRequirements'),   icon: FileInput },
    { id: 'import-containers',   label: t('nav.importContainers'),     icon: Container },
    { id: 'finance',             label: t('nav.finance'),              icon: Landmark },
    { id: 'price-calculator',    label: t('nav.priceCalculator', 'Price Calculator'),   icon: Calculator },
    { id: 'pricing-dashboard',   label: t('nav.pricingOverview', 'Pricing Overview'),   icon: BadgeDollarSign },
    { id: 'reports',             label: t('nav.reports', 'Reports'),                    icon: BarChart3 },
    { id: 'tasks',               label: t('nav.tasks'),                icon: ListChecks },
    { id: 'command-center',      label: t('nav.commandCenter'),        icon: Zap },
    { id: 'settings',            label: t('nav.settings'),             icon: Settings },
  ];

  const groups: MenuGroup[] = [
    { label: t('nav.groupMain', 'Main'),           items: allItems.filter(i => ['dashboard', 'crm', 'customers', 'document-bank'].includes(i.id)) },
    { label: t('nav.groupSales', 'Sales'),         items: allItems.filter(i => ['sales-orders', 'delivery-challan', 'sales'].includes(i.id)) },
    { label: t('nav.groupStock', 'Stock'),         items: allItems.filter(i => ['products', 'batches', 'stock'].includes(i.id)) },
    { label: t('nav.groupPurchases', 'Purchases'), items: allItems.filter(i => ['purchase-orders', 'import-requirements', 'import-containers'].includes(i.id)) },
    { label: t('nav.groupFinance', 'Finance'),     items: allItems.filter(i => ['finance', 'price-calculator'].includes(i.id)) },
    { label: t('nav.groupPricing', 'Pricing'),     items: allItems.filter(i => ['pricing-dashboard'].includes(i.id)) },
    { label: t('nav.groupReports', 'Reports'),     items: allItems.filter(i => ['reports'].includes(i.id)) },
    { label: t('nav.groupSystem', 'System'),       items: allItems.filter(i => ['tasks', 'command-center', 'settings'].includes(i.id)) },
  ];

  // Helper: check if a module is accessible. For Finance, if user has finance OR granular purchase-invoices OR tax-compliance,
  // expose parent Finance module in the global sidebar while keeping internal section access governed inside Finance.
  const isItemAccessible = (itemId: string) => {
    if (itemId === 'finance') {
      return (
        accessibleModules.has('finance') ||
        accessibleModules.has('purchase-invoices') ||
        accessibleModules.has('tax-compliance')
      );
    }
    return accessibleModules.has(itemId);
  };

  const currentItem = allItems.find(i => i.id === currentPage);
  const currentPageTitle = currentItem?.label || (currentPage ? currentPage.charAt(0).toUpperCase() + currentPage.slice(1).replace(/-/g, ' ') : 'Dashboard');

  const toggleLanguage = () => {
    setLanguage(language === 'en' ? 'id' : 'en');
  };

  const showDateRange = !['dashboard', 'crm', 'command-center', 'settings'].includes(currentPage);

  const navigate = (id: string) => {
    setCurrentPage(id);
    setSidebarOpen(false);
    setHoverExpanded(false);
  };

  const mainPadding = sidebarCollapsed ? 'lg:pl-16' : 'lg:pl-[200px]';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Setup Mode banner */}
      {setupMode && (
        <div className="sticky top-0 z-40 bg-amber-500 text-white text-xs md:text-sm px-4 py-1.5 text-center font-medium shadow">
          <span className="uppercase tracking-wide mr-2">Setup Mode Enabled</span>
          <span className="hidden md:inline text-amber-50 font-normal">
            Historical protections are temporarily disabled while the ERP is being configured. Switch back to Production Mode in Settings before going live.
          </span>
        </div>
      )}

      {/* Mobile Drawer Backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-xs z-50 lg:hidden transition-opacity duration-300"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile Slide-Over Navigation Drawer */}
      <aside
        className={`fixed top-0 left-0 bottom-0 z-50 w-[280px] max-w-[82vw] bg-white flex flex-col shadow-2xl
          transform transition-transform duration-300 ease-out lg:hidden print:hidden
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
        aria-label="Mobile Navigation Drawer"
      >
        {/* Mobile Drawer Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50/80 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <img src={logo} alt="SAPJ Logo" className="w-6 h-6 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-gray-900 truncate leading-tight">{currentCompanyName}</p>
              <span className="text-[10px] font-semibold text-blue-600 uppercase tracking-wider">SAPJ ERP</span>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="no-compact w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-200/70 text-gray-600 transition-colors"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mobile Drawer Nav Groups */}
        <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-2 overscroll-contain">
          {groups.map((group) => {
            const visibleItems = group.items.filter(item => isItemAccessible(item.id));
            if (visibleItems.length === 0) return null;

            return (
              <div key={group.label} className="space-y-0.5">
                <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {visibleItems.map(item => {
                    const Icon = item.icon;
                    const isActive = currentPage === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => navigate((item.path ?? `/${item.id}`).replace(/^\//, ''))}
                        className={`no-compact w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors min-h-[38px]
                          ${isActive
                            ? 'bg-blue-50 text-blue-700 font-semibold'
                            : 'text-gray-700 hover:bg-gray-100 font-medium'
                          }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-blue-600' : 'text-gray-500'}`} strokeWidth={isActive ? 2 : 1.75} />
                          <span className="text-[13px] leading-tight truncate">{item.label}</span>
                        </div>
                        {isActive ? (
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Mobile Drawer User Footer */}
        {profile && (
          <div className="border-t border-gray-200 bg-gray-50/80 px-3 py-2 flex flex-col gap-1.5 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-bold text-gray-900 truncate">{profile.full_name || profile.username}</p>
                <p className="text-[11px] text-gray-500 capitalize">{profile.role}</p>
              </div>
              <button
                onClick={toggleLanguage}
                className="no-compact flex items-center gap-1 px-2 py-1 rounded-md border border-gray-200 bg-white text-[11px] font-semibold text-gray-700 uppercase shrink-0"
                title="Change language"
              >
                <Globe className="w-3.5 h-3.5 text-gray-500" />
                <span>{language}</span>
              </button>
            </div>
            <button
              onClick={() => signOut()}
              className="no-compact w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 text-xs font-medium transition-colors min-h-[36px]"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{t('auth.logout')}</span>
            </button>
          </div>
        )}
      </aside>

      {/* Desktop Compact / Responsive Sidebar */}
      <aside
        ref={sidebarRef}
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
        className={`hidden lg:flex fixed top-0 left-0 z-30 h-full bg-white border-r border-gray-200 flex-col print:hidden
          transform transition-[width] duration-200 ease-in-out
          ${isCollapsed ? 'w-16' : 'w-[200px]'}
          ${hoverExpanded ? 'shadow-xl ring-1 ring-black/5 z-30' : ''}`}
      >
        {/* Company header */}
        <div className={`flex items-center border-b border-gray-200 flex-shrink-0 ${isCollapsed ? 'justify-center px-2 py-2' : 'gap-1.5 px-2.5 py-2'}`} style={{ minHeight: 48 }}>
          <button
            type="button"
            onClick={() => navigate('dashboard')}
            className="flex flex-shrink-0 items-center rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Dashboard"
            aria-label="Go to Dashboard"
          >
            <img src={logo} alt="Logo" className="flex-shrink-0" style={{ width: 28, height: 28 }} />
          </button>
          {!isCollapsed && (
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-gray-900 truncate leading-tight">{currentCompanyName}</p>
            </div>
          )}
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-0.5">
          {groups.map((group, gi) => {
            const visibleItems = group.items.filter(item => isItemAccessible(item.id));
            if (visibleItems.length === 0) return null;

            return (
              <div key={group.label} className={gi > 0 ? 'mt-px' : ''}>
                {/* Group label — hidden when collapsed */}
                {!isCollapsed && (
                  <p className="px-2.5 pt-1 pb-px text-[9px] font-semibold text-gray-400 uppercase tracking-wider">
                    {group.label}
                  </p>
                )}
                {/* Collapsed: tiny gap line between groups */}
                {isCollapsed && gi > 0 && (
                  <div className="mx-2.5 my-px border-t border-gray-100" />
                )}

                <div className="px-1.5">
                  {visibleItems.map(item => {
                    const Icon = item.icon;
                    const isActive = currentPage === item.id;
                    return (
                      <a
                        key={item.id}
                        href={item.path ?? `/${item.id}`}
                        onClick={e => { e.preventDefault(); navigate((item.path ?? `/${item.id}`).replace(/^\//, '')); }}
                        className={`relative group flex items-center rounded-md transition-colors duration-100
                          ${isCollapsed ? 'justify-center px-0' : 'gap-2 px-2'}
                          ${isActive
                            ? 'bg-blue-50 text-blue-600'
                            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                          }`}
                        style={{ height: 28 }}
                      >
                        {/* Active left bar */}
                        {isActive && (
                          <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-blue-500 rounded-r" />
                        )}
                        <Icon className="flex-shrink-0" style={{ width: 15, height: 15 }} strokeWidth={isActive ? 2 : 1.75} />
                        {!isCollapsed && (
                          <span className="text-xs font-medium truncate">{item.label}</span>
                        )}
                        {/* Tooltip — only when truly collapsed (not hover-expanded) */}
                        {sidebarCollapsed && !hoverExpanded && (
                          <NavTooltip label={item.label} />
                        )}
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* User footer */}
        {!isCollapsed && profile && (
          <div className="flex-shrink-0 border-t border-gray-200 px-2.5 py-1.5">
            <p className="text-xs font-medium text-gray-700 truncate">{profile.full_name || profile.username}</p>
            <p className="text-[11px] text-gray-400 capitalize truncate">{profile.role}</p>
          </div>
        )}
      </aside>

      {/* Main content */}
      <div className={`flex-1 flex flex-col transition-[padding] duration-200 ${mainPadding} min-w-0 max-w-full overflow-x-hidden print:pl-0 print:overflow-visible`}>
        <header className="bg-white border-b border-gray-200 sticky top-0 z-20 print:hidden">
          <div className="flex items-center justify-between gap-2 px-2 sm:px-3 py-1 min-h-[44px]">
            {/* Left Controls & Page Header */}
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              {/* Mobile menu button */}
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="no-compact lg:hidden w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 active:bg-gray-200 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 shrink-0"
                title="Open menu"
                aria-label="Open navigation menu"
              >
                <Menu className="w-5 h-5" />
              </button>

              {/* Desktop toggle button */}
              <button
                type="button"
                onClick={handleToggleSidebar}
                className="hidden lg:flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!sidebarCollapsed}
              >
                <Menu className="w-4 h-4" />
              </button>

              {/* Mobile Branding & Active Module Badge */}
              <div className="lg:hidden flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => navigate('dashboard')}
                  className="flex items-center focus:outline-none"
                  aria-label="SAPJ Home"
                >
                  <img src={logo} alt="SAPJ" className="w-6 h-6 flex-shrink-0" />
                </button>
                <div className="h-4 w-px bg-gray-200" />
                <span className="text-xs font-bold text-gray-900 bg-gray-100/90 px-2 py-0.5 rounded-md truncate max-w-[130px] sm:max-w-[200px]">
                  {currentPageTitle}
                </span>
              </div>
            </div>

            {/* Desktop date range with quick presets */}
            <div className={`flex-1 hidden md:flex items-center justify-center px-2 ${!showDateRange ? 'invisible' : ''}`} aria-hidden={!showDateRange}>
              {showDateRange && (
                <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-lg p-1">
                  <div className="flex items-center gap-1 mr-1">
                    <button
                      type="button"
                      onClick={() => applyPreset('1M')}
                      className={`px-2 py-0.5 text-xs font-semibold rounded transition ${
                        activePreset === '1M'
                          ? 'bg-blue-600 text-white shadow-2xs'
                          : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
                      }`}
                      title="Last 1 Month (Rolling Calendar Month)"
                    >
                      1M
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('2M')}
                      className={`px-2 py-0.5 text-xs font-semibold rounded transition ${
                        activePreset === '2M'
                          ? 'bg-blue-600 text-white shadow-2xs'
                          : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
                      }`}
                      title="Last 2 Months (Extended Operational Range)"
                    >
                      2M
                    </button>
                  </div>
                  <Calendar className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <input
                    name="date_range"
                    aria-label="Date Range"
                    type="date"
                    value={dateRange.startDate}
                    onChange={(e) => setDateRange({ ...dateRange, startDate: e.target.value })}
                    className="px-1.5 py-0.5 text-xs border border-gray-200 rounded bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 font-mono"
                  />
                  <span className="text-xs text-gray-400">to</span>
                  <input
                    name="date_range"
                    aria-label="Date Range"
                    type="date"
                    value={dateRange.endDate}
                    onChange={(e) => setDateRange({ ...dateRange, endDate: e.target.value })}
                    className="px-1.5 py-0.5 text-xs border border-gray-200 rounded bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 font-mono"
                  />
                </div>
              )}
            </div>

            {/* Mobile date range toggle */}
            <div className={`md:hidden relative ${!showDateRange ? 'invisible' : ''}`} ref={datePickerRef} aria-hidden={!showDateRange}>
              {showDateRange && (
                <button
                  onClick={() => setDatePickerOpen(!datePickerOpen)}
                  className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600 focus:outline-none"
                  aria-label="Toggle date filter"
                >
                  <Calendar className="w-4 h-4" />
                </button>
              )}
              {showDateRange && datePickerOpen && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg p-3 z-50 w-72">
                  <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-800">Date Range Filter</p>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => applyPreset('1M')}
                        className={`px-2 py-0.5 text-[11px] font-semibold rounded ${
                          activePreset === '1M'
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        1 Month
                      </button>
                      <button
                        type="button"
                        onClick={() => applyPreset('2M')}
                        className={`px-2 py-0.5 text-[11px] font-semibold rounded ${
                          activePreset === '2M'
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        2 Months
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <label className="text-[11px] font-medium text-gray-500">From Date</label>
                      <input
                        name="from"
                        aria-label="From"
                        type="date"
                        value={dateRange.startDate}
                        onChange={(e) => setDateRange({ ...dateRange, startDate: e.target.value })}
                        className="w-full mt-0.5 px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:ring-1 focus:ring-blue-500 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-gray-500">To Date</label>
                      <input
                        name="to"
                        aria-label="To"
                        type="date"
                        value={dateRange.endDate}
                        onChange={(e) => setDateRange({ ...dateRange, endDate: e.target.value })}
                        className="w-full mt-0.5 px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:ring-1 focus:ring-blue-500 font-mono"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => setDatePickerOpen(false)}
                    className="mt-2.5 w-full text-xs font-semibold bg-blue-600 text-white py-1.5 rounded-lg hover:bg-blue-700 transition"
                  >
                    Apply Filter
                  </button>
                </div>
              )}
            </div>

            {/* Header Right Actions */}
            <div className="flex items-center gap-1 shrink-0">
              {/* Mobile Search Button */}
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="no-compact sm:hidden w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600"
                title="Search"
                aria-label="Search"
              >
                <Search className="w-4 h-4" />
              </button>

              {/* Desktop Search Button (condensed on compact laptop/tablet) */}
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="hidden sm:flex items-center gap-1 px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 text-xs"
                title="Search (Ctrl/Cmd+K)"
              >
                <Search className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">Search</span>
                <kbd className="hidden 2xl:inline text-[10px] bg-gray-100 px-1 rounded">⌘K</kbd>
              </button>

              <ApprovalNotifications variant="topbar" />

              <NotificationDropdown />

              <button
                type="button"
                onClick={toggleLanguage}
                className="no-compact flex items-center gap-1 px-1.5 sm:px-2 py-1 rounded hover:bg-gray-100 text-gray-700 min-h-[34px]"
                title="Toggle language"
                aria-label="Toggle language"
              >
                <Globe className="w-3.5 h-3.5 text-gray-600" />
                <span className="text-xs font-semibold uppercase">{language}</span>
              </button>

              <button
                type="button"
                onClick={() => signOut()}
                className="hidden sm:flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 text-gray-700"
                title={t('auth.logout')}
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden xl:inline text-xs font-medium">{t('auth.logout')}</span>
              </button>
            </div>
          </div>
        </header>

        {/* Content Area — extra bottom padding on <lg clears the fixed bottom nav + iOS safe area */}
        <main className="flex-1 min-w-0 p-2 sm:p-2.5 xl:p-3 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] lg:pb-3 max-w-full overflow-x-clip print:p-0 print:overflow-visible">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation Shortcut Layer */}
      <nav
        aria-label="Mobile Navigation"
        className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-gray-200 px-1 py-0.5 flex items-center justify-around shadow-[0_-2px_10px_rgba(0,0,0,0.06)] lg:hidden print:hidden"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 4px)' }}
      >
        {/* 1. HOME */}
        <button
          type="button"
          onClick={() => navigate('dashboard')}
          className={`no-compact flex-1 min-w-0 flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[42px]
            ${currentPage === 'dashboard' ? 'text-blue-600 font-semibold' : 'text-gray-500 hover:text-gray-900 font-medium'}`}
        >
          <LayoutDashboard className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" strokeWidth={currentPage === 'dashboard' ? 2 : 1.75} />
          <span className="text-[10px] mt-0.5 truncate tracking-tight">{t('nav.home', 'Home')}</span>
        </button>

        {/* 2. CRM */}
        <button
          type="button"
          onClick={() => navigate('crm')}
          className={`no-compact flex-1 min-w-0 flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[42px]
            ${['crm', 'customers'].includes(currentPage) ? 'text-blue-600 font-semibold' : 'text-gray-500 hover:text-gray-900 font-medium'}`}
        >
          <UsersRound className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" strokeWidth={['crm', 'customers'].includes(currentPage) ? 2 : 1.75} />
          <span className="text-[10px] mt-0.5 truncate tracking-tight">{t('nav.crm', 'CRM')}</span>
        </button>

        {/* 3. SALES */}
        <button
          type="button"
          onClick={() => navigate('sales')}
          className={`no-compact flex-1 min-w-0 flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[42px]
            ${['sales', 'sales-orders', 'delivery-challan'].includes(currentPage) ? 'text-blue-600 font-semibold' : 'text-gray-500 hover:text-gray-900 font-medium'}`}
        >
          <ReceiptText className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" strokeWidth={['sales', 'sales-orders', 'delivery-challan'].includes(currentPage) ? 2 : 1.75} />
          <span className="text-[10px] mt-0.5 truncate tracking-tight">{t('nav.sales', 'Sales')}</span>
        </button>

        {/* 4. STOCK */}
        <button
          type="button"
          onClick={() => navigate('stock')}
          className={`no-compact flex-1 min-w-0 flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[42px]
            ${['stock', 'products', 'batches', 'inventory'].includes(currentPage) ? 'text-blue-600 font-semibold' : 'text-gray-500 hover:text-gray-900 font-medium'}`}
        >
          <Warehouse className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" strokeWidth={['stock', 'products', 'batches', 'inventory'].includes(currentPage) ? 2 : 1.75} />
          <span className="text-[10px] mt-0.5 truncate tracking-tight">{t('nav.stock', 'Stock')}</span>
        </button>

        {/* 5. MORE */}
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className={`no-compact flex-1 min-w-0 flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[42px]
            ${sidebarOpen ? 'text-blue-600 font-semibold' : 'text-gray-500 hover:text-gray-900 font-medium'}`}
        >
          <MoreHorizontal className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" strokeWidth={1.75} />
          <span className="text-[10px] mt-0.5 truncate tracking-tight">{t('common.more', 'More')}</span>
        </button>
      </nav>

      {searchOpen && (
        <div className="fixed inset-0 z-[70] bg-black/30 flex items-start justify-center pt-[12vh] px-4" onMouseDown={() => setSearchOpen(false)}>
          <div className="w-full max-w-xl bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden" onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-3 py-2 border-b">
              <Search className="w-4 h-4 text-gray-400" />
              <input name="search_term" aria-label="Search" autoFocus value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder={t('common.searchPlaceholder', 'Search invoices, SOs, DCs, customers, batches…')} className="flex-1 outline-none text-sm" />
              <button onClick={() => setSearchOpen(false)} className="text-xs text-gray-400">{t('common.close', 'Esc')}</button>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {searching && <p className="px-3 py-4 text-sm text-gray-500">{t('common.searching', 'Searching…')}</p>}
              {!searching && searchTerm.trim().length >= 2 && searchResults.length === 0 && <p className="px-3 py-4 text-sm text-gray-500">{t('common.noResults', 'No matching documents found.')}</p>}
              {searchResults.map(result => (
                <button key={`${result.kind}-${result.id}`} className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b last:border-0" onClick={() => {
                  if (result.kind === 'Invoice') setNavigationData({ sourceType: 'sales_invoice', invoiceId: result.id });
                  if (result.kind === 'Sales Order') setNavigationData({ salesOrderId: result.id });
                  if (result.kind === 'Delivery Challan') setNavigationData({ challanId: result.id });
                  setCurrentPage(result.page);
                  setSearchOpen(false); setSearchTerm('');
                }}>
                  <span className="text-[10px] uppercase tracking-wide text-blue-600">{result.kind}</span>
                  <span className="block text-sm font-medium text-gray-900">{result.label}</span>
                  {result.detail && <span className="block text-xs text-gray-500">{result.detail}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
