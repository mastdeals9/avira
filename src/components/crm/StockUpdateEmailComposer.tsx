import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { supabase } from '../../lib/supabase';
import { showToast } from '../ToastNotification';
import { applyEmailTemplateVariables } from '../../utils/crmEmailPersonalization';

interface Props { onClose: () => void; onComplete: () => void; }
interface StockRow {
  id: string; product_id?: string; batch_number: string; current_stock: number; reserved_stock: number;
  available_stock?: number;
  packaging_details: string | null; expiry_date: string | null;
  products?: { product_name: string; product_code: string; };
}
interface Recipient { id: string; sourceId: string; label: string; company_name: string; email: string; contact_person: string | null; source: 'crm_contact' | 'customer'; }
interface ContactRow { id: string; company_name: string; email: string; contact_person: string | null; }

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function StockUpdateEmailComposer({ onClose, onComplete }: Props) {
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [selectedStock, setSelectedStock] = useState<Set<string>>(new Set());
  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState('Weekly Stock Update');
  const [body, setBody] = useState('Dear {{salutation}},<br/><br/>Please find our latest stock availability below:<br/>{{stock_table}}<br/>Please reply if you would like to reserve any items.<br/><br/>Best regards');
  const [followUpDays, setFollowUpDays] = useState<number | ''>('');
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Record<string, 'pending' | 'sent' | 'failed'>>({});
  const [productSearch, setProductSearch] = useState('');
  const [showExpiryDate, setShowExpiryDate] = useState(true);
  const [showBatchNumber, setShowBatchNumber] = useState(true);
  const [manualPrices, setManualPrices] = useState<Record<string, string>>({});

  useEffect(() => { (async () => {
    const [b, sSummary, cc, cu] = await Promise.all([
      supabase.from('batches').select('id,product_id,batch_number,current_stock,reserved_stock,packaging_details,expiry_date,products(product_name,product_code)').eq('is_active', true).order('expiry_date', { ascending: true }),
      supabase.from('inventory_v1_stock_summary').select('product_id,available_quantity'),
      supabase.from('crm_contacts').select('id,company_name,email,contact_person').not('email', 'is', null).neq('email', '').eq('is_active', true),
      supabase.from('customers').select('id,company_name,email,contact_person').not('email', 'is', null).neq('email', '').eq('is_active', true),
    ]);
    const atpMap = new Map<string, number>();
    (sSummary.data || []).forEach((s: any) => atpMap.set(s.product_id, Number(s.available_quantity || 0)));

    const stockRows = ((b.data || []) as unknown as StockRow[]).map(row => {
      const atp = atpMap.get((row as any).product_id) ?? Math.max(0, row.current_stock - (row.reserved_stock || 0));
      const effectiveAvail = Math.max(0, Math.min(row.current_stock - (row.reserved_stock || 0), atp));
      return {
        ...row,
        available_stock: effectiveAvail,
        products: Array.isArray(row.products) ? row.products[0] : row.products,
      };
    }).filter(s => (s.available_stock ?? 0) > 0);
    setStocks(stockRows);
    const all: Recipient[] = [
      ...((cc.data || []) as ContactRow[]).map((r) => ({ id: `crm-${r.id}`, sourceId: r.id, label: `[CRM] ${r.company_name}`, company_name: r.company_name, email: r.email, contact_person: r.contact_person, source: 'crm_contact' as const })),
      ...((cu.data || []) as ContactRow[]).map((r) => ({ id: `cust-${r.id}`, sourceId: r.id, label: `[Customer] ${r.company_name}`, company_name: r.company_name, email: r.email, contact_person: r.contact_person, source: 'customer' as const })),
    ];
    setRecipients(all);
  })(); }, []);

  const filteredStocks = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return stocks;
    return stocks.filter(s => {
      const available = s.available_stock ?? (s.current_stock - (s.reserved_stock || 0));
      return `${s.products?.product_name || ''} ${s.products?.product_code || ''} ${s.batch_number || ''} ${available}`.toLowerCase().includes(q);
    });
  }, [productSearch, stocks]);

  const selectedStockItems = useMemo(() => stocks.filter(s => selectedStock.has(s.id)), [selectedStock, stocks]);

  const stockTableHtml = useMemo(() => {
    const headers = ['Product'];
    if (showBatchNumber) headers.push('Batch');
    headers.push('Available', 'Pack Type');
    if (showExpiryDate) headers.push('Expiry');
    headers.push('Price');

    const rows = selectedStockItems.map(s => {
      const cells = [
        `<td>${s.products?.product_name || '-'}</td>`,
      ];
      if (showBatchNumber) cells.push(`<td>${s.batch_number || '-'}</td>`);
      cells.push(`<td>${s.available_stock ?? (s.current_stock - (s.reserved_stock || 0))}</td>`);
      cells.push(`<td>${s.packaging_details || '-'}</td>`);
      if (showExpiryDate) cells.push(`<td>${s.expiry_date || '-'}</td>`);
      cells.push(`<td>${manualPrices[s.id] || ''}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    }).join('');

    return `<table border="1" cellspacing="0" cellpadding="6"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }, [manualPrices, selectedStockItems, showBatchNumber, showExpiryDate]);

  const invalidRecipientIds = useMemo(() => {
    const invalid = new Set<string>();
    recipients.forEach(r => {
      const emails = r.email.split(';').map(e => e.trim()).filter(Boolean);
      if (!emails.length || emails.some(e => !EMAIL_REGEX.test(e))) invalid.add(r.id);
    });
    return invalid;
  }, [recipients]);

  const sanitizedPreviewHtml = useMemo(
    () => DOMPurify.sanitize(body.replace('{{stock_table}}', stockTableHtml)),
    [body, stockTableHtml]
  );

  const resolveContactId = async (r: Recipient): Promise<string | null> => {
    if (r.source === 'crm_contact') return r.sourceId;
    const { data } = await supabase.from('crm_contacts').select('id').eq('email', r.email).maybeSingle();
    return data?.id || null;
  };

  const sendEmail = async (selected: Recipient[], isTest = false) => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: session } = await supabase.auth.getSession();
    if (!user || !session.session) return false;

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const newResults: Record<string, 'pending' | 'sent' | 'failed'> = {};

    for (const r of selected) {
      if (invalidRecipientIds.has(r.id)) {
        newResults[r.id] = 'failed';
        setResults({ ...newResults });
        continue;
      }
      newResults[r.id] = 'pending'; setResults({ ...newResults });
      const contactId = await resolveContactId(r);
      if (!contactId && !isTest) { newResults[r.id] = 'failed'; setResults({ ...newResults }); continue; }

      const personalizedSubject = applyEmailTemplateVariables(subject, r);
      const personalizedBody = applyEmailTemplateVariables(body.replace('{{stock_table}}', stockTableHtml), r);
      const toEmails = isTest ? [user.email || ''] : r.email.split(';').map(e => e.trim()).filter(Boolean);

      const resp = await fetch(`${supabaseUrl}/functions/v1/send-bulk-email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.session.access_token}` },
        body: JSON.stringify({ userId: user.id, toEmails, subject: `[TEST] ${personalizedSubject}`, body: personalizedBody, contactId, senderName: '', isHtml: true, workflowType: 'stock_update' }),
      });
      const data = await resp.json();
      if (data.success) {
        if (!isTest) {
          await supabase.from('crm_email_activities').insert({
            contact_id: contactId, email_type: 'sent', from_email: user.email, to_email: toEmails,
            subject: personalizedSubject, body: personalizedBody, sent_date: new Date().toISOString(), created_by: user.id,
          });
        }
        newResults[r.id] = 'sent';
      } else newResults[r.id] = 'failed';
      setResults({ ...newResults });
    }

    if (followUpDays && !isTest) {
      const dueDate = new Date(Date.now() + Number(followUpDays) * 86400000).toISOString();
      const reminders = await Promise.all(selected.map(async r => {
        const contactId = await resolveContactId(r);
        return contactId ? { contact_id: contactId, reminder_type: 'follow_up', due_date: dueDate, assigned_to: user.id, created_by: user.id, inquiry_id: null, title: `Stock update follow-up: ${r.company_name}` } : null;
      }));
      const valid = reminders.filter(Boolean);
      if (valid.length) await supabase.from('crm_reminders').insert(valid);
    }

    return true;
  };

  const send = async () => {
    const selected = recipients.filter(r => selectedRecipients.has(r.id));
    if (!selected.length || !selectedStock.size) return showToast({ type: 'error', title: 'Error', message: 'Select stock and recipients' });
    if (selected.some(r => invalidRecipientIds.has(r.id))) return showToast({ type: 'error', title: 'Invalid email', message: 'One or more selected recipients have no valid email.' });
    setSending(true);
    await sendEmail(selected, false);
    setSending(false);
    onComplete();
    showToast({ type: 'success', title: 'Done', message: 'Stock update emails processed' });
  };

  const sendTestEmailToMyself = async () => {
    const selected = recipients.filter(r => selectedRecipients.has(r.id)).slice(0, 1);
    if (!selected.length || !selectedStock.size) return showToast({ type: 'error', title: 'Error', message: 'Select at least one recipient and stock for a test email.' });
    setSending(true);
    const ok = await sendEmail(selected, true);
    setSending(false);
    if (ok) showToast({ type: 'success', title: 'Test sent', message: 'Test email sent to your account email.' });
  };

  return <div className='space-y-3 p-3 max-h-[80vh] overflow-y-auto'>
    <h3 className='font-semibold'>Stock Update Email</h3>
    <div className='grid grid-cols-1 lg:grid-cols-2 gap-3'>
      <div className='border rounded p-2 space-y-2'>
        <input name="product_search" aria-label="Search product / code / batch" className='w-full border rounded px-2 py-1 text-xs' placeholder='Search product / code / batch' value={productSearch} onChange={e => setProductSearch(e.target.value)} />
        <div className='max-h-44 overflow-auto space-y-1'>
          {filteredStocks.map(s => <div key={s.id} className='flex items-center justify-between gap-2 text-xs border rounded px-2 py-1'>
            <label className='flex items-center gap-2 min-w-0'>
              <input name="selected" aria-label="Select item" type='checkbox' checked={selectedStock.has(s.id)} onChange={() => { const n = new Set(selectedStock); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); setSelectedStock(n); }} />
              <span className='truncate'>{s.products?.product_name} • {s.available_stock ?? (s.current_stock - (s.reserved_stock || 0))} avail</span>
            </label>
            <input name="manual_prices" aria-label="Price" className='w-24 border rounded px-1 py-0.5 text-xs' placeholder='Price' value={manualPrices[s.id] || ''} onChange={e => setManualPrices(prev => ({ ...prev, [s.id]: e.target.value }))} />
          </div>)}
        </div>
      </div>
      <div className='border rounded p-2 max-h-56 overflow-auto'>
        {recipients.map(r => <label key={r.id} className='block text-xs'>
          <input name="selected" aria-label="Select item" type='checkbox' checked={selectedRecipients.has(r.id)} onChange={() => { const n = new Set(selectedRecipients); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setSelectedRecipients(n); }} /> {r.label} ({r.email})
          {invalidRecipientIds.has(r.id) && <span className='text-red-600 ml-2'>⚠ invalid email</span>}
        </label>)}
      </div>
    </div>
    <div className='flex flex-wrap gap-4 text-xs'>
      <label className='flex items-center gap-1'><input name="checkbox" aria-label="Checkbox" type='checkbox' checked={showExpiryDate} onChange={e => setShowExpiryDate(e.target.checked)} /> Include expiry date</label>
      <label className='flex items-center gap-1'><input name="checkbox" aria-label="Checkbox" type='checkbox' checked={showBatchNumber} onChange={e => setShowBatchNumber(e.target.checked)} /> Include batch number</label>
    </div>
    <input name="subject" aria-label="Subject" className='w-full border rounded p-2 text-sm' value={subject} onChange={e => setSubject(e.target.value)} />
    <textarea name="body" aria-label="Body" className='w-full border rounded p-2 text-sm h-28' value={body} onChange={e => setBody(e.target.value)} />
    <div className='border rounded p-3 bg-gray-50'>
      <div className='text-xs font-semibold mb-2'>Email Preview</div>
      <div className='text-xs bg-white border rounded p-2 overflow-auto max-h-52' dangerouslySetInnerHTML={{ __html: sanitizedPreviewHtml }} />
    </div>
    <select name="follow_up_days" aria-label="Follow Up Days" className='border rounded p-2 text-sm' value={followUpDays} onChange={e => setFollowUpDays(e.target.value ? Number(e.target.value) : '')}><option value=''>No follow-up reminder</option><option value='3'>Remind in 3 days</option><option value='7'>Remind in 7 days</option></select>
    <div className='text-xs'>Delivery: sent {Object.values(results).filter(v => v === 'sent').length}, failed {Object.values(results).filter(v => v === 'failed').length}, pending {Object.values(results).filter(v => v === 'pending').length}</div>
    <div className='flex gap-2 justify-end flex-wrap'>
      <button onClick={onClose} className='px-3 py-1 border rounded'>Close</button>
      <button disabled={sending} onClick={sendTestEmailToMyself} className='px-3 py-1 border rounded'>Send test email to myself</button>
      <button disabled={sending} onClick={send} className='px-3 py-1 bg-blue-600 text-white rounded'>Send</button>
    </div>
  </div>;
}
