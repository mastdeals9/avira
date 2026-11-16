import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { BulkEmailComposer } from '../BulkEmailComposer';
import { DeliveryLog } from '../DeliveryLog';
import { BulkWhatsAppPilotModal } from '../BulkWhatsAppPilotModal';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../../finance/FloatingField';
import { SapRow } from '../../finance/SapLayout';
import {
  Send,
  Users,
  FileText,
  Clock,
  History,
  Plus,
  Search,
  CheckCircle2,
  Trash2,
  Edit3,
  RefreshCw,
  FolderOpen,
  MessageCircle,
} from 'lucide-react';

interface RecipientTarget {
  id: string;
  company_name: string;
  email: string;
  contact_person: string | null;
  customer_type?: string | null;
  city?: string | null;
  phone?: string | null;
  mobile?: string | null;
}

interface TemplateRow {
  id: string;
  template_name: string;
  subject: string;
  body: string;
  category: string | null;
  is_active: boolean;
  created_at: string;
}

interface Props {
  initialRecipients?: RecipientTarget[];
}

type BulkEmailTab = 'compose' | 'recipients' | 'templates' | 'history' | 'drafts';

export function CrmBulkEmailWorkspace({ initialRecipients }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const subtabParam = searchParams.get('subtab')?.toLowerCase() as BulkEmailTab | null;
  const initialSubtab: BulkEmailTab = (subtabParam && ['compose', 'recipients', 'templates', 'history', 'drafts'].includes(subtabParam))
    ? subtabParam
    : 'compose';

  const [activeTab, setActiveTab] = useState<BulkEmailTab>(initialSubtab);

  const handleTabChange = useCallback((tab: BulkEmailTab) => {
    setActiveTab(tab);
    const newParams = new URLSearchParams(searchParams);
    newParams.set('subtab', tab);
    setSearchParams(newParams, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (subtabParam && ['compose', 'recipients', 'templates', 'history', 'drafts'].includes(subtabParam)) {
      if (subtabParam !== activeTab) {
        setActiveTab(subtabParam);
      }
    }
  }, [subtabParam, activeTab]);

  // Selected recipients for composition
  const [selectedRecipients, setSelectedRecipients] = useState<RecipientTarget[]>(
    initialRecipients || []
  );

  // Recipients Directory State
  const [allContacts, setAllContacts] = useState<RecipientTarget[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());

  // Templates State
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [showNewTemplateModal, setShowNewTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateSubject, setNewTemplateSubject] = useState('');
  const [newTemplateBody, setNewTemplateBody] = useState('');
  const [newTemplateCategory, setNewTemplateCategory] = useState('Marketing');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [showBulkWhatsAppPilot, setShowBulkWhatsAppPilot] = useState(false);

  useEffect(() => {
    if (initialRecipients && initialRecipients.length > 0) {
      setSelectedRecipients(initialRecipients);
      setSelectedContactIds(new Set(initialRecipients.map(r => r.id)));
      setActiveTab('compose');
    }
  }, [initialRecipients]);

  useEffect(() => {
    loadContactsDirectory();
    loadTemplatesList();
  }, []);

  const loadContactsDirectory = async () => {
    setLoadingContacts(true);
    try {
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id, company_name, email, contact_person, customer_type, city, phone, mobile')
        .not('email', 'is', null)
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      const seenEmails = new Set<string>();
      const deduplicated: RecipientTarget[] = [];
      for (const c of data || []) {
        const emailClean = (c.email || '').trim().toLowerCase();
        if (emailClean && emailClean.includes('@') && !seenEmails.has(emailClean)) {
          seenEmails.add(emailClean);
          deduplicated.push({ ...c, email: emailClean });
        }
      }
      setAllContacts(deduplicated);
    } catch (err: any) {
      console.error('Failed to load contacts for bulk email:', err);
    } finally {
      setLoadingContacts(false);
    }
  };

  const loadTemplatesList = async () => {
    setLoadingTemplates(true);
    try {
      const { data, error } = await supabase
        .from('crm_email_templates')
        .select('*')
        .order('template_name');

      if (error) throw error;
      setTemplates(data || []);
    } catch (err: any) {
      console.error('Failed to load email templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleToggleContact = (contact: RecipientTarget) => {
    setSelectedContactIds(prev => {
      const next = new Set(prev);
      if (next.has(contact.id)) next.delete(contact.id);
      else next.add(contact.id);
      return next;
    });
  };

  const handleSelectAllContacts = (checked: boolean) => {
    if (checked) {
      const filtered = filteredContacts.map(c => c.id);
      setSelectedContactIds(new Set(filtered));
    } else {
      setSelectedContactIds(new Set());
    }
  };

  const handleApplySelectedToCompose = () => {
    const chosen = allContacts.filter(c => selectedContactIds.has(c.id));
    if (chosen.length === 0) {
      showToast({ type: 'warning', title: 'No Recipients', message: 'Please select at least one contact.' });
      return;
    }
    setSelectedRecipients(chosen);
    handleTabChange('compose');
    showToast({ type: 'success', title: 'Recipients Ready', message: `${chosen.length} recipients staged for email.` });
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTemplateName.trim() || !newTemplateSubject.trim() || !newTemplateBody.trim()) {
      showToast({ type: 'error', title: 'Missing Fields', message: 'All fields are required.' });
      return;
    }

    setSavingTemplate(true);
    try {
      const { error } = await supabase.from('crm_email_templates').insert({
        template_name: newTemplateName.trim(),
        subject: newTemplateSubject.trim(),
        body: DOMPurify.sanitize(newTemplateBody.trim()),
        category: newTemplateCategory,
        is_active: true,
      });

      if (error) throw error;

      showToast({ type: 'success', title: 'Template Saved', message: 'Email template is now available.' });
      setShowNewTemplateModal(false);
      setNewTemplateName('');
      setNewTemplateSubject('');
      setNewTemplateBody('');
      loadTemplatesList();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Template Error', message: err.message });
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (id: string, name: string) => {
    if (!confirm(`Delete template "${name}"?`)) return;
    try {
      const { error } = await supabase.from('crm_email_templates').delete().eq('id', id);
      if (error) throw error;
      showToast({ type: 'success', title: 'Deleted', message: 'Template removed.' });
      loadTemplatesList();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Delete Failed', message: err.message });
    }
  };

  const filteredContacts = allContacts.filter(c => {
    if (!recipientSearch.trim()) return true;
    const q = recipientSearch.toLowerCase().trim();
    return (
      c.company_name.toLowerCase().includes(q) ||
      (c.contact_person && c.contact_person.toLowerCase().includes(q)) ||
      c.email.toLowerCase().includes(q) ||
      (c.city && c.city.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-4">
      {/* Top Bulk Email Navigation */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {(
            [
              ['compose', Send, 'COMPOSE'],
              ['recipients', Users, `RECIPIENTS (${selectedRecipients.length > 0 ? `${selectedRecipients.length} staged` : allContacts.length})`],
              ['templates', FileText, `TEMPLATES (${templates.length})`],
              ['history', History, 'SENT / HISTORY'],
              ['drafts', FolderOpen, 'DRAFTS'],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              onClick={() => handleTabChange(key as BulkEmailTab)}
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-semibold transition ${
                activeTab === key
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'recipients' && selectedContactIds.size > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowBulkWhatsAppPilot(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1 bg-teal-600 text-white rounded-md text-xs font-semibold hover:bg-teal-700 transition"
              title="Send controlled pilot WhatsApp messages"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              Pilot WhatsApp ({selectedContactIds.size})
            </button>
            <button
              onClick={handleApplySelectedToCompose}
              className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-600 text-white rounded-md text-xs font-semibold hover:bg-emerald-700 transition"
            >
              <Send className="w-3.5 h-3.5" />
              Stage {selectedContactIds.size} for Compose
            </button>
          </div>
        )}

        {activeTab === 'templates' && (
          <button
            onClick={() => setShowNewTemplateModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            New Template
          </button>
        )}
      </div>

      {/* 1. COMPOSE TAB */}
      {activeTab === 'compose' && (
        <div>
          {selectedRecipients.length === 0 ? (
            <div className="bg-white rounded-lg border border-dashed border-gray-300 p-12 text-center">
              <Users className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <h3 className="text-sm font-bold text-gray-900 mb-1">No Recipients Selected</h3>
              <p className="text-xs text-gray-500 max-w-sm mx-auto mb-4">
                Choose recipients from your customer directory or recent inquiries before launching a campaign.
              </p>
              <button
                onClick={() => handleTabChange('recipients')}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 shadow-sm"
              >
                Select Recipients ({allContacts.length} available)
              </button>
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
              <div className="flex items-center justify-between pb-3 mb-3 border-b border-gray-200 text-xs">
                <span className="font-semibold text-gray-700">
                  Targeted Recipients: <span className="text-blue-600 font-bold">{selectedRecipients.length} companies</span>
                </span>
                <button
                  onClick={() => handleTabChange('recipients')}
                  className="text-blue-600 hover:underline font-medium"
                >
                  Change Recipients
                </button>
              </div>

              <BulkEmailComposer
                selectedCustomers={selectedRecipients}
                onClose={() => setSelectedRecipients([])}
                onComplete={() => {
                  showToast({ type: 'success', title: 'Bulk Email Queued', message: 'Campaign is running in background worker.' });
                  handleTabChange('history');
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* 2. RECIPIENTS TAB */}
      {activeTab === 'recipients' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
              <input
                type="text"
                value={recipientSearch}
                onChange={(e) => setRecipientSearch(e.target.value)}
                placeholder="Search companies, contacts, emails, cities..."
                className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div className="text-xs text-gray-500">
              Selected: <span className="font-bold text-gray-900">{selectedContactIds.size}</span> of {filteredContacts.length}
            </div>
          </div>

          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-gray-200 text-gray-500 font-semibold uppercase">
                  <th className="py-2.5 px-3 w-8 text-center">
                    <input
                      type="checkbox"
                      checked={filteredContacts.length > 0 && selectedContactIds.size === filteredContacts.length}
                      onChange={(e) => handleSelectAllContacts(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-0"
                    />
                  </th>
                  <th className="py-2.5 px-3">Company Name</th>
                  <th className="py-2.5 px-3">Contact Person</th>
                  <th className="py-2.5 px-3">Email Address</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">City</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loadingContacts ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-gray-400">
                      <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-blue-600" />
                      Loading recipients directory...
                    </td>
                  </tr>
                ) : filteredContacts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-gray-400">
                      No contacts found matching search.
                    </td>
                  </tr>
                ) : (
                  filteredContacts.map((c) => {
                    const isChecked = selectedContactIds.has(c.id);
                    return (
                      <tr
                        key={c.id}
                        onClick={() => handleToggleContact(c)}
                        className={`hover:bg-blue-50/50 cursor-pointer transition ${
                          isChecked ? 'bg-blue-50/30' : ''
                        }`}
                      >
                        <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleContact(c)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-0"
                          />
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-gray-900">{c.company_name}</td>
                        <td className="py-2.5 px-3 text-gray-700">{c.contact_person || '—'}</td>
                        <td className="py-2.5 px-3 text-blue-600">{c.email}</td>
                        <td className="py-2.5 px-3 text-gray-500">{c.customer_type || 'General'}</td>
                        <td className="py-2.5 px-3 text-gray-500">{c.city || 'Indonesia'}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. TEMPLATES TAB */}
      {activeTab === 'templates' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Saved Reusable Templates ({templates.length})
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((tpl) => (
              <div key={tpl.id} className="border border-gray-200 rounded-lg p-4 bg-slate-50/50 hover:bg-white hover:border-blue-300 transition shadow-xs flex flex-col justify-between">
                <div>
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h4 className="text-sm font-bold text-gray-900">{tpl.template_name}</h4>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold border border-blue-200">
                      {tpl.category || 'General'}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-gray-700 mb-2">Subject: {tpl.subject}</div>
                  <div
                    className="text-xs text-gray-500 line-clamp-3 font-sans"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(tpl.body.slice(0, 200)) }}
                  />
                </div>

                <div className="flex items-center justify-between pt-3 mt-3 border-t border-gray-200 text-xs">
                  <button
                    onClick={() => {
                      if (selectedRecipients.length === 0 && allContacts.length > 0) {
                        setSelectedRecipients(allContacts.slice(0, 10));
                      }
                      handleTabChange('compose');
                    }}
                    className="text-blue-600 hover:underline font-semibold"
                  >
                    Use in Campaign
                  </button>

                  <button
                    onClick={() => handleDeleteTemplate(tpl.id, tpl.template_name)}
                    className="text-gray-400 hover:text-red-600 p-1 rounded"
                    title="Delete Template"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. SENT / HISTORY TAB */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <DeliveryLog />
        </div>
      )}

      {/* 5. DRAFTS TAB */}
      {activeTab === 'drafts' && (
        <div className="bg-white rounded-lg border border-dashed border-gray-300 p-12 text-center text-xs text-gray-500">
          <FolderOpen className="w-8 h-8 text-gray-400 mx-auto mb-2" />
          No drafts saved. You can save recurring outreach drafts as reusable Templates.
        </div>
      )}

      {/* New Template Modal */}
      {showNewTemplateModal && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 border border-gray-200">
            <h3 className="text-base font-bold text-gray-900 mb-4">Create Email Template</h3>
            <form onSubmit={handleSaveTemplate} className="space-y-3 text-xs">
              <SapRow>
                <FloatingField label="Template Name" required span={6} filled={!!newTemplateName}>
                  <input
                    type="text"
                    required
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    placeholder="e.g. Paracetamol Monthly Availability"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>

                <FloatingField label="Subject Line" required span={6} filled={!!newTemplateSubject}>
                  <input
                    type="text"
                    required
                    value={newTemplateSubject}
                    onChange={(e) => setNewTemplateSubject(e.target.value)}
                    placeholder="e.g. Update: Available Stock for {{company_name}}"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label="Category" span={12} filled={!!newTemplateCategory}>
                  <input
                    type="text"
                    value={newTemplateCategory}
                    onChange={(e) => setNewTemplateCategory(e.target.value)}
                    placeholder="Marketing / Sourcing / Follow-up"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField
                  label="Email Body (HTML / Text)"
                  required
                  textarea
                  span={12}
                  filled={!!newTemplateBody}
                  hint="Available tags: {{company_name}}, {{contact_person}}, {{salutation}}"
                >
                  <textarea
                    required
                    value={newTemplateBody}
                    onChange={(e) => setNewTemplateBody(e.target.value)}
                    rows={6}
                    placeholder="Dear {{contact_person}},&#10;&#10;We are pleased to offer..."
                    className={FLOAT_TEXTAREA}
                  />
                </FloatingField>
              </SapRow>

              <div className="flex justify-end gap-2 pt-3 border-t border-gray-200 mt-4">
                <button
                  type="button"
                  onClick={() => setShowNewTemplateModal(false)}
                  className="px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-md font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTemplate}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded-md font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingTemplate ? 'Saving...' : 'Save Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Controlled Bulk WhatsApp Pilot Modal */}
      {showBulkWhatsAppPilot && (
        <BulkWhatsAppPilotModal
          isOpen={showBulkWhatsAppPilot}
          onClose={() => setShowBulkWhatsAppPilot(false)}
          recipients={allContacts.filter((c) => selectedContactIds.has(c.id))}
          onComplete={() => setShowBulkWhatsAppPilot(false)}
        />
      )}
    </div>
  );
}
