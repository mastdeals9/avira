import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import * as XLSX from 'xlsx';
import {
  ChevronDown, X, Mail, Phone, FileText, Calendar,
  Flame, ArrowUp, Minus, Send, MessageSquare, CheckSquare,
  Download, FileSpreadsheet, ArrowUpDown, ArrowDown, XCircle, Plus, ChevronRight, Layers, Clock, CheckCircle2, Calculator, Search, ExternalLink, Loader, Upload
} from 'lucide-react';
import { Modal } from '../Modal';
import { GmailLikeComposer } from './GmailLikeComposer';
import { TaskFormModal } from '../tasks/TaskFormModal';
import { OurSideChips } from './OurSideChips';
import { PipelineStatusBadge, pipelineStatusOptions } from './PipelineStatusBadge';
import { LostReasonModal } from './LostReasonModal';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { getSignedUrlCached } from '../../utils/signedUrlCache';
import { sanitizeExportRows } from '../../utils/csvSafe';
import { canSeeInternalPricing, canSeeFinalQuote } from '../../utils/permissions';
import { showToast } from '../ToastNotification';
import { MoneyInput } from '../MoneyInput';
import { showConfirm } from '../ConfirmDialog';
import { loadAllRouteRecipients, recipientConfigurationError } from '../../services/sourcingRecipients';
import { deriveSourcingRoute, getOperationalStatus, calculateSourcingAging } from '../../utils/sourcingWorkflowStatus';
import { uploadOptimizedFile } from '../../services/storage/uploadOptimizationService';

interface InquiryItem {
  id: string;
  parent_inquiry_id: string;
  inquiry_number: string;
  product_name: string;
  specification?: string | null;
  quantity: string;
  make?: string | null;
  supplier_name?: string | null;
  supplier_country?: string | null;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  aceerp_no?: string | null;
  purchase_price?: number | null;
  purchase_price_currency?: string;
  offered_price?: number | null;
  offered_price_currency?: string;
  our_side_status?: string[];
  price_sent_at?: string | null;
  coa_sent_at?: string | null;
  sample_sent_at?: string | null;
  agency_letter_sent_at?: string | null;
  others_sent_at?: string | null;
  price_required?: boolean | null;
  coa_required?: boolean | null;
  sample_required?: boolean | null;
  agency_letter_required?: boolean | null;
  others_required?: boolean | null;
  status: string;
  pipeline_stage: string;
  document_sent: boolean;
  document_sent_at?: string | null;
  remarks?: string | null;
  notes?: string | null;
}

interface Inquiry {
  id: string;
  customer_id?: string | null;
  crm_contact_id?: string | null;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  specification?: string | null;
  quantity: string;
  supplier_name: string | null;
  supplier_country: string | null;
  company_name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  email_subject?: string | null;
  mail_subject?: string | null;
  status: string;
  pipeline_status?: string;
  priority: string;
  coa_sent: boolean;
  msds_sent: boolean;
  sample_sent: boolean;
  price_quoted: boolean;
  price_required?: boolean;
  coa_required?: boolean;
  sample_required?: boolean;
  agency_letter_required?: boolean;
  others_required?: boolean;
  price_sent_at?: string | null;
  coa_sent_at?: string | null;
  sample_sent_at?: string | null;
  agency_letter_sent_at?: string | null;
  others_sent_at?: string | null;
  aceerp_no?: string | null;
  purchase_price?: number | null;
  purchase_price_currency?: string;
  offered_price?: number | null;
  offered_price_currency?: string;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  remarks: string | null;
  is_multi_product?: boolean;
  has_items?: boolean;
  price_ready?: boolean;
  source_type?: string | null;
  source_status?: string | null;
  document_status?: string | null;
  kunal_price_status?: string | null;
  quote_status?: string | null;
  quote_sent_at?: string | null;
  last_sourcing_sent_at?: string | null;
  last_reminder_sent_at?: string | null;
  reminder_count?: number | null;
  kunal_pricing_requested_at?: string | null;
  kunal_pricing_note?: string | null;
}

interface InquiryDocument {
  id: string;
  inquiry_id: string | null;
  document_type: string;
  make?: string | null;
  product_name?: string | null;
  specification?: string | null;
  is_permanent?: boolean;
  display_file_name?: string | null;
  original_file_name?: string | null;
  storage_path: string;
}

interface InquiryContextEvent {
  id: string;
  source: 'activity' | 'appointment' | 'email' | 'requirement';
  title: string;
  description?: string;
  eventAt: string;
}

interface ColumnFilter {
  column: string;
  values: string[];
}

interface InquiryTableProps {
  inquiries: Inquiry[];
  onRefresh: () => void;
  canManage: boolean;
  onAddInquiry?: () => void;
  onOpenDrawer?: (inquiry: Inquiry) => void;
  onOpenCustomer?: (customerId: string) => void;
}

export function InquiryTableExcel({
  inquiries,
  onRefresh,
  canManage,
  onAddInquiry,
  onOpenDrawer,
  onOpenCustomer,
}: InquiryTableProps) {
  const { profile } = useAuth();
  const { t } = useLanguage();
  // Role-based pricing masks: P.Price is admin/manager only; O.Price is
  // admin/manager always, sales only when price_ready=true; warehouse / auditor
  // never see either.
  const canSeePPrice = canSeeInternalPricing(profile?.role);
  const isSalesRole = profile?.role === 'sales';
  const isInternalRestrictedRole = profile?.role === 'warehouse' || profile?.role === 'auditor_ca';
  // Header visibility of O.Price column. Sales sees the column (cells masked per-row);
  // warehouse / auditor never see it.
  const canSeeQuoteColumn = !isInternalRestrictedRole;
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState('all');
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [filteredData, setFilteredData] = useState<Inquiry[]>(inquiries);
  const [sortConfig, setSortConfig] = useState<{ column: string; direction: 'asc' | 'desc' | null }>({ column: 'inquiry_date', direction: 'desc' });
  const [editingCell, setEditingCell] = useState<{ id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [selectedInquiryForEmail, setSelectedInquiryForEmail] = useState<Inquiry | null>(null);
  const [selectedInquiriesForEmail, setSelectedInquiriesForEmail] = useState<Inquiry[]>([]);
  const [emailMode, setEmailMode] = useState<'price' | 'coa' | 'general' | 'india' | 'china'>('general');
  const [indiaDefaultTo, setIndiaDefaultTo] = useState('');
  const [indiaDefaultCc, setIndiaDefaultCc] = useState('');
  const [logCallModalOpen, setLogCallModalOpen] = useState(false);
  const [callNotes, setCallNotes] = useState('');
  const [followUpModalOpen, setFollowUpModalOpen] = useState(false);
  const [followUpDate, setFollowUpDate] = useState('');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [createTaskModalOpen, setCreateTaskModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lostReasonModalOpen, setLostReasonModalOpen] = useState(false);
  const [inquiryToMarkLost, setInquiryToMarkLost] = useState<Inquiry | null>(null);
  const [offeredPriceModalOpen, setOfferedPriceModalOpen] = useState(false);
  const [inquiryForOfferedPrice, setInquiryForOfferedPrice] = useState<Inquiry | null>(null);
  const [offeredPriceInput, setOfferedPriceInput] = useState('');
  const [requirementDocumentModalOpen, setRequirementDocumentModalOpen] = useState(false);
  const [inquiryForRequirementDocument, setInquiryForRequirementDocument] = useState<Inquiry | null>(null);
  const [requirementDocumentType, setRequirementDocumentType] = useState<'coa' | 'sample' | 'agency_letter' | 'others' | null>(null);
  const [requirementUploadFiles, setRequirementUploadFiles] = useState<File[]>([]);
  const [requirementUploadNotes, setRequirementUploadNotes] = useState('');
  const [savingRequirementDocument, setSavingRequirementDocument] = useState(false);
  const [editRequirementsModalOpen, setEditRequirementsModalOpen] = useState(false);
  const [requirementsForm, setRequirementsForm] = useState({
    price_required: false,
    coa_required: false,
    sample_required: false,
    agency_letter_required: false,
    others_required: false,
  });
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [inquiryItems, setInquiryItems] = useState<Map<string, InquiryItem[]>>(new Map());
  const [contextEvents, setContextEvents] = useState<InquiryContextEvent[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [appointmentModalOpen, setAppointmentModalOpen] = useState(false);
  const [appointmentDate, setAppointmentDate] = useState('');
  const [appointmentType, setAppointmentType] = useState<'meeting' | 'video_call' | 'phone_call'>('meeting');
  const [appointmentNotes, setAppointmentNotes] = useState('');

  const [inquiryDocuments, setInquiryDocuments] = useState<Map<string, InquiryDocument[]>>(new Map());
  const [documentPreviewOpen, setDocumentPreviewOpen] = useState(false);
  const [documentPreviewTitle, setDocumentPreviewTitle] = useState('Inquiry Documents');
  const [documentPreviewUrl, setDocumentPreviewUrl] = useState<string | null>(null);
  const [documentPreviewBlobUrl, setDocumentPreviewBlobUrl] = useState<string | null>(null);
  const [documentPreviewLoading, setDocumentPreviewLoading] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    checkbox: 45,
    inquiry_number: 140,
    inquiry_date: 110,
    company_name: 180,
    product_name: 180,
    specification: 160,
    quantity: 90,
    supplier_name: 150,
    aceerp_no: 120,
    purchase_price: 110,
    offered_price: 110,
    our_side: 140,
    quote_status: 120,
    status_next: 190,
    delivery_date: 110,
    pipeline_status: 120,
    priority: 100,
    mail_subject: 160,
    remarks: 160,
    actions: 80,
  } as Record<string, number>);
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(() => {
    try {
      return {
        checkbox: true,
        inquiry_number: true,
        inquiry_date: true,
        company_name: true,
        product_name: true,
        specification: true,
        quantity: true,
        supplier_name: true,
        aceerp_no: true,
        purchase_price: true,
        offered_price: true,
        our_side: true,
        quote_status: true,
        status_next: true,
        delivery_date: true,
        pipeline_status: true,
        priority: true,
        mail_subject: true,
        remarks: true,
        actions: true,
        ...JSON.parse(localStorage.getItem('crm_inquiry_table_visibility') || '{}'),
      };
    } catch {
      return {};
    }
  });
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [resizing, setResizing] = useState<{ column: string; startX: number; startWidth: number } | null>(null);
  const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));

  const priorityOptions = [
    { value: 'urgent', label: 'Urgent', icon: <Flame className="w-3 h-3 text-red-600" /> },
    { value: 'high', label: 'High', icon: <ArrowUp className="w-3 h-3 text-orange-600" /> },
    { value: 'medium', label: 'Medium', icon: <Minus className="w-3 h-3 text-gray-400" /> },
    { value: 'low', label: 'Low', icon: <Minus className="w-3 h-3 text-gray-300" /> },
  ];

  useEffect(() => {
    applyFiltersAndSort();
  }, [inquiries, filters, productSearch, quickFilter, sortConfig]);

  useEffect(() => {
    loadInquiryDocuments();
  }, [inquiries]);

  useEffect(() => () => {
    if (documentPreviewBlobUrl) URL.revokeObjectURL(documentPreviewBlobUrl);
  }, [documentPreviewBlobUrl]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('crm_inquiry_table_widths') || '{}');
      if (saved && typeof saved === 'object') {
        setColumnWidths(prev => ({ ...prev, ...saved }));
      }
    } catch {
      // ignore invalid localStorage
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('crm_inquiry_table_widths', JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    localStorage.setItem('crm_inquiry_table_visibility', JSON.stringify(columnVisibility));
  }, [columnVisibility]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setOpenFilter(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizing) return;
      const delta = e.clientX - resizing.startX;
      const newWidth = Math.max(50, resizing.startWidth + delta);
      setColumnWidths(prev => ({ ...prev, [resizing.column]: newWidth }));
    };

    const handleMouseUp = () => {
      setResizing(null);
    };

    if (resizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [resizing]);

  useEffect(() => {
    if (!selectedInquiry?.id) {
      setContextEvents([]);
      return;
    }
    loadInquiryContextTimeline(selectedInquiry);
  }, [selectedInquiry?.id, selectedInquiry?.crm_contact_id]);

  const handleResizeStart = (column: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({
      column,
      startX: e.clientX,
      startWidth: columnWidths[column] || 150,
    });
  };

  const ResizableHeader = ({
    column,
    label,
    sortable = true,
    className = ''
  }: {
    column: string;
    label: string;
    sortable?: boolean;
    className?: string;
  }) => {
    if (columnVisibility[column] === false) return null;
    return (
    <th
      style={{ width: columnWidths[column], minWidth: columnWidths[column] }}
      className={`relative px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 ${sortable ? 'cursor-pointer hover:bg-gray-100 select-none' : ''} ${className}`}
      onClick={sortable ? () => handleSort(column) : undefined}
    >
      <div className="flex items-center gap-1">
        <span className="truncate">{label}</span>
        {sortable && getSortIcon(column)}
      </div>
      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400 group"
        onMouseDown={(e) => handleResizeStart(column, e)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-0 right-0 w-1 h-full bg-transparent group-hover:bg-blue-400" />
      </div>
    </th>
    );
  };

  const isColumnVisible = (column: string) => columnVisibility[column] !== false;
  const toggleColumnVisibility = (column: string) => {
    const required = ['checkbox', 'inquiry_number', 'product_name'].includes(column);
    if (required) return;
    setColumnVisibility(prev => ({ ...prev, [column]: !(prev[column] !== false) }));
  };
  const resetTablePrefs = () => {
    localStorage.removeItem('crm_inquiry_table_widths');
    localStorage.removeItem('crm_inquiry_table_visibility');
    window.location.reload();
  };

  const loadInquiryContextTimeline = async (inquiry: Inquiry) => {
    try {
      setContextLoading(true);

      const activitiesQuery = supabase
        .from('crm_activities')
        .select('id, inquiry_id, customer_id, activity_type, subject, description, created_at, follow_up_date')
        .order('created_at', { ascending: false })
        .limit(80);

      // crm_activities.customer_id references crm_contacts, so scope by
      // inquiry.crm_contact_id (the CRM prospect FK) — not customer_id.
      const scopedActivitiesQuery = inquiry.crm_contact_id
        ? activitiesQuery.or(`inquiry_id.eq.${inquiry.id},customer_id.eq.${inquiry.crm_contact_id}`)
        : activitiesQuery.eq('inquiry_id', inquiry.id);

      const scopedEmailQuery = supabase
        .from('crm_email_activities')
        .select('id, inquiry_id, email_type, subject, from_email, to_email, sent_date, created_at')
        .eq('inquiry_id', inquiry.id)
        .order('sent_date', { ascending: false })
        .limit(40);

      const [{ data: activities, error: activitiesError }, { data: emails, error: emailsError }] = await Promise.all([
        scopedActivitiesQuery,
        scopedEmailQuery,
      ]);

      if (activitiesError) throw activitiesError;
      if (emailsError) throw emailsError;

      const activityEvents: InquiryContextEvent[] = (activities || []).map((activity: any) => {
        const appointmentTypes = ['meeting', 'video_call', 'phone_call'];
        const isAppointment = appointmentTypes.includes(activity.activity_type);
        const when = activity.follow_up_date || activity.created_at;
        return {
          id: `activity-${activity.id}`,
          source: isAppointment ? 'appointment' : 'activity',
          title: isAppointment
            ? `${activity.activity_type.replace('_', ' ')} scheduled`
            : (activity.subject || activity.activity_type?.replace('_', ' ') || 'Activity'),
          description: activity.description || undefined,
          eventAt: when,
        };
      });

      const emailEvents: InquiryContextEvent[] = (emails || []).map((email: any) => ({
        id: `email-${email.id}`,
        source: 'email',
        title: `${email.email_type === 'received' ? 'Email received' : 'Email sent'}${email.subject ? `: ${email.subject}` : ''}`,
        description: Array.isArray(email.to_email) ? `To: ${email.to_email.join(', ')}` : undefined,
        eventAt: email.sent_date || email.created_at,
      }));

      const requirementEvents: InquiryContextEvent[] = [
        inquiry.price_sent_at ? { id: `${inquiry.id}-price`, source: 'requirement', title: 'Price sent', eventAt: inquiry.price_sent_at } : null,
        inquiry.coa_sent_at ? { id: `${inquiry.id}-coa`, source: 'requirement', title: 'COA sent', eventAt: inquiry.coa_sent_at } : null,
        inquiry.sample_sent_at ? { id: `${inquiry.id}-sample`, source: 'requirement', title: 'Sample sent', eventAt: inquiry.sample_sent_at } : null,
        inquiry.agency_letter_sent_at ? { id: `${inquiry.id}-agency`, source: 'requirement', title: 'Agency letter sent', eventAt: inquiry.agency_letter_sent_at } : null,
      ].filter(Boolean) as InquiryContextEvent[];

      const mergedEvents = [...activityEvents, ...emailEvents, ...requirementEvents]
        .filter((event) => !!event.eventAt)
        .sort((a, b) => new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime());

      setContextEvents(mergedEvents);
    } catch (error) {
      console.error('Error loading inquiry context timeline:', error);
      setContextEvents([]);
    } finally {
      setContextLoading(false);
    }
  };

  const statusLabel = (value?: string | null) => (value || '').replace(/_/g, ' ') || '-';

  const daysSince = (value?: string | null) => {
    if (!value) return 0;
    const ms = Date.now() - new Date(value).getTime();
    return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86400000)) : 0;
  };

  const isReminderDue = (inquiry: Inquiry) => {
    const source = inquiry.source_status || 'not_sent';
    const last = inquiry.last_reminder_sent_at || inquiry.last_sourcing_sent_at;
    return ['sent', 'waiting_reply', 'partial_received'].includes(source)
      && daysSince(last) >= 3
      && inquiry.pipeline_status !== 'won'
      && inquiry.pipeline_status !== 'lost'
      && inquiry.quote_status !== 'won'
      && inquiry.quote_status !== 'lost';
  };

  const normalizeDocumentTypeLabel = (type: string) => (type === 'SPEC' ? 'Specification' : type);

  const getInquiryDocs = (inquiryId: string) => inquiryDocuments.get(inquiryId) || [];

  const hasValidCoa = (inquiry: Inquiry) => {
    const docs = getInquiryDocs(inquiry.id);
    return docs.some(d => {
      const isCoa = d.document_type?.toUpperCase() === 'COA';
      if (!isCoa) return false;
      if (inquiry.supplier_name && d.make) {
        const sup = inquiry.supplier_name.toLowerCase().trim();
        const mk = d.make.toLowerCase().trim();
        return sup.includes(mk) || mk.includes(sup) || sup === 'any' || sup === 'any, india';
      }
      return true;
    });
  };

  const hasInquiryDocs = (inquiry: Inquiry) => {
    if (inquiry.coa_required) {
      return hasValidCoa(inquiry);
    }
    return getInquiryDocs(inquiry.id).length > 0;
  };

  const getInquiryDocTypeLabels = (inquiry: Inquiry) => Array.from(new Set(getInquiryDocs(inquiry.id).map(doc => normalizeDocumentTypeLabel(doc.document_type))));

  const loadInquiryDocuments = async () => {
    const ids = inquiries.map(i => i.id).filter(Boolean);
    if (ids.length === 0) {
      setInquiryDocuments(new Map());
      return;
    }
    try {
      const { data, error } = await supabase
        .from('crm_product_documents')
        .select('id,inquiry_id,document_type,make,product_name,specification,is_permanent,display_file_name,original_file_name,storage_path')
        .in('inquiry_id', ids);
      if (error) throw error;
      const map = new Map<string, InquiryDocument[]>();
      ((data || []) as InquiryDocument[]).forEach(doc => {
        if (!doc.inquiry_id) return;
        const existing = map.get(doc.inquiry_id) || [];
        existing.push(doc);
        map.set(doc.inquiry_id, existing);
      });
      setInquiryDocuments(map);
    } catch (error) {
      console.error('Error loading inquiry documents:', error);
      setInquiryDocuments(new Map());
    }
  };

  const openDocumentPreview = async (inquiry: Inquiry) => {
    const docs = getInquiryDocs(inquiry.id);
    if (docs.length === 0) {
      showToast({ type: 'error', title: 'No documents', message: 'No uploaded documents are available for this inquiry.' });
      return;
    }
    const firstDoc = docs[0];
    const title = docs.length === 1
      ? (firstDoc.display_file_name || firstDoc.original_file_name || firstDoc.storage_path.split('/').pop() || 'Inquiry Document')
      : `${inquiry.inquiry_number} documents (${docs.length})`;
    setDocumentPreviewTitle(title);
    setDocumentPreviewOpen(true);
    setDocumentPreviewLoading(true);
    setDocumentPreviewUrl(null);
    if (documentPreviewBlobUrl) {
      URL.revokeObjectURL(documentPreviewBlobUrl);
      setDocumentPreviewBlobUrl(null);
    }
    try {
      const signedUrl = await getSignedUrlCached('crm-documents', firstDoc.storage_path, 3600);
      setDocumentPreviewUrl(signedUrl);
      if (!signedUrl) return;
      const res = await fetch(signedUrl);
      if (!res.ok) return;
      const blob = await res.blob();
      setDocumentPreviewBlobUrl(URL.createObjectURL(blob));
    } catch (error) {
      console.error('Error opening document preview:', error);
      setDocumentPreviewBlobUrl(null);
    } finally {
      setDocumentPreviewLoading(false);
    }
  };

  const getQuoteStatus = (inquiry: Inquiry): { label: string; tone: 'warning' | 'info' | 'success' | 'neutral' } => {
    const pipeline = (inquiry.pipeline_status || inquiry.status || '').toLowerCase();
    const qStatus = (inquiry.quote_status || '').toLowerCase();
    if (pipeline === 'won' || qStatus === 'won') return { label: 'Won', tone: 'success' };
    if (pipeline === 'lost' || qStatus === 'lost') return { label: 'Lost', tone: 'neutral' };
    if (qStatus === 'follow_up_due') return { label: 'Follow-up required', tone: 'warning' };
    if (inquiry.quote_sent_at || inquiry.price_sent_at || qStatus === 'sent' || pipeline === 'quoted') {
      return { label: 'Sent', tone: 'success' };
    }
    if (inquiry.price_ready || inquiry.offered_price != null || qStatus === 'prepared' || qStatus === 'ready') {
      return { label: 'Prepared', tone: 'info' };
    }
    return { label: 'Not prepared', tone: 'neutral' };
  };

  const getPendingAction = (inquiry: Inquiry): { label: string; tone: 'warning' | 'info' | 'success' | 'neutral' } => {
    const pipeline = (inquiry.pipeline_status || inquiry.status || '').toLowerCase();
    if (pipeline === 'won') return { label: 'Won', tone: 'success' };
    if (pipeline === 'lost') return { label: 'Lost', tone: 'neutral' };
    if (pipeline === 'closed') return { label: 'Closed', tone: 'neutral' };

    const coaReq = inquiry.coa_required ?? true;
    const coaSent = Boolean(inquiry.coa_sent_at || inquiry.coa_sent);
    const sampleReq = Boolean(inquiry.sample_required);
    const sampleSent = Boolean(inquiry.sample_sent_at || inquiry.sample_sent);
    const agencyReq = Boolean(inquiry.agency_letter_required);
    const agencySent = Boolean(inquiry.agency_letter_sent_at);
    const othersReq = Boolean(inquiry.others_required);
    const othersSent = Boolean(inquiry.others_sent_at);

    const priceSent = Boolean(inquiry.price_sent_at || inquiry.quote_sent_at || inquiry.quote_status === 'sent');
    const hasPPrice = inquiry.purchase_price != null;
    const hasOPrice = inquiry.offered_price != null;
    const isPriceReady = inquiry.price_ready === true || inquiry.kunal_price_status === 'entered' || (hasPPrice && hasOPrice);

    // 1. If quote / price has already been sent to customer:
    if (priceSent) {
      if (coaReq && !coaSent) {
        return { label: 'Price sent — COA pending', tone: 'warning' };
      }
      if (coaReq && coaSent) {
        return { label: 'COA + price sent — waiting customer', tone: 'success' };
      }
      return { label: 'Quote sent — waiting customer', tone: 'info' };
    }

    // 2. If price is ready/prepared but quote has not been sent:
    if (isPriceReady || hasOPrice) {
      if (coaReq && !coaSent) {
        if (!hasValidCoa(inquiry)) {
          return { label: 'Price ready — COA pending', tone: 'warning' };
        }
        return { label: 'Price & COA ready — quote not sent', tone: 'success' };
      }
      return { label: 'Price ready — quote not sent', tone: 'warning' };
    }

    // 3. If supplier price is not yet available:
    if (!hasPPrice) {
      const coaAvailable = hasValidCoa(inquiry);
      if (coaReq && !coaSent && !coaAvailable) {
        return { label: 'Supplier price & COA pending', tone: 'warning' };
      }
      if (coaAvailable) {
        return { label: 'COA ready — supplier price pending', tone: 'info' };
      }
      return { label: 'Supplier price pending', tone: 'warning' };
    }

    // 4. If supplier purchase price is available but offered price is not yet set:
    if (hasPPrice && !hasOPrice) {
      return { label: 'Supplier price received — O.Price pending', tone: 'warning' };
    }

    // 5. Document-specific pendings:
    if (coaReq && !coaSent) {
      return { label: 'COA pending', tone: 'warning' };
    }
    if (sampleReq && !sampleSent) {
      return { label: 'Sample pending', tone: 'warning' };
    }
    if (agencyReq && !agencySent) {
      return { label: 'Agency letter pending', tone: 'warning' };
    }
    if (othersReq && !othersSent) {
      return { label: 'Document pending', tone: 'warning' };
    }

    return { label: 'Action pending', tone: 'neutral' };
  };

  const getToneBadgeClass = (tone: 'warning' | 'info' | 'success' | 'neutral') => {
    switch (tone) {
      case 'warning':
        return 'bg-amber-50 text-amber-800 border-amber-300';
      case 'info':
        return 'bg-sky-50 text-sky-800 border-sky-300';
      case 'success':
        return 'bg-emerald-50 text-emerald-800 border-emerald-300';
      case 'neutral':
      default:
        return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  const getWorkflowStatus = (inquiry: Inquiry) => {
    const pipeline = inquiry.pipeline_status || '';
    const quote = inquiry.quote_status || (inquiry.price_sent_at ? 'sent' : 'not_sent');
    const source = inquiry.source_status || 'not_sent';
    const hasBothPrices = inquiry.purchase_price != null && inquiry.offered_price != null;

    if (pipeline === 'won' || quote === 'won') return 'Won';
    if (pipeline === 'lost' || quote === 'lost') return 'Lost';
    if (pipeline === 'closed') return 'Closed';
    if (quote === 'follow_up_due') return 'Follow-up Due';
    if (quote === 'sent' || !!inquiry.quote_sent_at) return 'Quote Sent';
    const priceReady = inquiry.price_ready === true || inquiry.kunal_price_status === 'entered' || inquiry.offered_price != null;
    const docsReady = hasInquiryDocs(inquiry);
    if (priceReady && docsReady) return 'Price & Docs Ready';
    if (docsReady) return 'Docs Ready';
    if (priceReady) return 'Price Ready';
    if (source === 'received' || source === 'partial_received') {
      return hasBothPrices ? 'Price Ready' : 'Pricing Pending';
    }
    if (inquiry.last_sourcing_sent_at || source === 'requested' || source === 'sent' || source === 'waiting_reply') {
      return isReminderDue(inquiry) ? 'Follow-up Due' : 'Awaiting Supplier Reply';
    }
    if (source === 'not_sent' || !inquiry.source_status) return 'New Inquiry';
    return 'Sourcing Pending';
  };

  const workflowStatusClass = (status: string) => {
    switch (status) {
      case 'Won':
      case 'Price Ready':
      case 'Docs Ready':
      case 'Price & Docs Ready':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'Lost':
      case 'Closed':
        return 'bg-gray-100 text-gray-600 border-gray-200';
      case 'Quote Sent':
        return 'bg-sky-50 text-sky-700 border-sky-200';
      case 'Follow-up Due':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'Pricing Pending':
      case 'Supplier Reply Received':
        return 'bg-indigo-50 text-indigo-700 border-indigo-200';
      case 'Awaiting Supplier Reply':
      case 'Sourcing Sent':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200';
    }
  };

  const workflowTooltip = (inquiry: Inquiry) => [
    `Source: ${statusLabel(inquiry.source_status || 'not_sent')}`,
    `Docs: ${getInquiryDocTypeLabels(inquiry).join(', ') || statusLabel(inquiry.document_status || 'not_required')}`,
    `Pricing: ${inquiry.price_ready || inquiry.kunal_price_status === 'entered' ? 'ready' : 'pending'}`,
    `Quote: ${statusLabel(inquiry.quote_status || (inquiry.price_sent_at ? 'sent' : 'not_sent'))}`,
  ].join(' | ');

  const matchesQuickFilter = (inquiry: Inquiry) => {
    const workflowStatus = getWorkflowStatus(inquiry);
    switch (quickFilter) {
      case 'new_not_sent':
        return workflowStatus === 'New Inquiry' || workflowStatus === 'Sourcing Pending';
      case 'waiting_india':
        return workflowStatus === 'Awaiting Supplier Reply';
      case 'reminder_due':
        return workflowStatus === 'Follow-up Due';
      case 'need_kunal':
        return workflowStatus === 'Pricing Pending';
      case 'reply_pending':
        return ['Price Ready', 'Docs Ready', 'Price & Docs Ready'].includes(workflowStatus);
      case 'quote_sent':
        return workflowStatus === 'Quote Sent';
      default:
        return true;
    }
  };

  const applyFiltersAndSort = () => {
    let result = [...inquiries];

    if (quickFilter !== 'all') {
      result = result.filter(matchesQuickFilter);
    }

    // Product name search
    if (productSearch.trim()) {
      const q = productSearch.trim().toLowerCase();
      result = result.filter(r =>
        r.product_name?.toLowerCase().includes(q)
      );
    }

    // Apply filters
    filters.forEach(filter => {
      if (filter.values.length > 0) {
        result = result.filter(row => {
          const value = row[filter.column as keyof Inquiry];
          return filter.values.includes(String(value || ''));
        });
      }
    });

    // Apply sorting
    if (sortConfig.column && sortConfig.direction) {
      result.sort((a, b) => {
        const aValue = a[sortConfig.column as keyof Inquiry];
        const bValue = b[sortConfig.column as keyof Inquiry];

        // Handle null/undefined values
        if (aValue == null && bValue == null) return 0;
        if (aValue == null) return sortConfig.direction === 'asc' ? 1 : -1;
        if (bValue == null) return sortConfig.direction === 'asc' ? -1 : 1;

        // Convert to strings for comparison
        const aStr = String(aValue).toLowerCase();
        const bStr = String(bValue).toLowerCase();

        if (sortConfig.direction === 'asc') {
          return aStr > bStr ? 1 : aStr < bStr ? -1 : 0;
        } else {
          return aStr < bStr ? 1 : aStr > bStr ? -1 : 0;
        }
      });
    }

    setFilteredData(result);
  };

  const handleSort = (column: string) => {
    let direction: 'asc' | 'desc' | null = 'asc';

    if (sortConfig.column === column) {
      if (sortConfig.direction === 'asc') {
        direction = 'desc';
      } else if (sortConfig.direction === 'desc') {
        direction = null;
      }
    }

    setSortConfig({ column, direction });
  };

  const getSortIcon = (column: string) => {
    if (sortConfig.column !== column) {
      return <ArrowUpDown className="w-3 h-3 text-gray-400" />;
    }
    if (sortConfig.direction === 'asc') {
      return <ArrowUp className="w-3 h-3 text-blue-600" />;
    }
    if (sortConfig.direction === 'desc') {
      return <ArrowDown className="w-3 h-3 text-blue-600" />;
    }
    return <ArrowUpDown className="w-3 h-3 text-gray-400" />;
  };

  const exportToExcel = () => {
    setExporting(true);

    try {
      const exportData = filteredData.map(inquiry => ({
        'No.': inquiry.inquiry_number,
        'Date': new Date(inquiry.inquiry_date).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        }),
        'Product': inquiry.product_name,
        'Specification': inquiry.specification || '-',
        'Qty': inquiry.quantity,
        'Supplier': inquiry.supplier_name || '-',
        'Country': inquiry.supplier_country || '-',
        'Company': inquiry.company_name,
        'Mail Subject': inquiry.mail_subject || '-',
        'ACE ERP#': inquiry.aceerp_no || '-',
        'Pipeline': pipelineStatusOptions.find(p => p.value === inquiry.pipeline_status)?.label || '-',
        'Price Needed': inquiry.price_required ? 'Yes' : 'No',
        'COA Needed': inquiry.coa_required ? 'Yes' : 'No',
        'Sample Needed': inquiry.sample_required ? 'Yes' : 'No',
        'Agency Letter Needed': inquiry.agency_letter_required ? 'Yes' : 'No',
        'Others Needed': inquiry.others_required ? 'Yes' : 'No',
        'Price Sent': inquiry.price_sent_at ? 'Yes' : 'No',
        'COA Sent': inquiry.coa_sent_at ? 'Yes' : 'No',
        'Sample Sent': inquiry.sample_sent_at ? 'Yes' : 'No',
        'Agency Letter Sent': inquiry.agency_letter_sent_at ? 'Yes' : 'No',
        'Purchase Price': canSeePPrice && inquiry.purchase_price ? `${inquiry.purchase_price} ${inquiry.purchase_price_currency || 'USD'}` : (canSeePPrice ? '-' : 'Restricted'),
        'Offered Price': canSeeFinalQuote(profile?.role, inquiry.price_ready) && inquiry.offered_price ? `${inquiry.offered_price} ${inquiry.offered_price_currency || 'USD'}` : (canSeeFinalQuote(profile?.role, inquiry.price_ready) ? '-' : 'Restricted'),
        'Delivery Date': inquiry.delivery_date ? new Date(inquiry.delivery_date).toLocaleDateString('en-GB') : '-',
        'Delivery Terms': inquiry.delivery_terms || '-',
        'Priority': priorityOptions.find(p => p.value === inquiry.priority)?.label || inquiry.priority,
        'Remarks': inquiry.remarks || '-',
      }));

      const ws = XLSX.utils.json_to_sheet(sanitizeExportRows(exportData));

      // Set column widths
      ws['!cols'] = [
        { wch: 15 },  // No.
        { wch: 12 },  // Date
        { wch: 30 },  // Product
        { wch: 20 },  // Specification
        { wch: 10 },  // Qty
        { wch: 20 },  // Supplier
        { wch: 12 },  // Country
        { wch: 25 },  // Company
        { wch: 30 },  // Mail Subject
        { wch: 12 },  // ACE ERP#
        { wch: 15 },  // Pipeline
        { wch: 13 },  // Price Needed
        { wch: 12 },  // COA Needed
        { wch: 15 },  // Sample Needed
        { wch: 20 },  // Agency Letter Needed
        { wch: 12 },  // Price Sent
        { wch: 11 },  // COA Sent
        { wch: 13 },  // Sample Sent
        { wch: 19 },  // Agency Letter Sent
        { wch: 18 },  // Purchase Price
        { wch: 18 },  // Offered Price
        { wch: 15 },  // Delivery Date
        { wch: 18 },  // Delivery Terms
        { wch: 10 },  // Priority
        { wch: 30 },  // Remarks
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'CRM Inquiries');

      const fileName = `CRM-Inquiries-${new Date().toISOString().split('T')[0]}.xlsx`;
      XLSX.writeFile(wb, fileName);

      showToast({ type: 'success', title: 'Success', message: `Exported ${exportData.length} inquiries to ${fileName}` });
    } catch (error) {
      console.error('Export error:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to export data. Please try again.' });
    } finally {
      setExporting(false);
    }
  };

  const exportToCSV = () => {
    setExporting(true);

    try {
      const exportData = filteredData.map(inquiry => ({
        'No.': inquiry.inquiry_number,
        'Date': new Date(inquiry.inquiry_date).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        }),
        'Product': inquiry.product_name,
        'Specification': inquiry.specification || '-',
        'Qty': inquiry.quantity,
        'Supplier': inquiry.supplier_name || '-',
        'Country': inquiry.supplier_country || '-',
        'Company': inquiry.company_name,
        'Mail Subject': inquiry.mail_subject || '-',
        'ACE ERP#': inquiry.aceerp_no || '-',
        'Pipeline': pipelineStatusOptions.find(p => p.value === inquiry.pipeline_status)?.label || '-',
        'Price Needed': inquiry.price_required ? 'Yes' : 'No',
        'COA Needed': inquiry.coa_required ? 'Yes' : 'No',
        'Sample Needed': inquiry.sample_required ? 'Yes' : 'No',
        'Agency Letter Needed': inquiry.agency_letter_required ? 'Yes' : 'No',
        'Others Needed': inquiry.others_required ? 'Yes' : 'No',
        'Price Sent': inquiry.price_sent_at ? 'Yes' : 'No',
        'COA Sent': inquiry.coa_sent_at ? 'Yes' : 'No',
        'Sample Sent': inquiry.sample_sent_at ? 'Yes' : 'No',
        'Agency Letter Sent': inquiry.agency_letter_sent_at ? 'Yes' : 'No',
        'Purchase Price': canSeePPrice && inquiry.purchase_price ? `${inquiry.purchase_price} ${inquiry.purchase_price_currency || 'USD'}` : (canSeePPrice ? '-' : 'Restricted'),
        'Offered Price': canSeeFinalQuote(profile?.role, inquiry.price_ready) && inquiry.offered_price ? `${inquiry.offered_price} ${inquiry.offered_price_currency || 'USD'}` : (canSeeFinalQuote(profile?.role, inquiry.price_ready) ? '-' : 'Restricted'),
        'Delivery Date': inquiry.delivery_date ? new Date(inquiry.delivery_date).toLocaleDateString('en-GB') : '-',
        'Delivery Terms': inquiry.delivery_terms || '-',
        'Priority': priorityOptions.find(p => p.value === inquiry.priority)?.label || inquiry.priority,
        'Remarks': inquiry.remarks || '-',
      }));

      const ws = XLSX.utils.json_to_sheet(sanitizeExportRows(exportData));
      const csv = XLSX.utils.sheet_to_csv(ws);

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);

      link.setAttribute('href', url);
      link.setAttribute('download', `CRM-Inquiries-${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      showToast({ type: 'success', title: 'Success', message: `Exported ${exportData.length} inquiries to CSV. You can import this file to Google Sheets.` });
    } catch (error) {
      console.error('Export error:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to export data. Please try again.' });
    } finally {
      setExporting(false);
    }
  };

  const downloadImportTemplate = () => {
    const templateData = [{
      'Date': '02-12-2024',
      'Product': 'Example Product Name',
      'Specification': 'BP / USP / EP',
      'Qty': '500 KG',
      'Supplier': 'Manufacturer Name',
      'Country': 'Japan',
      'Company': 'Customer Company Name',
      'Mail Subject': 'Inquiry for Product',
      'ACE ERP#': 'ACE-123',
      'Price Needed': 'Yes',
      'COA Needed': 'Yes',
      'Sample Needed': 'No',
      'Agency Letter Needed': 'No',
      'Others Needed': 'No',
      'Purchase Price': '100',
      'Purchase Price Currency': 'USD',
      'Offered Price': '150',
      'Offered Price Currency': 'USD',
      'Delivery Date': '2025-12-31',
      'Delivery Terms': 'FOB Shanghai',
      'Priority': 'Medium',
      'Remarks': 'Additional notes',
    }];

    const ws = XLSX.utils.json_to_sheet(sanitizeExportRows(templateData));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Import Template');

    XLSX.writeFile(wb, 'CRM-Import-Template.xlsx');
    showToast({ type: 'info', title: 'Notice', message: 'Template downloaded! Fill in your data and use the Import button to upload.' });
  };

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      showToast({ type: 'error', title: 'Error', message: 'File exceeds maximum supported size of 25MB' });
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);

        if (jsonData.length === 0) {
          showToast({ type: 'error', title: 'Error', message: 'No data found in the file' });
          return;
        }

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        const parseDate = (dateStr: any) => {
          if (!dateStr) return new Date().toISOString().split('T')[0];

          // Handle Excel serial date numbers (e.g., 45261)
          if (typeof dateStr === 'number') {
            // Excel epoch starts on January 1, 1900 (but Excel incorrectly treats 1900 as a leap year)
            const excelEpoch = new Date(1899, 11, 30); // December 30, 1899
            const date = new Date(excelEpoch.getTime() + dateStr * 86400000);
            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            return `${year}-${month}-${day}`;
          }

          // Handle string formats
          const str = dateStr.toString().trim();

          // D/M/YY or DD/MM/YY format (e.g., 4/10/25, 10/11/25)
          const twoDigitYear = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
          if (twoDigitYear) {
            const [, day, month, year] = twoDigitYear;
            // Convert 2-digit year to 4-digit (00-29 = 2000s, 30-99 = 1900s)
            const fullYear = parseInt(year) < 30 ? `20${year}` : `19${year}`;
            return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          // DD-MM-YYYY format
          const ddmmyyyy1 = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
          if (ddmmyyyy1) {
            const [, day, month, year] = ddmmyyyy1;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          // DD/MM/YYYY format
          const ddmmyyyy2 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (ddmmyyyy2) {
            const [, day, month, year] = ddmmyyyy2;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          // YYYY-MM-DD format
          const yyyymmdd = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          if (yyyymmdd) {
            const [, year, month, day] = yyyymmdd;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          return new Date().toISOString().split('T')[0];
        };

        const inquiriesToInsert = jsonData.map((row: any) => ({
          product_name: row['Product'] || '',
          specification: row['Specification'] || null,
          quantity: row['Qty'] || '',
          supplier_name: row['Supplier'] || null,
          supplier_country: row['Country'] || null,
          company_name: row['Company'] || '',
          mail_subject: row['Mail Subject'] || null,
          aceerp_no: row['ACE ERP#'] || null,
          price_required: (row['Price Needed'] || '').toLowerCase() === 'yes',
          coa_required: (row['COA Needed'] || '').toLowerCase() === 'yes',
          sample_required: (row['Sample Needed'] || '').toLowerCase() === 'yes',
          agency_letter_required: (row['Agency Letter Needed'] || '').toLowerCase() === 'yes',
          others_required: (row['Others Needed'] || '').toLowerCase() === 'yes',
          purchase_price: row['Purchase Price'] ? parseFloat(row['Purchase Price']) : null,
          purchase_price_currency: row['Purchase Price Currency'] || 'USD',
          offered_price: row['Offered Price'] ? parseFloat(row['Offered Price']) : null,
          offered_price_currency: row['Offered Price Currency'] || 'USD',
          delivery_date: row['Delivery Date'] || null,
          delivery_terms: row['Delivery Terms'] || null,
          priority: (row['Priority'] || 'medium').toLowerCase(),
          remarks: row['Remarks'] || null,
          inquiry_date: parseDate(row['Date']),
          pipeline_status: 'new',
          status: 'new',
          inquiry_source: 'other',
          assigned_to: user.id,
          created_by: user.id,
        }));

        const { error } = await supabase
          .from('crm_inquiries')
          .insert(inquiriesToInsert);

        if (error) throw error;

        showToast({ type: 'success', title: 'Success', message: `Successfully imported ${inquiriesToInsert.length} inquiries!` });
        onRefresh();

        event.target.value = '';
      } catch (error) {
        console.error('Import error:', error);
        showToast({ type: 'error', title: 'Error', message: 'Failed to import data. Please check the file format and try again.' });
        event.target.value = '';
      }
    };

    reader.readAsArrayBuffer(file);
  };

  const toggleFilter = (column: string, value: string) => {
    setFilters(prev => {
      const existing = prev.find(f => f.column === column);
      if (existing) {
        const newValues = existing.values.includes(value)
          ? existing.values.filter(v => v !== value)
          : [...existing.values, value];

        if (newValues.length === 0) {
          return prev.filter(f => f.column !== column);
        }
        return prev.map(f => f.column === column ? { ...f, values: newValues } : f);
      }
      return [...prev, { column, values: [value] }];
    });
  };

  const clearColumnFilter = (column: string) => {
    setFilters(prev => prev.filter(f => f.column !== column));
  };

  const getUniqueValues = (column: keyof Inquiry) => {
    const values = inquiries.map(i => i[column]);
    return [...new Set(values)].filter(Boolean).sort();
  };

  const isColumnFiltered = (column: string) => {
    return filters.some(f => f.column === column && f.values.length > 0);
  };

  const toggleRowSelection = (id: string) => {
    setSelectedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id); // Allow multiple selections
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedRows.size === filteredData.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(filteredData.map(i => i.id)));
    }
  };

  const toggleRowExpansion = async (inquiryId: string) => {
    const newExpanded = new Set(expandedRows);

    if (newExpanded.has(inquiryId)) {
      newExpanded.delete(inquiryId);
    } else {
      newExpanded.add(inquiryId);

      if (!inquiryItems.has(inquiryId)) {
        try {
          const { data, error } = await supabase
            .from('crm_inquiry_items')
            .select('*')
            .eq('parent_inquiry_id', inquiryId)
            .order('inquiry_number', { ascending: true });

          if (error) throw error;

          const newItems = new Map(inquiryItems);
          newItems.set(inquiryId, data || []);
          setInquiryItems(newItems);
        } catch (error) {
          console.error('Error fetching inquiry items:', error);
        }
      }
    }

    setExpandedRows(newExpanded);
  };

  const startEditing = (inquiry: Inquiry, field: keyof Inquiry) => {
    if (!canManage) return;
    setEditingCell({ id: inquiry.id, field: field as string });
    setEditValue(String(inquiry[field] || ''));
  };

  const saveEdit = async () => {
    if (!editingCell) return;

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ [editingCell.field]: editValue || null })
        .eq('id', editingCell.id);

      if (error) throw error;
      setEditingCell(null);
      onRefresh();
    } catch (error) {
      console.error('Error updating field:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to update. Please try again.' });
    }
  };



  const updatePriority = async (inquiry: Inquiry, newPriority: string) => {
    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ priority: newPriority })
        .eq('id', inquiry.id);

      if (error) throw error;
      onRefresh();
    } catch (error) {
      console.error('Error updating priority:', error);
    }
  };

  const updatePipelineStatus = async (inquiry: Inquiry, newStatus: string) => {
    if (newStatus === 'lost') {
      setInquiryToMarkLost(inquiry);
      setLostReasonModalOpen(true);
      return;
    }

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ pipeline_status: newStatus })
        .eq('id', inquiry.id);

      if (error) throw error;
      onRefresh();
    } catch (error) {
      console.error('Error updating pipeline status:', error);
    }
  };

  const formatRequirementType = (requirementType: 'price' | 'coa' | 'sample' | 'agency_letter' | 'others') => {
    const labels: Record<'price' | 'coa' | 'sample' | 'agency_letter' | 'others', string> = {
      price: 'Price',
      coa: 'COA',
      sample: 'Sample',
      agency_letter: 'Agency Letter',
      others: 'Others',
    };
    return labels[requirementType];
  };

  const resetRequirementDocumentModal = () => {
    setRequirementDocumentModalOpen(false);
    setInquiryForRequirementDocument(null);
    setRequirementDocumentType(null);
    setRequirementUploadFiles([]);
    setRequirementUploadNotes('');
    setSavingRequirementDocument(false);
  };

  const markRequirementSent = async (inquiry: Inquiry, requirementType: 'price' | 'coa' | 'sample' | 'agency_letter' | 'others') => {
    const sentAtField = `${requirementType}_sent_at` as keyof Inquiry;
    const isSent = inquiry[sentAtField];

    if (isSent) {
      if (!await showConfirm({ title: 'Confirm', message: `Are you sure you want to unmark ${formatRequirementType(requirementType)} as sent?`, variant: 'warning' })) {
        return;
      }

      try {
        const updateData = { [sentAtField]: null };
        const { error } = await supabase
          .from('crm_inquiries')
          .update(updateData)
          .eq('id', inquiry.id);

        if (error) throw error;
        onRefresh();
        showToast({ type: 'success', title: 'Success', message: `${formatRequirementType(requirementType)} unmarked!` });
      } catch (error) {
        console.error('Error unmarking requirement:', error);
        showToast({ type: 'error', title: 'Error', message: 'Failed to unmark. Please try again.' });
      }
      return;
    }

    if (requirementType === 'price') {
      setInquiryForOfferedPrice(inquiry);
      setOfferedPriceInput(inquiry.offered_price?.toString() || '');
      setOfferedPriceModalOpen(true);
      return;
    }

    if (['coa', 'sample', 'agency_letter', 'others'].includes(requirementType)) {
      setInquiryForRequirementDocument(inquiry);
      setRequirementDocumentType(requirementType as 'coa' | 'sample' | 'agency_letter' | 'others');
      setRequirementUploadFiles([]);
      setRequirementUploadNotes('');
      setRequirementDocumentModalOpen(true);
      return;
    }

    try {
      const { error } = await supabase.rpc('mark_requirement_sent', {
        inquiry_id: inquiry.id,
        requirement_type: requirementType
      });

      if (error) throw error;
      onRefresh();
      showToast({ type: 'success', title: 'Success', message: `${formatRequirementType(requirementType)} marked as sent!` });
    } catch (error) {
      console.error('Error marking requirement as sent:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to mark as sent. Please try again.' });
    }
  };

  const saveRequirementDocumentAndMarkSent = async () => {
    if (!inquiryForRequirementDocument || !requirementDocumentType) return;

    setSavingRequirementDocument(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const uploadedPaths: string[] = [];
      for (const file of requirementUploadFiles) {
        const sanitizedFileName = file.name.replace(/\s+/g, '_');
        const filePath = `requirement-documents/${inquiryForRequirementDocument.id}/${requirementDocumentType}/${user.id}/${Date.now()}_${sanitizedFileName}`;
        const { error: uploadError } = await uploadOptimizedFile(supabase, 'crm-documents', filePath, file);
        if (uploadError) throw uploadError;
        uploadedPaths.push(filePath);
      }

      // Log activity (notes or files)
      if (requirementUploadNotes.trim() || uploadedPaths.length > 0) {
        const { error: activityError } = await supabase.from('crm_activities').insert({
          inquiry_id: inquiryForRequirementDocument.id,
          activity_type: 'document',
          subject: `${formatRequirementType(requirementDocumentType)} marked as sent`,
          description: requirementUploadNotes.trim() || null,
          attachment_urls: uploadedPaths.length > 0 ? uploadedPaths : null,
          activity_date: new Date().toISOString().split('T')[0],
          is_completed: true,
          created_by: user.id,
        });
        if (activityError) throw activityError;
      }

      const { error: markError } = await supabase.rpc('mark_requirement_sent', {
        inquiry_id: inquiryForRequirementDocument.id,
        requirement_type: requirementDocumentType
      });
      if (markError) throw markError;

      resetRequirementDocumentModal();
      onRefresh();
      showToast({ type: 'success', title: 'Success', message: `${formatRequirementType(requirementDocumentType)} marked as sent.` });
    } catch (error) {
      console.error('Error uploading requirement document:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to mark requirement as sent. Please try again.' });
      setSavingRequirementDocument(false);
    }
  };

  const saveOfferedPriceAndMarkSent = async () => {
    if (!inquiryForOfferedPrice) return;

    const price = offeredPriceInput.trim() ? parseFloat(offeredPriceInput) : null;

    try {
      const { error: updateError } = await supabase
        .from('crm_inquiries')
        .update({ offered_price: price })
        .eq('id', inquiryForOfferedPrice.id);

      if (updateError) throw updateError;

      const { error: markError } = await supabase.rpc('mark_requirement_sent', {
        inquiry_id: inquiryForOfferedPrice.id,
        requirement_type: 'price'
      });

      if (markError) throw markError;

      setOfferedPriceModalOpen(false);
      setInquiryForOfferedPrice(null);
      setOfferedPriceInput('');
      onRefresh();
      showToast({ type: 'success', title: 'Success', message: 'Price marked as sent with offered price updated!' });
    } catch (error) {
      console.error('Error saving offered price and marking sent:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to save. Please try again.' });
    }
  };

  const handleSendQuote = () => {
    const selected = filteredData.filter(i => selectedRows.has(i.id));
    if (!selected.length) return;

    if (selected.length > 1) {
      // Validate same email thread (subject line must match)
      const subjectKey = (inq: Inquiry) => (inq.mail_subject || inq.email_subject || '').trim().toLowerCase();
      const firstSubject = subjectKey(selected[0]);
      const allSameSubject = selected.every(i => subjectKey(i) === firstSubject);

      if (!firstSubject) {
        showToast({ type: 'error', title: 'Cannot group', message: 'Selected inquiries have no email subject. Multi-product reply requires a shared email thread.' });
        return;
      }
      if (!allSameSubject) {
        const subjects = [...new Set(selected.map(i => subjectKey(i)))];
        showToast({ type: 'error', title: 'Different email threads', message: `Selected inquiries are from different email threads. Only group inquiries from the same email.\n\n${subjects.join('\n')}` });
        return;
      }
    }

    setSelectedInquiryForEmail(selected[0]);
    setSelectedInquiriesForEmail(selected);
    setEmailMode('price');
    setEmailModalOpen(true);
  };

  const handleSendCOAMSDS = async () => {
    const selected = filteredData.filter(i => selectedRows.has(i.id));
    if (!selected.length) return;

    if (selected.length > 1) {
      const subjectKey = (inq: Inquiry) => (inq.mail_subject || inq.email_subject || '').trim().toLowerCase();
      const firstSubject = subjectKey(selected[0]);
      const allSameSubject = selected.every(i => subjectKey(i) === firstSubject);
      if (!firstSubject || !allSameSubject) {
        showToast({ type: 'error', title: 'Different email threads', message: 'Multi-product COA/MSDS is only allowed when all selected inquiries share the same email thread subject.' });
        return;
      }
    }

    setSelectedInquiryForEmail(selected[0]);
    setSelectedInquiriesForEmail(selected);
    setEmailMode('coa');
    setEmailModalOpen(true);
  };

  const expandInquiriesForEmail = async (items: Inquiry[]): Promise<Inquiry[]> => {
    const expandedRows: Inquiry[] = [];
    for (const inq of items) {
      if (inq.has_items) {
        let childItems = inquiryItems.get(inq.id);
        if (!childItems) {
          const { data } = await supabase
            .from('crm_inquiry_items')
            .select('*')
            .eq('parent_inquiry_id', inq.id)
            .order('inquiry_number', { ascending: true });
          childItems = data || [];
        }
        if (childItems.length > 0) {
          for (const item of childItems) {
            expandedRows.push({
              ...inq,
              product_name: item.product_name,
              specification: item.specification ?? inq.specification,
              quantity: item.quantity,
              supplier_name: item.supplier_name ?? item.make ?? inq.supplier_name,
              delivery_date: item.delivery_date ?? inq.delivery_date,
              aceerp_no: item.aceerp_no ?? inq.aceerp_no,
              remarks: item.remarks ?? inq.remarks,
            });
          }
        } else {
          expandedRows.push(inq);
        }
      } else {
        expandedRows.push(inq);
      }
    }
    return expandedRows;
  };

  const handleSendToIndia = async () => {
    const selected = filteredData.filter(i => selectedRows.has(i.id));
    if (!selected.length) return;

    // Filter to only India-route inquiries
    const indiaSelected = selected.filter(i => deriveSourcingRoute(i) === 'india');
    if (indiaSelected.length === 0) {
      showToast({
        type: 'error',
        title: 'No India Route Selected',
        message: 'None of the selected inquiries are routed to India.',
      });
      return;
    }

    const missing = indiaSelected.filter(i => !i.aceerp_no);
    if (missing.length > 0) {
      showToast({
        type: 'error',
        title: 'Missing ACE ERP Reference',
        message: `ACE ERP Reference Number is required for: ${missing.map(i => i.inquiry_number).join(', ')}`,
      });
      return;
    }

    const expandedRows = await expandInquiriesForEmail(indiaSelected);
    const recipients = (await loadAllRouteRecipients()).india;
    if (recipients.to.length === 0) {
      showToast({
        type: 'error',
        title: 'Send To India unavailable',
        message: recipientConfigurationError('india'),
      });
      return;
    }

    setSelectedInquiryForEmail(indiaSelected[0]);
    setSelectedInquiriesForEmail(expandedRows);
    setIndiaDefaultTo(recipients.to.join(', '));
    setIndiaDefaultCc(recipients.cc.length > 0 ? recipients.cc.join(', ') : 'devansh@shubham.co.in');
    setEmailMode('india');
    setEmailModalOpen(true);
  };

  const handleSendToChina = async () => {
    const selected = filteredData.filter(i => selectedRows.has(i.id));
    if (!selected.length) return;

    // Filter to only China-route inquiries
    const chinaSelected = selected.filter(i => deriveSourcingRoute(i) === 'china');
    if (chinaSelected.length === 0) {
      showToast({
        type: 'error',
        title: 'No China Route Selected',
        message: 'None of the selected inquiries are routed to China.',
      });
      return;
    }

    const missing = chinaSelected.filter(i => !i.aceerp_no);
    if (missing.length > 0) {
      showToast({
        type: 'error',
        title: 'Missing ACE ERP Reference',
        message: `ACE ERP Reference Number is required for: ${missing.map(i => i.inquiry_number).join(', ')}`,
      });
      return;
    }

    const expandedRows = await expandInquiriesForEmail(chinaSelected);
    const recipients = (await loadAllRouteRecipients()).china;
    if (recipients.to.length === 0) {
      showToast({
        type: 'error',
        title: 'Send To China Team unavailable',
        message: recipientConfigurationError('china'),
      });
      return;
    }

    setSelectedInquiryForEmail(chinaSelected[0]);
    setSelectedInquiriesForEmail(expandedRows);
    setIndiaDefaultTo(recipients.to.join(', '));
    setIndiaDefaultCc(recipients.cc.join(', '));
    setEmailMode('china');
    setEmailModalOpen(true);
  };

  const handleLogCall = () => {
    setLogCallModalOpen(true);
  };

  const handleSendGeneralEmail = () => {
    const inquiry = selectedInquiry || filteredData.find(i => selectedRows.has(i.id));
    if (!inquiry) return;
    setSelectedInquiryForEmail(inquiry);
    setEmailMode('general');
    setEmailModalOpen(true);
  };

  const saveLogCall = async () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      await supabase.from('crm_activities').insert({
        inquiry_id: selectedInquiry.id,
        activity_type: 'call',
        description: callNotes,
        activity_date: new Date().toISOString().split('T')[0],
        is_completed: true,
        created_by: user.id,
      });

      setLogCallModalOpen(false);
      setCallNotes('');
      await loadInquiryContextTimeline(selectedInquiry);
      showToast({ type: 'success', title: 'Success', message: 'Call logged successfully!' });
      onRefresh();
    } catch (error) {
      console.error('Error logging call:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to log call. Please try again.' });
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedRows.size === 0) return;

    const count = selectedRows.size;
    if (!await showConfirm({ title: 'Confirm', message: `Are you sure you want to delete ${count} selected ${count === 1 ? 'inquiry' : 'inquiries'}? This action cannot be undone.`, variant: 'danger', confirmLabel: 'Delete' })) {
      return;
    }

    try {
      const idsToDelete = Array.from(selectedRows);
      const { error } = await supabase
        .from('crm_inquiries')
        .delete()
        .in('id', idsToDelete);

      if (error) throw error;

      setSelectedRows(new Set());
      showToast({ type: 'success', title: 'Success', message: `Successfully deleted ${count} ${count === 1 ? 'inquiry' : 'inquiries'}` });
      onRefresh();
    } catch (error) {
      console.error('Error deleting inquiries:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete inquiries. Please try again.' });
    }
  };

  const handleScheduleFollowUp = () => {
    setFollowUpModalOpen(true);
  };

  const handleScheduleAppointment = () => {
    setAppointmentType('meeting');
    setAppointmentDate('');
    setAppointmentNotes('');
    setAppointmentModalOpen(true);
  };

  const saveAppointment = async () => {
    const inquiry = selectedInquiry || filteredData.find(i => selectedRows.has(i.id));
    if (!inquiry || !appointmentDate) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const titleByType: Record<string, string> = {
        meeting: 'Meeting scheduled',
        video_call: 'Video call scheduled',
        phone_call: 'Phone call scheduled',
      };

      const { error } = await supabase.from('crm_activities').insert({
        inquiry_id: inquiry.id,
        // crm_activities.customer_id FKs crm_contacts, so use crm_contact_id
        // from the inquiry — not customer_id (which is the ERP customers FK).
        customer_id: inquiry.crm_contact_id || null,
        activity_type: appointmentType,
        subject: titleByType[appointmentType],
        description: appointmentNotes || null,
        activity_date: new Date().toISOString().split('T')[0],
        follow_up_date: appointmentDate,
        is_completed: false,
        created_by: user.id,
      });

      if (error) throw error;

      setAppointmentModalOpen(false);
      setAppointmentDate('');
      setAppointmentNotes('');
      await loadInquiryContextTimeline(inquiry);
      showToast({ type: 'success', title: 'Success', message: 'Appointment scheduled successfully!' });
      onRefresh();
    } catch (error) {
      console.error('Error scheduling appointment:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to schedule appointment. Please try again.' });
    }
  };

  const saveFollowUp = async () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      await supabase.from('crm_activities').insert({
        inquiry_id: selectedInquiry.id,
        activity_type: 'follow_up',
        description: followUpNotes,
        activity_date: new Date().toISOString().split('T')[0],
        follow_up_date: followUpDate,
        is_completed: false,
        created_by: user.id,
      });

      setFollowUpModalOpen(false);
      setFollowUpDate('');
      setFollowUpNotes('');
      await loadInquiryContextTimeline(selectedInquiry);
      showToast({ type: 'success', title: 'Success', message: 'Follow-up scheduled successfully!' });
      onRefresh();
    } catch (error) {
      console.error('Error scheduling follow-up:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to schedule follow-up. Please try again.' });
    }
  };

  const handleEditRequirements = () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    setRequirementsForm({
      price_required: selectedInquiry.price_required ?? false,
      coa_required: selectedInquiry.coa_required ?? false,
      sample_required: selectedInquiry.sample_required ?? false,
      agency_letter_required: selectedInquiry.agency_letter_required ?? false,
      others_required: selectedInquiry.others_required ?? false,
    });
    setEditRequirementsModalOpen(true);
  };

  const saveRequirements = async () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update(requirementsForm)
        .eq('id', selectedInquiry.id);

      if (error) throw error;

      setEditRequirementsModalOpen(false);
      showToast({ type: 'success', title: 'Success', message: 'Customer requirements updated successfully!' });
      onRefresh();
    } catch (error) {
      console.error('Error updating requirements:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to update requirements. Please try again.' });
    }
  };

  const handleSendToKunalPricing = async () => {
    if (!canManage || selectedRows.size === 0) return;
    const rows = filteredData.filter(inquiry => selectedRows.has(inquiry.id));
    const activeRows = rows.filter(inquiry => inquiry.pipeline_status !== 'won' && inquiry.pipeline_status !== 'lost');
    if (activeRows.length === 0) {
      showToast({ type: 'error', title: 'Nothing to send', message: 'Won/lost inquiries are skipped.' });
      return;
    }

    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('crm_inquiries')
        .update({
          kunal_price_status: 'pending',
          price_ready: false,
          kunal_pricing_requested_at: now,
          kunal_pricing_requested_by: profile?.id || null,
          kunal_pricing_note: 'Marked for Kunal review from CRM Inquiry table',
          updated_at: now,
        })
        .in('id', activeRows.map(inquiry => inquiry.id));

      if (error) throw error;

      await Promise.all(activeRows.map(inquiry => Promise.resolve(supabase.from('crm_inquiry_timeline').insert({
        inquiry_id: inquiry.id,
        event_type: 'sent_to_kunal_pricing',
        actor_id: profile?.id || null,
        actor_name: profile?.full_name || profile?.username || null,
        description: 'Marked for Kunal review',
        metadata: { source: 'crm_inquiry_table' },
      })).catch(() => {})));

      showToast({ type: 'success', title: 'Marked for Kunal Review', message: `${activeRows.length} inquiry row${activeRows.length !== 1 ? 's' : ''} flagged. Source price/docs are not transferred by this action.` });
      onRefresh();
    } catch (error) {
      console.error('Error sending to Kunal Pricing:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to send inquiry to Kunal Pricing.' });
    }
  };

  return (
    <div className="space-y-4">
      {/* Compact toolbar — Export/Import dropdowns + Columns + Add Inquiry + search + count */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Export dropdown */}
        <div className="relative">
          <button
            onClick={() => { setExportMenuOpen(o => !o); setImportMenuOpen(false); setColumnsMenuOpen(false); }}
            disabled={exporting || filteredData.length === 0}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 transition disabled:opacity-50 disabled:cursor-not-allowed min-h-[32px]"
          >
            <Download className="w-3 h-3" />
            {exporting ? 'Exporting…' : t('common.export', 'Export')}
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          {exportMenuOpen && (
            <div className="absolute left-0 top-full mt-1 w-40 bg-white border border-gray-200 rounded shadow-lg z-50 py-1">
              <button onClick={() => { setExportMenuOpen(false); exportToExcel(); }} className="w-full text-left px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
                <FileSpreadsheet className="w-3 h-3" /> Excel (.xlsx)
              </button>
              <button onClick={() => { setExportMenuOpen(false); exportToCSV(); }} className="w-full text-left px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
                <Download className="w-3 h-3" /> CSV
              </button>
            </div>
          )}
        </div>

        {/* Import dropdown */}
        {canManage && (
          <div className="relative">
            <button
              onClick={() => { setImportMenuOpen(o => !o); setExportMenuOpen(false); setColumnsMenuOpen(false); }}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 transition min-h-[32px]"
            >
              <Upload className="w-3 h-3" />
              {t('common.import', 'Import')}
              <ChevronDown className="w-3 h-3 opacity-60" />
            </button>
            {importMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded shadow-lg z-50 py-1">
                <label className="w-full text-left px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 cursor-pointer">
                  <FileSpreadsheet className="w-3 h-3" /> Import Excel
                  <input name="file_upload" aria-label="Upload file" type="file" accept=".xlsx,.xls" onChange={(e) => { setImportMenuOpen(false); handleImportFile(e); }} className="hidden" />
                </label>
                <button onClick={() => { setImportMenuOpen(false); downloadImportTemplate(); }} className="w-full text-left px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
                  <Download className="w-3 h-3" /> Download Template
                </button>
              </div>
            )}
          </div>
        )}

        {/* Columns menu */}
        <div className="relative">
          <button
            onClick={() => { setColumnsMenuOpen(o => !o); setExportMenuOpen(false); setImportMenuOpen(false); }}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 transition min-h-[32px]"
          >
            {t('common.columns', 'Columns')}
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          {columnsMenuOpen && (
            <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded shadow-lg z-50 p-2">
              <button onClick={resetTablePrefs} className="text-[11px] text-blue-600 hover:underline mb-1">Reset widths</button>
              {[
                ['inquiry_number', 'ACRP / Inquiry #'],
                ['inquiry_date', 'Date'],
                ['company_name', 'Customer'],
                ['product_name', 'Product'],
                ['specification', 'Specification'],
                ['quantity', 'Qty'],
                ['supplier_name', 'Supplier'],
                ['aceerp_no', 'ACE ERP#'],
                ['purchase_price', 'P.Price'],
                ['offered_price', 'O.Price'],
                ['our_side', 'Requirements / Docs'],
                ['quote_status', 'Quote Status'],
                ['status_next', 'Pending / Next Action'],
                ['delivery_date', 'Delivery'],
                ['pipeline_status', 'Pipeline'],
                ['priority', 'Priority'],
                ['mail_subject', 'Mail Subject'],
                ['remarks', 'Remarks'],
                ['actions', 'Detail'],
              ].map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 px-1.5 py-1 text-xs text-gray-700">
                  <input name="checkbox" aria-label="Checkbox"
                    type="checkbox"
                    checked={isColumnVisible(key)}
                    disabled={['inquiry_number', 'product_name'].includes(key)}
                    onChange={() => toggleColumnVisibility(key)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {canManage && onAddInquiry && (
          <button
            onClick={onAddInquiry}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 border border-blue-600 rounded hover:bg-blue-700 transition min-h-[32px]"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('crm.form.addInquiry', 'Add Inquiry')}</span>
          </button>
        )}

        {/* Product search — sits inline in the toolbar */}
        <div className="relative flex-1 min-w-[180px] max-w-[320px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 pointer-events-none" />
          <input name="product_search" aria-label="Search product..."
            type="text"
            value={productSearch}
            onChange={e => setProductSearch(e.target.value)}
            placeholder={t('crm.form.productNamePlaceholder', 'Search product...')}
            className="w-full pl-7 pr-6 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white"
          />
          {productSearch && (
            <button
              onClick={() => setProductSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="ml-auto text-xs text-gray-500">
          {filteredData.length} {filteredData.length === 1 ? 'inquiry' : 'inquiries'}
          {filters.length > 0 && ' · filtered'}
          {sortConfig.direction && ' · sorted'}
        </div>
      </div>

      {/* Compact status chips */}
      <div className="flex flex-wrap items-center gap-1">
        {[
          ['all', 'All'],
          ['new_not_sent', 'New Not Sent'],
          ['waiting_india', 'Waiting India'],
          ['reminder_due', 'Reminder Due'],
          ['need_kunal', 'Need Kunal Price'],
          ['reply_pending', 'Reply Pending'],
          ['quote_sent', 'Quote Sent'],
        ].map(([value, label]) => (
          <button
            key={value}
            onClick={() => setQuickFilter(value)}
            className={`px-2 py-0.5 text-[11px] rounded-full border transition ${
              quickFilter === value
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Compact quick-actions toolbar — one row, ERP density */}
      {selectedRows.size > 0 && canManage && selectedInquiry && (() => {
        const allHaveAceRef = filteredData.filter(i => selectedRows.has(i.id)).every(i => !!i.aceerp_no);
        const btn = 'flex items-center gap-1 px-1.5 py-1 text-[11px] font-medium rounded border transition';
        return (
          <div className="bg-blue-50 border border-blue-200 rounded px-2 py-1 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-blue-900 font-medium mr-1">
              <span className="font-bold">{selectedInquiry.inquiry_number}</span>
              <span className="text-blue-700"> · {selectedInquiry.product_name}</span>
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              <button onClick={handleSendQuote} title="Send Price"
                className={`${btn} text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100`}>
                <Send className="w-3 h-3" /> Send Price
              </button>
              <button onClick={handleSendCOAMSDS} title="Send COA/MSDS"
                className={`${btn} text-green-700 bg-green-50 border-green-200 hover:bg-green-100`}>
                <FileText className="w-3 h-3" /> COA/MSDS
              </button>
              <button
                onClick={handleSendToIndia}
                disabled={!allHaveAceRef}
                title={allHaveAceRef ? 'Send Email to India' : 'ACE ERP Reference Number required'}
                className={`${btn} ${allHaveAceRef ? 'text-indigo-700 bg-indigo-50 border-indigo-200 hover:bg-indigo-100' : 'text-gray-400 bg-gray-50 border-gray-200 cursor-not-allowed opacity-60'}`}
              >
                <Upload className="w-3 h-3" /> Send Email to India
              </button>
              <button
                onClick={handleSendToChina}
                disabled={!allHaveAceRef}
                title={allHaveAceRef ? 'Send Email to China Team' : 'ACE ERP Reference Number required'}
                className={`${btn} ${allHaveAceRef ? 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100' : 'text-gray-400 bg-gray-50 border-gray-200 cursor-not-allowed opacity-60'}`}
              >
                <Upload className="w-3 h-3" /> Send Email to China Team
              </button>
              <button onClick={handleLogCall} title="Log Call"
                className={`${btn} text-gray-700 bg-white border-gray-300 hover:bg-gray-50`}>
                <Phone className="w-3 h-3" /> Log Call
              </button>
              <button onClick={handleScheduleFollowUp} title="Schedule Follow-up"
                className={`${btn} text-gray-700 bg-white border-gray-300 hover:bg-gray-50`}>
                <Calendar className="w-3 h-3" /> Follow-up
              </button>
              <button onClick={() => setCreateTaskModalOpen(true)} title="Create Task"
                className={`${btn} text-gray-700 bg-white border-gray-300 hover:bg-gray-50`}>
                <CheckSquare className="w-3 h-3" /> Task
              </button>
              <button onClick={handleDeleteSelected} title="Delete Selected"
                className={`${btn} text-red-700 bg-red-50 border-red-200 hover:bg-red-100`}>
                <X className="w-3 h-3" /> Delete
              </button>
            </div>
            <button
              onClick={() => setSelectedRows(new Set())}
              className="ml-auto p-0.5 text-gray-400 hover:text-gray-600 hover:bg-white rounded"
              title="Deselect"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })()}

      {/* Compact collapsible Inquiry Context — collapsed by default; Inquiry 360 tab covers this in depth */}
      {selectedInquiry && (
        <div className="bg-white border border-gray-200 rounded">
          <button
            type="button"
            onClick={() => {
              const next = !timelineExpanded;
              setTimelineExpanded(next);
              if (next) loadInquiryContextTimeline(selectedInquiry);
            }}
            className="w-full flex items-center justify-between px-2 py-1 text-[11px] hover:bg-gray-50"
          >
            <span className="flex items-center gap-1.5">
              {timelineExpanded ? <ChevronDown className="w-3 h-3 text-gray-500" /> : <ChevronRight className="w-3 h-3 text-gray-500" />}
              <span className="font-semibold text-gray-700">Context Timeline</span>
              <span className="text-gray-500">· {selectedInquiry.inquiry_number} · {selectedInquiry.company_name}</span>
              {!timelineExpanded && contextEvents.length > 0 && (
                <span className="text-gray-400">({contextEvents.length})</span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleSendGeneralEmail(); }}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-blue-700 hover:bg-blue-100 rounded"
                title="Send Email"
              >
                <Mail className="w-3 h-3" /> Email
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleScheduleAppointment(); }}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-teal-700 hover:bg-teal-100 rounded"
                title="Schedule Appointment"
              >
                <Calendar className="w-3 h-3" /> Appointment
              </button>
              {timelineExpanded && (
                <span
                  onClick={(e) => { e.stopPropagation(); loadInquiryContextTimeline(selectedInquiry); }}
                  className="text-[11px] text-gray-500 hover:text-gray-700 cursor-pointer"
                >Refresh</span>
              )}
            </span>
          </button>

          {timelineExpanded && (
            <div className="px-2 pb-2 border-t border-gray-100">
              {contextLoading ? (
                <div className="text-xs text-gray-500 py-3 text-center">Loading timeline…</div>
              ) : contextEvents.length === 0 ? (
                <div className="text-xs text-gray-500 py-3 text-center">No context events yet.</div>
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto pr-1 mt-1.5">
                  {contextEvents.map((event) => (
                    <div key={event.id} className="border border-gray-200 rounded px-2 py-1 flex items-start gap-2">
                      <div className="mt-0.5">
                        {event.source === 'email' && <Mail className="w-3 h-3 text-blue-600" />}
                        {event.source === 'appointment' && <Calendar className="w-3 h-3 text-teal-600" />}
                        {event.source === 'activity' && <Phone className="w-3 h-3 text-purple-600" />}
                        {event.source === 'requirement' && <FileText className="w-3 h-3 text-green-600" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[12px] font-medium text-gray-800 truncate">{event.title}</p>
                          <span className="text-[10px] text-gray-500 flex items-center gap-1 shrink-0">
                            <Clock className="w-2.5 h-2.5" />
                            {new Date(event.eventAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {event.description && (
                          <p className="text-[11px] text-gray-600 whitespace-pre-wrap line-clamp-2">{event.description}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Excel-like Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden border border-gray-200">
        <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
          <table className="w-full text-xs border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-20">
              <tr className="border-b border-gray-300">
                <th className="px-3 py-2 border-r border-gray-300">
                  <input name="selected" aria-label="Select item"
                    type="checkbox"
                    checked={selectedRows.size === filteredData.length && filteredData.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300"
                  />
                </th>

                <ResizableHeader column="inquiry_number" label="ACRP / Inquiry #" className="whitespace-nowrap" />

                <ResizableHeader column="inquiry_date" label="Date" className="whitespace-nowrap" />

                {/* Customer - Sortable with Filter */}
                {isColumnVisible('company_name') && <th style={{ width: columnWidths.company_name, minWidth: columnWidths.company_name }} className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 min-w-[150px] relative">
                  <div className="flex items-center justify-between gap-2">
                    <span>Customer</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'company_name' ? null : 'company_name')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('company_name') ? 'text-blue-600' : ''}`}
                      title="Filter Customer"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  {openFilter === 'company_name' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-64">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter Customer</span>
                        {isColumnFiltered('company_name') && (
                          <button
                            onClick={() => clearColumnFilter('company_name')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2 max-h-64 overflow-y-auto">
                        {getUniqueValues('company_name').map(company => {
                          const isSelected = filters.find(f => f.column === 'company_name')?.values.includes(String(company));
                          return (
                            <label key={String(company)} className="flex items-center gap-2 p-1.5 hover:bg-gray-50 rounded cursor-pointer">
                              <input name="checkbox" aria-label="Checkbox"
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleFilter('company_name', String(company))}
                                className="rounded border-gray-300"
                              />
                              <span className="text-sm">{String(company)}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </th>}

                <ResizableHeader column="product_name" label="Product" />

                <ResizableHeader column="specification" label="Specification" />

                <ResizableHeader column="quantity" label="Qty" />

                <ResizableHeader column="supplier_name" label="Supplier" />

                {/* ACE ERP No - Sortable with Filter */}
                {isColumnVisible('aceerp_no') && <th style={{ width: columnWidths.aceerp_no, minWidth: columnWidths.aceerp_no }} className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 min-w-[120px] relative">
                  <div className="flex items-center justify-between gap-1">
                    <span>ACE ERP#</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'aceerp_no' ? null : 'aceerp_no')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('aceerp_no') ? 'text-blue-600' : ''}`}
                      title="Filter ACE ERP#"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {openFilter === 'aceerp_no' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-56">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter ACE ERP#</span>
                        {isColumnFiltered('aceerp_no') && (
                          <button
                            onClick={() => clearColumnFilter('aceerp_no')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2 max-h-64 overflow-y-auto">
                        {getUniqueValues('aceerp_no').map(aceVal => {
                          const isSelected = filters.find(f => f.column === 'aceerp_no')?.values.includes(String(aceVal));
                          return (
                            <label key={String(aceVal)} className="flex items-center gap-2 p-1.5 hover:bg-gray-50 rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleFilter('aceerp_no', String(aceVal))}
                                className="rounded border-gray-300"
                              />
                              <span className="text-sm">{String(aceVal)}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </th>}

                {/* Purchase Price (Admin Only) */}
                {canSeePPrice && isColumnVisible('purchase_price') && (
                  <th
                    style={{ width: columnWidths.purchase_price, minWidth: columnWidths.purchase_price }}
                    className="relative px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300"
                  >
                    <span>P.Price</span>
                    <div
                      className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400"
                      onMouseDown={(e) => handleResizeStart('purchase_price', e)}
                    />
                  </th>
                )}

                {/* Offered Price (O.Price) */}
                {canSeeQuoteColumn && isColumnVisible('offered_price') && (
                  <th
                    style={{ width: columnWidths.offered_price, minWidth: columnWidths.offered_price }}
                    className="relative px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300"
                  >
                    <span>O.Price</span>
                    <div
                      className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400"
                      onMouseDown={(e) => handleResizeStart('offered_price', e)}
                    />
                  </th>
                )}

                {/* Requirements / Documents / Our Side */}
                {isColumnVisible('our_side') && <th className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 min-w-[130px] relative">
                  <div className="flex items-center justify-between gap-2">
                    <span>Requirements / Docs</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'our_side' ? null : 'our_side')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('our_side') ? 'text-blue-600' : ''}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  {openFilter === 'our_side' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-56">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter Requirements</span>
                        {isColumnFiltered('our_side') && (
                          <button
                            onClick={() => clearColumnFilter('our_side')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2 space-y-1">
                        <button
                          onClick={() => {
                            const pricePendingInquiries = inquiries.filter(i =>
                              (i.price_required ?? true) && !i.price_sent_at
                            );
                            setFilteredData(pricePendingInquiries);
                            setOpenFilter(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 hover:bg-red-50 rounded text-left text-sm"
                        >
                          <span className="w-5 h-5 rounded bg-red-100 text-red-700 flex items-center justify-center font-bold text-xs">P</span>
                          <span>Price Pending</span>
                        </button>
                        <button
                          onClick={() => {
                            const coaPendingInquiries = inquiries.filter(i =>
                              (i.coa_required ?? true) && !i.coa_sent_at
                            );
                            setFilteredData(coaPendingInquiries);
                            setOpenFilter(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 hover:bg-red-50 rounded text-left text-sm"
                        >
                          <span className="w-5 h-5 rounded bg-red-100 text-red-700 flex items-center justify-center font-bold text-xs">C</span>
                          <span>COA Pending</span>
                        </button>
                        <button
                          onClick={() => {
                            const priceSentInquiries = inquiries.filter(i =>
                              (i.price_required ?? true) && i.price_sent_at
                            );
                            setFilteredData(priceSentInquiries);
                            setOpenFilter(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 hover:bg-green-50 rounded text-left text-sm"
                        >
                          <span className="w-5 h-5 rounded bg-green-100 text-green-700 flex items-center justify-center font-bold text-xs">P</span>
                          <span>Price Sent</span>
                        </button>
                        <button
                          onClick={() => {
                            const coaSentInquiries = inquiries.filter(i =>
                              (i.coa_required ?? true) && i.coa_sent_at
                            );
                            setFilteredData(coaSentInquiries);
                            setOpenFilter(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 hover:bg-green-50 rounded text-left text-sm"
                        >
                          <span className="w-5 h-5 rounded bg-green-100 text-green-700 flex items-center justify-center font-bold text-xs">C</span>
                          <span>COA Sent</span>
                        </button>
                      </div>
                    </div>
                  )}
                </th>}

                {/* Quote Status */}
                {isColumnVisible('quote_status') && (
                  <th style={{ width: columnWidths.quote_status, minWidth: columnWidths.quote_status }} className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 min-w-[120px]">
                    Quote Status
                  </th>
                )}

                {/* Pending / Next Action */}
                {isColumnVisible('status_next') && (
                  <th style={{ width: columnWidths.status_next, minWidth: columnWidths.status_next }} className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 min-w-[180px]">
                    Pending / Next Action
                  </th>
                )}

                {/* Delivery Date */}
                {isColumnVisible('delivery_date') && (
                  <th
                    style={{ width: columnWidths.delivery_date, minWidth: columnWidths.delivery_date }}
                    className="relative px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300"
                  >
                    <span>Delivery</span>
                    <div
                      className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400"
                      onMouseDown={(e) => handleResizeStart('delivery_date', e)}
                    />
                  </th>
                )}

                {/* Pipeline Status with filter */}
                {isColumnVisible('pipeline_status') && <th className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 relative min-w-[130px]">
                  <div className="flex items-center justify-between gap-2">
                    <span>Pipeline</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'pipeline_status' ? null : 'pipeline_status')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('pipeline_status') ? 'text-blue-600' : ''}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  {openFilter === 'pipeline_status' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-56">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter Pipeline</span>
                        {isColumnFiltered('pipeline_status') && (
                          <button
                            onClick={() => clearColumnFilter('pipeline_status')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2 max-h-64 overflow-y-auto">
                        {pipelineStatusOptions.map(option => {
                          const isSelected = filters.find(f => f.column === 'pipeline_status')?.values.includes(option.value);
                          return (
                            <label key={option.value} className="flex items-center gap-2 p-1.5 hover:bg-gray-50 rounded cursor-pointer">
                              <input name="checkbox" aria-label="Checkbox"
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleFilter('pipeline_status', option.value)}
                                className="rounded border-gray-300"
                              />
                              <span className="text-sm">{option.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </th>}

                {/* Priority with filter */}
                {isColumnVisible('priority') && <th className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 relative">
                  <div className="flex items-center justify-between gap-2">
                    <span>Priority</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'priority' ? null : 'priority')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('priority') ? 'text-blue-600' : ''}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  {openFilter === 'priority' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-48">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter Priority</span>
                        {isColumnFiltered('priority') && (
                          <button
                            onClick={() => clearColumnFilter('priority')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2">
                        {priorityOptions.map(option => {
                          const isSelected = filters.find(f => f.column === 'priority')?.values.includes(option.value);
                          return (
                            <label key={option.value} className="flex items-center gap-2 p-1.5 hover:bg-gray-50 rounded cursor-pointer">
                              <input name="checkbox" aria-label="Checkbox"
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleFilter('priority', option.value)}
                                className="rounded border-gray-300"
                              />
                              {option.icon}
                              <span className="text-sm">{option.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </th>}

                <ResizableHeader column="mail_subject" label="Mail Subject" />

                <ResizableHeader column="remarks" label="Remarks" />

                {isColumnVisible('actions') && (
                  <th style={{ width: columnWidths.actions, minWidth: columnWidths.actions }} className="px-2 py-2 text-center font-semibold text-gray-700 border-r border-gray-300">
                    Detail
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {filteredData.length === 0 ? (
                <tr>
                  <td colSpan={20} className="px-3 py-8 text-center text-gray-500">
                    No inquiries found
                  </td>
                </tr>
              ) : (
                filteredData.map((inquiry) => (
                  <React.Fragment key={inquiry.id}>
                  <tr
                    className={`border-b border-gray-200 hover:bg-blue-50 transition ${
                      selectedRows.has(inquiry.id) ? 'bg-blue-100' : ''
                    }`}
                  >
                    <td className="px-3 py-2 border-r border-gray-200">
                      <input name="selected" aria-label="Select item"
                        type="checkbox"
                        checked={selectedRows.has(inquiry.id)}
                        onChange={() => toggleRowSelection(inquiry.id)}
                        className="rounded border-gray-300"
                      />
                    </td>

                    <td className="px-3 py-2 border-r border-gray-200 font-medium text-blue-600">
                      <div className="flex items-center gap-1">
                        {inquiry.has_items && (
                          <button
                            onClick={() => toggleRowExpansion(inquiry.id)}
                            className="hover:bg-blue-100 rounded p-0.5 transition"
                            title={expandedRows.has(inquiry.id) ? "Collapse products" : "Expand products"}
                          >
                            {expandedRows.has(inquiry.id) ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </button>
                        )}
                        {inquiry.is_multi_product && (
                          <span title="Multi-product inquiry">
                            <Layers className="w-3.5 h-3.5 text-blue-500" />
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenDrawer?.(inquiry)}
                          className="font-bold hover:underline text-blue-600 text-left"
                          title="Click to view full inquiry details"
                        >
                          {inquiry.inquiry_number}
                        </button>
                        {inquiry.price_ready && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full whitespace-nowrap" title="Final price ready — quote can be sent to customer">
                            <CheckCircle2 className="w-2.5 h-2.5" /> Price Ready
                          </span>
                        )}
                      </div>
                    </td>

                    {isColumnVisible('inquiry_date') && <td className="px-3 py-1.5 border-r border-gray-200 text-gray-600 whitespace-nowrap">
                      {new Date(inquiry.inquiry_date).toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric'
                      })}
                    </td>}

                    {/* Customer */}
                    {isColumnVisible('company_name') && <td className="px-3 py-1.5 border-r border-gray-200">
                      <div
                        className={`font-medium text-sm ${(inquiry.crm_contact_id || inquiry.customer_id) && onOpenCustomer ? 'text-gray-900 hover:text-blue-700 cursor-pointer hover:underline' : 'text-gray-900'}`}
                        onClick={() => (inquiry.crm_contact_id || inquiry.customer_id) && onOpenCustomer?.(inquiry.crm_contact_id || inquiry.customer_id!)}
                        title={(inquiry.crm_contact_id || inquiry.customer_id) && onOpenCustomer ? 'Click to view customer' : undefined}
                      >
                        {inquiry.company_name}
                      </div>
                      {inquiry.contact_person && (
                        <div className="text-xs text-gray-500 mt-0.5">{inquiry.contact_person}</div>
                      )}
                      {inquiry.contact_phone && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <a
                            href={`https://wa.me/${inquiry.contact_phone.replace(/[^0-9]/g, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-700 hover:underline"
                            title="Open WhatsApp"
                          >
                            <MessageSquare className="w-3 h-3" />
                            {inquiry.contact_phone}
                          </a>
                        </div>
                      )}
                    </td>}

                    {isColumnVisible('product_name') && <td className="px-3 py-1.5 border-r border-gray-200 font-medium">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'product_name' ? (
                        <input name="value" aria-label="Value"
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'product_name')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded"
                        >
                          {inquiry.product_name}
                        </div>
                      )}
                    </td>}

                    {isColumnVisible('specification') && <td className="px-3 py-1.5 border-r border-gray-200 text-gray-600 text-xs">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'specification' ? (
                        <input name="value" aria-label="Value"
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'specification')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded"
                        >
                          {inquiry.specification || '-'}
                        </div>
                      )}
                    </td>}

                    {isColumnVisible('quantity') && <td className="px-3 py-1.5 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'quantity' ? (
                        <input name="value" aria-label="Value"
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'quantity')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded"
                        >
                          {inquiry.quantity}
                        </div>
                      )}
                    </td>}

                    {isColumnVisible('supplier_name') && <td className="px-3 py-1.5 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'supplier_name' ? (
                        <input name="value" aria-label="Value"
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'supplier_name')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded"
                        >
                          <div>{inquiry.supplier_name || '-'}</div>
                          {inquiry.supplier_country && (
                            <div className="text-xs text-gray-500">{inquiry.supplier_country}</div>
                          )}
                        </div>
                      )}
                    </td>}

                    {/* ACE ERP No */}
                    {isColumnVisible('aceerp_no') && <td className="px-3 py-1.5 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'aceerp_no' ? (
                        <input name="value" aria-label="Value"
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => canManage && startEditing(inquiry, 'aceerp_no')}
                          className={canManage ? "cursor-text hover:bg-yellow-50 px-2 py-1 rounded font-mono" : "px-2 py-1 font-mono"}
                        >
                          {inquiry.aceerp_no || (canManage ? <span className="text-gray-400 text-xs">Click to add</span> : '-')}
                        </div>
                      )}
                    </td>}

                    {/* Purchase Price (Admin Only) */}
                    {canSeePPrice && isColumnVisible('purchase_price') && (
                      <td className="px-3 py-1.5 border-r border-gray-200 font-mono">
                        {editingCell?.id === inquiry.id && editingCell?.field === 'purchase_price' ? (
                          <input name="value" aria-label="Click to add"
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit();
                              if (e.key === 'Escape') setEditingCell(null);
                            }}
                            className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                            autoFocus
                            placeholder="Click to add"
                          />
                        ) : (
                          <div
                            onDoubleClick={() => startEditing(inquiry, 'purchase_price')}
                            className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-xs"
                          >
                            {inquiry.purchase_price ?
                              `$${inquiry.purchase_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` :
                              <span className="text-gray-400">Click to add</span>
                            }
                          </div>
                        )}
                      </td>
                    )}

                    {/* Offered Price (O.Price) — sales sees only when price_ready=true; warehouse/auditor never see) */}
                    {canSeeQuoteColumn && isColumnVisible('offered_price') && <td className="px-3 py-1.5 border-r border-gray-200 font-mono">
                      {(() => {
                        const allowed = canSeeFinalQuote(profile?.role, inquiry.price_ready);
                        if (!allowed) {
                          return <span className="px-2 py-1 text-xs text-gray-400 italic">Restricted</span>;
                        }
                        return editingCell?.id === inquiry.id && editingCell?.field === 'offered_price' ? (
                          <input name="value" aria-label="Click to add"
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit();
                              if (e.key === 'Escape') setEditingCell(null);
                            }}
                            className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                            autoFocus
                            placeholder="Click to add"
                          />
                        ) : (
                          <div
                            onDoubleClick={() => canManage && !isSalesRole && startEditing(inquiry, 'offered_price')}
                            className={canManage && !isSalesRole ? "cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-xs" : "px-2 py-1 text-xs"}
                          >
                            {inquiry.offered_price ?
                              `$${inquiry.offered_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` :
                              (canManage && !isSalesRole ? <span className="text-gray-400">Click to add</span> : '-')
                            }
                          </div>
                        );
                      })()}
                    </td>}

                    {/* Requirements / Documents / Our Side */}
                    {isColumnVisible('our_side') && <td className="px-3 py-1.5 border-r border-gray-200">
                      <div className="flex items-center justify-center">
                        <OurSideChips
                          inquiry={inquiry}
                          onMarkSent={canManage ? (type) => markRequirementSent(inquiry, type) : undefined}
                          documentTypes={getInquiryDocTypeLabels(inquiry)}
                          onPreviewDocuments={getInquiryDocs(inquiry.id).length > 0 ? () => openDocumentPreview(inquiry) : undefined}
                        />
                      </div>
                    </td>}

                    {/* Quote Status */}
                    {isColumnVisible('quote_status') && (
                      <td className="px-3 py-1.5 border-r border-gray-200 whitespace-nowrap">
                        {(() => {
                          const q = getQuoteStatus(inquiry);
                          return (
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${getToneBadgeClass(q.tone)}`}>
                              {q.label}
                            </span>
                          );
                        })()}
                      </td>
                    )}

                    {/* Pending / Next Action */}
                    {isColumnVisible('status_next') && <td className="px-3 py-1.5 border-r border-gray-200">
                      {(() => {
                        const opStatus = getOperationalStatus(inquiry as any);
                        const aging = calculateSourcingAging(inquiry as any);
                        const pending = getPendingAction(inquiry);
                        const docTypes = getInquiryDocTypeLabels(inquiry);
                        return (
                          <div className="space-y-1" title={workflowTooltip(inquiry)}>
                            <div className="flex flex-wrap items-center gap-1">
                              <span
                                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 whitespace-nowrap ${opStatus.badgeClass}`}
                              >
                                {opStatus.label}
                              </span>
                              {aging.hasStarted && (
                                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border ${
                                  aging.isOverdue ? 'bg-red-50 text-red-700 border-red-200' : 'bg-slate-50 text-slate-600 border-slate-200'
                                }`}>
                                  {aging.formattedAging}
                                </span>
                              )}
                            </div>
                            {opStatus.priceBadge && (
                              <div className="flex flex-wrap items-center gap-1">
                                <span className={`inline-flex items-center rounded px-1.5 py-0.2 text-[10px] font-medium border ${opStatus.priceBadge.className}`}>
                                  {opStatus.priceBadge.label}
                                </span>
                                {opStatus.coaBadge && (
                                  <span className={`inline-flex items-center rounded px-1.5 py-0.2 text-[10px] font-medium border ${opStatus.coaBadge.className}`}>
                                    {opStatus.coaBadge.label}
                                  </span>
                                )}
                              </div>
                            )}
                            {docTypes.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {docTypes.map(type => (
                                  <span key={type} className="inline-flex items-center rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 border border-blue-100">
                                    {type}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>}

                    {/* Delivery Date */}
                    {isColumnVisible('delivery_date') && <td className="px-3 py-1.5 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'delivery_date' ? (
                        <input name="value" aria-label="Value"
                          type="date"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => canManage && startEditing(inquiry, 'delivery_date')}
                          className={canManage ? "cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-xs whitespace-nowrap" : "px-2 py-1 text-xs whitespace-nowrap"}
                        >
                          {inquiry.delivery_date ?
                            new Date(inquiry.delivery_date).toLocaleDateString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric'
                            }) :
                            (canManage ? <span className="text-gray-400">Click to add</span> : '-')
                          }
                        </div>
                      )}
                    </td>}

                    {/* Pipeline Status */}
                    {isColumnVisible('pipeline_status') && <td className="px-3 py-1.5 border-r border-gray-200">
                      <select name="inquiry" aria-label="Inquiry"
                        value={inquiry.pipeline_status || 'new'}
                        onChange={(e) => updatePipelineStatus(inquiry, e.target.value)}
                        disabled={!canManage}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-xs focus:border-blue-500 focus:outline-none cursor-pointer bg-white"
                      >
                        {pipelineStatusOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </td>}

                    {/* Priority */}
                    {isColumnVisible('priority') && <td className="px-3 py-1.5 border-r border-gray-200">
                      <select name="inquiry" aria-label="Inquiry"
                        value={inquiry.priority}
                        onChange={(e) => updatePriority(inquiry, e.target.value)}
                        disabled={!canManage}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-xs focus:border-blue-500 focus:outline-none cursor-pointer"
                      >
                        {priorityOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </td>}

                    {/* Mail Subject */}
                    {isColumnVisible('mail_subject') && <td className="px-3 py-1.5 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'mail_subject' ? (
                        <input name="value" aria-label="Value"
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'mail_subject')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-xs"
                          title={inquiry.mail_subject || ''}
                        >
                          {inquiry.mail_subject ? (
                            <div className="line-clamp-2">{inquiry.mail_subject}</div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </div>
                      )}
                    </td>}

                    {/* Remarks */}
                    {isColumnVisible('remarks') && <td className="px-3 py-1.5 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'remarks' ? (
                        <input name="value" aria-label="Value"
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'remarks')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-gray-600"
                        >
                          {inquiry.remarks || '-'}
                        </div>
                      )}
                    </td>}

                    {/* Actions / Detail */}
                    {isColumnVisible('actions') && (
                      <td className="px-2 py-1.5 border-r border-gray-200 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onOpenDrawer?.(inquiry)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition"
                          title="Open supplementary inquiry drawer"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Detail
                        </button>
                      </td>
                    )}
                  </tr>
                  {inquiry.has_items && expandedRows.has(inquiry.id) && inquiryItems.get(inquiry.id)?.map((item) => (
                    <tr key={item.id} className="bg-blue-50 border-b border-blue-100">
                      <td className="px-3 py-2 border-r border-gray-200"></td>
                      <td className="px-3 py-2 border-r border-gray-200 text-sm text-blue-700 pl-8">
                        {item.inquiry_number}
                      </td>
                      {isColumnVisible('inquiry_date') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-500">-</td>}
                      {isColumnVisible('company_name') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-500">-</td>}
                      {isColumnVisible('product_name') && <td className="px-3 py-2 border-r border-gray-200 text-sm font-medium">{item.product_name}</td>}
                      {isColumnVisible('specification') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-600">{item.specification || '-'}</td>}
                      {isColumnVisible('quantity') && <td className="px-3 py-2 border-r border-gray-200 text-sm">{item.quantity}</td>}
                      {isColumnVisible('supplier_name') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-500">{item.supplier_name || item.make || '-'}</td>}
                      {isColumnVisible('aceerp_no') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-600 font-mono">{item.aceerp_no || '-'}</td>}
                      {canSeePPrice && isColumnVisible('purchase_price') && (
                        <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-700 font-mono">
                          {item.purchase_price ? `$${item.purchase_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '-'}
                        </td>
                      )}
                      {canSeeQuoteColumn && isColumnVisible('offered_price') && (
                        <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-700 font-mono">
                          {item.offered_price ? `$${item.offered_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '-'}
                        </td>
                      )}
                      {isColumnVisible('our_side') && (
                        <td className="px-3 py-2 border-r border-gray-200 text-center">
                          {(() => {
                            const priceRequired = item.price_required !== undefined && item.price_required !== null
                              ? Boolean(item.price_required)
                              : (inquiry.price_required ?? true);

                            const coaRequired = item.coa_required !== undefined && item.coa_required !== null
                              ? Boolean(item.coa_required)
                              : (inquiry.coa_required ?? true);

                            const sampleRequired = item.sample_required !== undefined && item.sample_required !== null
                              ? Boolean(item.sample_required)
                              : Boolean(inquiry.sample_required);

                            const agencyLetterRequired = item.agency_letter_required !== undefined && item.agency_letter_required !== null
                              ? Boolean(item.agency_letter_required)
                              : Boolean(inquiry.agency_letter_required);

                            const othersRequired = item.others_required !== undefined && item.others_required !== null
                              ? Boolean(item.others_required)
                              : Boolean(inquiry.others_required);

                            const anyRequired = priceRequired || coaRequired || sampleRequired || agencyLetterRequired || othersRequired;

                            if (!anyRequired) {
                              return <XCircle className="w-4 h-4 text-gray-400 mx-auto" />;
                            }

                            return (
                              <div className="flex items-center justify-center">
                                <OurSideChips
                                  inquiry={{
                                    price_required: priceRequired,
                                    coa_required: coaRequired,
                                    sample_required: sampleRequired,
                                    agency_letter_required: agencyLetterRequired,
                                    others_required: othersRequired,
                                    price_sent_at: item.price_sent_at ?? inquiry.price_sent_at ?? null,
                                    coa_sent_at: item.coa_sent_at ?? (item.document_sent ? item.document_sent_at : null) ?? inquiry.coa_sent_at ?? null,
                                    sample_sent_at: item.sample_sent_at ?? inquiry.sample_sent_at ?? null,
                                    agency_letter_sent_at: item.agency_letter_sent_at ?? inquiry.agency_letter_sent_at ?? null,
                                    others_sent_at: item.others_sent_at ?? inquiry.others_sent_at ?? null,
                                  }}
                                  compact
                                />
                              </div>
                            );
                          })()}
                        </td>
                      )}
                      {isColumnVisible('quote_status') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-500">-</td>}
                      {isColumnVisible('status_next') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-600">{item.status || '-'}</td>}
                      {isColumnVisible('delivery_date') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-500">{item.delivery_date ? new Date(item.delivery_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '-'}</td>}
                      {isColumnVisible('pipeline_status') && <td className="px-3 py-2 border-r border-gray-200"><PipelineStatusBadge status={item.pipeline_stage} /></td>}
                      {isColumnVisible('priority') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-500">-</td>}
                      {isColumnVisible('mail_subject') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-500">-</td>}
                      {isColumnVisible('remarks') && <td className="px-3 py-2 border-r border-gray-200 text-xs text-gray-600">{item.notes || item.remarks || '-'}</td>}
                      {isColumnVisible('actions') && <td className="px-3 py-2 border-r border-gray-200"></td>}
                    </tr>
                  ))}
                </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Gmail-like Email Composer Modal */}
      {emailModalOpen && selectedInquiryForEmail && (
        <GmailLikeComposer
          isOpen={emailModalOpen}
          onClose={() => {
            setEmailModalOpen(false);
            setSelectedInquiryForEmail(null);
            setSelectedInquiriesForEmail([]);
            setEmailMode('general');
            setIndiaDefaultTo('');
            setIndiaDefaultCc('');
            onRefresh();
          }}
          inquiry={selectedInquiryForEmail}
          inquiries={
            emailMode === 'india' || emailMode === 'china'
              ? (selectedInquiriesForEmail.length > 0 ? selectedInquiriesForEmail : undefined)
              : (selectedInquiriesForEmail.length > 1 ? selectedInquiriesForEmail : undefined)
          }
          mode={emailMode}
          defaultTo={(emailMode === 'india' || emailMode === 'china') ? indiaDefaultTo : undefined}
          defaultCc={emailMode === 'india' ? indiaDefaultCc : undefined}
        />
      )}

      {/* Inquiry document preview modal (same Modal + iframe preview pattern as Sales Orders PO preview) */}
      {documentPreviewOpen && (
        <Modal
          isOpen={documentPreviewOpen}
          onClose={() => {
            setDocumentPreviewOpen(false);
            setDocumentPreviewUrl(null);
            if (documentPreviewBlobUrl) {
              URL.revokeObjectURL(documentPreviewBlobUrl);
              setDocumentPreviewBlobUrl(null);
            }
          }}
          title={documentPreviewTitle}
          size="xl"
        >
          <div className="flex flex-col gap-2" style={{ height: '75vh' }}>
            <div className="flex justify-end gap-2">
              {documentPreviewUrl && (
                <>
                  <a
                    href={documentPreviewUrl}
                    download
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-green-700 border border-green-200 rounded-lg hover:bg-green-50 transition"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </a>
                  <a
                    href={documentPreviewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open in new tab
                  </a>
                </>
              )}
            </div>

            {documentPreviewLoading && (
              <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-center text-gray-500">
                  <Loader className="w-8 h-8 animate-spin mx-auto mb-2 text-blue-500" />
                  <p className="text-sm">Loading document...</p>
                </div>
              </div>
            )}
            {!documentPreviewLoading && (documentPreviewBlobUrl || documentPreviewUrl) && (
              <iframe
                src={documentPreviewBlobUrl || documentPreviewUrl || ''}
                className="flex-1 w-full rounded-lg border border-gray-200 bg-white"
                title="Inquiry document preview"
              />
            )}
            {!documentPreviewLoading && !documentPreviewBlobUrl && !documentPreviewUrl && (
              <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-center text-gray-500 px-6">
                  <FileText className="w-10 h-10 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm font-medium mb-2">Document cannot be previewed</p>
                  <p className="text-xs text-gray-400 mb-5">Please check file storage or try downloading again.</p>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Log Call Modal */}
      <Modal
        isOpen={logCallModalOpen}
        onClose={() => {
          setLogCallModalOpen(false);
          setCallNotes('');
        }}
        title="Log Phone Call"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Call Notes *
            </label>
            <textarea name="call_notes" aria-label="Call Notes"
              value={callNotes}
              onChange={(e) => setCallNotes(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="What was discussed during the call?"
              required
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => {
                setLogCallModalOpen(false);
                setCallNotes('');
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={saveLogCall}
              disabled={!callNotes.trim()}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              Save Call Log
            </button>
          </div>
        </div>
      </Modal>

      {/* Schedule Follow-up Modal */}
      <Modal
        isOpen={appointmentModalOpen}
        onClose={() => {
          setAppointmentModalOpen(false);
          setAppointmentDate('');
          setAppointmentNotes('');
        }}
        title="Schedule Appointment"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Appointment Type *</label>
            <select name="appointment_type" aria-label="Appointment Type"
              value={appointmentType}
              onChange={(e) => setAppointmentType(e.target.value as 'meeting' | 'video_call' | 'phone_call')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="meeting">Meeting</option>
              <option value="video_call">Video Call</option>
              <option value="phone_call">Phone Call</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
            <input name="date" aria-label="Date"
              type="date"
              value={appointmentDate}
              onChange={(e) => setAppointmentDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea name="notes" aria-label="Notes"
              value={appointmentNotes}
              onChange={(e) => setAppointmentNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Agenda / preparation notes"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => {
                setAppointmentModalOpen(false);
                setAppointmentDate('');
                setAppointmentNotes('');
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={saveAppointment}
              disabled={!appointmentDate}
              className="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
            >
              Schedule Appointment
            </button>
          </div>
        </div>
      </Modal>

      {/* Schedule Follow-up Modal */}
      <Modal
        isOpen={followUpModalOpen}
        onClose={() => {
          setFollowUpModalOpen(false);
          setFollowUpDate('');
          setFollowUpNotes('');
        }}
        title="Schedule Follow-up"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Follow-up Date *
            </label>
            <input name="follow_up_date" aria-label="Follow-up Date"
              type="date"
              value={followUpDate}
              onChange={(e) => setFollowUpDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notes
            </label>
            <textarea name="notes" aria-label="Notes"
              value={followUpNotes}
              onChange={(e) => setFollowUpNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="What needs to be followed up?"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => {
                setFollowUpModalOpen(false);
                setFollowUpDate('');
                setFollowUpNotes('');
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={saveFollowUp}
              disabled={!followUpDate}
              className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
            >
              Schedule Follow-up
            </button>
          </div>
        </div>
      </Modal>

      {/* Create Task Modal */}
      {createTaskModalOpen && selectedInquiry && (
        <TaskFormModal
          isOpen={createTaskModalOpen}
          onClose={() => setCreateTaskModalOpen(false)}
          onSuccess={() => {
            setCreateTaskModalOpen(false);
            onRefresh();
          }}
          initialData={{
            inquiry_id: selectedInquiry.id
          }}
        />
      )}

      {/* Lost Reason Modal */}
      {inquiryToMarkLost && (
        <LostReasonModal
          isOpen={lostReasonModalOpen}
          onClose={() => {
            setLostReasonModalOpen(false);
            setInquiryToMarkLost(null);
          }}
          inquiryId={inquiryToMarkLost.id}
          inquiryNumber={inquiryToMarkLost.inquiry_number}
          onSuccess={() => {
            onRefresh();
            setInquiryToMarkLost(null);
          }}
        />
      )}

      {/* Offered Price Modal */}
      <Modal
        isOpen={offeredPriceModalOpen}
        onClose={() => {
          setOfferedPriceModalOpen(false);
          setInquiryForOfferedPrice(null);
          setOfferedPriceInput('');
        }}
        title="Enter Offered Price"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Inquiry: {inquiryForOfferedPrice?.inquiry_number || '-'}
            </label>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Product: {inquiryForOfferedPrice?.product_name || '-'}
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Offered Price (O.Price) *
            </label>
            <MoneyInput
              value={Number(offeredPriceInput) || 0}
              onChange={(amount) => setOfferedPriceInput(String(amount))}
              placeholder="Enter offered price"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              min="0"
              maximumFractionDigits={4}
            />
            <p className="mt-1 text-xs text-gray-500">
              Enter the price you offered to the customer
            </p>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => {
                setOfferedPriceModalOpen(false);
                setInquiryForOfferedPrice(null);
                setOfferedPriceInput('');
              }}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={saveOfferedPriceAndMarkSent}
              className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              Save & Mark Price as Sent
            </button>
          </div>
        </div>
      </Modal>

      {/* Requirement Document Upload Modal */}
      <Modal
        isOpen={requirementDocumentModalOpen}
        onClose={resetRequirementDocumentModal}
        title={`Mark ${requirementDocumentType ? formatRequirementType(requirementDocumentType) : 'Requirement'} as Sent`}
      >
        <div className="space-y-4">
          <div className="text-sm text-gray-600">
            Optionally attach supporting document(s). You can also mark as sent without a file — useful when already sent via email or in person.
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Inquiry: {inquiryForRequirementDocument?.inquiry_number || '-'}
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Product: {inquiryForRequirementDocument?.product_name || '-'}
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Attach file(s) <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input name="file_upload" aria-label="Upload file"
              type="file"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length === 0) return;
                setRequirementUploadFiles(prev => [...prev, ...files]);
                e.target.value = '';
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg file:mr-3 file:px-3 file:py-1.5 file:border-0 file:bg-blue-50 file:text-blue-700 file:rounded-md hover:file:bg-blue-100"
            />
            {requirementUploadFiles.length > 0 ? (
              <div className="mt-2 space-y-2 max-h-36 overflow-auto">
                {requirementUploadFiles.map((file, index) => (
                  <div key={`${file.name}-${index}`} className="flex items-center justify-between gap-2 text-xs bg-gray-50 border border-gray-200 rounded-md px-2 py-1.5">
                    <span className="text-gray-700 truncate">{file.name}</span>
                    <button
                      onClick={() => setRequirementUploadFiles(prev => prev.filter((_, i) => i !== index))}
                      className="text-red-600 hover:text-red-700"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-gray-500">No file selected — you can still mark as sent.</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Notes (optional)
            </label>
            <textarea name="notes_optional" aria-label="Notes (optional)"
              rows={3}
              value={requirementUploadNotes}
              onChange={(e) => setRequirementUploadNotes(e.target.value)}
              placeholder="Add any notes related to this document dispatch..."
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={resetRequirementDocumentModal}
              disabled={savingRequirementDocument}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              onClick={saveRequirementDocumentAndMarkSent}
              disabled={savingRequirementDocument}
              className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60"
            >
              {savingRequirementDocument ? 'Saving...' : requirementUploadFiles.length > 0 ? 'Upload & Mark Sent' : 'Mark as Sent'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Edit Requirements Modal */}
      <Modal
        isOpen={editRequirementsModalOpen}
        onClose={() => setEditRequirementsModalOpen(false)}
        title="Edit Customer Requirements"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Check what the customer has requested:
          </p>
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input name="price_required" aria-label="Price Required"
                type="checkbox"
                checked={requirementsForm.price_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, price_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">Price</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input name="coa_required" aria-label="Coa Required"
                type="checkbox"
                checked={requirementsForm.coa_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, coa_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">COA</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input name="sample_required" aria-label="Sample Required"
                type="checkbox"
                checked={requirementsForm.sample_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, sample_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">Sample</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input name="agency_letter_required" aria-label="Agency Letter Required"
                type="checkbox"
                checked={requirementsForm.agency_letter_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, agency_letter_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">Agency Letter</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input name="others_required" aria-label="Others Required"
                type="checkbox"
                checked={requirementsForm.others_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, others_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">Others</span>
            </label>
          </div>
          <div className="flex justify-end gap-2 mt-6 pt-4 border-t">
            <button
              onClick={() => setEditRequirementsModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              onClick={saveRequirements}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition"
            >
              Save Requirements
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
