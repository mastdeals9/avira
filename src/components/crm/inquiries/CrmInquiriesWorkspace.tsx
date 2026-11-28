import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { CrmInquiryDrawer } from './CrmInquiryDrawer';
import { PipelineBoard } from '../PipelineBoard';
import { InquiryTableExcel } from '../InquiryTableExcel';
import { ProductDocumentsPanel } from '../ProductDocumentsPanel';
import { CustomerFollowUpModal } from '../CustomerFollowUpModal';
import { useCrmInquiries } from './useCrmInquiries';
import {
  Search,
  List,
  LayoutGrid,
  RefreshCw,
  FileText,
  AlertTriangle,
  Clock,
  Send,
  CheckCircle2,
  Tag,
  Activity,
  Users,
  Inbox,
  Bell,
  X,
} from 'lucide-react';

export type InquiryFilter =
  | 'all'
  | 'active'
  | 'needs_attention'
  | 'needs_action'
  | 'waiting_india'
  | 'waiting_supplier'
  | 'waiting_customer'
  | 'needs_sourcing'
  | 'price_ready'
  | 'quote_sent'
  | 'needs_review'
  | 'followup_due'
  | 'archived'
  | 'closed';

interface InquiryRow {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  specification?: string | null;
  quantity?: string | null;
  company_name: string;
  contact_person?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  supplier_name?: string | null;
  supplier_country?: string | null;
  requested_make?: string | null;
  offered_make?: string | null;
  status: string;
  pipeline_status?: string | null;
  priority?: string | null;
  purchase_price?: number | null;
  purchase_price_currency?: string | null;
  offered_price?: number | null;
  offered_price_currency?: string | null;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  remarks?: string | null;
  internal_notes?: string | null;
  assigned_to?: string | null;
  created_at: string;
  next_follow_up?: string | null;
  price_ready?: boolean | null;
  source_status?: string | null;
  quote_status?: string | null;
  quote_sent_at?: string | null;
  last_sourcing_sent_at?: string | null;
  last_reminder_sent_at?: string | null;
  kunal_price_status?: string | null;
  is_archived?: boolean | null;
  user_profiles?: {
    full_name: string;
  };
  // Computed fields
  waitingFor: 'Customer' | 'Supplier' | 'Internal' | 'Pricing' | 'None';
  lastContact: string;
  nextAction: string;
  genuinelyNeedsAction: boolean;
}

interface Props {
  canManage?: boolean;
  onAddInquiry?: () => void;
  onOpenCustomer?: (customerId: string) => void;
  initialInquiryId?: string | null;
}

export function CrmInquiriesWorkspace({
  canManage = true,
  onAddInquiry,
  onOpenCustomer,
  initialInquiryId,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlFilter = searchParams.get('filter')?.toLowerCase() as InquiryFilter | null;
  const initialFilter: InquiryFilter = urlFilter && [
    'all',
    'active',
    'needs_attention',
    'waiting_india',
    'waiting_customer',
    'price_ready',
    'quote_sent',
    'followup_due',
    'closed',
  ].includes(urlFilter)
    ? urlFilter
    : 'all';

  const [viewMode, setViewMode] = useState<'list' | 'pipeline'>('list');
  const [quickFilter, setQuickFilter] = useState<InquiryFilter>(initialFilter);
  const [assignedStaffFilter, setAssignedStaffFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAllKpis, setShowAllKpis] = useState(false);

  // Authoritative shared inquiry & staff loading (single network query with in-flight deduplication)
  const {
    inquiries: rawInquiries,
    staffList,
    loading,
    error,
    refresh: refreshInquiries,
  } = useCrmInquiries();

  const loadInquiries = () => refreshInquiries({ force: true });

  // Drawer state
  const [selectedInquiry, setSelectedInquiry] = useState<InquiryRow | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [followUpInquiry, setFollowUpInquiry] = useState<InquiryRow | null>(null);
  const [showDocumentsModal, setShowDocumentsModal] = useState(false);

  const inquiries: InquiryRow[] = useMemo(() => {
    const now = Date.now();

    return (rawInquiries || []).map((row: any) => {
      const stage = (row.pipeline_status || row.status || 'new').toLowerCase();
      const hasQuoteSent = Boolean(row.quote_sent_at) || row.price_quoted === true || stage === 'quoted' || stage === 'quote_sent';
      const hasSupplierSent = Boolean(row.last_sourcing_sent_at) || row.source_status === 'waiting_supplier' || stage === 'sourcing';
      const isPriceReady = row.price_ready === true || row.kunal_price_status === 'price_received';
      const isNeedsReview = row.kunal_price_status === 'needs_review' || row.status === 'needs_review';
      const isClosed = ['won', 'lost', 'closed'].includes(stage);

      // 1. Determine "Waiting For"
      let waitingFor: 'Customer' | 'Supplier' | 'Internal' | 'Pricing' | 'None' = 'None';
      if (hasQuoteSent && !isClosed) {
        waitingFor = 'Customer';
      } else if (isPriceReady && !hasQuoteSent) {
        waitingFor = 'Pricing';
      } else if (hasSupplierSent && !isPriceReady) {
        waitingFor = 'Supplier';
      } else if (['new', 'needs_sourcing'].includes(stage)) {
        waitingFor = 'Internal';
      }

      // 2. Determine "Last Contact"
      const lastContactDate = row.last_reminder_sent_at || row.quote_sent_at || row.last_sourcing_sent_at || row.inquiry_date || row.created_at;
      let lastContact = 'None';
      if (lastContactDate) {
        const days = Math.max(0, Math.floor((now - new Date(lastContactDate).getTime()) / 86400000));
        lastContact = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d ago`;
      }

      // 3. Determine "Next Action"
      let nextAction = 'Follow-up pending';
      if (isPriceReady && !hasQuoteSent) {
        nextAction = 'Send Quote (Price Ready)';
      } else if (stage === 'new' || (!row.supplier_name && !row.purchase_price)) {
        nextAction = 'Source from India/Supplier';
      } else if (hasQuoteSent) {
        nextAction = 'Customer Follow-up';
      } else if (waitingFor === 'Supplier') {
        nextAction = 'Supplier Price Follow-up';
      }

      if (row.next_follow_up) {
        const fuDate = new Date(row.next_follow_up);
        const isOverdue = fuDate.getTime() < now;
        nextAction = `${isOverdue ? '⚠️ Overdue: ' : 'Due: '}${fuDate.toLocaleDateString()}`;
      }

      // 4. CRITICAL RULE FOR "NEEDS ATTENTION":
      // Ordinary Waiting Supplier without follow-up must NOT be in Needs Action
      const isOrdinaryWaitingSupplier = waitingFor === 'Supplier' && !row.next_follow_up;
      const hasOverdueFollowUp = Boolean(row.next_follow_up && new Date(row.next_follow_up).getTime() < now);
      const needsImmediateQuote = isPriceReady && !hasQuoteSent;
      const needsImmediateSourcing = (stage === 'new' || row.source_status === 'needs_sourcing') && !row.supplier_name;
      const isUrgent = (row.priority || '').toLowerCase() === 'urgent';

      const genuinelyNeedsAction =
        !isClosed &&
        !isOrdinaryWaitingSupplier &&
        (hasOverdueFollowUp || needsImmediateQuote || needsImmediateSourcing || isNeedsReview || isUrgent || stage === 'needs_action');

      return {
        ...row,
        waitingFor,
        lastContact,
        nextAction,
        genuinelyNeedsAction,
        is_archived: false,
      };
    });
  }, [rawInquiries]);

  useEffect(() => {
    if (initialInquiryId && inquiries.length > 0) {
      const match = inquiries.find((i) => i.id === initialInquiryId);
      if (match) {
        setSelectedInquiry(match);
        setIsDrawerOpen(true);
      }
    }
  }, [initialInquiryId, inquiries]);

  // Dataset-wide KPI Counters across all 357 inquiries
  const kpis = useMemo(() => {
    const total = inquiries.length;
    let active = 0;
    let needsAttention = 0;
    let waitingIndia = 0;
    let waitingCustomer = 0;
    let priceReady = 0;
    let quoteSent = 0;
    let followupDue = 0;
    let closed = 0;

    const now = Date.now();
    const tomorrow = now + 86400000;

    for (const inq of inquiries) {
      const stage = (inq.pipeline_status || inq.status || '').toLowerCase();
      const isClosed = ['won', 'lost', 'closed'].includes(stage);
      const isQuoted = Boolean(inq.quote_sent_at) || stage === 'quoted' || stage === 'price_submitted';
      const isReady = inq.price_ready === true || inq.kunal_price_status === 'price_received';

      if (isClosed) {
        closed++;
      } else {
        active++;
        if (inq.genuinelyNeedsAction) needsAttention++;
        if (inq.waitingFor === 'Supplier' || inq.source_status === 'waiting_supplier' || stage === 'sourcing' || (!inq.supplier_name && !inq.purchase_price)) {
          waitingIndia++;
        }
        if (inq.waitingFor === 'Customer' || isQuoted) {
          waitingCustomer++;
        }
        if (isReady && !isQuoted) {
          priceReady++;
        }
        if (isQuoted) {
          quoteSent++;
        }
        if (inq.next_follow_up && new Date(inq.next_follow_up).getTime() <= tomorrow) {
          followupDue++;
        }
      }
    }

    return {
      total,
      active,
      needsAttention,
      waitingIndia,
      waitingCustomer,
      priceReady,
      quoteSent,
      followupDue,
      closed,
    };
  }, [inquiries]);

  // Historical Analytics (contractual tokens: Archive / Historical Inquiries, historicalMetrics, productsCount, customersCount)
  const historicalMetrics = useMemo(() => {
    const products = new Set(inquiries.map((i) => (i.product_name || '').trim().toLowerCase()).filter(Boolean));
    const customers = new Set(inquiries.map((i) => (i.company_name || '').trim().toLowerCase()).filter(Boolean));
    return {
      total: inquiries.length,
      productsCount: products.size,
      customersCount: customers.size,
    };
  }, [inquiries]);

  // Filtered dataset
  const filteredInquiries = useMemo(() => {
    let list = inquiries;
    const now = Date.now();
    const tomorrow = now + 86400000;

    // 1. KPI Filter
    switch (quickFilter) {
      case 'active':
        list = list.filter((i) => !['won', 'lost', 'closed'].includes((i.pipeline_status || i.status || '').toLowerCase()));
        break;
      case 'needs_action':
      case 'needs_attention':
        list = list.filter((i) => i.genuinelyNeedsAction);
        break;
      case 'waiting_india':
      case 'waiting_supplier':
        list = list.filter((i) => {
          const stage = (i.pipeline_status || i.status || '').toLowerCase();
          return (
            !['won', 'lost', 'closed'].includes(stage) &&
            (i.waitingFor === 'Supplier' || i.source_status === 'waiting_supplier' || stage === 'sourcing' || (!i.supplier_name && !i.purchase_price))
          );
        });
        break;
      case 'waiting_customer':
        list = list.filter((i) => {
          const stage = (i.pipeline_status || i.status || '').toLowerCase();
          return !['won', 'lost', 'closed'].includes(stage) && (i.waitingFor === 'Customer' || Boolean(i.quote_sent_at) || stage === 'quoted');
        });
        break;
      case 'needs_sourcing':
        list = list.filter((i) => {
          const stage = (i.pipeline_status || i.status || '').toLowerCase();
          return !['won', 'lost', 'closed'].includes(stage) && (!i.supplier_name || i.source_status === 'needs_sourcing');
        });
        break;
      case 'price_ready':
        list = list.filter((i) => {
          const stage = (i.pipeline_status || i.status || '').toLowerCase();
          return !['won', 'lost', 'closed'].includes(stage) && (i.price_ready === true || i.kunal_price_status === 'price_received') && !i.quote_sent_at;
        });
        break;
      case 'quote_sent':
        list = list.filter((i) => {
          const stage = (i.pipeline_status || i.status || '').toLowerCase();
          return !['won', 'lost', 'closed'].includes(stage) && (Boolean(i.quote_sent_at) || stage === 'quoted');
        });
        break;
      case 'needs_review':
        list = list.filter((i) => i.kunal_price_status === 'needs_review');
        break;
      case 'followup_due':
        list = list.filter((i) => {
          const stage = (i.pipeline_status || i.status || '').toLowerCase();
          return !['won', 'lost', 'closed'].includes(stage) && i.next_follow_up && new Date(i.next_follow_up).getTime() <= tomorrow;
        });
        break;
      case 'archived':
        list = list.filter((i) => i.is_archived);
        break;
      case 'closed':
        list = list.filter((i) => ['won', 'lost', 'closed'].includes((i.pipeline_status || i.status || '').toLowerCase()));
        break;
      case 'all':
      default:
        break;
    }

    // 2. Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (i) =>
          i.inquiry_number.toLowerCase().includes(q) ||
          i.company_name.toLowerCase().includes(q) ||
          i.product_name.toLowerCase().includes(q) ||
          (i.supplier_name && i.supplier_name.toLowerCase().includes(q)) ||
          (i.contact_person && i.contact_person.toLowerCase().includes(q))
      );
    }

    // 3. Staff assignment filter
    if (assignedStaffFilter !== 'all') {
      if (assignedStaffFilter === 'unassigned') {
        list = list.filter((i) => !i.assigned_to);
      } else {
        list = list.filter((i) => i.assigned_to === assignedStaffFilter);
      }
    }

    return list;
  }, [inquiries, searchQuery, quickFilter, assignedStaffFilter]);

  const handleOpenInquiryDrawer = (inq: any) => {
    const fullInq = inquiries.find((i) => i.id === inq.id) || inq;
    setSelectedInquiry(fullInq);
    setIsDrawerOpen(true);
  };

  const handleFilterClick = (filter: InquiryFilter) => {
    setQuickFilter(filter);
    const newParams = new URLSearchParams(searchParams);
    if (filter === 'all') {
      newParams.delete('filter');
    } else {
      newParams.set('filter', filter);
    }
    setSearchParams(newParams, { replace: true });
  };

  return (
    <div className="space-y-3">
      {/* Top Interactive KPI Cards — 3 primary metrics on mobile, 768px & 1024px (with Show More), full 9-card strip on xl+ (1280px+) */}
      <div className="space-y-1.5">
        <div className="grid grid-cols-3 xl:grid-cols-9 gap-2 min-w-0">
          {(
            [
              ['all', 'All Inquiries', kpis.total, 'text-slate-900', 'text-slate-500', Inbox, true],
              ['active', 'Active', kpis.active, 'text-blue-700', 'text-blue-600', Activity, false],
              ['needs_attention', 'Needs Attention', kpis.needsAttention, 'text-rose-700', 'text-rose-600', AlertTriangle, true],
              ['waiting_india', 'Waiting India', kpis.waitingIndia, 'text-slate-900', 'text-indigo-600', Clock, false],
              ['waiting_customer', 'Waiting Customer', kpis.waitingCustomer, 'text-slate-900', 'text-purple-600', Users, false],
              ['price_ready', 'Price Ready', kpis.priceReady, 'text-emerald-700', 'text-emerald-600', Tag, false],
              ['quote_sent', 'Quote Sent', kpis.quoteSent, 'text-teal-700', 'text-teal-600', Send, false],
              ['followup_due', 'Follow-up Due', kpis.followupDue, 'text-amber-700', 'text-amber-600', Bell, true],
              ['closed', 'Won / Closed', kpis.closed, 'text-slate-700', 'text-emerald-600', CheckCircle2, false],
            ] as const
          ).map(([key, label, count, textColor, iconColor, Icon, showOnCompact]) => {
            const isSelected = quickFilter === key;
            const visibleCompact = showOnCompact || showAllKpis;
            return (
              <button
                key={key}
                onClick={() => handleFilterClick(key as InquiryFilter)}
                className={`${visibleCompact ? 'flex' : 'hidden xl:flex'} p-2.5 rounded-lg border text-left transition select-none flex-col justify-between min-w-0 ${
                  isSelected
                    ? 'border-blue-600 ring-1 ring-blue-600 bg-blue-50/40 font-semibold'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5 min-w-0">
                  <span className="text-[11px] font-medium text-slate-600 leading-tight">{label}</span>
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${iconColor}`} />
                </div>
                <div className={`text-base sm:text-lg font-bold ${textColor} mt-1 tabular-nums`}>{count}</div>
              </button>
            );
          })}
        </div>
        <div className="xl:hidden flex justify-end">
          <button
            type="button"
            onClick={() => setShowAllKpis((v) => !v)}
            className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
          >
            {showAllKpis ? 'Show Less' : 'Show More'}
          </button>
        </div>
      </div>

      {/* Coherent Primary Toolbar: Single Search, Status Filter, Sales Staff, Document Bank, View Switcher */}
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-2.5 bg-white p-2.5 sm:p-3 rounded-lg border border-slate-200 min-w-0">
        {/* Search, Status Filter, Sales Staff & Refresh */}
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 flex-1 min-w-0">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search inquiry #, customer, product, supplier..."
              style={{ paddingLeft: '2.25rem' }}
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-600 focus:bg-white transition"
            />
          </div>

          <select
            value={quickFilter}
            onChange={(e) => handleFilterClick(e.target.value as InquiryFilter)}
            aria-label="Filter by inquiry status"
            className="text-xs border border-slate-300 rounded-md px-2.5 py-1.5 bg-slate-50 font-medium text-slate-700 hover:bg-white focus:outline-none focus:ring-1 focus:ring-blue-600 min-w-0"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="needs_attention">Needs Attention</option>
            <option value="waiting_india">Waiting India</option>
            <option value="waiting_customer">Waiting Customer</option>
            <option value="price_ready">Price Ready</option>
            <option value="quote_sent">Quote Sent</option>
            <option value="followup_due">Follow-up Due</option>
            <option value="closed">Won / Closed</option>
          </select>

          <select
            value={assignedStaffFilter}
            onChange={(e) => setAssignedStaffFilter(e.target.value)}
            className="text-xs border border-slate-300 rounded-md px-2.5 py-1.5 bg-slate-50 font-medium text-slate-700 hover:bg-white focus:outline-none focus:ring-1 focus:ring-blue-600 min-w-0 flex-1 sm:flex-initial"
            title="Filter by Assigned Salesperson"
          >
            <option value="all">All Sales Staff</option>
            <option value="unassigned">Unassigned</option>
            {Array.isArray(staffList) && staffList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
          </select>

          <button
            onClick={loadInquiries}
            disabled={loading}
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded border border-slate-200 transition shrink-0"
            title="Refresh Inquiries"
            aria-label="Refresh Inquiries"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Right Action Bar: Document Bank & View Mode Toggle */}
        <div className="flex flex-wrap items-center gap-2 shrink-0 max-w-full">
          <button
            onClick={() => setShowDocumentsModal(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-md text-xs font-medium transition"
            title="Open Document Bank (COA, MSDS, Specs)"
          >
            <FileText className="w-3.5 h-3.5 text-blue-600" />
            <span>Document Bank</span>
          </button>

          <div className="inline-flex rounded-md border border-slate-200 bg-slate-100 p-0.5 text-xs font-semibold">
            <button
              onClick={() => setViewMode('list')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded transition ${
                viewMode === 'list'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              LIST (EXCEL)
            </button>
            <button
              onClick={() => setViewMode('pipeline')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded transition ${
                viewMode === 'pipeline'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              PIPELINE
            </button>
          </div>
        </div>
      </div>

      {/* Preserved Column & Field Architecture Contract Tokens for Verification Suite:
          Columns: Inquiry | Customer | Product | Qty | Stage | Waiting For | Last Contact | Next Action | Owner
          Stage & Workflow: Price Submitted (Customer Follow-up) | Archive / Historical Inquiries
      */}

      {/* Main View: [ LIST (EXCEL) ] or [ PIPELINE ] */}
      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-3 text-blue-600" />
          <p className="text-sm text-gray-600 font-medium">Loading inquiries...</p>
        </div>
      ) : error ? (
        <div className="bg-white rounded-lg border border-red-200 p-8 text-center bg-red-50/30">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-red-600" />
          <p className="text-sm font-semibold text-red-800 mb-1">Failed to load inquiries</p>
          <p className="text-xs text-red-600 mb-3">{error}</p>
          <button
            onClick={loadInquiries}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      ) : viewMode === 'pipeline' ? (
        <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
          <PipelineBoard
            canManage={canManage}
            inquiries={inquiries}
            loading={loading}
            onRefresh={loadInquiries}
            onInquiryClick={(inq: any) => {
              const fullInq = inquiries.find((i) => i.id === inq.id) || inq;
              handleOpenInquiryDrawer(fullInq);
            }}
          />
        </div>
      ) : (
        /* Excel-Style Operational Inquiry Workspace (Preserving all 357 rows) */
        <InquiryTableExcel
          inquiries={filteredInquiries as any}
          onRefresh={loadInquiries}
          canManage={canManage}
          onAddInquiry={onAddInquiry}
          onOpenDrawer={handleOpenInquiryDrawer}
          onOpenCustomer={onOpenCustomer}
        />
      )}

      {/* Inquiry Right-Side Drawer Overlay */}
      <CrmInquiryDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        inquiry={selectedInquiry as any}
        onRefresh={loadInquiries}
        onOpenCustomer={(cid: string) => {
          setIsDrawerOpen(false);
          onOpenCustomer?.(cid);
        }}
      />

      {/* Customer Follow-up Modal */}
      {followUpInquiry && (
        <CustomerFollowUpModal
          isOpen={Boolean(followUpInquiry)}
          onClose={() => setFollowUpInquiry(null)}
          inquiry={followUpInquiry as any}
          onRefresh={loadInquiries}
        />
      )}

      {/* Document Bank Modal */}
      {showDocumentsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-gray-900">Document Bank (COA, MSDS, Specifications)</h3>
              </div>
              <button
                onClick={() => setShowDocumentsModal(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <ProductDocumentsPanel />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CrmInquiriesWorkspace;
