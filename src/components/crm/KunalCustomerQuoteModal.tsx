import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { supabase } from '../../lib/supabase';
import { X, Send, Loader, Paperclip, Plus } from 'lucide-react';
import { AttachFromDocumentBankModal } from '../documents/AttachFromDocumentBankModal';
import { linkUniversalDocument } from '../../services/documents/universalDocumentBankService';
import { showToast } from '../ToastNotification';
import {
  buildCompanySignature,
  buildCustomerQuoteTable,
  escapeHtml,
  type CustomerQuoteRow,
} from '../../utils/emailFormatting';
import { type CompanySnapshot, FALLBACK_COMPANY } from '../../types/company';
import { sendPricingWorkflowEmail, type PricingEmailAttachment } from '../../services/pricingEmail';
import { getSignedUrlCached } from '../../utils/signedUrlCache';
import { findBankedDocumentsForProductMake } from '../../services/crm/documentBankService';
import { CustomerPriceHistoryCard } from '../pricing/CustomerPriceHistoryCard';
import { FloatingField, FLOAT_INPUT } from '../finance/FloatingField';
import { SapRow } from '../finance/SapLayout';

export interface CustomerQuoteInquiry {
  id: string;
  inquiry_number: string;
  aceerp_no: string | null;
  product_name: string;
  quantity: string | null;
  email_subject?: string | null;
  contact_email?: string | null;
  company_name?: string | null;
}

/** Selected pricing option — customer-safe fields only. */
export interface CustomerQuoteOption {
  offered_make: string | null;
  origin: string | null;
  specification: string | null;
  moq: string | null;
  packing: string | null;
  lead_time: string | null;
  selling_price: number | null;
  selling_currency: string | null;
  source_currency: string;
  remark: string | null;
}

interface DocItem {
  id: string;
  document_type: string;
  display_file_name: string | null;
  original_file_name: string | null;
  storage_path: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  inquiry: CustomerQuoteInquiry;
  option?: CustomerQuoteOption | null;
  options?: any[] | null;
}

function parseRecipients(raw: string): string[] {
  return raw.split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

function fmtPrice(price: number | null, currency: string): string {
  if (price == null || isNaN(price) || price <= 0) return 'On request';
  return `${currency || 'USD'} ${price.toLocaleString()}`;
}

function buildBody(
  inquiry: CustomerQuoteInquiry,
  option: CustomerQuoteOption | null | undefined,
  options: any[] | null | undefined,
  userName: string,
  co?: CompanySnapshot | null,
): string {
  let candidateOptions: any[] = [];
  if (options && options.length > 0) {
    candidateOptions = options.filter(o => o.include_in_customer_quote !== false);
  } else if (option) {
    candidateOptions = [option];
  }

  if (candidateOptions.length === 0 && option) {
    candidateOptions = [option];
  }

  const rows: CustomerQuoteRow[] = candidateOptions.map((opt, idx) => {
    let makeLabel = opt.offered_make || null;
    if (candidateOptions.length > 1 && makeLabel) {
      makeLabel = `${makeLabel} (Option ${String.fromCharCode(65 + idx)}${idx === 0 ? ' — Primary' : ' — Alternate'})`;
    }
    return {
      product: inquiry.product_name,
      make: makeLabel,
      origin: opt.origin ?? null,
      specification: opt.specification ?? null,
      moq: opt.moq ?? null,
      packing: opt.packing ?? null,
      leadTime: opt.lead_time ?? null,
      qty: inquiry.quantity,
      quotePrice: fmtPrice(opt.selling_price ?? null, opt.selling_currency || opt.source_currency || 'USD'),
      remarks: opt.remark ?? null,
    };
  });

  const greeting = inquiry.company_name ? `Dear ${escapeHtml(inquiry.company_name)} team,` : 'Dear Sir/Madam,';
  const intro = candidateOptions.length > 1
    ? `<p>Thank you for your inquiry. Please find our quotation for <strong>${escapeHtml(inquiry.product_name)}</strong> below offering ${candidateOptions.length} sourcing options for your consideration:</p>`
    : `<p>Thank you for your inquiry. Please find our quotation for <strong>${escapeHtml(inquiry.product_name)}</strong> below:</p>`;

  return (
    `<p>${greeting}</p>` +
    intro +
    buildCustomerQuoteTable(rows) +
    `<p style="margin-top:12px;">Prices are subject to confirmation at the time of order. We look forward to your valued order.</p>` +
    buildCompanySignature(userName, co)
  );
}

function buildSubject(inquiry: CustomerQuoteInquiry): string {
  if (inquiry.email_subject) {
    return inquiry.email_subject.startsWith('Re:') ? inquiry.email_subject : `Re: ${inquiry.email_subject}`;
  }
  return `Quotation: ${inquiry.product_name} — ${inquiry.inquiry_number}`;
}

export function KunalCustomerQuoteModal({ isOpen, onClose, inquiry, option, options }: Props) {
  const [toEmail, setToEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  const [bccEmail, setBccEmail] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [userName, setUserName] = useState('');
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [resolvedCustomerId, setResolvedCustomerId] = useState<string | null>(null);
  const [resolvedProductId, setResolvedProductId] = useState<string | null>(null);
  const [bankModalOpen, setBankModalOpen] = useState(false);

  const handleAttachBankDoc = async (doc: any) => {
    try {
      await linkUniversalDocument({
        documentId: doc.id,
        entityType: 'crm_inquiry',
        entityId: inquiry.id,
        productId: resolvedProductId || undefined,
        productSourceId: doc.primary_product_source_id || undefined,
      });
    } catch (err) {
      console.error('Failed to create relational document link:', err);
    }

    const newDocItem: DocItem = {
      id: doc.id,
      document_type: doc.document_type,
      display_file_name: `[Bank] ${doc.title}`,
      original_file_name: doc.original_file_name,
      storage_path: doc.storage_path || '',
    };
    setDocs(prev => [...prev.filter(d => d.id !== doc.id), newDocItem]);
    setSelectedDocs(prev => new Set(prev).add(doc.id));
    showToast({ type: 'success', title: 'Attached from Bank', message: `Attached "${doc.title}" to quotation` });
  };

  useEffect(() => {
    if (!isOpen) return;
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      let name = '';
      if (user) {
        const { data: profile } = await supabase.from('user_profiles').select('full_name').eq('id', user.id).maybeSingle();
        name = profile?.full_name || '';
      }
      setUserName(name);

      const [coResult, docResult, inqResult] = await Promise.all([
        supabase.from('company_profiles')
          .select('company_name, company_address, company_phone, company_email, company_tax_id, company_logo_url, pbf_license, cdob_certificate')
          .lte('effective_from', new Date().toISOString().split('T')[0])
          .order('effective_from', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from('crm_product_documents')
          .select('id,document_type,display_file_name,original_file_name,storage_path')
          .eq('inquiry_id', inquiry.id)
          .order('created_at', { ascending: false }),
        supabase.from('crm_inquiries')
          .select('customer_id, product_name')
          .eq('id', inquiry.id)
          .maybeSingle(),
      ]);
      const co = (coResult.data as CompanySnapshot | null) ?? FALLBACK_COMPANY;
      const directDocs = (docResult.data as DocItem[]) || [];

      // Auto-surface BANKED technical documents for this Product + Make
      const targetProductName = inqResult.data?.product_name || inquiry.product_name;
      let bankedDocs: DocItem[] = [];
      if (targetProductName) {
        const foundBanked = await findBankedDocumentsForProductMake({
          productName: targetProductName,
          make: option?.offered_make || undefined,
        });
        bankedDocs = foundBanked.map(b => ({
          id: b.id,
          document_type: b.document_type,
          display_file_name: b.display_file_name ? `[Banked] ${b.display_file_name}` : b.display_file_name,
          original_file_name: b.original_file_name,
          storage_path: b.storage_path,
        }));
      }

      // Merge and deduplicate by id
      const mergedMap = new Map<string, DocItem>();
      directDocs.forEach(d => mergedMap.set(d.id, d));
      bankedDocs.forEach(d => {
        if (!mergedMap.has(d.id)) mergedMap.set(d.id, d);
      });

      setDocs(Array.from(mergedMap.values()));
      setSelectedDocs(new Set());
      setToEmail(inquiry.contact_email || '');
      setSubject(buildSubject(inquiry));
      setBody(buildBody(inquiry, option, options, name, co));

      if (inqResult.data?.customer_id) {
        setResolvedCustomerId(inqResult.data.customer_id);
      }
      if (targetProductName) {
        const { data: prodData } = await supabase
          .from('products')
          .select('id')
          .ilike('product_name', `%${targetProductName.trim()}%`)
          .limit(1)
          .maybeSingle();
        if (prodData?.id) {
          setResolvedProductId(prodData.id);
        }
      }
    };
    init();
  }, [isOpen, inquiry.id]);

  const toggleDoc = (id: string) => {
    setSelectedDocs(cur => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSend = async () => {
    const toList = parseRecipients(toEmail);
    if (toList.length === 0) {
      showToast({ type: 'error', title: 'Missing recipient', message: 'Please enter at least one TO email address.' });
      return;
    }
    if (!subject.trim()) {
      showToast({ type: 'error', title: 'Missing subject', message: 'Please enter a subject line.' });
      return;
    }

    setSending(true);
    try {
      // Resolve signed URLs for the selected attachments (private bucket).
      const attachments: PricingEmailAttachment[] = [];
      for (const doc of docs) {
        if (!selectedDocs.has(doc.id)) continue;
        const url = await getSignedUrlCached('crm-documents', doc.storage_path, 3600);
        if (!url) continue;
        attachments.push({
          url,
          storagePath: doc.storage_path,
          filename: doc.display_file_name || doc.original_file_name || `${doc.document_type}.pdf`,
        });
      }

      const result = await sendPricingWorkflowEmail({
        workflowType: 'customer_quote',
        requiredSenderEmail: 'sales@avira.co.id',
        module: 'crm',
        to: toList,
        cc: parseRecipients(ccEmail),
        bcc: parseRecipients(bccEmail),
        subject,
        body,
        isHtml: true,
        senderName: userName,
        attachmentUrls: attachments,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to send quotation.');
      }

      // Record threading + timeline (best-effort).
      const { data: { user } } = await supabase.auth.getUser();
      if (user && (result.messageId || result.threadId)) {
        supabase.from('email_inquiry_links').insert({
          gmail_message_id: result.messageId,
          gmail_thread_id: result.threadId,
          inquiry_id: inquiry.id,
          link_type: 'generic',
        }).then(() => {}, () => {});
        const candidateOptions = (options && options.length > 0)
          ? options.filter((o: any) => o.include_in_customer_quote !== false)
          : (option ? [option] : []);

        supabase.from('crm_inquiry_timeline').insert({
          inquiry_id: inquiry.id,
          event_type: 'quote_sent',
          event_title: 'Customer quotation sent',
          event_description: `Quotation sent to ${toList.join(', ')}${attachments.length ? ` with ${attachments.length} attachment(s)` : ''}`,
          performed_by: user.id,
          metadata: {
            pricing_option_ids: candidateOptions.map((o: any) => o.id).filter(Boolean),
            makes: candidateOptions.map((o: any) => o.offered_make).filter(Boolean),
          },
        }).then(() => {}, () => {});

        supabase.from('crm_inquiries').update({
          quote_status: 'sent',
          updated_at: new Date().toISOString(),
        }).eq('id', inquiry.id).then(() => {}, () => {});
      }

      showToast({ type: 'success', title: 'Quotation sent', message: `Sent to ${toList.join(', ')}.` });
      onClose();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Send failed', message: err.message || 'Failed to send quotation.' });
    } finally {
      setSending(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-[820px] max-h-[90vh] overflow-auto mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2.5">
            <h3 className="text-lg font-semibold text-gray-900">Send Customer Quotation</h3>
            <span className="text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-full font-medium">Sending from: sales@avira.co.id</span>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <SapRow>
            <FloatingField label="To" filled={!!toEmail} span={12}
              right={
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setShowCc(!showCc)} className="text-xs text-blue-600 hover:underline whitespace-nowrap">Cc</button>
                  <button type="button" onClick={() => setShowBcc(!showBcc)} className="text-xs text-blue-600 hover:underline whitespace-nowrap">Bcc</button>
                </div>
              }>
              <input name="to" aria-label="To" type="text" value={toEmail} onChange={e => setToEmail(e.target.value)}
                placeholder="customer@example.com"
                className={FLOAT_INPUT} />
            </FloatingField>
          </SapRow>

          {showCc && (
            <SapRow>
              <FloatingField label="Cc" filled={!!ccEmail} span={12}>
                <input name="cc" aria-label="Cc" type="text" value={ccEmail} onChange={e => setCcEmail(e.target.value)}
                  placeholder="cc@example.com" className={FLOAT_INPUT} />
              </FloatingField>
            </SapRow>
          )}

          {showBcc && (
            <SapRow>
              <FloatingField label="Bcc" filled={!!bccEmail} span={12}>
                <input name="bcc" aria-label="Bcc" type="text" value={bccEmail} onChange={e => setBccEmail(e.target.value)}
                  placeholder="bcc@example.com" className={FLOAT_INPUT} />
              </FloatingField>
            </SapRow>
          )}

          <SapRow>
            <FloatingField label="Subject" filled={!!subject} span={12}>
              <input name="subject" aria-label="Subject" type="text" value={subject} onChange={e => setSubject(e.target.value)}
                className={FLOAT_INPUT} />
            </FloatingField>
          </SapRow>

          {/* Attachment picker */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-gray-600 flex items-center gap-1">
                <Paperclip className="w-3.5 h-3.5 text-gray-400" /> Attach documents:
              </label>
              <button
                type="button"
                onClick={() => setBankModalOpen(true)}
                className="text-xs text-blue-600 hover:text-blue-800 font-semibold inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Attach from Document Bank
              </button>
            </div>
            {docs.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {docs.map(doc => (
                  <label key={doc.id} className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs cursor-pointer ${selectedDocs.has(doc.id) ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600'}`}>
                    <input name="selected" aria-label="Select item" type="checkbox" checked={selectedDocs.has(doc.id)} onChange={() => toggleDoc(doc.id)} className="text-blue-600" />
                    <span className="font-medium">{doc.document_type}</span>
                    <span className="truncate max-w-[180px]" title={doc.display_file_name || doc.original_file_name || ''}>{doc.display_file_name || doc.original_file_name || 'file'}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-gray-400 italic">No pre-loaded attachments. Click "Attach from Document Bank" above to attach verified technical specs.</p>
            )}
          </div>

          {/* Informational Customer Price History & Rate Card Benchmark */}
          {resolvedProductId && (
            <div className="my-2">
              <CustomerPriceHistoryCard
                customerId={resolvedCustomerId}
                productId={resolvedProductId}
                currentCurrency={option?.selling_currency || 'IDR'}
                compact={true}
              />
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Preview (customer-safe — no source cost shown):</label>
            <div className="border border-gray-200 rounded-lg p-4 bg-white max-h-[400px] overflow-auto"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body) }} />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button onClick={onClose} disabled={sending} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={handleSend} disabled={sending}
            className="flex items-center gap-1.5 px-5 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {sending ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {sending ? 'Sending...' : 'Confirm Send'}
          </button>
        </div>
      </div>

      {bankModalOpen && (
        <AttachFromDocumentBankModal
          isOpen={bankModalOpen}
          onClose={() => setBankModalOpen(false)}
          initialProductId={resolvedProductId}
          title={`Attach Document to Quote (${inquiry.product_name})`}
          onDocumentSelected={handleAttachBankDoc}
        />
      )}
    </div>
  );
}
