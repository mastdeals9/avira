import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { supabase } from '../../lib/supabase';
import { X, Send, Loader } from 'lucide-react';
import { showToast } from '../ToastNotification';
import {
  buildCompanySignature,
  buildInternalPriceTable,
  escapeHtml,
  type InternalPriceRow,
} from '../../utils/emailFormatting';
import { type CompanySnapshot, FALLBACK_COMPANY } from '../../types/company';
import { FloatingField, FLOAT_INPUT } from '../finance/FloatingField';
import { SapRow } from '../finance/SapLayout';

export interface KunalReplyInquiry {
  id: string;
  inquiry_number: string;
  aceerp_no: string | null;
  product_name: string;
  supplier_name: string | null;
  quantity: string;
  email_subject?: string | null;
  remarks?: string | null;
}

export interface KunalReplyDraft {
  india_price: string;
  india_price_currency: string;
  purchase_price: string;
  purchase_currency: string;
  offered_price: string;
  offered_currency: string;
  kunal_remark?: string;
}

export interface KunalReplySourceOption {
  offered_make: string | null;
}

export interface KunalReplyMultiOption {
  optionLabel?: string;
  offered_make: string | null;
  india_price: string;
  india_price_currency: string;
  purchase_price: string;
  purchase_currency: string;
  offered_price: string;
  offered_currency: string;
  kunal_remark?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  inquiry: KunalReplyInquiry;
  draft: KunalReplyDraft;
  sourceOption: KunalReplySourceOption | null;
  options?: KunalReplyMultiOption[];
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fmtPrice(price: string, currency: string): string {
  const n = parseFloat(price);
  if (isNaN(n) || n <= 0) return '-';
  return `${currency || 'USD'} ${n.toLocaleString()}`;
}

function buildBody(
  inquiry: KunalReplyInquiry,
  draft: KunalReplyDraft,
  sourceOption: KunalReplySourceOption | null,
  userName: string,
  co?: CompanySnapshot | null,
  options?: KunalReplyMultiOption[],
): string {
  const rows: InternalPriceRow[] = options && options.length > 0
    ? options.map((opt, idx) => {
        const letter = String.fromCharCode(65 + idx);
        const optMake = opt.offered_make
          ? `${opt.offered_make} (Option ${letter})`
          : `Option ${letter}`;
        return {
          inquiryNumber: inquiry.inquiry_number,
          aceerpNo: inquiry.aceerp_no,
          product: inquiry.product_name,
          requiredMake: inquiry.supplier_name,
          offeredMake: optMake,
          qty: inquiry.quantity,
          inrSourcePrice: fmtPrice(opt.india_price, opt.india_price_currency),
          usdLandedCost: fmtPrice(opt.purchase_price, opt.purchase_currency),
          quotePrice: fmtPrice(opt.offered_price, opt.offered_currency),
          remarks: opt.kunal_remark || draft.kunal_remark || inquiry.remarks || null,
        };
      })
    : [{
        inquiryNumber: inquiry.inquiry_number,
        aceerpNo: inquiry.aceerp_no,
        product: inquiry.product_name,
        requiredMake: inquiry.supplier_name,
        offeredMake: sourceOption?.offered_make ?? null,
        qty: inquiry.quantity,
        inrSourcePrice: fmtPrice(draft.india_price, draft.india_price_currency),
        usdLandedCost: fmtPrice(draft.purchase_price, draft.purchase_currency),
        quotePrice: fmtPrice(draft.offered_price, draft.offered_currency),
        remarks: draft.kunal_remark || inquiry.remarks || null,
      }];

  const safeUserName = escapeHtml(userName);
  return (
    `<p>Hi team,</p>` +
    `<p>Please find the pricing details below for <strong>${escapeHtml(inquiry.product_name)}</strong> (${escapeHtml(inquiry.inquiry_number)}):</p>` +
    buildInternalPriceTable(rows) +
    `<p>Please proceed with the customer quotation.</p>` +
    `<p>Thanks,<br>${safeUserName}</p>` +
    buildCompanySignature(userName, co)
  );
}

function buildSubject(inquiry: KunalReplyInquiry): string {
  if (inquiry.email_subject) {
    return inquiry.email_subject.startsWith('Re:') ? inquiry.email_subject : `Re: ${inquiry.email_subject}`;
  }
  return `Internal Pricing: ${inquiry.product_name} — ${inquiry.inquiry_number}`;
}

export function KunalInternalReplyModal({ isOpen, onClose, inquiry, draft, sourceOption, options }: Props) {
  const [toEmail, setToEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  const [bccEmail, setBccEmail] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [userName, setUserName] = useState('');

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

      const [settingsResult, coResult] = await Promise.all([
        supabase.from('app_settings').select('internal_price_reply_to, internal_price_reply_cc').maybeSingle(),
        supabase.from('company_profiles')
          .select('company_name, company_address, company_phone, company_email, company_tax_id, company_logo_url, pbf_license, cdob_certificate')
          .lte('effective_from', new Date().toISOString().split('T')[0])
          .order('effective_from', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      setToEmail(settingsResult.data?.internal_price_reply_to || '');
      setCcEmail(settingsResult.data?.internal_price_reply_cc || '');
      const co = (coResult.data as CompanySnapshot | null) ?? FALLBACK_COMPANY;

      setSubject(buildSubject(inquiry));
      setBody(buildBody(inquiry, draft, sourceOption, name, co, options));
    };
    init();
  }, [isOpen, inquiry.id]);

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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const ccList = parseRecipients(ccEmail);
      const bccList = parseRecipients(bccEmail);

      const { data: fnData, error: fnErr } = await supabase.functions.invoke('send-bulk-email', {
        body: {
          requiredSenderEmail: 'sales@avira.co.id',
          module: 'crm',
          toEmails: toList,
          cc: ccList,
          bcc: bccList,
          subject,
          body,
          isHtml: true,
          senderName: userName,
          workflowType: 'crm_bulk_email',
        },
      });

      if (fnErr || !fnData?.success) {
        throw new Error(fnData?.error || fnErr?.message || 'Failed to send email');
      }

      // Record threading link
      const messageId: string | null = fnData.messageId || null;
      const threadId: string | null = fnData.threadId || null;
      if (messageId || threadId) {
        // link_type uses an allowed value ('generic'); the kunal-specific intent
        // is recorded in the timeline event title below.
        supabase.from('email_inquiry_links').insert({
          gmail_message_id: messageId,
          gmail_thread_id: threadId,
          inquiry_id: inquiry.id,
          link_type: 'generic',
        }).then(() => {}, () => {});
      }

      // Record timeline event (event_type must be from the CHECK allowlist;
      // 'email_sent' is the closest match — specifics go into event_title/description)
      supabase.from('crm_inquiry_timeline').insert({
        inquiry_id: inquiry.id,
        event_type: 'email_sent',
        event_title: 'Kunal internal price reply sent',
        event_description: `Internal pricing reply sent to ${toList.join(', ')}`,
        performed_by: user.id,
      }).then(() => {}, () => {});

      showToast({ type: 'success', title: 'Sent', message: 'Internal price reply sent successfully.' });
      onClose();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Send failed', message: err.message || 'Failed to send email.' });
    } finally {
      setSending(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-[740px] max-h-[90vh] overflow-auto mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2.5">
            <h3 className="text-lg font-semibold text-gray-900">Send Internal Price Reply</h3>
            <span className="text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-full font-medium">Sending from: sales@avira.co.id</span>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* To */}
          <SapRow>
            <FloatingField label="To" filled={!!toEmail} span={12}
              right={
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setShowCc(!showCc)} className="text-xs text-blue-600 hover:underline whitespace-nowrap">Cc</button>
                  <button type="button" onClick={() => setShowBcc(!showBcc)} className="text-xs text-blue-600 hover:underline whitespace-nowrap">Bcc</button>
                </div>
              }>
              <input name="to" aria-label="To"
                type="text"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="anvi@sapharmajaya.co.id, sonal@sapharmajaya.co.id"
                className={FLOAT_INPUT}
              />
            </FloatingField>
          </SapRow>

          {/* Cc */}
          {showCc && (
            <SapRow>
              <FloatingField label="Cc" filled={!!ccEmail} span={12}>
                <input name="cc" aria-label="Cc"
                  type="text"
                  value={ccEmail}
                  onChange={(e) => setCcEmail(e.target.value)}
                  placeholder="cc@example.com"
                  className={FLOAT_INPUT}
                />
              </FloatingField>
            </SapRow>
          )}

          {/* Bcc */}
          {showBcc && (
            <SapRow>
              <FloatingField label="Bcc" filled={!!bccEmail} span={12}>
                <input name="bcc" aria-label="Bcc"
                  type="text"
                  value={bccEmail}
                  onChange={(e) => setBccEmail(e.target.value)}
                  placeholder="bcc@example.com"
                  className={FLOAT_INPUT}
                />
              </FloatingField>
            </SapRow>
          )}

          {/* Subject */}
          <SapRow>
            <FloatingField label="Subject" filled={!!subject} span={12}>
              <input name="subject" aria-label="Subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={FLOAT_INPUT}
              />
            </FloatingField>
          </SapRow>

          {/* Body preview */}
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Preview:</label>
            <div
              className="border border-gray-200 rounded-lg p-4 bg-white max-h-[400px] overflow-auto"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body) }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button onClick={onClose} disabled={sending} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending}
            className="flex items-center gap-1.5 px-5 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {sending ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {sending ? 'Sending...' : 'Confirm Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
