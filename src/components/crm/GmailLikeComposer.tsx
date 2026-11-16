import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Send, Paperclip, X, ChevronDown, Loader, Minimize2, Maximize2, AlertCircle, FileText, Check } from 'lucide-react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { openGmailReconnectPopup } from './gmailReconnect';
import { applyEmailTemplateVariables, getDisplayContactName, getSalutation } from '../../utils/crmEmailPersonalization';
import { buildNormalizedBaseKey, buildUniqueDocumentNames } from '../../utils/documentNaming';
import { escapeHtml, buildCompanySignature, buildIndiaRfqEmail, buildIndiaRfqSubject, buildChinaRfqEmail, buildChinaRfqSubject } from '../../utils/emailFormatting';
import { type CompanySnapshot, FALLBACK_COMPANY } from '../../types/company';
import { uploadOptimizedFile } from '../../services/storage/uploadOptimizationService';

interface Inquiry {
  id: string;
  inquiry_number: string;
  company_name: string;
  contact_person: string | null;
  contact_email: string | null;
  product_name: string;
  specification?: string | null;
  quantity: string;
  supplier_name?: string | null;
  supplier_country?: string | null;
  email_subject?: string | null;
  mail_subject?: string | null;
  offered_price?: number | null;
  offered_price_currency?: string;
  purchase_price?: number | null;
  purchase_price_currency?: string;
  remarks?: string | null;
  aceerp_no?: string | null;
  delivery_date?: string | null;
  coa_required?: boolean | null;
  sample_required?: boolean | null;
  agency_letter_required?: boolean | null;
  others_required?: boolean | null;
  source_status?: string | null;
}

interface EmailTemplate {
  id: string;
  template_name: string;
  subject: string;
  body: string;
  category: string;
  variables: string[];
  use_count?: number;
  last_used?: string | null;
}

interface CrmDoc {
  id: string;
  inquiry_id: string | null;
  product_name: string | null;
  make: string | null;
  document_type: string;
  display_file_name: string | null;
  original_file_name: string | null;
  storage_path: string;
  created_at: string;
}

interface GmailLikeComposerProps {
  isOpen: boolean;
  onClose: () => void;
  inquiry: Inquiry;
  inquiries?: Inquiry[]; // multiple for multi-product email
  mode?: 'price' | 'coa' | 'general' | 'india' | 'china';
  defaultTo?: string;   // overrides inquiry.contact_email (used by india / china mode)
  defaultCc?: string;   // pre-fills CC field (used by india mode)
  replyTo?: {
    email_id: string;
    subject: string;
    from_email: string;
    body: string;
    threadId?: string;
  };
}

interface AttachedFile {
  file: File;
  name: string;
  size: number;
}

interface AttachmentUrlPayload {
  url: string;
  filename: string;
  source: 'crm_document' | 'local_upload';
  documentId?: string;
  storagePath: string;
}

interface WorkflowEvidenceRow {
  id: string;
  inquiry_number: string;
  status: string | null;
  pipeline_status: string | null;
  price_quoted: boolean | null;
  price_sent_at: string | null;
  quote_status: string | null;
  quote_sent_at: string | null;
  coa_sent: boolean | null;
  coa_sent_at: string | null;
}

function parseEmailRecipients(raw: string): string[] {
  return raw
    .split(/[;,]/)
    .map(email => email.trim())
    .filter(Boolean);
}

function getCrmDocFilename(doc: CrmDoc): string {
  return doc.display_file_name || doc.original_file_name || doc.storage_path.split('/').pop() || 'attachment';
}

function isCoaDocument(doc: CrmDoc): boolean {
  const haystack = `${doc.document_type || ''} ${getCrmDocFilename(doc)}`.toLowerCase();
  return haystack.includes('coa');
}

function inferDocumentType(fileName: string, mode: 'price' | 'coa' | 'general' | 'india' | 'china'): 'COA' | 'MSDS' | 'MHD' | 'TDS' | 'SPEC' | 'OTHER' {
  const normalized = fileName.toLowerCase();
  if (normalized.includes('coa')) return 'COA';
  if (normalized.includes('msds') || normalized.includes('sds')) return 'MSDS';
  if (normalized.includes('mhd') || normalized.includes('expiry')) return 'MHD';
  if (normalized.includes('tds')) return 'TDS';
  if (normalized.includes('spec')) return 'SPEC';
  if (mode === 'coa') return 'COA';
  return 'OTHER';
}

const quillModules = {
  toolbar: [
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link'],
    ['clean'],
  ],
};

const quillFormats = ['bold', 'italic', 'underline', 'list', 'bullet', 'link'];

function logEmailHtmlEvidence(_label: string, _html: string, _extra?: Record<string, unknown>) {
}

function buildSubject(inquiry: Inquiry, _mode: 'price' | 'coa' | 'general', replyTo?: GmailLikeComposerProps['replyTo']): string {
  if (replyTo?.subject) {
    return replyTo.subject.startsWith('Re:') ? replyTo.subject : `Re: ${replyTo.subject}`;
  }
  const baseSubject = inquiry.mail_subject || inquiry.email_subject || `${inquiry.product_name} - ${inquiry.inquiry_number}`;
  return `Re: ${baseSubject}`;
}


const normalizeDocTypeLabel = (type: string): string => {
  if (type === 'SPEC') return 'Specification';
  return type;
};

const extractQuantityUnit = (quantity?: string | null): string => {
  const normalized = (quantity || '').toLowerCase();
  const match = normalized.match(/(?:^|\d|\s)(gm|gram|grams|kg|kilogram|kilograms|pcs|pieces)\b/);
  const unit = match?.[1] || '';
  if (['gm', 'gram', 'grams'].includes(unit)) return 'gm';
  if (['kg', 'kilogram', 'kilograms'].includes(unit)) return 'kg';
  if (['pcs', 'pieces'].includes(unit)) return 'pcs';
  return '';
};

const formatOfferPrice = (inq: Inquiry): string => {
  const currency = inq.offered_price_currency || 'USD';
  if (!inq.offered_price || inq.offered_price <= 0) return 'To be confirmed';
  const amount = Number(inq.offered_price).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const unit = extractQuantityUnit(inq.quantity);
  return `${currency} ${amount}${unit ? `/${unit}` : ''}`;
};

const extractMakeFromRemarks = (remarks?: string | null): string => {
  const text = remarks?.trim() || '';
  const match = text.match(/make\s*:\s*([^,;\n|]+)/i);
  return (match?.[1] || '').trim();
};


function buildSupportingDocsHtml(docs: CrmDoc[]): string {
  const types = Array.from(new Set(docs.map(d => d.document_type))).filter(Boolean);
  if (types.length === 0) return '';
  const lines = types.map(type => `<div style="margin:2px 0;">&#10003; ${escapeHtml(normalizeDocTypeLabel(type))}</div>`).join('');
  return `<p style="margin:16px 0 6px 0;">Supporting documents attached:</p><div style="margin:0 0 14px 0;">${lines}</div>`;
}

// Build a Gmail/Outlook compatible HTML table for selected inquiry rows.
function buildPriceTable(items: Inquiry[]): string {
  const headerStyle = 'padding:10px 12px;border:1px solid #b7c9df;background:#073763;color:#ffffff;text-align:left;font-weight:700;font-size:13px;';
  const cellBase = 'padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;';
  const rows = items.map((inq, index) => {
    const background = index % 2 === 0 ? '#ffffff' : '#f8fafc';
    const spec = inq.specification?.trim() || '-';
    const make = extractMakeFromRemarks(inq.remarks) || '-';
    const remarks = inq.remarks?.trim() || '-';
    return `<tr style="background:${background};">
      <td style="${cellBase}font-weight:600;">${escapeHtml(inq.product_name || '-')}</td>
      <td style="${cellBase}">${escapeHtml(spec)}</td>
      <td style="${cellBase}">${escapeHtml(make)}</td>
      <td style="${cellBase}font-weight:600;white-space:nowrap;">${escapeHtml(formatOfferPrice(inq))}</td>
      <td style="${cellBase}">${escapeHtml(remarks)}</td>
    </tr>`;
  }).join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:760px;font-family:Arial,Helvetica,sans-serif;font-size:13px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <thead><tr>
      <th style="${headerStyle}">Product</th>
      <th style="${headerStyle}">Specification</th>
      <th style="${headerStyle}">Make / Supplier</th>
      <th style="${headerStyle}">Offer Price</th>
      <th style="${headerStyle}">Remarks</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function GmailLikeComposer({ isOpen, onClose, inquiry, inquiries, mode = 'general', defaultTo, defaultCc, replyTo }: GmailLikeComposerProps) {
  // All inquiries to include (multi-product support)
  const allInquiries = inquiries && inquiries.length > 0 ? inquiries : [inquiry];

  const [toEmail, setToEmail] = useState(defaultTo ?? inquiry.contact_email ?? '');
  const [ccEmail, setCcEmail] = useState(defaultCc ?? '');
  const [bccEmail, setBccEmail] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [currentUserName, setCurrentUserName] = useState('');
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [deliveryResult, setDeliveryResult] = useState<{
    delivered: boolean;
    sentAt: string;
    messageId?: string | null;
    threadId?: string | null;
    activityId?: string | null;
  } | null>(null);
  const [companyCo, setCompanyCo] = useState<CompanySnapshot>(FALLBACK_COMPANY);

  // CRM docs panel
  const [crmDocs, setCrmDocs] = useState<CrmDoc[]>([]);
  const [crmDocsLoading, setCrmDocsLoading] = useState(false);
  const [selectedCrmDocs, setSelectedCrmDocs] = useState<Set<string>>(new Set());
  const [showDocPanel, setShowDocPanel] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const htmlPreviewRef = useRef<HTMLDivElement>(null);
  const quillWrapRef = useRef<HTMLDivElement>(null);

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
    if (!isOpen) return;
    loadTemplates();
    setToEmail(defaultTo ?? inquiry.contact_email ?? '');
    setCcEmail(defaultCc ?? '');
    setSelectedCrmDocs(new Set());
    setAttachments([]);

    // Check if an email was already delivered in this session for this inquiry/mode
    const sessionDeliveryKey = `crm_delivery_${inquiry.id}_${mode || 'general'}`;
    let restoredDelivery: { delivered: boolean; sentAt: string; messageId?: string | null; threadId?: string | null } | null = null;
    try {
      const cached = sessionStorage.getItem(sessionDeliveryKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.delivered && parsed?.sentAt && (Date.now() - new Date(parsed.sentAt).getTime() < 15 * 60 * 1000)) {
          restoredDelivery = parsed;
        } else {
          sessionStorage.removeItem(sessionDeliveryKey);
        }
      }
    } catch {
      sessionStorage.removeItem(sessionDeliveryKey);
    }

    if (!restoredDelivery) {
      // Check database to see if send-bulk-email already confirmed delivery in the last 15 minutes
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      supabase
        .from('crm_email_activities')
        .select('id, gmail_message_id, gmail_thread_id, sent_date')
        .eq('inquiry_id', inquiry.id)
        .not('gmail_message_id', 'is', null)
        .gte('sent_date', fifteenMinutesAgo)
        .order('sent_date', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data: recentAct }) => {
          if (recentAct?.gmail_message_id) {
            setDeliveryResult({
              delivered: true,
              sentAt: recentAct.sent_date,
              messageId: recentAct.gmail_message_id,
              threadId: recentAct.gmail_thread_id,
              activityId: recentAct.id,
            });
          }
        });
    }

    setDeliveryResult(restoredDelivery);

    if (mode === 'india') {
      setSubject(buildIndiaRfqSubject(allInquiries));
    } else if (mode === 'china') {
      setSubject(buildChinaRfqSubject(allInquiries));
    } else {
      setSubject(buildSubject(inquiry, mode, replyTo));
    }

    const initialiseComposer = async () => {
      const [userName, docs] = await Promise.all([loadUserInfo(), loadCrmDocs()]);
      if (replyTo) {
        const quotedBody = `<br><br><div style="border-left:3px solid #e2e8f0;padding-left:12px;margin-left:8px;color:#64748b"><p><strong>${replyTo.from_email} wrote:</strong></p>${replyTo.body}</div>`;
        logEmailHtmlEvidence('Generated reply body before inserting into editor', quotedBody, { mode, inquiryIds: allInquiries.map(i => i.id) });
        setBody(quotedBody);
      } else {
        generateBody(mode, userName, docs);
      }
    };

    initialiseComposer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, inquiry.id, mode]);

  useEffect(() => {
    if (!isOpen || !body) return;
    window.setTimeout(() => {
      const isHtmlSurface = mode === 'price' || mode === 'india' || mode === 'china';
      const insertedHtml = isHtmlSurface
        ? htmlPreviewRef.current?.innerHTML || ''
        : quillWrapRef.current?.querySelector('.ql-editor')?.innerHTML || '';
      logEmailHtmlEvidence('Editor value after insertion', insertedHtml, {
        mode,
        editor: isHtmlSurface ? 'HTML preview surface' : 'ReactQuill',
        stateMatchesInsertedDom: insertedHtml === body,
      });
    }, 0);
  }, [isOpen, body, mode]);

  const loadUserInfo = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return '';
      const isSupplierRoute = mode === 'india' || mode === 'china';
      const targetMailbox = isSupplierRoute ? 'kunal@avira.co.id' : 'sales@avira.co.id';

      const profilePromise = supabase.from('user_profiles').select('full_name').eq('id', user.id).maybeSingle();

      // Check connection status via backend edge function (which bypasses RLS securely)
      // and fall back to direct query only for personal mailbox where RLS permits SELECT
      let isConnected: boolean | null = null;
      try {
        const { data: statusData, error: statusErr } = await supabase.functions.invoke('send-bulk-email', {
          body: {
            checkConnectionOnly: true,
            requiredSenderEmail: targetMailbox,
            senderEmail: targetMailbox,
            workflowType: isSupplierRoute ? 'india_pricing' : 'customer_quote',
          },
        });
        if (!statusErr && statusData && typeof statusData.connected === 'boolean') {
          isConnected = statusData.connected;
        } else if (targetMailbox === user.email) {
          const { data: directConn } = await supabase
            .from('gmail_connections')
            .select('id')
            .ilike('email_address', targetMailbox)
            .eq('is_connected', true)
            .limit(1)
            .maybeSingle();
          isConnected = !!directConn;
        } else {
          // For shared company mailbox (sales@avira.co.id), RLS blocks direct client SELECT.
          // If the edge function explicitly reported disconnected, record false; otherwise keep null.
          if (statusData && statusData.connected === false) {
            isConnected = false;
          }
        }
      } catch {
        if (targetMailbox === user.email) {
          const { data: directConn } = await supabase
            .from('gmail_connections')
            .select('id')
            .ilike('email_address', targetMailbox)
            .eq('is_connected', true)
            .limit(1)
            .maybeSingle();
          isConnected = !!directConn;
        }
      }

      const profileRes = await profilePromise;
      const fullName = profileRes.data?.full_name || '';
      setCurrentUserName(fullName);
      setGmailConnected(isConnected);
      return fullName;
    } catch (err) {
      console.error('Error loading user info:', err);
      return '';
    }
  };

  const loadCrmDocs = async () => {
    const ids = allInquiries.map(i => i.id);
    if (ids.length === 0) return [] as CrmDoc[];
    setCrmDocsLoading(true);
    const { data } = await supabase
      .from('crm_product_documents')
      .select('id,inquiry_id,product_name,make,document_type,display_file_name,original_file_name,storage_path,created_at')
      .in('inquiry_id', ids)
      .order('created_at', { ascending: false });
    const docs = (data || []) as unknown as CrmDoc[];
    setCrmDocs(docs);
    if (mode === 'price' || mode === 'coa' || mode === 'india' || mode === 'china') {
      setSelectedCrmDocs(new Set(docs.map(doc => doc.id)));
    }
    setCrmDocsLoading(false);
    return docs;
  };

  const loadTemplates = async () => {
    try {
      const { data } = await supabase.from('crm_email_templates').select('*').eq('is_active', true).order('template_name');
      setTemplates(data || []);
    } catch (err) {
      console.error('Error loading templates:', err);
    }
  };

  const generateBody = (emailMode: 'price' | 'coa' | 'general' | 'india' | 'china', userName = currentUserName, docs: CrmDoc[] = crmDocs) => {
    const salutation = `<p>${escapeHtml(getSalutation(inquiry.contact_person))}</p>`;
    const signature = buildCompanySignature(userName, companyCo);

    if (emailMode === 'india') {
      const html = buildIndiaRfqEmail(allInquiries, companyCo);
      logEmailHtmlEvidence('Generated India email HTML', html, { mode: emailMode, inquiryIds: allInquiries.map(i => i.id) });
      setBody(html);
      return;
    }

    if (emailMode === 'china') {
      const html = buildChinaRfqEmail(allInquiries, companyCo);
      logEmailHtmlEvidence('Generated China email HTML', html, { mode: emailMode, inquiryIds: allInquiries.map(i => i.id) });
      setBody(html);
      return;
    }

    if (emailMode === 'price') {
      let html = salutation;
      html += `<p>Thank you for your inquiry.</p>`;
      html += `<p>Please find our quotation below:</p>`;
      html += buildPriceTable(allInquiries);
      html += buildSupportingDocsHtml(docs);
      html += `<p>Please let us know if you require additional information.</p>`;
      html += signature;
      logEmailHtmlEvidence('Generated HTML before inserting into editor', html, { mode: emailMode, inquiryIds: allInquiries.map(i => i.id) });
      setBody(html);
    } else if (emailMode === 'coa') {
      let html = salutation;
      const productList = allInquiries.map(i => `<strong>${escapeHtml(i.product_name)}</strong>`).join(', ');
      html += `<p>Further to your inquiry for ${productList}, please find attached the requested documents (COA / MSDS).</p>`;
      html += buildSupportingDocsHtml(docs);
      html += `<p>Kindly review the documents and let us know if you require any further information or alternative grades.</p>`;
      html += signature;
      logEmailHtmlEvidence('Generated HTML before inserting into editor', html, { mode: emailMode, inquiryIds: allInquiries.map(i => i.id) });
      setBody(html);
    } else {
      let html = salutation;
      html += `<p>Thank you for your inquiry regarding <strong>${escapeHtml(inquiry.product_name)}</strong>.</p>`;
      if (inquiry.specification) html += `<p><strong>Specification:</strong> ${escapeHtml(inquiry.specification)}</p>`;
      html += `<p><strong>Quantity:</strong> ${escapeHtml(inquiry.quantity)}</p>`;
      html += `<p>Please find the attached documents for your reference.</p>`;
      html += signature;
      logEmailHtmlEvidence('Generated HTML before inserting into editor', html, { mode: emailMode, inquiryIds: allInquiries.map(i => i.id) });
      setBody(html);
    }
  };

  const applyTemplate = (template: EmailTemplate) => {
    const offeredPriceText = inquiry.offered_price
      ? `${inquiry.offered_price_currency || 'USD'} ${inquiry.offered_price.toLocaleString()}`
      : 'To be confirmed';
    setSubject(applyEmailTemplateVariables(template.subject, {
      ...inquiry, contact_person: getDisplayContactName(inquiry.contact_person),
      user_name: currentUserName, offered_price: offeredPriceText,
    }));
    const templatedBody = applyEmailTemplateVariables(template.body, {
      ...inquiry, contact_person: getDisplayContactName(inquiry.contact_person),
      user_name: currentUserName, offered_price: offeredPriceText,
    });
    logEmailHtmlEvidence('Template HTML before inserting into editor', templatedBody, { templateName: template.template_name });
    setBody(templatedBody);
    setShowTemplates(false);
    const currentUseCount = typeof template.use_count === 'number' ? template.use_count : 0;
    supabase.from('crm_email_templates')
      .update({ use_count: currentUseCount + 1, last_used: new Date().toISOString() })
      .eq('id', template.id).then(() => {});
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newFiles: AttachedFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.size > 25 * 1024 * 1024) { alert(`${f.name} exceeds 25MB limit.`); continue; }
      newFiles.push({ file: f, name: f.name, size: f.size });
    }
    setAttachments(prev => [...prev, ...newFiles]);
  };

  const toggleCrmDoc = (docId: string) => {
    setSelectedCrmDocs(prev => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const formatSize = (b: number) => {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const DOC_TYPE_COLOR: Record<string, string> = {
    COA: 'bg-green-100 text-green-700',
    MSDS: 'bg-red-100 text-red-700',
    TDS: 'bg-blue-100 text-blue-700',
    SPEC: 'bg-amber-100 text-amber-700',
  };

  const sendEmail = async () => {
    const sanitizedBody = DOMPurify.sanitize(body, { ADD_ATTR: ['target'] });
    if (!toEmail.trim() || !subject.trim() || !sanitizedBody.trim()) {
      alert('Please fill in To, Subject, and Body.');
      return;
    }
    if (gmailConnected === false) {
      alert(`Gmail is not connected for ${displaySender}. Please connect ${displaySender} in Settings > Gmail Settings.`);
      return;
    }

    setSending(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const inquiryIds = allInquiries.map(inq => inq.id);
      const readWorkflowEvidence = async () => {
        const { data, error } = await supabase
          .from('crm_inquiries')
          .select('id,inquiry_number,status,pipeline_status,price_quoted,price_sent_at,quote_status,quote_sent_at,coa_sent,coa_sent_at')
          .in('id', inquiryIds);
        if (error) {
          return [] as WorkflowEvidenceRow[];
        }
        return (data || []) as WorkflowEvidenceRow[];
      };

      // 1. Upload new file attachments
      const uploadedFiles: { storagePath: string; fileName: string }[] = [];
      const attachmentFolder = `email-attachments/${user.id}`;
      const { data: existingObjects } = await supabase.storage.from('crm-documents').list(attachmentFolder, { limit: 1000 });
      const existingStoragePaths = (existingObjects || []).map(obj => `${attachmentFolder}/${obj.name}`);
      const normalizedDocType = mode === 'coa' ? 'coa' : mode === 'price' ? 'quotation' : mode === 'india' ? 'india_pricing' : 'attachment';
      const normalizedBaseKey = buildNormalizedBaseKey(inquiry.product_name || 'product', inquiry.supplier_name || inquiry.company_name || 'supplier', normalizedDocType);

      for (const att of attachments) {
        const fileNaming = buildUniqueDocumentNames({
          product: inquiry.product_name || 'product',
          supplier: inquiry.supplier_name || inquiry.company_name || 'supplier',
          docType: normalizedDocType,
          originalFilename: att.name,
          existingStoragePaths: existingStoragePaths.filter(p => p.split('/').pop()?.startsWith(normalizedBaseKey)),
        });
        const filePath = `${attachmentFolder}/${fileNaming.fileName}`;
        const { error: upErr } = await uploadOptimizedFile(supabase, 'crm-documents', filePath, att.file);
        if (upErr) throw new Error(`Failed to upload attachment ${att.name}: ${upErr.message}`);
        uploadedFiles.push({ storagePath: filePath, fileName: fileNaming.fileName });
        existingStoragePaths.push(filePath);
      }

      // 2. Get signed URLs for selected CRM docs and newly uploaded files so they can be sent via email
      const selectedDocList = crmDocs.filter(d => selectedCrmDocs.has(d.id));
      const attachmentUrls: AttachmentUrlPayload[] = [];
      for (const doc of selectedDocList) {
        const { data: signed, error: signedErr } = await supabase.storage.from('crm-documents').createSignedUrl(doc.storage_path, 3600);
        if (signedErr || !signed?.signedUrl) throw new Error(`Failed to generate signed URL for ${getCrmDocFilename(doc)}.`);
        if (signed?.signedUrl) {
          attachmentUrls.push({
            url: signed.signedUrl,
            filename: getCrmDocFilename(doc),
            source: 'crm_document',
            documentId: doc.id,
            storagePath: doc.storage_path,
          });
        }
      }

      for (const uploaded of uploadedFiles) {
        const { data: signed, error: signedErr } = await supabase.storage.from('crm-documents').createSignedUrl(uploaded.storagePath, 3600);
        if (signedErr || !signed?.signedUrl) throw new Error(`Failed to generate signed URL for ${uploaded.fileName}.`);
        if (signed?.signedUrl) {
          attachmentUrls.push({
            url: signed.signedUrl,
            filename: uploaded.fileName,
            source: 'local_upload',
            storagePath: uploaded.storagePath,
          });
        }
      }

      const toList = parseEmailRecipients(toEmail);
      const ccList = parseEmailRecipients(ccEmail);
      const bccList = parseEmailRecipients(bccEmail);
      const finalRecipientList = [...toList, ...ccList, ...bccList];
      const selectedContainsCoa = selectedDocList.some(isCoaDocument);
      const shouldMarkCoaSent = mode === 'coa' || selectedContainsCoa;

      if (toList.length === 0) throw new Error('At least one TO recipient is required.');
      const beforeWorkflowRows = await readWorkflowEvidence();

      logEmailHtmlEvidence('Actual HTML submitted to send-bulk-email', body, {
        mode,
        subject,
        toEmails: toList,
        cc: ccList,
        bcc: bccList,
        selectedCrmDocCount: selectedDocList.length,
        selectedCrmDocIds: selectedDocList.map(doc => doc.id),
      });

      // 3. Send via Gmail — fixed sender based on module purpose:
      // Customer: sales@avira.co.id
      // Supplier: kunal@avira.co.id
      const isSupplierRoute = mode === 'india' || mode === 'china';
      const senderMailbox = isSupplierRoute ? 'kunal@avira.co.id' : 'sales@avira.co.id';
      const sessionDeliveryKey = `crm_delivery_${inquiry.id}_${mode || 'general'}`;

      let activeDelivery = deliveryResult;
      if (!activeDelivery) {
        try {
          const cached = sessionStorage.getItem(sessionDeliveryKey);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed?.delivered && parsed?.sentAt && (Date.now() - new Date(parsed.sentAt).getTime() < 15 * 60 * 1000)) {
              activeDelivery = parsed;
              setDeliveryResult(parsed);
            }
          }
        } catch {
          /* ignore storage read error */
        }
      }

      let quoteSentAt = activeDelivery?.sentAt || new Date().toISOString();

      if (!activeDelivery?.delivered) {
        const { data: fnData, error: fnErr } = await supabase.functions.invoke('send-bulk-email', {
          body: {
            ...(isSupplierRoute
              ? {
                  requiredSenderEmail: 'kunal@avira.co.id',
                  senderEmail: 'kunal@avira.co.id',
                  replyTo: 'kunal@avira.co.id',
                  workflowType: mode === 'india' ? 'india_pricing' : 'supplier_pricing',
                }
              : {
                  requiredSenderEmail: 'sales@avira.co.id',
                  senderEmail: 'sales@avira.co.id',
                  replyTo: 'sales@avira.co.id',
                  workflowType: mode === 'price' ? 'customer_quote' : 'crm_bulk_email',
                }),
            toEmails: toList,
            cc: ccList,
            bcc: bccList,
            subject,
            body: sanitizedBody,
            isHtml: true,
            inquiryId: inquiry.id,
            senderName: currentUserName,
            attachmentUrls,
            threadId: replyTo?.threadId || undefined,
          },
        });

        if (fnErr || !fnData?.success) {
          const composedError = fnData?.code
            ? `${fnData.code}: ${fnData?.error || fnErr?.message || 'Failed to send email'}`
            : (fnData?.error || fnErr?.message || 'Failed to send email');
          throw new Error(composedError);
        }

        quoteSentAt = new Date().toISOString();
        const newDelivery = {
          delivered: true,
          sentAt: quoteSentAt,
          messageId: fnData?.messageId || null,
          threadId: fnData?.threadId || null,
          activityId: fnData?.activityId || null,
        };
        setDeliveryResult(newDelivery);
        activeDelivery = newDelivery;
        try {
          sessionStorage.setItem(sessionDeliveryKey, JSON.stringify(newDelivery));
        } catch {
          /* ignore storage write error */
        }
      }

      // 4. Confirmed-delivery workflow completion: delivery log, CRM activity, and durable status fields.
      const allAttachmentPaths = [
        ...uploadedFiles.map(f => f.storagePath),
        ...selectedDocList.map(d => d.storage_path),
      ];

      const { data: campaign, error: campaignError } = await supabase
        .from('bulk_email_campaigns')
        .insert({
          subject,
          total_recipients: finalRecipientList.length,
          sent_count: finalRecipientList.length,
          failed_count: 0,
          status: 'completed',
          has_attachments: attachmentUrls.length > 0,
          template_id: null,
          started_at: quoteSentAt,
          completed_at: quoteSentAt,
          created_by: user.id,
        })
        .select('id')
        .single();
      if (campaignError || !campaign) throw new Error(`Delivery Log campaign failed: ${campaignError?.message || 'No campaign id returned'}`);

      const recipientRows = finalRecipientList.map(email => ({
        campaign_id: campaign.id,
        contact_id: null,
        company_name: inquiry.company_name || '',
        email,
        status: 'sent',
        error_message: null,
        sent_at: quoteSentAt,
      }));
      const { error: recipientsError } = await supabase.from('bulk_email_recipients').insert(recipientRows);
      if (recipientsError) throw new Error(`Delivery Log recipients failed: ${recipientsError.message}`);

      const activityIds: string[] = [];
      for (const inq of allInquiries) {
        let activityId = (activeDelivery as any)?.activityId || null;

        if (!activityId) {
          // trg_crm_email_activities_dedup transparently suppresses duplicate activity insert
          // when send-bulk-email has already recorded the outbound message, returning 0 rows.
          // Using maybeSingle() avoids PGRST116 ("Cannot coerce the result to a single JSON object").
          const { data: activityData, error: activityError } = await supabase.from('crm_email_activities').insert([{
            inquiry_id: inq.id,
            email_type: 'sent',
            from_email: senderMailbox,
            to_email: toList,
            cc_email: ccList.length > 0 ? ccList : null,
            bcc_email: bccList.length > 0 ? bccList : null,
            subject,
            body,
            attachment_urls: allAttachmentPaths.length > 0 ? allAttachmentPaths : null,
            sent_date: new Date().toISOString(),
            created_by: user.id,
            gmail_message_id: activeDelivery?.messageId || null,
            gmail_thread_id: activeDelivery?.threadId || null,
          }]).select('id').maybeSingle();

          if (activityError) {
            throw new Error(`Email activity log failed for ${inq.inquiry_number}: ${activityError.message}`);
          }

          activityId = activityData?.id || null;
        }

        if (!activityId) {
          // If deduplication trigger suppressed the duplicate insert, look up the existing activity row
          const query = supabase.from('crm_email_activities').select('id');
          if (activeDelivery?.messageId) {
            query.eq('gmail_message_id', activeDelivery.messageId);
          } else {
            query.eq('inquiry_id', inq.id).eq('subject', subject).order('sent_date', { ascending: false });
          }
          const { data: existingAct } = await query.limit(1).maybeSingle();
          activityId = existingAct?.id || null;
        }
        if (activityId) activityIds.push(activityId);

        // 5. Record newly uploaded files in crm_product_documents
        if (uploadedFiles.length > 0) {
          const rows = uploadedFiles.map(({ storagePath, fileName }) => {
            const docType = inferDocumentType(fileName, mode);
            return {
              inquiry_id: inq.id,
              product_name: inq.product_name,
              make: inq.supplier_name || null,
              document_type: docType,
              original_file_name: fileName,
              display_file_name: fileName,
              storage_bucket: 'crm-documents',
              storage_path: storagePath,
              is_permanent: false,
              lifecycle_status: 'TEMP',
              uploaded_by: user.id,
            };
          });
          const { error: productDocError } = await supabase.from('crm_product_documents').insert(rows);
          if (productDocError) {
            throw new Error(`Product document save failed: ${productDocError.message}`);
          }
        }
      }

      const timelineRows = allInquiries.map(inq => ({
        inquiry_id: inq.id,
        event_type: 'email_sent',
        event_title: mode === 'price' ? 'Quotation email sent' : mode === 'coa' ? 'COA/MSDS email sent' : mode === 'india' ? 'Sent To India' : mode === 'china' ? 'Sent To China Team' : 'Email sent',
        event_description: `Subject: ${subject}`,
        old_value: beforeWorkflowRows.find(row => row.id === inq.id)?.quote_status || 'not_sent',
        new_value: mode === 'price' ? 'sent' : null,
        related_email_id: activityIds[0] || null,
        performed_by: user.id,
        event_timestamp: quoteSentAt,
      }));
      const { error: timelineError } = await supabase.from('crm_inquiry_timeline').insert(timelineRows);
      if (timelineError) throw new Error(`Inquiry timeline failed: ${timelineError.message}`);

      const activityLogRows = allInquiries.map(inq => ({
        inquiry_id: inq.id,
        activity_type: 'email_sent',
        activity_title: mode === 'price' ? 'Quotation email sent' : mode === 'coa' ? 'COA/MSDS email sent' : mode === 'india' ? 'Sent To India' : mode === 'china' ? 'Sent To China Team' : 'Email sent',
        activity_description: `Subject: ${subject}`,
        activity_date: quoteSentAt,
        attachments: allAttachmentPaths.length > 0 ? allAttachmentPaths : null,
        created_by: user.id,
      }));
      const { error: activityLogError } = await supabase.from('crm_activity_logs').insert(activityLogRows);
      if (activityLogError) throw new Error(`Activity log failed: ${activityLogError.message}`);

      // 6. Auto-update inquiry status after confirmed Gmail delivery.
      for (const inq of allInquiries) {
        const updateData: Record<string, unknown> = {};
        if (mode === 'price') {
          updateData.price_quoted = true;
          updateData.price_quoted_date = new Date().toISOString().split('T')[0];
          updateData.status = 'price_quoted';
          updateData.price_sent_at = quoteSentAt;
          updateData.quote_status = 'sent';
          updateData.quote_sent_at = quoteSentAt;
        } else if (mode === 'coa') {
          updateData.coa_sent = true;
          updateData.coa_sent_date = new Date().toISOString().split('T')[0];
          updateData.coa_sent_at = quoteSentAt;
        } else if (mode === 'india') {
          const isFirstSend = !inq.source_status || inq.source_status === 'not_sent';
          updateData.sent_to_india = true;
          updateData.sent_to_india_at = quoteSentAt;
          updateData.sent_to_india_by = user.id;
          updateData.last_sourcing_sent_at = quoteSentAt;
          updateData.source_status = isFirstSend ? 'sent' : 'waiting_reply';
        } else if (mode === 'china') {
          const isFirstSend = !inq.source_status || inq.source_status === 'not_sent';
          updateData.sent_to_china = true;
          updateData.sent_to_china_at = quoteSentAt;
          updateData.sent_to_china_by = user.id;
          updateData.last_sourcing_sent_at = quoteSentAt;
          updateData.source_status = isFirstSend ? 'sent' : 'waiting_reply';
        }
        if (shouldMarkCoaSent) {
          updateData.coa_sent = true;
          updateData.coa_sent_date = new Date().toISOString().split('T')[0];
          updateData.coa_sent_at = quoteSentAt;
        }
        if (Object.keys(updateData).length > 0) {
          const { error: updateError } = await supabase.from('crm_inquiries').update(updateData).eq('id', inq.id);
          if (updateError) {
            throw new Error(`Email was delivered successfully (Message ID: ${activeDelivery?.messageId || 'sent'}), but updating status for inquiry ${inq.inquiry_number} failed: ${updateError.message}. Click Send to retry saving status.`);
          }
        }
      }

      try {
        sessionStorage.removeItem(sessionDeliveryKey);
      } catch {
        /* ignore storage cleanup error */
      }
      setDeliveryResult(null);
      onClose();
    } catch (err: unknown) {
      console.error('Email send error:', err);
      const errorMessage = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Failed to send email. Please try again.');
      const needsReauth = errorMessage.includes('TOKEN_REAUTH_REQUIRED') || errorMessage.includes('Failed to refresh access token');
      if (needsReauth) {
        if (window.confirm(`Your Gmail connection for ${displaySender} has expired. Reconnect Gmail now?`)) openGmailReconnectPopup();
      } else {
        alert(errorMessage);
      }
    } finally {
      setSending(false);
    }
  };

  const sanitizedPreviewBody = useMemo(() => DOMPurify.sanitize(body, {
    ADD_ATTR: ['target'],
  }), [body]);

  if (!isOpen) return null;

  const isMulti = allInquiries.length > 1;
  const modeLabel =
    mode === 'price'
      ? 'Send Price Quotation'
      : mode === 'coa'
      ? 'Send COA / MSDS'
      : mode === 'india'
      ? 'Send Email to India'
      : mode === 'china'
      ? 'Send Email to China Team'
      : 'New Message';
  const isSupplierMode = mode === 'india' || mode === 'china';
  const displaySender = isSupplierMode ? 'kunal@avira.co.id' : 'sales@avira.co.id';
  const windowCls = fullscreen
    ? 'fixed inset-4 z-50 flex flex-col bg-white rounded-xl shadow-2xl border border-gray-200'
    : 'fixed bottom-0 right-6 z-50 flex flex-col bg-white rounded-t-xl shadow-2xl border border-gray-200 w-[620px]';

  const totalAttachCount = attachments.length + selectedCrmDocs.size;

  return (
    <>
      {fullscreen && <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />}

      <div className={windowCls} style={!fullscreen ? { maxHeight: minimized ? 'auto' : '90vh' } : {}}>
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-2.5 bg-gray-800 rounded-t-xl cursor-pointer select-none"
          onClick={() => !fullscreen && setMinimized(m => !m)}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-white truncate">
              {minimized ? (subject || modeLabel) : modeLabel}
            </span>
            {!minimized && (
              <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-gray-600 text-gray-200">
                {isMulti ? `${allInquiries.length} products` : inquiry.company_name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
            {templates.length > 0 && !minimized && (
              <button onClick={() => setShowTemplates(s => !s)}
                className="p-1 text-gray-300 hover:text-white hover:bg-gray-700 rounded transition" title="Templates">
                <ChevronDown className="w-4 h-4" />
              </button>
            )}
            <button onClick={() => { setMinimized(m => !m); setFullscreen(false); }}
              className="p-1 text-gray-300 hover:text-white hover:bg-gray-700 rounded transition"
              title={minimized ? 'Expand' : 'Minimize'}>
              <Minimize2 className="w-4 h-4" />
            </button>
            <button onClick={() => { setFullscreen(f => !f); setMinimized(false); }}
              className="p-1 text-gray-300 hover:text-white hover:bg-gray-700 rounded transition"
              title={fullscreen ? 'Restore' : 'Full Screen'}>
              <Maximize2 className="w-4 h-4" />
            </button>
            <button onClick={onClose}
              className="p-1 text-gray-300 hover:text-white hover:bg-gray-700 rounded transition" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {!minimized && (
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Gmail not connected warning */}
            {gmailConnected === false && (
              <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                Gmail not connected ({displaySender}) — go to Settings &gt; Gmail Settings to connect before sending.
              </div>
            )}

            {/* Multi-product indicator */}
            {isMulti && (
              <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 text-xs text-blue-800">
                <strong>{allInquiries.length} products</strong> from the same inquiry thread:{' '}
                {allInquiries.map(i => i.product_name).join(', ')}
              </div>
            )}

            {/* Templates dropdown */}
            {showTemplates && templates.length > 0 && (
              <div className="border-b border-gray-200 bg-gray-50 p-3">
                <p className="text-xs font-medium text-gray-600 mb-2">Choose template:</p>
                <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                  {templates.map(t => (
                    <button key={t.id} onClick={() => applyTemplate(t)}
                      className="text-left px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded hover:bg-blue-50 hover:border-blue-300 transition">
                      <div className="font-medium text-gray-900 truncate">{t.template_name}</div>
                      <div className="text-gray-400 truncate">{t.category}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Sender identity indicator (non-editable) */}
            <div className="flex items-center justify-between px-4 py-1.5 bg-gray-50/80 border-b border-gray-100 text-xs">
              <span className="text-gray-500 font-medium">From:</span>
              <span className="font-mono text-gray-700 bg-white border border-gray-200 px-2 py-0.5 rounded select-none text-[11px]">
                Sending from: {displaySender}
              </span>
            </div>

            {/* Fields */}
            <div className="border-b border-gray-100">
              <div className="flex items-center px-4 py-1.5 border-b border-gray-100">
                <span className="text-xs text-gray-500 w-8 shrink-0">To</span>
                <input name="to_email" aria-label="Recipients" type="email" value={toEmail} onChange={e => setToEmail(e.target.value)}
                  className="flex-1 text-sm outline-none py-1 text-gray-900 placeholder-gray-400" placeholder="Recipients" />
                <div className="flex gap-2 ml-2 shrink-0">
                  <button onClick={() => setShowCc(s => !s)} className="text-xs text-gray-500 hover:text-gray-700">Cc</button>
                  <button onClick={() => setShowBcc(s => !s)} className="text-xs text-gray-500 hover:text-gray-700">Bcc</button>
                </div>
              </div>
              {showCc && (
                <div className="flex items-center px-4 py-1.5 border-b border-gray-100">
                  <span className="text-xs text-gray-500 w-8 shrink-0">Cc</span>
                  <input name="cc_email" aria-label="Cc (comma-separated)" type="text" value={ccEmail} onChange={e => setCcEmail(e.target.value)}
                    className="flex-1 text-sm outline-none py-1 text-gray-900 placeholder-gray-400" placeholder="Cc (comma-separated)" />
                </div>
              )}
              {showBcc && (
                <div className="flex items-center px-4 py-1.5 border-b border-gray-100">
                  <span className="text-xs text-gray-500 w-8 shrink-0">Bcc</span>
                  <input name="bcc_email" aria-label="Bcc (comma-separated)" type="text" value={bccEmail} onChange={e => setBccEmail(e.target.value)}
                    className="flex-1 text-sm outline-none py-1 text-gray-900 placeholder-gray-400" placeholder="Bcc (comma-separated)" />
                </div>
              )}
              <div className="flex items-center px-4 py-1.5">
                <input name="subject" aria-label="Subject" type="text" value={subject} onChange={e => setSubject(e.target.value)}
                  className="flex-1 text-sm outline-none py-1 text-gray-900 placeholder-gray-400 font-medium" placeholder="Subject" />
              </div>
            </div>

            {/* Rich text body */}
            <div className="flex-1 overflow-y-auto" style={{ minHeight: fullscreen ? 300 : 220 }}>
              {(mode === 'price' || mode === 'india') ? (
                <div className="crm-html-composer">
                  <div
                    ref={htmlPreviewRef}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(event) => setBody(DOMPurify.sanitize(event.currentTarget.innerHTML, { ADD_ATTR: ['target'] }))}
                    dangerouslySetInnerHTML={{ __html: sanitizedPreviewBody }}
                    className="crm-html-editor"
                    style={{ minHeight: fullscreen ? 300 : 220 }}
                  />
                </div>
              ) : (
                <div ref={quillWrapRef}>
                  <ReactQuill theme="snow" value={body} onChange={setBody}
                    modules={quillModules} formats={quillFormats}
                    style={{ height: fullscreen ? '100%' : 220, border: 'none' }}
                    className="crm-quill-composer" />
                </div>
              )}
            </div>

            {/* CRM Documents panel */}
            {showDocPanel && (
              <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 max-h-48 overflow-y-auto">
                <p className="text-xs font-semibold text-gray-700 mb-2">
                  Attach documents from CRM
                  {crmDocsLoading && <span className="ml-2 text-gray-400">Loading…</span>}
                  {!crmDocsLoading && crmDocs.length === 0 && <span className="ml-2 text-gray-400 font-normal">— No documents uploaded yet for this inquiry</span>}
                </p>
                {crmDocs.map(doc => (
                  <label key={doc.id} className={`flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer hover:bg-white transition mb-0.5 ${selectedCrmDocs.has(doc.id) ? 'bg-white border border-blue-200' : ''}`}>
                    <input name="selected" aria-label="Select item" type="checkbox" checked={selectedCrmDocs.has(doc.id)} onChange={() => toggleCrmDoc(doc.id)} className="w-3.5 h-3.5" />
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${DOC_TYPE_COLOR[doc.document_type] || 'bg-gray-100 text-gray-600'}`}>{doc.document_type}</span>
                    <span className="flex-1 text-xs text-gray-700 truncate">{doc.display_file_name || doc.original_file_name || doc.storage_path.split('/').pop()}</span>
                    {selectedCrmDocs.has(doc.id) && <Check className="w-3.5 h-3.5 text-blue-600 shrink-0" />}
                  </label>
                ))}
              </div>
            )}

            {/* Attached new files list */}
            {attachments.length > 0 && (
              <div className="px-4 py-2 border-t border-gray-100 flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <div key={i} className="flex items-center gap-1.5 bg-gray-100 rounded-full px-3 py-1 text-xs text-gray-700">
                    <span className="truncate max-w-[120px]">{a.name}</span>
                    <span className="text-gray-400">({formatSize(a.size)})</span>
                    <button onClick={() => setAttachments(p => p.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500 ml-1">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100">
              <button
                onClick={sendEmail}
                disabled={sending || !toEmail.trim() || !subject.trim()}
                className="flex items-center gap-2 px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-full hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending ? <><Loader className="w-4 h-4 animate-spin" />Sending…</> : <><Send className="w-4 h-4" />Send</>}
              </button>

              <input name="file_upload" aria-label="Upload file" ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />
              <button onClick={() => fileInputRef.current?.click()}
                className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-full transition" title="Attach new file">
                <Paperclip className="w-4 h-4" />
              </button>

              <button
                onClick={() => setShowDocPanel(s => !s)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border transition ${showDocPanel ? 'bg-blue-600 text-white border-blue-600' : 'text-gray-600 border-gray-300 hover:bg-gray-100'}`}
                title="Attach from CRM documents"
              >
                <FileText className="w-3.5 h-3.5" />
                CRM Docs
                {selectedCrmDocs.size > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 bg-white text-blue-700 rounded-full text-[10px] font-bold">{selectedCrmDocs.size}</span>
                )}
              </button>

              {totalAttachCount > 0 && (
                <span className="text-xs text-gray-500">{totalAttachCount} attachment{totalAttachCount !== 1 ? 's' : ''}</span>
              )}

              <div className="ml-auto text-xs text-gray-400 truncate">
                {isMulti ? `${allInquiries.length} products · ${inquiry.company_name}` : `${inquiry.inquiry_number} · ${inquiry.product_name}`}
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .crm-quill-composer .ql-container { border: none !important; font-size: 14px; }
        .crm-quill-composer .ql-toolbar { border: none !important; border-bottom: 1px solid #f1f5f9 !important; padding: 6px 12px; }
        .crm-quill-composer .ql-editor { padding: 12px 16px; min-height: 180px; }
        .crm-quill-composer .ql-editor p { margin-bottom: 6px; }
        .crm-html-composer { min-height: 100%; background: #ffffff; }
        .crm-html-editor { padding: 12px 16px; font-size: 14px; line-height: 1.45; outline: none; color: #111827; }
        .crm-html-editor p { margin: 0 0 6px 0; }
        .crm-html-editor table { border-collapse: collapse; margin: 8px 0 14px 0; }
        .crm-html-editor th, .crm-html-editor td { border: 1px solid #d1d5db; padding: 9px 12px; text-align: left; vertical-align: top; }
      `}</style>
    </>
  );
}
