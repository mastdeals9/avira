import { useCallback, useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileText,
  Loader,
  Mail,
  Maximize2,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { sendPricingWorkflowEmail, userHasConnectedGmail } from '../services/pricingEmail';
import { TableColumn, useColumnPreferences } from '../hooks/useColumnPreferences';
import {
  loadAllRouteRecipients, recipientConfigurationError, saveRouteRecipients, type RouteRecipients, type SourcingRoute,
} from '../services/sourcingRecipients';
import { RecipientChips } from '../components/crm/RecipientChips';
import { MoneyInput } from '../components/MoneyInput';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { aiImproveEmail, extractProtectedTokens } from '../services/aiEmailAssistant';
import { buildIndiaRfqEmail, buildIndiaRfqSubject } from '../utils/emailFormatting';
import { FALLBACK_COMPANY, type CompanySnapshot } from '../types/company';
import { GmailLikeComposer } from '../components/crm/GmailLikeComposer';
import { deriveSourcingRoute, getOperationalStatus, calculateSourcingAging } from '../utils/sourcingWorkflowStatus';
import {
  findInquiryCandidates,
  parseSourceReplyEmail,
  saveSourceReplyRow,
  type InquiryCandidate,
  type ParsedSourceRow,
  type SourceType,
} from '../services/sourceReplyParser';

interface Inquiry {
  id: string;
  inquiry_number: string;
  aceerp_no: string | null;
  company_name: string;
  product_name: string;
  specification: string | null;
  quantity: string;
  delivery_date: string | null;
  supplier_name: string | null;
  source_type: string | null;
  source_status: string;
  document_status: string;
  kunal_price_status: string;
  quote_status: string | null;
  pipeline_status: string | null;
  purchase_price: number | null;
  offered_price: number | null;
  price_ready: boolean | null;
  reminder_count: number | null;
  last_sourcing_sent_at: string | null;
  last_reminder_sent_at: string | null;
  kunal_pricing_requested_at: string | null;
  kunal_pricing_note: string | null;
  remarks: string | null;
  coa_required: boolean | null;
  coa_sent_at: string | null;
  sample_required: boolean | null;
  sample_sent_at: string | null;
  price_required: boolean | null;
  price_sent_at: string | null;
  agency_letter_required: boolean | null;
  agency_letter_sent_at: string | null;
  others_required: boolean | null;
  others_sent_at: string | null;
  email_subject: string | null;
  mail_subject: string | null;
  created_at: string;
}

interface SourceDraft {
  offered_make: string;
  source_price: string;
  source_currency: string;
  availability: 'available' | 'partial' | 'na';
  document_status: 'pending' | 'partial' | 'received' | 'not_required';
  remark: string;
}

type TabKey = 'new' | 'reminder' | 'partial' | 'docs' | 'all';
type SectionKey = 'ai' | 'sheet' | 'preview';
type RouteFilter = 'all' | 'india' | 'china' | 'local';
type MissingFilter = 'all' | 'price' | 'docs';

type AiMailType =
  | 'Supplier Price Reply'
  | 'India Office Query / Revert Needed'
  | 'Document / Certificate Received'
  | 'Customer Inquiry'
  | 'General / No Action'
  | 'Needs Review';

interface GmailReviewMessage {
  messageId: string;
  threadId: string | null;
  from: string;
  to?: string;
  subject: string;
  date: string;
  snippet: string;
  body?: string;
  hasAttachments: boolean;
  attachments?: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
}

interface AiMailReviewRow extends GmailReviewMessage {
  aiType: AiMailType;
  product: string | null;
  matchedInquiryNumber: string | null;
  aceerpNo: string | null;
  summary: string;
  suggestedAction: string;
  confidence: number;
  extractedQuestion: string | null;
  documentType: 'COA' | 'MSDS' | 'COC' | 'GMP' | 'ISO' | 'DMF' | 'OTHER' | null;
  make: string | null;
  sourceTypeHint: SourceType;
  candidates: InquiryCandidate[];
  selectedInquiryId: string | null;
  reviewed: boolean;
}

interface AiReviewDraft {
  question: string;
  documentType: DocumentType;
  notes: string;
  product: string;
  make: string;
  displayFileName: string;
  attachmentId: string;
}

type DocumentType = 'COA' | 'MSDS' | 'COC' | 'GMP' | 'ISO' | 'DMF' | 'SPEC' | 'OTHER';

interface SourceExtractionRow extends ParsedSourceRow {
  selectedInquiryId: string | null;
  candidates: InquiryCandidate[];
  saved?: boolean;
  saveError?: string | null;
}

interface ReplyDraft {
  open: boolean;
  to: string;
  subject: string;
  body: string;
  sending: boolean;
}

const REMINDER_DAYS = 3;

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'new', label: 'New Not Sent' },
  { key: 'reminder', label: 'Reminder Due' },
  { key: 'partial', label: 'Partial Received' },
  { key: 'docs', label: 'Docs Pending' },
  { key: 'all', label: 'All Pending' },
];

const ANVI_COLUMNS: TableColumn[] = [
  { key: 'select', label: '', width: 44, minWidth: 44, required: true },
  { key: 'inquiry', label: 'Inquiry No', width: 130, minWidth: 110, required: true },
  { key: 'aceerp', label: 'AC ERP#', width: 110, minWidth: 90 },
  { key: 'customer', label: 'Customer', width: 160, minWidth: 120 },
  { key: 'product', label: 'Product', width: 190, minWidth: 130, required: true },
  { key: 'spec', label: 'Spec', width: 170, minWidth: 110 },
  { key: 'mail_subject', label: 'Inquiry Subject', width: 180, minWidth: 120 },
  { key: 'qty', label: 'Qty', width: 80, minWidth: 60 },
  { key: 'preferred', label: 'Preferred Make', width: 150, minWidth: 110 },
  { key: 'route', label: 'Route', width: 90, minWidth: 70 },
  { key: 'status', label: 'Status', width: 120, minWidth: 90 },
  { key: 'pending', label: 'Pending', width: 130, minWidth: 90 },
  { key: 'aging', label: 'Aging', width: 80, minWidth: 70 },
  { key: 'reminder', label: 'Reminder #', width: 90, minWidth: 80 },
  { key: 'lastSent', label: 'Last Sent', width: 110, minWidth: 90 },
  { key: 'created', label: 'Created', width: 110, minWidth: 90 },
  { key: 'actions', label: '', width: 120, minWidth: 105, required: true },
];

function normalizeSourceRoute(route: string | null | undefined): 'india' | 'china' | 'local' {
  const source = (route || '').trim().toLowerCase();
  if (source === 'china') return 'china';
  if (source === 'local') return 'local';
  return 'india';
}

function deriveSourceType(i: Pick<Inquiry, 'source_type' | 'supplier_name'>): 'india' | 'china' | 'local' {
  const source = (i.source_type || '').trim().toLowerCase();
  if (source === 'india' || source === 'china' || source === 'local') return normalizeSourceRoute(source);
  const supplier = (i.supplier_name || '').toLowerCase();
  if (supplier.includes('china')) return 'china';
  if (supplier.includes('local')) return 'local';
  return normalizeSourceRoute(i.source_type);
}

function ageDays(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86400000)) : 0;
}

function lastContactAge(row: Inquiry): number {
  return Math.max(ageDays(row.last_sourcing_sent_at), ageDays(row.last_reminder_sent_at));
}

function isCompleted(row: Inquiry): boolean {
  return row.source_status === 'received'
    || row.source_status === 'unavailable'
    || row.quote_status === 'won'
    || row.quote_status === 'lost'
    || row.pipeline_status === 'won'
    || row.pipeline_status === 'lost';
}

function pendingLabel(row: Inquiry): string {
  const parts: string[] = [];
  // Price pending: kunal not entered, or no purchase/offered price
  const priceNeeded = row.price_required !== false; // default true
  if (priceNeeded && (row.kunal_price_status === 'pending' || !row.purchase_price || !row.offered_price)) parts.push('Price');
  // COA pending
  if (row.coa_required && !row.coa_sent_at) parts.push('COA');
  // Sample pending
  if (row.sample_required && !row.sample_sent_at) parts.push('Sample');
  // Agency letter pending
  if (row.agency_letter_required && !row.agency_letter_sent_at) parts.push('Agency Letter');
  // Others pending
  if (row.others_required && !row.others_sent_at) parts.push('Others');
  // Document status (sourcing side)
  if (!parts.length && (row.document_status === 'pending' || row.document_status === 'partial')) parts.push('Docs');
  if (row.source_status === 'partial_received') parts.push('Partial reply');
  return parts.join(' + ') || 'Reply';
}

function intelligenceBadges(row: Inquiry): string[] {
  const badges: string[] = [];
  const noteText = `${row.remarks || ''} ${row.kunal_pricing_note || ''}`.toLowerCase();
  if (row.source_status === 'received' || row.source_status === 'partial_received') badges.push('Price reply received');
  if (noteText.includes('india query:')) badges.push('Query from India');
  if (row.document_status === 'received') badges.push('Documents received');
  if (noteText.includes('needs review') || noteText.includes('ai mail review')) badges.push('Needs review');
  return badges.slice(0, 3);
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('en-GB') : '-';
}

function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] || value).trim();
}

function shouldSkipEmail(message: GmailReviewMessage): boolean {
  const haystack = `${message.from} ${message.subject} ${message.snippet} ${message.body || ''}`.toLowerCase();
  return [
    'google flights',
    'bank',
    'newsletter',
    'verification code',
    'verify your',
    'feedback',
    'marketing',
    'promotion',
    'unsubscribe',
  ].some(term => haystack.includes(term));
}

function sourcingPriority(message: GmailReviewMessage): number {
  const haystack = `${message.from} ${message.to || ''} ${message.subject} ${message.snippet} ${message.body || ''}`.toLowerCase();
  let score = 0;
  [
    'sonal', 'aanvi', 'anvi', 'kunal', 'sales@avira.co.id', 'sales@sapharmajaya.co.id',
  ].forEach(term => { if (haystack.includes(term)) score += 5; });
  [
    'sourcing', 'permintaan', 'npd', 'alt', 'reform', 'inquiry',
  ].forEach(term => { if (haystack.includes(term)) score += 3; });
  [
    'inr', 'price', 'rate', 'kg', 'coa', 'msds', 'gmp', 'make', 'manufacturer',
    'source', 'availability', 'lead time', 'target price', 'quantity', 'specification',
  ].forEach(term => { if (haystack.includes(term)) score += 2; });
  if (message.hasAttachments) score += 3;
  return score;
}

export function SourcingOutbox() {
  const { profile } = useAuth();
  const { setCurrentPage, setNavigationData } = useNavigation();
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';
  const canRouteToKunal = profile?.role === 'admin' || profile?.role === 'manager' || profile?.role === 'sales';
  const [section, setSection] = useState<SectionKey>('ai');
  const [tab, setTab] = useState<TabKey>('new');
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [hasGmail, setHasGmail] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [fullscreenRoute, setFullscreenRoute] = useState<'india' | 'china' | null>(null);
  const [search, setSearch] = useState('');
  const [routeFilter, setRouteFilter] = useState<RouteFilter>('all');
  const [customerFilter, setCustomerFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [agingFilter, setAgingFilter] = useState('all');
  const [missingFilter, setMissingFilter] = useState<MissingFilter>('all');
  const [sourceModalRow, setSourceModalRow] = useState<Inquiry | null>(null);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>({
    offered_make: '',
    source_price: '',
    source_currency: 'INR',
    availability: 'available',
    document_status: 'pending',
    remark: '',
  });
  const [savingSource, setSavingSource] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const table = useColumnPreferences('anvi_sourcing_table', ANVI_COLUMNS);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiRows, setAiRows] = useState<AiMailReviewRow[]>([]);
  const [aiScanError, setAiScanError] = useState<string | null>(null);
  const [aiReviewRow, setAiReviewRow] = useState<AiMailReviewRow | null>(null);
  const [aiReviewDraft, setAiReviewDraft] = useState<AiReviewDraft>({
    question: '',
    documentType: 'OTHER',
    notes: '',
    product: '',
    make: '',
    displayFileName: '',
    attachmentId: '',
  });
  const [aiSaving, setAiSaving] = useState(false);
  const [gmailQuery, setGmailQuery] = useState('newer_than:30d');
  const [gmailScanLimit, setGmailScanLimit] = useState(50);
  const [aiSearch, setAiSearch] = useState('');
  const [aiTypeFilter, setAiTypeFilter] = useState<'all' | AiMailType>('all');
  const [selectedAiMessageId, setSelectedAiMessageId] = useState<string | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [sourceExtractionRows, setSourceExtractionRows] = useState<SourceExtractionRow[]>([]);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [companyCo, setCompanyCo] = useState<CompanySnapshot>(FALLBACK_COMPANY);
  const [replyDraft, setReplyDraft] = useState<ReplyDraft>({
    open: false,
    to: '',
    subject: '',
    body: '',
    sending: false,
  });

  // Per-route editable recipients used by the preview modal.
  const [routeRecipients, setRouteRecipients] = useState<Record<SourcingRoute, RouteRecipients>>({
    india: { route: 'india', to: [], cc: [], bcc: [] },
    china: { route: 'china', to: [], cc: [], bcc: [] },
    local: { route: 'local', to: [], cc: [], bcc: [] },
  });
  const [savingDefaults, setSavingDefaults] = useState<SourcingRoute | null>(null);

  // CRM-consistent Gmail-like composer state for India / China actions
  const [crmComposerOpen, setCrmComposerOpen] = useState(false);
  const [crmComposerMode, setCrmComposerMode] = useState<'india' | 'china'>('india');
  const [crmComposerRows, setCrmComposerRows] = useState<Inquiry[]>([]);
  const [crmComposerDefaultTo, setCrmComposerDefaultTo] = useState('');
  const [crmComposerDefaultCc, setCrmComposerDefaultCc] = useState('');

  useEffect(() => {
    supabase
      .from('company_profiles')
      .select('company_name, company_address, company_phone, company_email, company_tax_id, company_logo_url, pbf_license, cdob_certificate')
      .lte('effective_from', new Date().toISOString().split('T')[0])
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data) setCompanyCo(data as CompanySnapshot); });
  }, []);

  useEffect(() => {
    (async () => {
      const all = await loadAllRouteRecipients();
      setRouteRecipients(all);
      const missingRoutes = (['india', 'china'] as const).filter(route => all[route].to.length === 0);
      if (missingRoutes.length > 0) {
        showToast({
          type: 'error',
          title: 'Sourcing recipients not configured',
          message: missingRoutes.map(recipientConfigurationError).join(' '),
        });
      }
    })();
  }, []);

  // Per-route body override (when user edits the body or accepts an AI suggestion).
  const [bodyOverride, setBodyOverride] = useState<Record<'india' | 'china', string | null>>({
    india: null, china: null,
  });
  const [aiBusy, setAiBusy] = useState<'india' | 'china' | null>(null);
  const [aiNotes, setAiNotes] = useState<Record<'india' | 'china', string | null>>({
    india: null, china: null,
  });

  // Reset overrides whenever preview opens/closes
  useEffect(() => {
    if (!previewOpen) {
      setBodyOverride({ india: null, china: null });
      setAiNotes({ india: null, china: null });
    }
  }, [previewOpen]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('crm_inquiries')
      .select('id,inquiry_number,aceerp_no,company_name,product_name,specification,quantity,delivery_date,supplier_name,source_type,source_status,document_status,kunal_price_status,quote_status,pipeline_status,purchase_price,offered_price,price_ready,reminder_count,last_sourcing_sent_at,last_reminder_sent_at,kunal_pricing_requested_at,kunal_pricing_note,remarks,coa_required,coa_sent_at,sample_required,sample_sent_at,price_required,price_sent_at,agency_letter_required,agency_letter_sent_at,others_required,others_sent_at,email_subject,mail_subject,created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      showToast({ type: 'error', title: 'Could not load sourcing rows', message: error.message });
      setInquiries([]);
    } else {
      setInquiries((data as Inquiry[]) || []);
    }
    setSelected(new Set());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      setHasGmail(await userHasConnectedGmail('sales@avira.co.id'));
    })();
  }, []);

  const customerOptions = useMemo(() => {
    return Array.from(new Set(inquiries.map(i => i.company_name).filter(Boolean))).sort();
  }, [inquiries]);

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return inquiries.filter(row => {
      const route = deriveSourceType(row);
      const age = lastContactAge(row);
      const status = row.source_status || 'not_sent';
      const docsPending = row.document_status === 'pending' || row.document_status === 'partial';
      const priceMissing = !row.purchase_price || !row.offered_price || row.kunal_price_status === 'pending';

      if (isCompleted(row) && tab !== 'all') return false;
      if (tab === 'new' && status !== 'not_sent') return false;
      if (tab === 'reminder' && !(['sent', 'waiting_reply', 'partial_received'].includes(status) && age >= REMINDER_DAYS)) return false;
      if (tab === 'partial' && status !== 'partial_received') return false;
      if (tab === 'docs' && !docsPending) return false;
      if (tab === 'all' && isCompleted(row)) return false;

      if (routeFilter !== 'all' && route !== routeFilter) return false;
      if (customerFilter !== 'all' && row.company_name !== customerFilter) return false;
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (agingFilter !== 'all' && age < Number(agingFilter)) return false;
      if (missingFilter === 'price' && !priceMissing) return false;
      if (missingFilter === 'docs' && !docsPending) return false;

      if (term) {
        const haystack = [
          row.inquiry_number,
          row.aceerp_no,
          row.product_name,
          row.company_name,
          row.supplier_name,
          row.specification,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [agingFilter, customerFilter, inquiries, missingFilter, routeFilter, search, statusFilter, tab]);

  const selectedRows = useMemo(() => {
    return visibleRows.filter(row => selected.has(row.id));
  }, [selected, visibleRows]);

  const sendableRows = useMemo(() => {
    return selectedRows.filter(row => {
      const route = deriveSourceType(row);
      return (route === 'india' || route === 'china') && !isCompleted(row);
    });
  }, [selectedRows]);

  const groups = useMemo(() => {
    const grouped: Record<'india' | 'china', Inquiry[]> = { india: [], china: [] };
    for (const row of sendableRows) {
      const route = deriveSourceType(row);
      if (route === 'india' || route === 'china') grouped[route].push(row);
    }
    return grouped;
  }, [sendableRows]);

  const filteredAiRows = useMemo(() => {
    const term = aiSearch.trim().toLowerCase();
    return aiRows.filter(row => {
      if (aiTypeFilter !== 'all' && row.aiType !== aiTypeFilter) return false;
      if (!term) return true;
      const haystack = [
        row.from,
        row.subject,
        row.product,
        row.summary,
        row.suggestedAction,
        row.matchedInquiryNumber,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(term);
    });
  }, [aiRows, aiSearch, aiTypeFilter]);

  const selectedAiRow = useMemo(() => {
    return aiRows.find(row => row.messageId === selectedAiMessageId) || filteredAiRows[0] || null;
  }, [aiRows, filteredAiRows, selectedAiMessageId]);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectFilteredRows = () => setSelected(new Set(visibleRows.map(row => row.id)));
  const clearSelection = () => setSelected(new Set());

  const openInquiry = (id: string) => {
    setNavigationData({ crmInquiryId: id, returnTo: 'sourcing-outbox' });
    setCurrentPage('crm');
  };

  const matchReviewCandidates = async (row: {
    matchedInquiryNumber?: string | null;
    aceerpNo?: string | null;
    product?: string | null;
  }) => {
    const candidates = await findInquiryCandidates({
      inquiry_number: row.matchedInquiryNumber || null,
      aceerp_no: row.aceerpNo || null,
      product_name: row.product || undefined,
    });
    return candidates;
  };

  const scanGmail = async () => {
    setAiScanning(true);
    setAiScanError(null);
    try {
      const { data: listData, error: listError } = await supabase.functions.invoke('gmail-inbox-list', {
        body: {
          account: 'crm',
          emailAddress: 'sales@avira.co.id',
          query: gmailQuery.trim() || 'newer_than:30d',
          maxResults: gmailScanLimit,
        },
      });
      if (listError || !listData?.success) {
        const code = listData?.code || '';
        if (code === 'NO_GMAIL_CONNECTED') throw new Error('No Gmail connected. Connect sales@avira.co.id in Settings first.');
        throw new Error(listData?.error || listError?.message || 'Could not scan Gmail.');
      }

      const listMessages = ((listData.messages || []) as GmailReviewMessage[]).slice(0, gmailScanLimit);
      if (listMessages.length === 0) {
        setAiRows([]);
        showToast({ type: 'info', title: 'No recent emails', message: 'No Gmail messages found for review.' });
        return;
      }

      const messagesRaw = await Promise.all(listMessages.map(async message => {
        const { data } = await supabase.functions.invoke('gmail-inbox-message', {
          body: {
            messageId: message.messageId,
            account: 'crm',
            emailAddress: 'sales@avira.co.id',
          },
        });
        return {
          ...message,
          body: data?.message?.body || message.snippet,
          attachments: data?.message?.attachments || [],
          hasAttachments: data?.message?.hasAttachments ?? message.hasAttachments,
        } as GmailReviewMessage;
      }));
      const messages = messagesRaw
        .filter(message => !shouldSkipEmail(message))
        .sort((a, b) => sourcingPriority(b) - sourcingPriority(a))
        .slice(0, gmailScanLimit);

      const { data: classifyData, error: classifyError } = await supabase.functions.invoke('classify-sourcing-email', {
        body: { emails: messages },
      });
      if (classifyError || !classifyData?.success) {
        throw new Error(classifyData?.error || classifyError?.message || 'AI classification failed.');
      }

      const classified = (classifyData.results || []) as Array<Omit<AiMailReviewRow, keyof GmailReviewMessage | 'candidates' | 'selectedInquiryId' | 'reviewed'> & Pick<GmailReviewMessage, 'messageId' | 'threadId'>>;
      const rows = await Promise.all(messages.map(async message => {
        const result = classified.find(item => item.messageId === message.messageId);
        const candidates = await matchReviewCandidates({
          matchedInquiryNumber: result?.matchedInquiryNumber || null,
          aceerpNo: result?.aceerpNo || null,
          product: result?.product || message.subject,
        });
        return {
          ...message,
          aiType: (result?.aiType || 'Needs Review') as AiMailType,
          product: result?.product || null,
          matchedInquiryNumber: result?.matchedInquiryNumber || candidates[0]?.inquiry_number || null,
          aceerpNo: result?.aceerpNo || candidates[0]?.aceerp_no || null,
          summary: result?.summary || message.snippet || '-',
          suggestedAction: result?.suggestedAction || 'Review this email.',
          confidence: typeof result?.confidence === 'number' ? result.confidence : 0.5,
          extractedQuestion: result?.extractedQuestion || null,
          documentType: result?.documentType || null,
          make: result?.make || null,
          sourceTypeHint: result?.sourceTypeHint || 'india',
          candidates,
          selectedInquiryId: candidates[0]?.id || null,
          reviewed: false,
        } as AiMailReviewRow;
      }));
      setAiRows(rows);
      setSelectedAiMessageId(rows[0]?.messageId || null);
      setSourceExtractionRows([]);
      showToast({ type: 'success', title: 'Gmail scan complete', message: `${rows.length} email${rows.length !== 1 ? 's' : ''} ready for review.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gmail scan failed.';
      setAiScanError(message);
      showToast({ type: 'error', title: 'Scan failed', message });
    } finally {
      setAiScanning(false);
    }
  };

  const openAiReview = (row: AiMailReviewRow) => {
    setAiReviewRow(row);
    setAiReviewDraft({
      question: row.extractedQuestion || '',
      documentType: row.documentType || 'OTHER',
      notes: row.aiType === 'Document / Certificate Received'
        ? `${row.documentType || 'Certificate'} received${row.product ? ` for ${row.product}` : ''}${row.make ? ` / ${row.make}` : ''}`
        : row.summary || '',
      product: row.product || row.candidates[0]?.product_name || '',
      make: row.make || '',
      displayFileName: row.attachments?.[0]?.filename || '',
      attachmentId: row.attachments?.[0]?.attachmentId || '',
    });
  };

  const updateSourceExtractionRow = (index: number, patch: Partial<SourceExtractionRow>) => {
    setSourceExtractionRows(current => current.map((row, idx) => idx === index ? { ...row, ...patch } : row));
  };

  const analyzeEmail = async (row: AiMailReviewRow | null) => {
    if (!row) return;
    setAnalyzingId(row.messageId);
    setSourceExtractionRows([]);
    try {
      if (row.aiType === 'Supplier Price Reply') {
        const result = await parseSourceReplyEmail({
          emailSubject: row.subject,
          emailBody: row.body || row.snippet,
          fromEmail: row.from,
          receivedAt: row.date,
          gmailMessageId: row.messageId,
          gmailThreadId: row.threadId,
          sourceTypeHint: row.sourceTypeHint || 'india',
        });
        if (!result.success) throw new Error(result.error || 'Source reply extraction failed.');
        const extracted = await Promise.all(result.rows.map(async parsed => {
          const candidates = await findInquiryCandidates({
            inquiry_number: parsed.inquiry_number || row.matchedInquiryNumber,
            aceerp_no: parsed.aceerp_no || row.aceerpNo,
            product_name: parsed.product_name || row.product || undefined,
          });
          return {
            ...parsed,
            selectedInquiryId: candidates[0]?.id || row.selectedInquiryId || null,
            candidates,
            saved: false,
            saveError: null,
          } as SourceExtractionRow;
        }));
        setSourceExtractionRows(extracted);
        if (extracted.length === 0) {
          showToast({ type: 'info', title: 'No source rows found', message: 'No supplier price rows were extracted. You can still use Source Details manually.' });
        }
      } else {
        openAiReview(row);
      }
    } catch (error) {
      showToast({ type: 'error', title: 'Analyze failed', message: error instanceof Error ? error.message : 'Could not analyze email.' });
    } finally {
      setAnalyzingId(null);
    }
  };

  const saveSourceExtraction = async () => {
    if (!isManager || !selectedAiRow || sourceExtractionRows.length === 0) return;
    setSourceSaving(true);
    let saved = 0;
    const next = [...sourceExtractionRows];
    for (let i = 0; i < next.length; i += 1) {
      const row = next[i];
      if (row.saved || !row.selectedInquiryId || !row.product_name.trim()) continue;
      const result = await saveSourceReplyRow({
        inquiryId: row.selectedInquiryId,
        sourceType: selectedAiRow.sourceTypeHint || 'india',
        row,
        gmailMessageId: selectedAiRow.messageId,
        gmailThreadId: selectedAiRow.threadId,
        parserConfidence: row.confidence,
        actorId: profile?.id || null,
      });
      if (result.ok) {
        next[i] = { ...row, saved: true, saveError: null };
        saved += 1;
      } else {
        next[i] = { ...row, saveError: result.error || 'Save failed' };
      }
    }
    setSourceExtractionRows(next);
    setSourceSaving(false);
    if (saved > 0) {
      setAiRows(current => current.map(row => row.messageId === selectedAiRow.messageId ? { ...row, reviewed: true } : row));
      showToast({ type: 'success', title: 'Source reply saved', message: `${saved} source option${saved !== 1 ? 's' : ''} saved for Kunal Pricing.` });
      await load();
    }
  };

  const markNoAction = (row: AiMailReviewRow | null) => {
    if (!row) return;
    setAiRows(current => current.map(item => item.messageId === row.messageId ? {
      ...item,
      aiType: 'General / No Action',
      suggestedAction: 'Marked no action by user.',
      reviewed: true,
    } : item));
    setSourceExtractionRows([]);
  };

  const openReply = (row: AiMailReviewRow | null) => {
    if (!row) return;
    setReplyDraft({
      open: true,
      to: extractEmailAddress(row.from),
      subject: /^re:/i.test(row.subject) ? row.subject : `Re: ${row.subject}`,
      body: `Hi,\n\n\n\nRegards,\n${profile?.full_name || ''}`,
      sending: false,
    });
  };

  const sendReply = async () => {
    if (!replyDraft.to.trim()) {
      showToast({ type: 'error', title: 'Missing recipient', message: 'Enter a recipient email.' });
      return;
    }
    setReplyDraft(current => ({ ...current, sending: true }));
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw new Error('No active session');
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-bulk-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.session.access_token}`,
        },
        body: JSON.stringify({
          allowFallback: true,
          workflowType: 'crm_bulk_email',
          toEmails: [replyDraft.to.trim()],
          subject: replyDraft.subject,
          body: replyDraft.body.replace(/\n/g, '<br/>'),
          isHtml: true,
          senderName: profile?.full_name || '',
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || `HTTP ${response.status}`);
      showToast({ type: 'success', title: 'Reply sent', message: `Sent to ${replyDraft.to}.` });
      setReplyDraft({ open: false, to: '', subject: '', body: '', sending: false });
    } catch (error) {
      showToast({ type: 'error', title: 'Reply failed', message: error instanceof Error ? error.message : 'Could not send reply.' });
      setReplyDraft(current => ({ ...current, sending: false }));
    }
  };

  const saveAiReview = async () => {
    if (!aiReviewRow || !aiReviewRow.selectedInquiryId || !isManager) return;
    setAiSaving(true);
    const now = new Date();
    const stamp = now.toLocaleString('en-GB');
    const { data: inquiry, error: fetchError } = await supabase
      .from('crm_inquiries')
      .select('remarks,kunal_pricing_note,document_status')
      .eq('id', aiReviewRow.selectedInquiryId)
      .maybeSingle();

    if (fetchError) {
      setAiSaving(false);
      showToast({ type: 'error', title: 'Could not load inquiry', message: fetchError.message });
      return;
    }

    const existingRemarks = (inquiry?.remarks || '').trim();
    const noteLine = aiReviewRow.aiType === 'India Office Query / Revert Needed'
      ? `[${stamp}] India query: ${aiReviewDraft.question || aiReviewRow.summary}`
      : `[${stamp}] ${aiReviewDraft.documentType} received for ${aiReviewDraft.product || aiReviewRow.product || 'inquiry'}${aiReviewDraft.make ? ` / ${aiReviewDraft.make}` : ''} from email "${aiReviewRow.subject}"`;
    const nextRemarks = [existingRemarks, noteLine].filter(Boolean).join('\n');

    const patch: Record<string, unknown> = {
      remarks: nextRemarks,
      updated_at: new Date().toISOString(),
    };
    if (aiReviewRow.aiType === 'Document / Certificate Received') {
      patch.document_status = inquiry?.document_status === 'partial' ? 'partial' : 'received';
    }
    if (aiReviewRow.aiType === 'India Office Query / Revert Needed') {
      patch.kunal_pricing_note = [inquiry?.kunal_pricing_note, noteLine].filter(Boolean).join('\n');
    }

    const { error: updateError } = await supabase
      .from('crm_inquiries')
      .update(patch)
      .eq('id', aiReviewRow.selectedInquiryId);

    if (updateError) {
      setAiSaving(false);
      showToast({ type: 'error', title: 'Save failed', message: updateError.message });
      return;
    }

    if (aiReviewRow.aiType === 'Document / Certificate Received' && aiReviewDraft.attachmentId) {
      const attachment = aiReviewRow.attachments?.find(att => att.attachmentId === aiReviewDraft.attachmentId);
      const { data: attachmentData, error: attachmentError } = await supabase.functions.invoke('gmail-attachment-save', {
        body: {
          messageId: aiReviewRow.messageId,
          threadId: aiReviewRow.threadId,
          attachmentId: aiReviewDraft.attachmentId,
          originalFileName: attachment?.filename || aiReviewDraft.displayFileName || 'document',
          displayFileName: aiReviewDraft.displayFileName || attachment?.filename || 'document',
          mimeType: attachment?.mimeType || 'application/octet-stream',
          inquiryId: aiReviewRow.selectedInquiryId,
          productName: aiReviewDraft.product || aiReviewRow.product || 'product',
          make: aiReviewDraft.make || aiReviewRow.make || null,
          documentType: aiReviewDraft.documentType,
          sourceEmailSubject: aiReviewRow.subject,
        },
      });
      if (attachmentError || !attachmentData?.success) {
        setAiSaving(false);
        showToast({ type: 'error', title: 'Attachment save failed', message: attachmentData?.error || attachmentData?.code || attachmentError?.message || 'Could not save Gmail attachment.' });
        return;
      }
    }

    await Promise.resolve(supabase.from('email_inquiry_links').insert({
      gmail_message_id: aiReviewRow.messageId,
      gmail_thread_id: aiReviewRow.threadId,
      inquiry_id: aiReviewRow.selectedInquiryId,
      link_type: 'generic',
      parser_confidence: aiReviewRow.confidence,
      created_by: profile?.id || null,
    })).catch(() => {});

    await Promise.resolve(supabase.from('crm_inquiry_timeline').insert({
      inquiry_id: aiReviewRow.selectedInquiryId,
      event_type: aiReviewRow.aiType === 'Document / Certificate Received' ? 'document_received_from_email' : 'india_query_received',
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: noteLine,
      metadata: {
        gmail_message_id: aiReviewRow.messageId,
        gmail_thread_id: aiReviewRow.threadId,
        ai_type: aiReviewRow.aiType,
        document_type: aiReviewDraft.documentType,
      },
    })).catch(() => {});

    setAiRows(current => current.map(row => row.messageId === aiReviewRow.messageId ? { ...row, reviewed: true } : row));
    setAiReviewRow(null);
    setAiSaving(false);
    showToast({ type: 'success', title: 'Review saved', message: aiReviewRow.aiType === 'Document / Certificate Received' ? 'Document note linked to inquiry.' : 'India query added to inquiry notes.' });
    await load();
  };

  const openSourceModal = (row: Inquiry) => {
    setSourceModalRow(row);
    setSourceDraft({
      offered_make: row.supplier_name || '',
      source_price: '',
      source_currency: 'INR',
      availability: 'available',
      document_status: row.document_status === 'received' || row.document_status === 'partial' || row.document_status === 'not_required'
        ? row.document_status
        : 'pending',
      remark: '',
    });
  };

  const saveSourceDetails = async () => {
    if (!sourceModalRow || !canRouteToKunal) return;
    const route = deriveSourceType(sourceModalRow);
    const price = sourceDraft.source_price.trim() ? parseFloat(sourceDraft.source_price) : null;
    if (price !== null && !Number.isFinite(price)) {
      showToast({ type: 'error', title: 'Invalid INR price', message: 'Enter a valid source price.' });
      return;
    }

    setSavingSource(true);
    const now = new Date().toISOString();
    const optionPatch = {
      source_type: route,
      offered_make: sourceDraft.offered_make || null,
      source_price: price,
      source_currency: sourceDraft.source_currency || 'INR',
      availability: sourceDraft.availability,
      document_status: sourceDraft.document_status,
      remark: sourceDraft.remark || null,
      updated_at: now,
    };
    const { data: existingOption, error: existingOptionError } = await supabase
      .from('crm_inquiry_pricing_options')
      .select('id')
      .eq('inquiry_id', sourceModalRow.id)
      .eq('source_type', route)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingOptionError) {
      setSavingSource(false);
      showToast({ type: 'error', title: 'Could not load source details', message: existingOptionError.message });
      return;
    }

    const { error: optionError } = existingOption?.id
      ? await supabase
        .from('crm_inquiry_pricing_options')
        .update(optionPatch)
        .eq('id', existingOption.id)
      : await supabase
        .from('crm_inquiry_pricing_options')
        .insert({
          inquiry_id: sourceModalRow.id,
          ...optionPatch,
          created_by: profile?.id || null,
        });

    if (optionError) {
      setSavingSource(false);
      showToast({ type: 'error', title: 'Could not save source details', message: optionError.message });
      return;
    }

    const nextSourceStatus = sourceDraft.availability === 'partial' ? 'partial_received' : 'received';
    const { error: inquiryError } = await supabase
      .from('crm_inquiries')
      .update({
        source_status: nextSourceStatus,
        document_status: sourceDraft.document_status,
        kunal_price_status: 'pending',
        updated_at: now,
      })
      .eq('id', sourceModalRow.id);

    if (inquiryError) {
      setSavingSource(false);
      showToast({ type: 'error', title: 'Source saved, CRM sync failed', message: inquiryError.message });
      return;
    }

    await Promise.resolve(supabase.from('crm_inquiry_timeline').insert({
      inquiry_id: sourceModalRow.id,
      event_type: 'source_reply_updated',
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: `Source reply updated: ${sourceDraft.source_currency || 'INR'} ${sourceDraft.source_price || '-'}${sourceDraft.offered_make ? `, ${sourceDraft.offered_make}` : ''}`,
      metadata: {
        source_type: route,
        offered_make: sourceDraft.offered_make || null,
        source_price: price,
        source_currency: sourceDraft.source_currency || 'INR',
        availability: sourceDraft.availability,
        document_status: sourceDraft.document_status,
      },
    })).catch(() => {});

    setSavingSource(false);
    setSourceModalRow(null);
    showToast({ type: 'success', title: 'Source details saved', message: `${sourceModalRow.inquiry_number} is ready for Kunal Pricing.` });
    await load();
  };

  const buildEmailBody = (rows: Inquiry[], route: 'india' | 'china') => {
    if (route === 'india') return buildIndiaRfqEmail(rows, companyCo);
    const sections: string[] = [`Hi China Team,`];

    const newRows = rows.filter(row => row.source_status === 'not_sent');
    const reminderRows = rows.filter(row => row.source_status !== 'not_sent' && row.document_status !== 'pending');
    const docsRows = rows.filter(row => row.document_status === 'pending' || row.document_status === 'partial');

    if (newRows.length > 0) {
      sections.push('\nNew Inquiries');
      sections.push(newRows.map(row =>
        `- ${row.aceerp_no || '-'} | ${row.inquiry_number} | ${row.product_name}${row.specification ? ` (${row.specification})` : ''} | Qty ${row.quantity || '-'} | Preferred: ${row.supplier_name || '-'} | Customer: ${row.company_name}`
      ).join('\n'));
    }

    if (reminderRows.length > 0) {
      sections.push('\nReminder');
      sections.push(reminderRows.map(row =>
        `- ${row.aceerp_no || '-'} | ${row.inquiry_number} | ${row.product_name} | Pending ${lastContactAge(row)}d | Reminder #${(row.reminder_count ?? 0) + 1} | Pending: ${pendingLabel(row)}`
      ).join('\n'));
    }

    if (docsRows.length > 0) {
      sections.push('\nDocs Pending');
      sections.push(docsRows.map(row =>
        `- ${row.aceerp_no || '-'} | ${row.inquiry_number} | ${row.product_name} | Document status: ${row.document_status}`
      ).join('\n'));
    }

    sections.push('\nPlease share unit price, availability/lead time, and COA/MSDS status where applicable.');
    sections.push('\nThanks & regards');
    return sections.join('\n');
  };

  const previewBodies = useMemo(() => ({
    india: groups.india.length ? buildEmailBody(groups.india, 'india') : '',
    china: groups.china.length ? buildEmailBody(groups.china, 'china') : '',
  }), [companyCo, groups]);

  const sendGroup = async (route: 'india' | 'china') => {
    const rows = groups[route];
    if (rows.length === 0) return { ok: true, skipped: true };
    const recips = routeRecipients[route];
    if (!recips || recips.to.length === 0) {
      return { ok: false, error: `No recipient email set for ${route}. Edit recipients in the preview before sending.`, route };
    }
    const hasNew = rows.some(row => row.source_status === 'not_sent');
    const subject = route === 'india'
      ? buildIndiaRfqSubject(rows)
      : hasNew
        ? `Sourcing Request - ${rows.length} item${rows.length !== 1 ? 's' : ''}`
        : `Reminder - ${rows.length} pending item${rows.length !== 1 ? 's' : ''}`;

    const result = await sendPricingWorkflowEmail({
      workflowType: hasNew ? 'sourcing_request' : 'sourcing_reminder',
      module: 'crm',
      requiredSenderEmail: 'sales@avira.co.id',
      sourceType: route,
      to: recips.to,
      cc: recips.cc,
      bcc: recips.bcc,
      subject,
      body: route === 'india'
        ? (bodyOverride[route] ?? buildEmailBody(rows, route))
        : (bodyOverride[route] ?? buildEmailBody(rows, route)).replace(/\n/g, '<br/>'),
      isHtml: true,
      senderName: profile?.full_name || '',
      recordThread: false,
    });

    if (!result.success) return { ok: false, error: result.error, route };

    const now = new Date().toISOString();
    for (const row of rows) {
      const wasNew = row.source_status === 'not_sent';
      const patch: Record<string, unknown> = {
        source_status: wasNew ? 'sent' : 'waiting_reply',
        updated_at: now,
      };
      if (wasNew) patch.last_sourcing_sent_at = now;
      else {
        patch.last_reminder_sent_at = now;
        patch.reminder_count = (row.reminder_count ?? 0) + 1;
      }
      await supabase.from('crm_inquiries').update(patch).eq('id', row.id);
      await Promise.resolve(supabase.from('crm_inquiry_timeline').insert({
        inquiry_id: row.id,
        event_type: wasNew ? 'sourcing_request_sent' : 'reminder_sent',
        actor_id: profile?.id || null,
        actor_name: profile?.full_name || profile?.username || null,
        description: wasNew
          ? `Sourcing request sent to ${recips.to.join(', ')}`
          : `Reminder sent to ${recips.to.join(', ')}`,
        metadata: {
          source_type: route,
          to: recips.to,
          cc: recips.cc,
          bcc: recips.bcc,
          subject,
          sender_mode: result.senderMode,
          gmail_message_id: result.messageId,
          gmail_thread_id: result.threadId,
        },
      })).catch(() => {});
    }
    return { ok: true, route, count: rows.length, senderMode: result.senderMode };
  };

  const setRouteField = (route: SourcingRoute, field: 'to' | 'cc' | 'bcc', next: string[]) => {
    setRouteRecipients(prev => ({ ...prev, [route]: { ...prev[route], [field]: next } }));
  };

  const saveRouteDefaults = async (route: SourcingRoute) => {
    if (!isManager) return;
    setSavingDefaults(route);
    const res = await saveRouteRecipients(routeRecipients[route], profile?.id || null);
    setSavingDefaults(null);
    if (!res.ok) {
      showToast({ type: 'error', title: 'Save failed', message: res.error || 'Unknown error' });
    } else {
      showToast({ type: 'success', title: 'Defaults saved', message: `Updated ${route} recipients.` });
    }
  };

  const improveWithAi = async (route: 'india' | 'china') => {
    const rows = groups[route];
    if (rows.length === 0) return;
    const currentBody = bodyOverride[route] ?? buildEmailBody(rows, route);
    const hasNew = rows.some(row => row.source_status === 'not_sent');
    const subject = route === 'india'
      ? buildIndiaRfqSubject(rows)
      : hasNew
        ? `Sourcing Request - ${rows.length} item${rows.length !== 1 ? 's' : ''}`
        : `Reminder - ${rows.length} pending item${rows.length !== 1 ? 's' : ''}`;
    const protectedTokens = extractProtectedTokens(currentBody);

    setAiBusy(route);
    setAiNotes(prev => ({ ...prev, [route]: null }));
    const res = await aiImproveEmail({
      purpose: hasNew ? 'sourcing_request' : 'sourcing_reminder',
      subject,
      body: currentBody,
      protectedTokens,
      tone: 'professional',
    });
    setAiBusy(null);
    if (!res.success) {
      if (res.code === 'NO_OPENAI_KEY') {
        showToast({ type: 'info', title: 'AI not configured', message: 'OPENAI_API_KEY missing. Manual editor still works.' });
      } else {
        showToast({ type: 'error', title: 'AI improve failed', message: res.error || 'Unknown error' });
      }
      return;
    }
    if (res.warnings && res.warnings.length > 0) {
      showToast({
        type: 'warning',
        title: 'AI changed something protected',
        message: res.warnings.join(' · '),
      });
      return;
    }
    if (res.body) {
      setBodyOverride(prev => ({ ...prev, [route]: res.body || prev[route] }));
      setAiNotes(prev => ({ ...prev, [route]: res.notes || 'Updated by AI assistant' }));
    }
  };

  const confirmSend = async () => {
    if (!isManager) {
      showToast({ type: 'error', title: 'Not allowed', message: 'Only admin/manager can send sourcing emails.' });
      return;
    }
    if (sendableRows.length === 0) {
      showToast({ type: 'error', title: 'Nothing sendable', message: 'Select pending India/China rows that are not completed.' });
      return;
    }

    setSending(true);
    const results = [await sendGroup('india'), await sendGroup('china')];
    setSending(false);
    setPreviewOpen(false);

    const errors = results.filter(result => !result.ok);
    if (errors.length > 0) {
      showToast({ type: 'error', title: 'Some sends failed', message: errors.map(e => `${e.route}: ${e.error}`).join(' · ') });
    } else {
      const summary = results.filter(r => r.ok && !r.skipped).map(r => `${r.route}: ${r.count}`).join(' · ');
      showToast({ type: 'success', title: 'Sourcing email sent', message: summary || 'Nothing to send.' });
    }
    await load();
  };

  const handleSendToIndiaFromOutbox = async () => {
    const selected = selectedRows;
    if (selected.length === 0) {
      showToast({ type: 'error', title: 'No Selection', message: 'Select at least one inquiry row.' });
      return;
    }
    const indiaSelected = selected.filter(i => deriveSourcingRoute(i) === 'india');
    if (indiaSelected.length === 0) {
      showToast({ type: 'error', title: 'No India Route', message: 'None of the selected inquiries are routed to India.' });
      return;
    }
    const recipients = (await loadAllRouteRecipients()).india;
    if (recipients.to.length === 0) {
      showToast({ type: 'error', title: 'Send To India unavailable', message: recipientConfigurationError('india') });
      return;
    }
    setCrmComposerRows(indiaSelected);
    setCrmComposerDefaultTo(recipients.to.join(', '));
    setCrmComposerDefaultCc(recipients.cc.length > 0 ? recipients.cc.join(', ') : 'devansh@shubham.co.in');
    setCrmComposerMode('india');
    setCrmComposerOpen(true);
  };

  const handleSendToChinaFromOutbox = async () => {
    const selected = selectedRows;
    if (selected.length === 0) {
      showToast({ type: 'error', title: 'No Selection', message: 'Select at least one inquiry row.' });
      return;
    }
    const chinaSelected = selected.filter(i => deriveSourcingRoute(i) === 'china');
    if (chinaSelected.length === 0) {
      showToast({ type: 'error', title: 'No China Route', message: 'None of the selected inquiries are routed to China.' });
      return;
    }
    const recipients = (await loadAllRouteRecipients()).china;
    if (recipients.to.length === 0) {
      showToast({ type: 'error', title: 'Send To China Team unavailable', message: recipientConfigurationError('china') });
      return;
    }
    setCrmComposerRows(chinaSelected);
    setCrmComposerDefaultTo(recipients.to.join(', '));
    setCrmComposerDefaultCc(recipients.cc.join(', '));
    setCrmComposerMode('china');
    setCrmComposerOpen(true);
  };

  const markSelectedForKunal = async () => {
    if (!canRouteToKunal || selectedRows.length === 0) return;
    const now = new Date().toISOString();
    const rows = selectedRows.filter(row => row.pipeline_status !== 'won' && row.pipeline_status !== 'lost');
    if (rows.length === 0) {
      showToast({ type: 'error', title: 'Nothing to send', message: 'Completed won/lost rows are skipped.' });
      return;
    }

    const ids = rows.map(row => row.id);
    const { error } = await supabase
      .from('crm_inquiries')
      .update({
        kunal_price_status: 'pending',
        price_ready: false,
        kunal_pricing_requested_at: now,
        kunal_pricing_requested_by: profile?.id || null,
        kunal_pricing_note: 'Marked for Kunal review from Sourcing Outbox',
        updated_at: now,
      })
      .in('id', ids);

    if (error) {
      showToast({ type: 'error', title: 'Could not route to Kunal', message: error.message });
      return;
    }

    await Promise.all(rows.map(row => Promise.resolve(supabase.from('crm_inquiry_timeline').insert({
      inquiry_id: row.id,
      event_type: 'sent_to_kunal_pricing',
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: 'Marked for Kunal review',
      metadata: { source: 'sourcing_outbox' },
    })).catch(() => {})));

    showToast({ type: 'success', title: 'Marked for Kunal Review', message: `${rows.length} inquiry row${rows.length !== 1 ? 's' : ''} flagged. Source price/docs come from Source Details or Kunal AI Review & Save.` });
    await load();
  };

  return (
    <Layout>
      <div className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Anvi Sourcing</h1>
            <p className="text-xs text-gray-500 mt-0.5">Work directly from CRM inquiry rows. India and China emails are grouped separately before send.</p>
          </div>
          <button onClick={load} className="p-1.5 rounded hover:bg-gray-100 text-gray-500" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className={`mb-3 text-[11px] rounded px-2.5 py-1.5 border ${hasGmail ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
          {hasGmail === null ? 'Checking sender...' : hasGmail ? 'Sending from your connected Gmail.' : 'Using company fallback sender because your Gmail is not connected.'}
        </div>

        <div className="mb-3 bg-white border border-gray-200 rounded-lg px-2 py-1.5 flex flex-wrap gap-1.5">
          {[
            ['ai', 'AI Mail Review'],
            ['sheet', 'Sourcing Sheet'],
            ['preview', 'Preview & Send'],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSection(key as SectionKey)}
              className={`px-3 py-1.5 text-xs rounded font-medium ${section === key ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {section === 'ai' && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-3">
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">AI Mail Review</h2>
                <p className="text-[11px] text-gray-500">Read Gmail, analyze one email, edit extracted data, then confirm save.</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input name="gmail_query" aria-label="Gmail query, e.g. newer_than:30d"
                  value={gmailQuery}
                  onChange={e => setGmailQuery(e.target.value)}
                  placeholder="Gmail query, e.g. newer_than:30d"
                  className="w-64 max-w-full border border-gray-200 rounded px-2 py-1 text-xs"
                />
                <select name="gmail_scan_limit" aria-label="Gmail Scan Limit"
                  value={gmailScanLimit}
                  onChange={e => setGmailScanLimit(Number(e.target.value))}
                  className="border border-gray-200 rounded px-2 py-1 text-xs"
                >
                  {[25, 50, 100].map(limit => <option key={limit} value={limit}>{limit} emails</option>)}
                </select>
              <button
                onClick={scanGmail}
                disabled={aiScanning}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {aiScanning ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Scan Gmail
              </button>
              </div>
            </div>
            {aiScanError && (
              <div className="m-3 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded px-3 py-2">
                {aiScanError}
              </div>
            )}
            {aiRows.length === 0 && !aiScanning ? (
              <div className="py-10 text-center text-sm text-gray-500">
                No scanned emails yet. Click Scan Gmail to review recent supplier and sourcing messages.
              </div>
            ) : (
              <div className="space-y-3 p-3">
                <div className="border border-gray-200 rounded overflow-hidden bg-white">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-gray-900">AI Extraction Queue</h3>
                      <p className="text-[11px] text-gray-500">Main decision list. Review rows here, then read the original email below.</p>
                    </div>
                    <span className="text-[11px] text-gray-500">{filteredAiRows.length} shown</span>
                  </div>
                  <div className="overflow-x-auto max-h-[260px] overflow-y-auto">
                    <table className="w-full table-fixed text-xs">
                      <thead className="sticky top-0 z-10 bg-gray-100 border-b border-gray-300">
                        <tr>
                          {[
                            ['Date', 'w-[92px]'],
                            ['From', 'w-[170px]'],
                            ['Subject', 'w-[220px]'],
                            ['AI Type', 'w-[170px]'],
                            ['Matched Inquiry', 'w-[180px]'],
                            ['Product', 'w-[180px]'],
                            ['Summary', 'w-[240px]'],
                            ['Suggested Action', 'w-[220px]'],
                            ['Confidence', 'w-[90px]'],
                            ['Review', 'w-[90px]'],
                          ].map(([label, width]) => (
                            <th key={label} className={`${width} px-2 py-1.5 text-left text-[10px] font-bold uppercase text-gray-700 border-r border-gray-300 whitespace-nowrap`}>
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredAiRows.map(row => (
                          <tr key={row.messageId} className={`hover:bg-blue-50 ${selectedAiRow?.messageId === row.messageId ? 'bg-blue-50' : row.reviewed ? 'bg-green-50/40' : ''}`}>
                            <td className="px-2 py-1 border-r border-gray-200 whitespace-nowrap">{formatDate(row.date)}</td>
                            <td className="px-2 py-1 border-r border-gray-200 truncate" title={row.from}>{row.from || '-'}</td>
                            <td className="px-2 py-1 border-r border-gray-200 truncate" title={row.subject}>
                              <button onClick={() => setSelectedAiMessageId(row.messageId)} className="text-left hover:underline">
                                {row.subject || '(No subject)'} {row.hasAttachments ? <Paperclip className="w-3 h-3 inline text-gray-400" /> : null}
                              </button>
                            </td>
                            <td className="px-2 py-1 border-r border-gray-200">
                              <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                row.aiType === 'Supplier Price Reply' ? 'bg-emerald-50 text-emerald-700'
                                  : row.aiType === 'India Office Query / Revert Needed' ? 'bg-amber-50 text-amber-700'
                                  : row.aiType === 'Document / Certificate Received' ? 'bg-sky-50 text-sky-700'
                                  : 'bg-slate-50 text-slate-700'
                              }`}>{row.aiType}</span>
                            </td>
                            <td className="px-2 py-1 border-r border-gray-200">
                              {row.candidates.length > 0 ? (
                                <select name="selectedInquiryId" aria-label="SelectedInquiryId"
                                  value={row.selectedInquiryId || ''}
                                  onChange={e => setAiRows(current => current.map(item => item.messageId === row.messageId ? { ...item, selectedInquiryId: e.target.value || null } : item))}
                                  className="w-full border border-gray-200 rounded px-1 py-0.5 text-[11px]"
                                >
                                  <option value="">Needs product link</option>
                                  {row.candidates.map(candidate => (
                                    <option key={candidate.id} value={candidate.id}>
                                      {candidate.inquiry_number} · {candidate.product_name}
                                    </option>
                                  ))}
                                </select>
                              ) : <span className="text-amber-700">Needs product link</span>}
                            </td>
                            <td className="px-2 py-1 border-r border-gray-200 truncate" title={row.product || ''}>{row.product || '-'}</td>
                            <td className="px-2 py-1 border-r border-gray-200 truncate" title={row.summary}>{row.summary}</td>
                            <td className="px-2 py-1 border-r border-gray-200 truncate" title={row.suggestedAction}>{row.suggestedAction}</td>
                            <td className="px-2 py-1 border-r border-gray-200 whitespace-nowrap">{Math.round(row.confidence * 100)}%</td>
                            <td className="px-2 py-1 whitespace-nowrap">
                              <button
                                onClick={() => {
                                  setSelectedAiMessageId(row.messageId);
                                  if (row.aiType === 'Supplier Price Reply') analyzeEmail(row);
                                  else openAiReview(row);
                                }}
                                className="px-2 py-1 text-[11px] border border-gray-200 rounded hover:bg-white"
                              >
                                {row.reviewed ? 'Reviewed' : 'Review'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="border border-gray-200 rounded overflow-hidden bg-white">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                    <h3 className="text-xs font-semibold text-gray-900">Gmail Inbox View</h3>
                  </div>
              <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] h-[680px]">
                <div className="border-r border-gray-200 bg-gray-50/40 flex flex-col min-h-[620px]">
                  <div className="p-2 border-b border-gray-200 space-y-2">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1.5" />
                      <input name="ai_search" aria-label="Search sender, subject, product"
                        value={aiSearch}
                        onChange={e => setAiSearch(e.target.value)}
                        placeholder="Search sender, subject, product"
                        className="pl-7 pr-2 py-1 text-xs border border-gray-200 rounded w-full"
                      />
                    </div>
                    <select name="ai_type_filter" aria-label="Ai Type Filter" value={aiTypeFilter} onChange={e => setAiTypeFilter(e.target.value as typeof aiTypeFilter)}
                      className="w-full text-xs border border-gray-200 rounded px-2 py-1">
                      <option value="all">All AI types</option>
                      <option value="Supplier Price Reply">Supplier Price Reply</option>
                      <option value="India Office Query / Revert Needed">India Query / Revert Needed</option>
                      <option value="Document / Certificate Received">Documents / Certificates</option>
                      <option value="Needs Review">Needs Review</option>
                      <option value="General / No Action">No Action</option>
                    </select>
                  </div>
                  <div className="overflow-y-auto flex-1 min-h-0">
                    {filteredAiRows.map(row => (
                      <button
                        key={row.messageId}
                        onClick={() => {
                          setSelectedAiMessageId(row.messageId);
                          setSourceExtractionRows([]);
                        }}
                        className={`w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-white ${selectedAiRow?.messageId === row.messageId ? 'bg-white border-l-2 border-l-blue-600' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-xs text-gray-900 truncate flex-1">{row.from || '-'}</span>
                          {row.hasAttachments && <Paperclip className="w-3 h-3 text-gray-400" />}
                          <span className="text-[10px] text-gray-500 whitespace-nowrap">{formatDate(row.date)}</span>
                        </div>
                        <div className="text-xs text-gray-700 truncate mt-0.5">{row.subject || '(No subject)'}</div>
                        <div className="flex items-center gap-1 mt-1">
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            row.aiType === 'Supplier Price Reply' ? 'bg-emerald-50 text-emerald-700'
                              : row.aiType === 'India Office Query / Revert Needed' ? 'bg-amber-50 text-amber-700'
                              : row.aiType === 'Document / Certificate Received' ? 'bg-sky-50 text-sky-700'
                              : 'bg-slate-50 text-slate-700'
                          }`}>{row.aiType}</span>
                          {row.reviewed && <span className="text-[10px] text-green-700">reviewed</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col min-w-0 min-h-0">
                  {selectedAiRow ? (
                    <>
                      <div className="border-b border-gray-200 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-gray-900 truncate">{selectedAiRow.subject}</h3>
                            <p className="text-[11px] text-gray-500 mt-0.5">From: {selectedAiRow.from} · {selectedAiRow.date}</p>
                            <p className="text-[11px] text-gray-500">To: {selectedAiRow.to || '-'}</p>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap justify-end">
                            <button onClick={() => openReply(selectedAiRow)}
                              className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-50">
                              Reply
                            </button>
                            <button disabled
                              className="px-3 py-1.5 text-xs border border-gray-200 rounded text-gray-400 cursor-not-allowed"
                              title="Forward can be added safely once attachment forwarding is defined.">
                              Forward
                            </button>
                            <button onClick={() => analyzeEmail(selectedAiRow)} disabled={analyzingId === selectedAiRow.messageId}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                              {analyzingId === selectedAiRow.messageId ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                              Analyze This Email
                            </button>
                            <button onClick={() => markNoAction(selectedAiRow)}
                              className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-50">
                              Mark No Action
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="grid xl:grid-cols-[minmax(0,1fr)_430px] flex-1 min-h-0">
                        <div className="p-3 overflow-y-auto min-h-0 h-full">
                          <div className="text-[11px] text-gray-500 mb-2">Full email body</div>
                          <pre className="whitespace-pre-wrap text-xs text-gray-800 font-sans bg-white border border-gray-200 rounded p-3 min-h-[360px] max-h-[470px] overflow-auto">
                            {selectedAiRow.body || selectedAiRow.snippet || 'No body returned for this email.'}
                          </pre>
                          <div className="mt-3">
                            <div className="text-[11px] text-gray-500 mb-1">Attachments</div>
                            {selectedAiRow.attachments && selectedAiRow.attachments.length > 0 ? (
                              <div className="space-y-1">
                                {selectedAiRow.attachments.map(att => (
                                  <div key={att.attachmentId} className="flex items-center gap-2 text-xs border border-gray-200 rounded px-2 py-1">
                                    <Paperclip className="w-3.5 h-3.5 text-gray-400" />
                                    <span className="font-medium text-gray-800 flex-1 truncate">{att.filename}</span>
                                    <span className="text-gray-500">{att.mimeType}</span>
                                    <span className="text-gray-500">{att.size ? `${Math.round(att.size / 1024)} KB` : '-'}</span>
                                    <button disabled className="inline-flex items-center gap-1 text-gray-400 cursor-not-allowed" title="Available after confirm save uploads the private document">
                                      <Eye className="w-3 h-3" /> View
                                    </button>
                                    <button disabled className="inline-flex items-center gap-1 text-gray-400 cursor-not-allowed" title="Available after confirm save uploads the private document">
                                      <Download className="w-3 h-3" /> Download
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-xs text-gray-500 border border-gray-200 rounded px-2 py-2">No attachments found.</div>
                            )}
                          </div>
                        </div>

                        <div className="border-l border-gray-200 bg-gray-50/40 p-3 overflow-y-auto min-h-0 h-full">
                          <h3 className="text-xs font-semibold text-gray-900 mb-2">Extraction Review</h3>
                          {selectedAiRow.aiType === 'Supplier Price Reply' ? (
                            <div className="space-y-2">
                              {sourceExtractionRows.length === 0 ? (
                                <div className="text-xs text-gray-500 border border-gray-200 rounded bg-white p-3">
                                  Click Analyze This Email to extract source price rows.
                                </div>
                              ) : (
                                <>
                                  {sourceExtractionRows.map((row, idx) => (
                                    <div key={idx} className="bg-white border border-gray-200 rounded p-2 space-y-1.5">
                                      <select name="selectedInquiryId" aria-label="SelectedInquiryId" value={row.selectedInquiryId || ''}
                                        onChange={e => updateSourceExtractionRow(idx, { selectedInquiryId: e.target.value || null })}
                                        className="w-full border border-gray-200 rounded px-2 py-1 text-xs">
                                        <option value="">Matched Inquiry No</option>
                                        {row.candidates.map(candidate => (
                                          <option key={candidate.id} value={candidate.id}>
                                            {candidate.inquiry_number} · {candidate.aceerp_no || '-'} · {candidate.product_name}
                                          </option>
                                        ))}
                                      </select>
                                      <div className="grid grid-cols-2 gap-1.5">
                                        <input name="aceerp_no" aria-label="AC ERP#" value={row.aceerp_no || ''} onChange={e => updateSourceExtractionRow(idx, { aceerp_no: e.target.value || null })} placeholder="AC ERP#" className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                        <input name="quantity" aria-label="Qty" value={row.quantity || ''} onChange={e => updateSourceExtractionRow(idx, { quantity: e.target.value || null })} placeholder="Qty" className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                      </div>
                                      <input name="product_name" aria-label="Product" value={row.product_name} onChange={e => updateSourceExtractionRow(idx, { product_name: e.target.value })} placeholder="Product" className="w-full border border-gray-200 rounded px-2 py-1 text-xs" />
                                      <div className="grid grid-cols-2 gap-1.5">
                                        <input name="offered_make" aria-label="Offered Make / Manufacturer" value={row.offered_make || ''} onChange={e => updateSourceExtractionRow(idx, { offered_make: e.target.value || null })} placeholder="Offered Make / Manufacturer" className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                        <div className="flex gap-1">
                                          <MoneyInput value={row.source_price} onChange={amount => updateSourceExtractionRow(idx, { source_price: amount || null })} placeholder="INR Rate / Source Price" className="min-w-0 flex-1 border border-gray-200 rounded px-2 py-1 text-xs" maximumFractionDigits={4} />
                                          <select name="source_currency" aria-label="Source Currency" value={row.source_currency} onChange={e => updateSourceExtractionRow(idx, { source_currency: e.target.value })} className="w-16 border border-gray-200 rounded px-1 py-1 text-xs">
                                            {['INR','USD','CNY','IDR','EUR','GBP'].map(currency => <option key={currency}>{currency}</option>)}
                                          </select>
                                        </div>
                                      </div>
                                      <div className="grid grid-cols-2 gap-1.5">
                                        <select name="availability" aria-label="Availability" value={row.availability} onChange={e => updateSourceExtractionRow(idx, { availability: e.target.value as ParsedSourceRow['availability'] })} className="border border-gray-200 rounded px-2 py-1 text-xs">
                                          {['available','partial','na'].map(value => <option key={value}>{value}</option>)}
                                        </select>
                                        <select name="document_status" aria-label="Document Status" value={row.document_status} onChange={e => updateSourceExtractionRow(idx, { document_status: e.target.value as ParsedSourceRow['document_status'] })} className="border border-gray-200 rounded px-2 py-1 text-xs">
                                          {['pending','received','partial','not_required'].map(value => <option key={value}>{value}</option>)}
                                        </select>
                                      </div>
                                      <input name="lead_time" aria-label="Availability / Lead Time" value={row.lead_time || ''} onChange={e => updateSourceExtractionRow(idx, { lead_time: e.target.value || null })} placeholder="Availability / Lead Time" className="w-full border border-gray-200 rounded px-2 py-1 text-xs" />
                                      <textarea name="remark" aria-label="Remarks / India Comments" value={row.remark || ''} onChange={e => updateSourceExtractionRow(idx, { remark: e.target.value || null })} placeholder="Remarks / India Comments" className="w-full border border-gray-200 rounded px-2 py-1 text-xs min-h-[54px]" />
                                      <div className="flex justify-between text-[10px] text-gray-500">
                                        <span>Confidence {Math.round(row.confidence * 100)}%</span>
                                        {row.saved && <span className="text-green-700">saved</span>}
                                        {row.saveError && <span className="text-red-700">{row.saveError}</span>}
                                      </div>
                                    </div>
                                  ))}
                                  <button onClick={saveSourceExtraction} disabled={sourceSaving || !isManager}
                                    className="w-full px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                                    {sourceSaving ? 'Saving...' : 'Confirm Save Source Reply'}
                                  </button>
                                </>
                              )}
                            </div>
                          ) : (
                            <div className="text-xs text-gray-600 space-y-2">
                              <p>{selectedAiRow.suggestedAction}</p>
                              <button onClick={() => openAiReview(selectedAiRow)}
                                className="w-full px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
                                Review & Save
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="p-8 text-center text-sm text-gray-500">Select an email to review.</div>
                  )}
                </div>
              </div>
                </div>
              </div>
            )}
          </div>
        )}

        {section === 'preview' && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Preview & Send</h2>
                <p className="text-[11px] text-gray-500">Select rows in Sourcing Sheet first. Sending still requires the existing preview confirmation.</p>
              </div>
              <button onClick={() => setPreviewOpen(true)} disabled={sending || !isManager || sendableRows.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                <Mail className="w-3.5 h-3.5" />
                Open Email Preview
              </button>
            </div>
            <div className="mt-3 grid sm:grid-cols-3 gap-2 text-xs">
              <div className="border border-gray-200 rounded px-3 py-2">
                <p className="text-gray-500">Selected</p>
                <p className="font-semibold text-gray-900">{selectedRows.length}</p>
              </div>
              <div className="border border-gray-200 rounded px-3 py-2">
                <p className="text-gray-500">India sendable</p>
                <p className="font-semibold text-gray-900">{groups.india.length}</p>
              </div>
              <div className="border border-gray-200 rounded px-3 py-2">
                <p className="text-gray-500">China sendable</p>
                <p className="font-semibold text-gray-900">{groups.china.length}</p>
              </div>
            </div>
          </div>
        )}

        {section === 'sheet' && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="border-b border-gray-200 bg-gray-50 px-3 py-2 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {tabs.map(item => (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  className={`px-2.5 py-1 text-xs rounded font-medium ${tab === item.key ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-white border border-transparent hover:border-gray-200'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1.5" />
                <input name="search" aria-label="Search INQ, AC ERP, product, customer, make"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search INQ, AC ERP, product, customer, make"
                  className="pl-7 pr-2 py-1 text-xs border border-gray-200 rounded w-72 max-w-full"
                />
              </div>
              <select name="route_filter" aria-label="Route Filter" value={routeFilter} onChange={e => setRouteFilter(e.target.value as RouteFilter)} className="text-xs border border-gray-200 rounded px-2 py-1">
                <option value="all">All routes</option>
                <option value="india">India</option>
                <option value="china">China</option>
                <option value="local">Local</option>
              </select>
              <select name="customer_filter" aria-label="Customer Filter" value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} className="text-xs border border-gray-200 rounded px-2 py-1 max-w-[180px]">
                <option value="all">All customers</option>
                {customerOptions.map(customer => <option key={customer} value={customer}>{customer}</option>)}
              </select>
              <select name="status_filter" aria-label="Status Filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="text-xs border border-gray-200 rounded px-2 py-1">
                <option value="all">All status</option>
                {['not_sent', 'sent', 'waiting_reply', 'partial_received', 'received', 'unavailable'].map(status => <option key={status} value={status}>{status}</option>)}
              </select>
              <select name="aging_filter" aria-label="Aging Filter" value={agingFilter} onChange={e => setAgingFilter(e.target.value)} className="text-xs border border-gray-200 rounded px-2 py-1">
                <option value="all">Any age</option>
                <option value="3">3+ days</option>
                <option value="7">7+ days</option>
                <option value="15">15+ days</option>
                <option value="30">30+ days</option>
              </select>
              <select name="missing_filter" aria-label="Missing Filter" value={missingFilter} onChange={e => setMissingFilter(e.target.value as MissingFilter)} className="text-xs border border-gray-200 rounded px-2 py-1">
                <option value="all">Any pending</option>
                <option value="price">Missing price</option>
                <option value="docs">Missing docs</option>
              </select>
            </div>
          </div>

          <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-xs text-gray-700">
              <input name="selected" aria-label="Select item"
                type="checkbox"
                checked={selectedRows.length === visibleRows.length && visibleRows.length > 0}
                onChange={() => selectedRows.length === visibleRows.length ? clearSelection() : selectFilteredRows()}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span>{selectedRows.length} selected · {visibleRows.length} shown · India {groups.india.length} · China {groups.china.length}</span>
              <button onClick={selectFilteredRows} className="text-blue-600 hover:underline">Select filtered</button>
              <button onClick={clearSelection} className="text-gray-500 hover:underline">Clear</button>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <button onClick={() => setColumnsOpen(open => !open)}
                  className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-50">
                  Columns
                </button>
                {columnsOpen && (
                  <div className="absolute right-0 top-full mt-1 w-52 bg-white border border-gray-200 rounded shadow-lg z-30 p-2">
                    <button onClick={table.reset} className="text-[11px] text-blue-600 hover:underline mb-1">Reset widths</button>
                    {table.columns.map(column => (
                      <label key={column.key} className="flex items-center gap-2 px-1.5 py-1 text-xs text-gray-700">
                        <input name="column_visibility" aria-label="Toggle column visibility" type="checkbox" checked={table.isVisible(column.key)} disabled={column.required} onChange={() => table.toggleColumn(column.key)} />
                        <span>{column.label || 'Select/Actions'}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={markSelectedForKunal} disabled={!canRouteToKunal || selectedRows.length === 0}
                title="Mark for Kunal review only. Source price/docs come from Source Details save or Kunal AI Review & Save."
                className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50">
                Notify Kunal Review
              </button>
              <button
                onClick={handleSendToIndiaFromOutbox}
                disabled={!isManager || selectedRows.length === 0}
                title="Open CRM email composer for selected India rows"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 font-medium">
                <Send className="w-3.5 h-3.5" />
                Send Email to India
              </button>
              <button
                onClick={handleSendToChinaFromOutbox}
                disabled={!isManager || selectedRows.length === 0}
                title="Open CRM email composer for selected China rows"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 font-medium">
                <Send className="w-3.5 h-3.5" />
                Send Email to China Team
              </button>
              <button onClick={() => setPreviewOpen(true)} disabled={sending || !isManager || sendableRows.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50">
                <Mail className="w-3.5 h-3.5" />
                Preview & Send
              </button>
            </div>
          </div>

          {loading ? (
            <div className="py-10 text-center text-sm text-gray-400">Loading...</div>
          ) : visibleRows.length === 0 ? (
            <div className="py-10 text-center">
              <CheckCircle2 className="w-7 h-7 text-green-400 mx-auto mb-2" />
              <p className="text-sm text-gray-700">No inquiry rows match this view.</p>
              <p className="text-[11px] text-gray-500 mt-1">Change the tab or filters to see more CRM inquiry rows.</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[calc(100vh-330px)] overflow-y-auto">
              <table className="w-full table-fixed text-xs">
                <thead className="bg-gray-100 border-b border-gray-300 sticky top-0 z-10">
                  <tr>
                    {table.visibleColumns.map(column => (
                      <th key={column.key} style={table.getCellStyle(column.key)} className="relative px-2 py-1.5 text-left text-[10px] font-bold text-gray-700 uppercase whitespace-nowrap border-r border-gray-300">
                        {column.label}
                        <div className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400" onMouseDown={event => table.startResize(column.key, event)} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visibleRows.map(row => {
                    const route = deriveSourceType(row);
                    const lastSent = row.last_reminder_sent_at || row.last_sourcing_sent_at;
                    return (
                      <tr key={row.id} className="hover:bg-gray-50">
                        {table.isVisible('select') && <td style={table.getCellStyle('select')} className="px-2 py-1 border-r border-gray-200">
                          <input name="selected" aria-label="Select item" type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                        </td>}
                        {table.isVisible('inquiry') && <td style={table.getCellStyle('inquiry')} className="px-2 py-1 text-xs font-medium whitespace-nowrap border-r border-gray-200">
                          <button onClick={() => openInquiry(row.id)} className="text-blue-700 hover:underline">{row.inquiry_number}</button>
                        </td>}
                        {table.isVisible('aceerp') && <td style={table.getCellStyle('aceerp')} className="px-2 py-1 text-xs text-gray-700 whitespace-nowrap border-r border-gray-200 truncate">{row.aceerp_no || '-'}</td>}
                        {table.isVisible('customer') && <td style={table.getCellStyle('customer')} className="px-2 py-1 text-xs text-gray-700 truncate border-r border-gray-200" title={row.company_name}>{row.company_name}</td>}
                        {table.isVisible('product') && <td style={table.getCellStyle('product')} className="px-2 py-1 text-xs font-medium text-gray-800 truncate border-r border-gray-200" title={row.product_name}>{row.product_name}</td>}
                        {table.isVisible('spec') && <td style={table.getCellStyle('spec')} className="px-2 py-1 text-xs text-gray-500 truncate border-r border-gray-200" title={row.specification || ''}>{row.specification || '-'}</td>}
                        {table.isVisible('mail_subject') && <td style={table.getCellStyle('mail_subject')} className="px-2 py-1 text-xs text-gray-500 truncate border-r border-gray-200" title={(row.email_subject || row.mail_subject || '')}>{row.email_subject || row.mail_subject || '-'}</td>}
                        {table.isVisible('qty') && <td style={table.getCellStyle('qty')} className="px-2 py-1 text-xs text-gray-600 whitespace-nowrap border-r border-gray-200">{row.quantity || '-'}</td>}
                        {table.isVisible('preferred') && <td style={table.getCellStyle('preferred')} className="px-2 py-1 text-xs text-gray-700 truncate border-r border-gray-200" title={row.supplier_name || ''}>{row.supplier_name || '-'}</td>}
                        {table.isVisible('route') && <td style={table.getCellStyle('route')} className="px-2 py-1 border-r border-gray-200">
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${route === 'india' ? 'bg-orange-100 text-orange-700' : route === 'china' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{route || '-'}</span>
                        </td>}
                        {table.isVisible('status') && (() => {
                          const op = getOperationalStatus(row as any);
                          return (
                            <td style={table.getCellStyle('status')} className="px-2 py-1 text-xs whitespace-nowrap border-r border-gray-200">
                              <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold border ${op.badgeClass}`}>
                                {op.label}
                              </span>
                            </td>
                          );
                        })()}
                        {table.isVisible('pending') && <td style={table.getCellStyle('pending')} className="px-2 py-1 text-xs text-gray-600 border-r border-gray-200">
                          {(() => {
                            const op = getOperationalStatus(row as any);
                            return (
                              <div>
                                <div className="whitespace-nowrap font-medium text-gray-800">{pendingLabel(row)}</div>
                                {(op.priceBadge || op.coaBadge) && (
                                  <div className="mt-0.5 flex flex-wrap gap-1">
                                    {op.priceBadge && (
                                      <span className={`inline-flex px-1.5 py-0.2 rounded text-[10px] font-medium border ${op.priceBadge.className}`}>
                                        {op.priceBadge.label}
                                      </span>
                                    )}
                                    {op.coaBadge && (
                                      <span className={`inline-flex px-1.5 py-0.2 rounded text-[10px] font-medium border ${op.coaBadge.className}`}>
                                        {op.coaBadge.label}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {intelligenceBadges(row).length > 0 && (
                                  <div className="mt-0.5 flex flex-wrap gap-1">
                                    {intelligenceBadges(row).map(badge => (
                                      <span key={badge} className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-600">
                                        {badge}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </td>}
                        {table.isVisible('aging') && (() => {
                          const aging = calculateSourcingAging(row as any);
                          return (
                            <td style={table.getCellStyle('aging')} className="px-2 py-1 text-xs font-semibold whitespace-nowrap border-r border-gray-200">
                              <span className={aging.days > 7 ? 'text-red-600' : aging.days > 3 ? 'text-amber-600' : 'text-emerald-700'}>
                                {aging.formattedAging}
                              </span>
                            </td>
                          );
                        })()}
                        {table.isVisible('reminder') && <td style={table.getCellStyle('reminder')} className="px-2 py-1 text-xs text-gray-600 whitespace-nowrap border-r border-gray-200">#{(row.reminder_count ?? 0) + 1}</td>}
                        {table.isVisible('lastSent') && <td style={table.getCellStyle('lastSent')} className="px-2 py-1 text-xs text-gray-600 whitespace-nowrap border-r border-gray-200">{formatDate(lastSent)}</td>}
                        {table.isVisible('created') && <td style={table.getCellStyle('created')} className="px-2 py-1 text-xs text-gray-600 whitespace-nowrap border-r border-gray-200">{formatDate(row.created_at)}</td>}
                        {table.isVisible('actions') && <td style={table.getCellStyle('actions')} className="px-2 py-1 text-xs whitespace-nowrap">
                          <button
                            onClick={() => openSourceModal(row)}
                            disabled={!canRouteToKunal}
                            className="px-2 py-1 border border-gray-200 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Source Details
                          </button>
                        </td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}

        {!isManager && (
          <div className="mt-3 text-[11px] text-gray-500 flex items-center gap-1.5">
            <AlertCircle className="w-3 h-3" /> Only admin/manager can send sourcing emails. Sales can route owned rows to Kunal and update source details where permitted.
          </div>
        )}

        {previewOpen && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-gray-900">Email Preview</h2>
                    <span className="text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-full font-medium">Sending from: sales@avira.co.id</span>
                  </div>
                  <p className="text-[11px] text-gray-500">Completed rows and local rows are skipped. Blank routes default to India. India and China send separately.</p>
                </div>
                <button onClick={() => setPreviewOpen(false)} className="p-1 rounded hover:bg-gray-100"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 overflow-y-auto grid md:grid-cols-2 gap-4">
                {(['india', 'china'] as const).map(route => {
                  const recips = routeRecipients[route];
                  const hasRows = groups[route].length > 0;
                  const noTo = !recips || recips.to.length === 0;
                  return (
                    <div key={route} className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-700 flex items-center justify-between">
                        <span>{route === 'india' ? 'India' : 'China'} · {groups[route].length} rows</span>
                        {isManager && hasRows && (
                          <button onClick={() => saveRouteDefaults(route)} disabled={savingDefaults === route || noTo}
                            className="text-[10px] text-blue-600 hover:underline disabled:opacity-50">
                            {savingDefaults === route ? 'Saving…' : 'Save as default'}
                          </button>
                        )}
                      </div>
                      <div className="p-3 space-y-2 bg-gray-50/40">
                        <RecipientChips label="To"
                          emails={recips?.to || []}
                          onChange={next => setRouteField(route, 'to', next)}
                          disabled={!isManager}
                          placeholder="recipient@example.com" />
                        <RecipientChips label="CC"
                          emails={recips?.cc || []}
                          onChange={next => setRouteField(route, 'cc', next)}
                          disabled={!isManager} />
                        <RecipientChips label="BCC"
                          emails={recips?.bcc || []}
                          onChange={next => setRouteField(route, 'bcc', next)}
                          disabled={!isManager} />
                        {hasRows && noTo && (
                          <p className="text-[10px] text-red-600">Add at least one recipient or this route will be skipped.</p>
                        )}
                      </div>
                      <div className="border-t border-gray-200">
                        <div className="px-3 py-1.5 bg-gray-50 flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">Email body</span>
                          <div className="flex items-center gap-3">
                            {route === 'india' && hasRows && (previewBodies[route] || bodyOverride[route]) && (
                              <button
                                onClick={() => setFullscreenRoute(route)}
                                title="View full screen"
                                className="text-[11px] text-gray-600 hover:text-gray-900 flex items-center gap-1"
                              >
                                <Maximize2 className="w-3 h-3" /> Expand
                              </button>
                            )}
                            {hasRows && (
                              <button onClick={() => improveWithAi(route)} disabled={aiBusy === route || !isManager}
                                title="Only improves wording. It does not scan inbox or update pricing."
                                className="text-[11px] text-purple-600 hover:underline disabled:opacity-50 flex items-center gap-1">
                                <Sparkles className="w-3 h-3" />
                                {aiBusy === route ? 'Polishing…' : 'Polish Email Text'}
                              </button>
                            )}
                          </div>
                        </div>
                        {route === 'india' ? (
                          <div className="relative">
                            {(previewBodies[route] || bodyOverride[route]) ? (
                              <div
                                className="w-full p-3 overflow-x-auto min-h-[180px] text-[12px]"
                                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bodyOverride[route] ?? previewBodies[route] ?? '') }}
                              />
                            ) : (
                              <div className="w-full p-3 text-[11px] text-gray-400 min-h-[180px]">No sendable rows selected for this route.</div>
                            )}
                          </div>
                        ) : (
                          <textarea name="body_override" aria-label="No sendable rows selected for this route."
                            value={bodyOverride[route] ?? previewBodies[route] ?? ''}
                            onChange={e => setBodyOverride(prev => ({ ...prev, [route]: e.target.value }))}
                            placeholder="No sendable rows selected for this route."
                            rows={10}
                            className="w-full p-3 text-[11px] whitespace-pre-wrap font-sans text-gray-700 border-0 focus:outline-none focus:ring-0 resize-y min-h-[180px]"
                          />
                        )}
                        {aiNotes[route] && (
                          <p className="px-3 pb-2 text-[10px] text-purple-700 bg-purple-50 border-t border-purple-100">{aiNotes[route]}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50">
                <div className="text-[11px] text-gray-600 flex items-center gap-1.5">
                  <span className="text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-full font-medium">Sending from: sales@avira.co.id</span>
                </div>
                <button
                  onClick={confirmSend}
                  disabled={
                    sending
                    || sendableRows.length === 0
                    || (groups.india.length > 0 && routeRecipients.india.to.length === 0)
                    || (groups.china.length > 0 && routeRecipients.china.to.length === 0)
                  }
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                  <Send className="w-3.5 h-3.5" /> {sending ? 'Sending...' : 'Confirm Send'}
                </button>
              </div>
            </div>
          </div>
        )}

        {fullscreenRoute && (
          <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-2xl max-w-5xl w-full max-h-[92vh] overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Email Preview — {fullscreenRoute === 'india' ? 'India' : 'China'} Full Screen</h2>
                <button onClick={() => setFullscreenRoute(null)} className="p-1 rounded hover:bg-gray-100"><X className="w-4 h-4" /></button>
              </div>
              <div className="overflow-auto p-6 flex-1">
                <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bodyOverride[fullscreenRoute] ?? previewBodies[fullscreenRoute] ?? '') }} />
              </div>
            </div>
          </div>
        )}

        {aiReviewRow && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {aiReviewRow.aiType === 'Document / Certificate Received' ? <FileText className="w-4 h-4 text-sky-600" /> : <AlertCircle className="w-4 h-4 text-amber-600" />}
                  <div>
                    <h2 className="text-sm font-semibold text-gray-900">{aiReviewRow.aiType}</h2>
                    <p className="text-[11px] text-gray-500">{aiReviewRow.subject}</p>
                  </div>
                </div>
                <button onClick={() => setAiReviewRow(null)} className="p-1 rounded hover:bg-gray-100"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 space-y-3">
                <SapRow>
                  <FloatingField label="Matched Inquiry" span={6} filled={!!aiReviewRow.selectedInquiryId}>
                    <select name="ai_review_row" aria-label="Ai Review Row"
                      value={aiReviewRow.selectedInquiryId || ''}
                      onChange={e => setAiReviewRow(row => row ? { ...row, selectedInquiryId: e.target.value || null } : row)}
                      className={FLOAT_INPUT}
                    >
                      <option value="">Select inquiry</option>
                      {aiReviewRow.candidates.map(candidate => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.inquiry_number} · {candidate.product_name} · {candidate.company_name}
                        </option>
                      ))}
                    </select>
                  </FloatingField>
                  <FloatingField label="Product" span={6} filled={!!aiReviewDraft.product}>
                    <input name="ai_review_draft" aria-label="Ai Review Draft"
                      value={aiReviewDraft.product}
                      onChange={e => setAiReviewDraft(draft => ({ ...draft, product: e.target.value }))}
                      className={FLOAT_INPUT}
                    />
                  </FloatingField>
                </SapRow>

                {aiReviewRow.aiType === 'India Office Query / Revert Needed' ? (
                  <SapRow>
                    <FloatingField label="Extracted question" span={12} textarea filled={!!aiReviewDraft.question}>
                      <textarea name="ai_review_draft" aria-label="India query: Need quantity / specification..."
                        value={aiReviewDraft.question}
                        onChange={e => setAiReviewDraft(draft => ({ ...draft, question: e.target.value }))}
                        rows={4}
                        className={FLOAT_TEXTAREA}
                        placeholder="India query: Need quantity / specification..."
                      />
                    </FloatingField>
                  </SapRow>
                ) : (
                  <SapRow>
                    <FloatingField label="Document type" span={4} filled={!!aiReviewDraft.documentType}>
                      <select name="ai_review_draft" aria-label="Ai Review Draft"
                        value={aiReviewDraft.documentType}
                        onChange={e => setAiReviewDraft(draft => ({ ...draft, documentType: e.target.value as AiReviewDraft['documentType'] }))}
                        className={FLOAT_INPUT}
                      >
                        {['COA', 'MSDS', 'COC', 'GMP', 'ISO', 'DMF', 'SPEC', 'OTHER'].map(type => <option key={type}>{type}</option>)}
                      </select>
                    </FloatingField>
                    <FloatingField label="Make / Manufacturer" span={4} filled={!!aiReviewDraft.make}>
                      <input name="ai_review_draft" aria-label="Ai Review Draft"
                        value={aiReviewDraft.make}
                        onChange={e => setAiReviewDraft(draft => ({ ...draft, make: e.target.value }))}
                        className={FLOAT_INPUT}
                      />
                    </FloatingField>
                    <FloatingField label="Rename file" span={4} filled={!!aiReviewDraft.displayFileName}>
                      <input name="ai_review_draft" aria-label="Ai Review Draft"
                        value={aiReviewDraft.displayFileName}
                        onChange={e => setAiReviewDraft(draft => ({ ...draft, displayFileName: e.target.value }))}
                        className={FLOAT_INPUT}
                      />
                    </FloatingField>
                    <FloatingField label="Attachments" span={12} filled={!!aiReviewDraft.attachmentId}>
                      <select name="ai_review_draft" aria-label="Ai Review Draft"
                        value={aiReviewDraft.attachmentId}
                        onChange={e => {
                          const att = aiReviewRow.attachments?.find(item => item.attachmentId === e.target.value);
                          setAiReviewDraft(draft => ({ ...draft, attachmentId: e.target.value, displayFileName: att?.filename || draft.displayFileName }));
                        }}
                        className={FLOAT_INPUT}
                      >
                        <option value="">No attachment selected</option>
                        {(aiReviewRow.attachments || []).map(att => (
                          <option key={att.attachmentId} value={att.attachmentId}>
                            {att.filename || att.mimeType} {att.size ? `(${Math.round(att.size / 1024)} KB)` : ''}
                          </option>
                        ))}
                      </select>
                    </FloatingField>
                  </SapRow>
                )}

                <SapRow>
                  <FloatingField label="Note to append" span={12} textarea filled={!!aiReviewDraft.notes}>
                    <textarea name="ai_review_draft" aria-label="Ai Review Draft"
                      value={aiReviewDraft.notes}
                      onChange={e => setAiReviewDraft(draft => ({ ...draft, notes: e.target.value }))}
                      rows={3}
                      className={FLOAT_TEXTAREA}
                    />
                  </FloatingField>
                </SapRow>

                <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-3 py-2">
                  Save appends to CRM remarks. For documents, the selected Gmail attachment is downloaded server-side, uploaded to private CRM document storage, and linked to the inquiry.
                </div>
              </div>
              <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2">
                <button onClick={() => setAiReviewRow(null)} className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-white">Cancel</button>
                <button
                  onClick={saveAiReview}
                  disabled={aiSaving || !isManager || !aiReviewRow.selectedInquiryId}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {aiSaving ? 'Saving...' : 'Confirm & Save'}
                </button>
              </div>
            </div>
          </div>
        )}

        {replyDraft.open && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Send reply email</h2>
                  <p className="text-[11px] text-gray-500">Simple reply via connected Gmail/fallback. Nothing sends until you click Send.</p>
                </div>
                <button onClick={() => setReplyDraft({ open: false, to: '', subject: '', body: '', sending: false })} className="p-1 rounded hover:bg-gray-100">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <label className="block text-xs text-gray-600">
                  To
                  <input name="reply_draft" aria-label="Reply Draft"
                    value={replyDraft.to}
                    onChange={e => setReplyDraft(current => ({ ...current, to: e.target.value }))}
                    className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-xs"
                  />
                </label>
                <label className="block text-xs text-gray-600">
                  Subject
                  <input name="reply_draft" aria-label="Reply Draft"
                    value={replyDraft.subject}
                    onChange={e => setReplyDraft(current => ({ ...current, subject: e.target.value }))}
                    className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-xs"
                  />
                </label>
                <label className="block text-xs text-gray-600">
                  Body
                  <textarea name="reply_draft" aria-label="Reply Draft"
                    value={replyDraft.body}
                    onChange={e => setReplyDraft(current => ({ ...current, body: e.target.value }))}
                    rows={10}
                    className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-xs min-h-[180px]"
                  />
                </label>
              </div>
              <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2">
                <button onClick={() => setReplyDraft({ open: false, to: '', subject: '', body: '', sending: false })} className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-white">
                  Cancel
                </button>
                <button onClick={sendReply} disabled={replyDraft.sending}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                  {replyDraft.sending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        )}

        {sourceModalRow && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-lg w-full overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Update India Reply / Source Details</h2>
                  <p className="text-[11px] text-gray-500">{sourceModalRow.inquiry_number} · {sourceModalRow.product_name}</p>
                </div>
                <button onClick={() => setSourceModalRow(null)} className="p-1 rounded hover:bg-gray-100">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <SapRow>
                  <FloatingField label="Offered Make / Manufacturer" span={8} filled={!!sourceDraft.offered_make}>
                    <input name="source_draft" aria-label="Source Draft" value={sourceDraft.offered_make} onChange={e => setSourceDraft(d => ({ ...d, offered_make: e.target.value }))}
                      className={FLOAT_INPUT} />
                  </FloatingField>
                  <FloatingField label="INR Price" span={4} filled={sourceDraft.source_price !== '' && sourceDraft.source_price !== undefined && sourceDraft.source_price !== null}>
                    <MoneyInput value={Number(sourceDraft.source_price) || 0} onChange={amount => setSourceDraft(d => ({ ...d, source_price: String(amount) }))}
                      className={FLOAT_INPUT} placeholder="0.00" />
                  </FloatingField>
                  <FloatingField label="Currency" span={4} filled={!!sourceDraft.source_currency}>
                    <select name="source_draft" aria-label="Source Draft" value={sourceDraft.source_currency} onChange={e => setSourceDraft(d => ({ ...d, source_currency: e.target.value }))}
                      className={FLOAT_INPUT}>
                      {['INR', 'USD', 'CNY', 'IDR'].map(currency => <option key={currency}>{currency}</option>)}
                    </select>
                  </FloatingField>
                  <FloatingField label="Availability" span={4} filled={!!sourceDraft.availability}>
                    <select name="source_draft" aria-label="Source Draft" value={sourceDraft.availability} onChange={e => setSourceDraft(d => ({ ...d, availability: e.target.value as SourceDraft['availability'] }))}
                      className={FLOAT_INPUT}>
                      {['available', 'partial', 'na'].map(value => <option key={value}>{value}</option>)}
                    </select>
                  </FloatingField>
                  <FloatingField label="Document Status" span={4} filled={!!sourceDraft.document_status}>
                    <select name="source_draft" aria-label="Source Draft" value={sourceDraft.document_status} onChange={e => setSourceDraft(d => ({ ...d, document_status: e.target.value as SourceDraft['document_status'] }))}
                      className={FLOAT_INPUT}>
                      {['pending', 'partial', 'received', 'not_required'].map(value => <option key={value}>{value}</option>)}
                    </select>
                  </FloatingField>
                  <FloatingField label="Remark" span={12} textarea filled={!!sourceDraft.remark}>
                    <textarea name="source_draft" aria-label="Source Draft" value={sourceDraft.remark} onChange={e => setSourceDraft(d => ({ ...d, remark: e.target.value }))}
                      className={FLOAT_TEXTAREA} />
                  </FloatingField>
                </SapRow>
              </div>
              <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2">
                <button onClick={() => setSourceModalRow(null)} className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-white">Cancel</button>
                <button onClick={saveSourceDetails} disabled={savingSource || !canRouteToKunal}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                  {savingSource ? 'Saving...' : 'Save Source Details'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* CRM-consistent Gmail-like Email Composer Modal for India / China */}
        {crmComposerOpen && crmComposerRows.length > 0 && (
          <GmailLikeComposer
            isOpen={crmComposerOpen}
            onClose={() => {
              setCrmComposerOpen(false);
              setCrmComposerRows([]);
              load();
            }}
            inquiry={crmComposerRows[0] as any}
            inquiries={crmComposerRows as any}
            mode={crmComposerMode}
            defaultTo={crmComposerDefaultTo}
            defaultCc={crmComposerDefaultCc}
          />
        )}
      </div>
    </Layout>
  );
}
