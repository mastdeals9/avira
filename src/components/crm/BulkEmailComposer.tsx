import { useState, useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { supabase } from '../../lib/supabase';
import {
  Send, FileText, Clock, Users, CheckCircle,
  XCircle, Bold, Italic, Underline, List, AlignLeft, AlignCenter,
  AlignRight, Link2, ChevronDown, X, Minus, Plus, Type, Paperclip, Trash2
} from 'lucide-react';
import { showToast } from '../ToastNotification';
import { getDisplayContactName } from '../../utils/crmEmailPersonalization';
import { uploadOptimizedFile } from '../../services/storage/uploadOptimizationService';
import { deduplicateCampaignEmailRecipients } from '../../utils/crmContactCleaners';

interface EmailTemplate {
  id: string;
  template_name: string;
  subject: string;
  body: string;
  category: string | null;
}

interface SelectedCustomer {
  id: string;
  company_name: string;
  email: string;
  contact_person: string | null;
}

interface BulkEmailComposerProps {
  selectedCustomers: SelectedCustomer[];
  onClose: () => void;
  onComplete: () => void;
}

interface SendResult {
  customerId: string;
  companyName: string;
  email: string;
  status: 'pending' | 'sending' | 'success' | 'error';
  error?: string;
}

interface AttachedFile {
  file: File;
  id: string;
}

const VARIABLES = [
  { label: 'Company Name', value: '{{company_name}}' },
  { label: 'Contact Person', value: '{{contact_person}}' },
  { label: 'Customer Name', value: '{{Customer_name}}' },
  { label: 'Salutation', value: '{{salutation}}' },
];

function getJwtExpiryMs(accessToken: string): number | null {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1] || ''));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function uploadBulkEmailAttachment(campaignId: string, attached: AttachedFile) {
  const safeName = attached.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `bulk-email/${campaignId}/${attached.id}-${safeName}`;
  const { error: uploadError, optimization } = await uploadOptimizedFile(
    supabase,
    'crm-documents',
    storagePath,
    attached.file,
    { upsert: true }
  );
  if (uploadError) throw uploadError;

  const { data: signed, error: signedError } = await supabase.storage
    .from('crm-documents')
    .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
  if (signedError || !signed?.signedUrl) throw signedError || new Error('Could not create attachment URL');

  return {
    url: signed.signedUrl,
    filename: attached.file.name,
    mimeType: optimization.mimeType || attached.file.type || 'application/octet-stream',
    source: 'bulk_email_upload',
    storagePath,
  };
}

async function getFreshAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  let session = data.session;
  if (!session?.access_token) throw new Error('Not authenticated');

  const expiryMs = getJwtExpiryMs(session.access_token);
  const refreshBufferMs = 2 * 60 * 1000;
  if (!expiryMs || expiryMs - Date.now() <= refreshBufferMs) {
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session?.access_token) {
      throw new Error(refreshed.error?.message || 'Session refresh failed');
    }
    session = refreshed.data.session;
  }

  return session.access_token;
}

export function BulkEmailComposer({ selectedCustomers, onClose, onComplete }: BulkEmailComposerProps) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [subject, setSubject] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [sending, setSending] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [showVariableMenu, setShowVariableMenu] = useState(false);
  const [sendResults, setSendResults] = useState<SendResult[]>([]);
  const [step, setStep] = useState<'compose' | 'sending' | 'done'>('compose');
  const [senderName, setSenderName] = useState('');
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const editorRef = useRef<HTMLDivElement>(null);
  const templateMenuRef = useRef<HTMLDivElement>(null);
  const variableMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadTemplates();
    loadSenderInfo();
    const results = selectedCustomers.map(c => ({
      customerId: c.id,
      companyName: c.company_name,
      email: c.email,
      status: 'pending' as const,
    }));
    setSendResults(results);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (templateMenuRef.current && !templateMenuRef.current.contains(e.target as Node)) {
        setShowTemplateMenu(false);
      }
      if (variableMenuRef.current && !variableMenuRef.current.contains(e.target as Node)) {
        setShowVariableMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadSenderInfo = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('user_profiles')
      .select('full_name')
      .eq('id', user.id)
      .maybeSingle();
    if (data?.full_name) setSenderName(data.full_name);
  };

  const loadTemplates = async () => {
    const { data } = await supabase
      .from('crm_email_templates')
      .select('*')
      .eq('is_active', true)
      .order('template_name');
    setTemplates(data || []);
  };

  const applyTemplate = (template: EmailTemplate) => {
    setSubject(template.subject);
    setSelectedTemplate(template);
    setShowTemplateMenu(false);
    if (editorRef.current) {
      editorRef.current.innerHTML = DOMPurify.sanitize(template.body);
    }
  };

  const execFormat = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    syncHtml();
  };

  const syncHtml = () => undefined;

  const insertVariable = (variable: string) => {
    editorRef.current?.focus();
    document.execCommand('insertText', false, variable);
    syncHtml();
    setShowVariableMenu(false);
  };

  const insertLink = () => {
    const url = prompt('Enter URL:');
    if (url) execFormat('createLink', url);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newAttachments = files.map(file => ({
      file,
      id: `${Date.now()}-${Math.random()}`,
    }));
    setAttachments(prev => [...prev, ...newAttachments]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const sendBulkEmails = async () => {
    const rawHtml = editorRef.current?.innerHTML || '';
    const currentHtml = DOMPurify.sanitize(rawHtml);
    if (!subject.trim() || !currentHtml.trim() || currentHtml === '<br>') {
      showToast({ type: 'error', title: 'Error', message: 'Please fill in subject and message' });
      return;
    }

    setSending(true);
    setStep('sending');

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: gmailConnection } = await supabase
        .from('gmail_connections')
        .select('*')
        .ilike('email_address', 'sales@avira.co.id')
        .eq('is_connected', true)
        .limit(1)
        .maybeSingle();

      if (!gmailConnection) {
        showToast({
          type: 'error',
          title: 'CRM Sales Gmail Not Connected',
          message: 'sales@avira.co.id is not connected. Please connect it in Gmail Settings.',
        });
        setSending(false);
        setStep('compose');
        return;
      }

      const { data: settings } = await supabase
        .from('app_settings')
        .select('bulk_email_batch_size, bulk_email_batch_delay_seconds')
        .limit(1)
        .maybeSingle();

      // Deduplicate selected customers by email address to prevent duplicate dispatch
      const { unique: uniqueRecipients, duplicateCount } = deduplicateCampaignEmailRecipients(selectedCustomers);
      if (duplicateCount > 0) {
        console.info(`[BulkEmailComposer] Excluded ${duplicateCount} duplicate email recipients from campaign.`);
      }

      // email_body and sender_name go in the initial INSERT so they are always
      // persisted atomically — if only a separate UPDATE were used and it failed
      // silently, retry would have no body to send.
      const { data: campaign, error: campaignErr } = await supabase
        .from('bulk_email_campaigns')
        .insert({
          subject,
          total_recipients: uniqueRecipients.length,
          sent_count: 0,
          failed_count: 0,
          status: 'in_progress',
          has_attachments: attachments.length > 0,
          template_id: selectedTemplate?.id || null,
          created_by: user.id,
          email_body: currentHtml,
          sender_name: senderName,
          processing_batch_size: Math.max(1, Number(settings?.bulk_email_batch_size || 10)),
          processing_delay_seconds: Math.max(0, Number(settings?.bulk_email_batch_delay_seconds || intervalSeconds || 30)),
          next_run_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (campaignErr || !campaign) {
        throw new Error(`Delivery Log campaign failed: ${campaignErr?.message || 'No campaign id returned'}`);
      }
      const campaignId: string | null = campaign?.id || null;

      // Upload attachments after campaign row exists so storage paths reference campaignId
      const attachmentUrls = campaignId
        ? await Promise.all(attachments.map(att => uploadBulkEmailAttachment(campaignId, att)))
        : [];

      if (campaignId && attachmentUrls.length > 0) {
        const { error: attErr } = await supabase
          .from('bulk_email_campaigns')
          .update({ attachments_context: attachmentUrls })
          .eq('id', campaignId);
        if (attErr) throw new Error(`Failed to save attachment metadata: ${attErr.message}`);
      }

      // Insert all recipients as 'pending' up-front — only if the campaign
      // log row exists; otherwise skip the recipients log table too.
      if (campaignId) {
        await supabase.from('bulk_email_recipients').insert(
          uniqueRecipients.map((c, idx) => ({
            campaign_id: campaignId,
            contact_id: c.id,
            company_name: c.company_name,
            email: c.email,
            status: 'pending',
            send_order: idx + 1,
          }))
        ).then(({ error }) => {
          if (error) throw error;
        });
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const accessToken = await getFreshAccessToken();
      const response = await fetch(`${supabaseUrl}/functions/v1/process-bulk-email-campaign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ campaignId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        throw new Error(result.error || `Worker start failed: HTTP ${response.status}`);
      }

      if (selectedTemplate) {
        await supabase
          .from('crm_email_templates')
          .update({ last_used: new Date().toISOString() })
          .eq('id', selectedTemplate.id);
      }

      setStep('done');
      showToast({
        type: 'success',
        title: 'Bulk Email Started',
        message: `${selectedCustomers.length} recipients queued. Check Delivery Log for progress.`,
      });
      onComplete();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message || 'Failed to complete bulk email.' });
      setStep('compose');
    } finally {
      setSending(false);
    }
  };

  const successCount = sendResults.filter(r => r.status === 'success').length;
  const errorCount = sendResults.filter(r => r.status === 'error').length;
  const pendingCount = sendResults.filter(r => r.status === 'pending').length;
  const progress = selectedCustomers.length > 0 ? (successCount + errorCount) / selectedCustomers.length : 0;

  return (
    <div className="flex flex-col h-full" style={{ height: '85vh' }}>
      {/* Gmail-style header */}
      <div className="flex items-center justify-between px-5 py-3 bg-gray-800 rounded-t-lg flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white text-sm">New Message</span>
          <span className="px-2 py-0.5 bg-gray-700 text-gray-200 text-xs rounded font-mono select-none">
            Sending from: sales@avira.co.id
          </span>
          <span className="px-2 py-0.5 bg-blue-500 text-white text-xs rounded-full font-medium flex items-center gap-1">
            <Users className="w-3 h-3" />
            {selectedCustomers.length} recipients — sent individually
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onClose} disabled={sending} className="p-1.5 text-gray-300 hover:text-white hover:bg-gray-700 rounded transition disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden bg-white">
        {/* Main compose area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* To field */}
          <div className="flex items-start gap-2 px-5 py-2.5 border-b border-gray-200 bg-white flex-shrink-0">
            <span className="text-sm text-gray-500 w-16 flex-shrink-0 mt-0.5">To</span>
            <div className="flex-1 flex flex-wrap gap-1.5">
              {selectedCustomers.slice(0, 6).map(c => (
                <span key={c.id} className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-800 font-medium">
                  {`${getDisplayContactName(c.contact_person)} <${c.email}>`}
                </span>
              ))}
              {selectedCustomers.length > 6 && (
                <span className="inline-flex items-center px-2 py-1 bg-gray-100 border border-gray-200 rounded-full text-xs text-gray-600">
                  +{selectedCustomers.length - 6} more
                </span>
              )}
            </div>
          </div>

          {/* Subject */}
          <div className="flex items-center gap-2 px-5 py-2.5 border-b border-gray-200 bg-white flex-shrink-0">
            <span className="text-sm text-gray-500 w-16 flex-shrink-0">Subject</span>
            <input name="subject" aria-label="Subject (use {{company_name}}, {{contact_person}}, {{customer_name}}, {{salutation}})"
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              disabled={sending}
              className="flex-1 text-sm text-gray-900 outline-none bg-transparent placeholder-gray-400 disabled:opacity-60"
              placeholder="Subject (use {{company_name}}, {{contact_person}}, {{customer_name}}, {{salutation}})"
            />
            {/* Template picker — inline with subject */}
            <div className="relative flex-shrink-0" ref={templateMenuRef}>
              <button
                onClick={() => setShowTemplateMenu(v => !v)}
                disabled={sending}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg transition disabled:opacity-40"
              >
                <FileText className="w-3.5 h-3.5" />
                Templates
                <ChevronDown className="w-3 h-3" />
              </button>
              {showTemplateMenu && (
                <div className="absolute top-full right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-50 w-72">
                  <div className="px-3 py-2 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-700">Email Templates</p>
                  </div>
                  {templates.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-gray-400 text-center">No templates available</div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto">
                      {templates.map(t => (
                        <button
                          key={t.id}
                          onClick={() => applyTemplate(t)}
                          className="w-full text-left px-3 py-2.5 hover:bg-blue-50 border-b border-gray-50 last:border-0 transition"
                        >
                          <p className="text-sm font-medium text-gray-800">{t.template_name}</p>
                          <p className="text-xs text-gray-400 truncate mt-0.5">{t.subject}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Formatting toolbar */}
          <div className="flex items-center gap-0.5 px-4 py-1.5 border-b border-gray-100 bg-gray-50 flex-shrink-0 flex-wrap">
            <ToolbarButton icon={<Bold className="w-3.5 h-3.5" />} onClick={() => execFormat('bold')} title="Bold" />
            <ToolbarButton icon={<Italic className="w-3.5 h-3.5" />} onClick={() => execFormat('italic')} title="Italic" />
            <ToolbarButton icon={<Underline className="w-3.5 h-3.5" />} onClick={() => execFormat('underline')} title="Underline" />
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <ToolbarButton icon={<Type className="w-3.5 h-3.5" />} onClick={() => execFormat('fontSize', '4')} title="Larger text" />
            <ToolbarButton icon={<Type className="w-3 h-3" />} onClick={() => execFormat('fontSize', '2')} title="Smaller text" />
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <ToolbarButton icon={<AlignLeft className="w-3.5 h-3.5" />} onClick={() => execFormat('justifyLeft')} title="Align left" />
            <ToolbarButton icon={<AlignCenter className="w-3.5 h-3.5" />} onClick={() => execFormat('justifyCenter')} title="Align center" />
            <ToolbarButton icon={<AlignRight className="w-3.5 h-3.5" />} onClick={() => execFormat('justifyRight')} title="Align right" />
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <ToolbarButton icon={<List className="w-3.5 h-3.5" />} onClick={() => execFormat('insertUnorderedList')} title="Bullet list" />
            <ToolbarButton icon={<Link2 className="w-3.5 h-3.5" />} onClick={insertLink} title="Insert link" />
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <label className="relative cursor-pointer p-1.5 rounded hover:bg-gray-200 transition" title="Text color">
              <span className="text-xs font-bold text-red-500">A</span>
              <input name="field" aria-label="Field"
                type="color"
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                onChange={e => execFormat('foreColor', e.target.value)}
              />
            </label>

            <div className="relative ml-1" ref={variableMenuRef}>
              <button
                onClick={() => setShowVariableMenu(v => !v)}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 bg-white hover:bg-gray-100 border border-gray-200 rounded transition"
              >
                Insert variable <ChevronDown className="w-3 h-3" />
              </button>
              {showVariableMenu && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-[160px]">
                  {VARIABLES.map(v => (
                    <button
                      key={v.value}
                      onClick={() => insertVariable(v.value)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 text-gray-700 first:rounded-t-lg last:rounded-b-lg"
                    >
                      <span className="font-mono text-blue-600">{v.value}</span>
                      <span className="text-gray-400 ml-1">— {v.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-y-auto bg-white px-5 py-4">
            <div
              ref={editorRef}
              contentEditable={!sending}
              suppressContentEditableWarning
              onInput={syncHtml}
              onPaste={() => setTimeout(syncHtml, 0)}
              className={`min-h-full outline-none text-sm text-gray-800 leading-relaxed ${sending ? 'opacity-60 pointer-events-none' : ''}`}
              style={{ wordBreak: 'break-word', minHeight: '200px' }}
              data-placeholder="Write your message here... Use {{company_name}} and {{contact_person}} for personalization"
            />
          </div>

          {/* Attachments list */}
          {attachments.length > 0 && (
            <div className="flex-shrink-0 border-t border-gray-100 bg-gray-50 px-5 py-2 flex flex-wrap gap-2">
              {attachments.map(a => (
                <div key={a.id} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-700 shadow-sm">
                  <Paperclip className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                  <span className="max-w-[160px] truncate">{a.file.name}</span>
                  <span className="text-gray-400">({formatFileSize(a.file.size)})</span>
                  <button
                    onClick={() => removeAttachment(a.id)}
                    disabled={sending}
                    className="ml-1 text-gray-400 hover:text-red-500 transition disabled:opacity-40"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Footer toolbar */}
          <div className="flex-shrink-0 border-t border-gray-200 bg-white px-5 py-3">
            <div className="flex items-center gap-3 flex-wrap">
              {/* Send button */}
              <button
                onClick={sendBulkEmails}
                disabled={sending || !subject.trim()}
                className="flex items-center gap-2 px-5 py-2 bg-blue-600 text-white text-sm rounded-full hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                <Send className="w-3.5 h-3.5" />
                Send to {selectedCustomers.length}
              </button>

              {/* Attach file */}
              <label className="cursor-pointer p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-full transition" title="Attach files">
                <Paperclip className="w-5 h-5" />
                <input name="file_upload" aria-label="Upload file"
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                  disabled={sending}
                />
              </label>

              {/* Delay control */}
              <div className="flex items-center gap-2 text-xs text-gray-500 ml-2">
                <Clock className="w-3.5 h-3.5 text-amber-500" />
                <span>Delay:</span>
                <button onClick={() => setIntervalSeconds(s => Math.max(10, s - 5))} disabled={sending} className="p-0.5 hover:bg-gray-100 rounded">
                  <Minus className="w-3 h-3" />
                </button>
                <span className="font-mono font-semibold w-8 text-center">{intervalSeconds}s</span>
                <button onClick={() => setIntervalSeconds(s => Math.min(300, s + 5))} disabled={sending} className="p-0.5 hover:bg-gray-100 rounded">
                  <Plus className="w-3 h-3" />
                </button>
                <span className="text-gray-400">≈ {Math.ceil((selectedCustomers.length * intervalSeconds) / 60)} min</span>
              </div>

              <div className="ml-auto">
                <button onClick={onClose} disabled={sending} className="px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition disabled:opacity-40">
                  Discard
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Recipients panel */}
        <div className="w-60 border-l border-gray-200 bg-gray-50 flex flex-col flex-shrink-0">
          <div className="px-4 py-3 border-b border-gray-200 bg-white">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Recipients</p>
            <p className="text-xs text-gray-400 mt-0.5">Each gets their own email</p>
          </div>

          {step === 'sending' || step === 'done' ? (
            <>
              <div className="px-4 py-3 border-b border-gray-100 bg-white">
                <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                  <span>{successCount + errorCount} / {selectedCustomers.length}</span>
                  <span>{Math.round(progress * 100)}%</span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
                <div className="flex gap-3 mt-2 text-xs">
                  <span className="text-green-600 flex items-center gap-1"><CheckCircle className="w-3 h-3" />{successCount}</span>
                  <span className="text-red-500 flex items-center gap-1"><XCircle className="w-3 h-3" />{errorCount}</span>
                  <span className="text-gray-400 flex items-center gap-1"><Clock className="w-3 h-3" />{pendingCount}</span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {sendResults.map((r, idx) => (
                  <div key={idx} className={`px-4 py-2.5 border-b border-gray-100 last:border-0 flex items-center gap-2 ${
                    r.status === 'success' ? 'bg-green-50' :
                    r.status === 'error' ? 'bg-red-50' :
                    r.status === 'sending' ? 'bg-blue-50' : ''
                  }`}>
                    <div className="flex-shrink-0">
                      {r.status === 'success' && <CheckCircle className="w-3.5 h-3.5 text-green-600" />}
                      {r.status === 'error' && <XCircle className="w-3.5 h-3.5 text-red-500" />}
                      {r.status === 'sending' && <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />}
                      {r.status === 'pending' && <Clock className="w-3.5 h-3.5 text-gray-300" />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-800 truncate">{r.companyName}</p>
                      <p className="text-xs text-gray-400 truncate">{r.email}</p>
                      {r.error && <p className="text-xs text-red-500 truncate">{r.error}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {selectedCustomers.map((c, idx) => (
                <div key={idx} className="px-4 py-2.5 border-b border-gray-100 last:border-0">
                  <p className="text-xs font-medium text-gray-800 truncate">{c.company_name}</p>
                  {c.contact_person && <p className="text-xs text-gray-500 truncate">{c.contact_person}</p>}
                  <p className="text-xs text-gray-400 truncate">{c.email}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <style>{`
        [contenteditable]:empty:before {
          content: attr(data-placeholder);
          color: #9ca3af;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}

function ToolbarButton({ icon, onClick, title }: { icon: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      className="p-1.5 text-gray-600 hover:bg-gray-200 hover:text-gray-900 rounded transition"
      title={title}
      type="button"
    >
      {icon}
    </button>
  );
}
