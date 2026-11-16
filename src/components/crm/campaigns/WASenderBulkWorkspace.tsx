import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  MessageSquare,
  Play,
  Pause,
  Square,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Search,
  Paperclip,
  Trash2,
  Image as ImageIcon,
  FileText,
  Download,
  RefreshCw,
  Clock,
  ChevronLeft,
  ChevronRight,
  Eye,
  Users,
  X,
  FileSpreadsheet,
  Wifi,
  WifiOff,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { WhatsAppAttachmentModal, WhatsAppCampaignAttachment } from './WhatsAppAttachmentModal';
import { uploadOptimizedFile } from '../../../services/storage/uploadOptimizationService';
import { auditContactsMultiPhone, VerifiedContactItem } from '../../../utils/phoneValidation';
import {
  formatPersonalizedWhatsAppMessage,
  WHATSAPP_MEDIA_CAPTION_LIMIT,
} from '../../../utils/whatsappPersonalization';
import { WhatsAppTransportService } from '../../../services/whatsapp/whatsappTransportService';
import {
  cleanContactPerson,
  resolvePersonalizedGreeting,
  deduplicateCampaignPhoneRecipients,
} from '../../../utils/crmContactCleaners';
import {
  classifyCanonicalPhone,
  getNormalizedDestinationPhone,
} from '../../../services/crm/canonicalPhoneService';

export interface CampaignRecipientLogItem {
  id: string;
  company_name: string;
  contact_person: string | null;
  phone: string;
  status: 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled';
  message_id?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  error_message?: string | null;
  personalized_caption?: string | null;
}

export interface WASenderBulkWorkspaceProps {
  initialRecipients?: any[];
  onOpenAuditCentre?: () => void;
}

export function WASenderBulkWorkspace({
  initialRecipients,
  onOpenAuditCentre,
}: WASenderBulkWorkspaceProps) {
  // ---------------------------------------------------------------------------
  // 1. Adapter & Connection State (OpenWA: http://127.0.0.1:3100)
  // ---------------------------------------------------------------------------
  const [adapterHealth, setAdapterHealth] = useState<{
    status: 'checking' | 'connected' | 'disconnected';
    businessPhone?: string;
    details?: string;
  }>({ status: 'checking' });
  const [isCheckingAdapter, setIsCheckingAdapter] = useState(false);

  const checkAdapterHealth = useCallback(async () => {
    setIsCheckingAdapter(true);
    try {
      const health = await WhatsAppTransportService.checkHealth();
      setAdapterHealth({
        status: health.status === 'connected' ? 'connected' : 'disconnected',
        businessPhone: health.businessPhone,
        details: health.details,
      });
    } catch (err: any) {
      setAdapterHealth({
        status: 'disconnected',
        details: err?.message || 'OpenWA daemon unreachable at 127.0.0.1:3100',
      });
    } finally {
      setIsCheckingAdapter(false);
    }
  }, []);

  useEffect(() => {
    checkAdapterHealth();
  }, [checkAdapterHealth]);

  // ---------------------------------------------------------------------------
  // 2. Contacts Loading & Candidate Deduplication
  // ---------------------------------------------------------------------------
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [rawContacts, setRawContacts] = useState<any[]>([]);
  const [phoneRecords, setPhoneRecords] = useState<any[]>([]);
  const [contactSearchQuery, setContactSearchQuery] = useState('');

  const loadContactsAndPhones = useCallback(async () => {
    setLoadingContacts(true);
    try {
      const [{ data: contactsData, error: contactsErr }, { data: phonesData, error: phonesErr }] =
        await Promise.all([
          supabase
            .from('crm_contacts')
            .select(
              'id, company_name, contact_person, designation, email, phone, mobile, landline, country, city, customer_type, notes, is_active'
            )
            .eq('is_active', true)
            .order('company_name'),
          supabase
            .from('crm_contact_phones')
            .select(
              'id, contact_id, company_name, contact_person, department, raw_phone, normalized_phone, phone_type, is_whatsapp_eligible, is_primary, consent_status, opt_in_source, opt_in_timestamp, opt_in_evidence, permitted_categories'
            ),
        ]);

      if (contactsErr) throw contactsErr;
      if (phonesErr) console.warn('crm_contact_phones error (falling back to contacts):', phonesErr);

      setRawContacts(contactsData || []);
      setPhoneRecords(phonesData || []);
    } catch (err: any) {
      console.error('Failed to load CRM contacts:', err);
      showToast({
        type: 'error',
        title: 'Contacts Load Error',
        message: err.message || 'Could not fetch CRM contacts.',
      });
    } finally {
      setLoadingContacts(false);
    }
  }, []);

  useEffect(() => {
    loadContactsAndPhones();
  }, [loadContactsAndPhones]);

  // Compute multi-phone audit and extract deduplicated valid mobile candidates
  const { dedupedCandidates, duplicateCount, ambiguousSharedList } = useMemo(() => {
    if (rawContacts.length === 0) {
      return { dedupedCandidates: [], duplicateCount: 0, ambiguousSharedList: [] };
    }

    const audit = auditContactsMultiPhone(rawContacts, phoneRecords);
    const candidateItems = audit.items.filter((i) => i.is_candidate);

    // Apply strict canonical phone deduplication and detect shared switchboards across entities
    const { unique, duplicates, ambiguousShared } = deduplicateCampaignPhoneRecipients(candidateItems);

    // Clean contact_person so company names or phone numbers are never shown
    const cleanedUnique = unique.map((item) => ({
      ...item,
      contact_person: cleanContactPerson(item.contact_person, item.company_name),
    }));

    return {
      dedupedCandidates: cleanedUnique,
      duplicateCount: duplicates.length,
      ambiguousSharedList: ambiguousShared,
    };
  }, [rawContacts, phoneRecords]);

  // Filtered by user search
  const filteredCandidates = useMemo(() => {
    if (!contactSearchQuery.trim()) return dedupedCandidates;
    const q = contactSearchQuery.toLowerCase().trim();
    return dedupedCandidates.filter((c) => {
      const company = (c.company_name || '').toLowerCase();
      const person = (c.contact_person || '').toLowerCase();
      const phone = getNormalizedDestinationPhone(c).toLowerCase();
      return company.includes(q) || person.includes(q) || phone.includes(q);
    });
  }, [dedupedCandidates, contactSearchQuery]);

  // Selected candidate phone IDs
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const hasInitializedSelectionRef = useRef(false);

  // Auto-select valid candidates on initial load if none selected (run once)
  useEffect(() => {
    if (!hasInitializedSelectionRef.current && dedupedCandidates.length > 0) {
      hasInitializedSelectionRef.current = true;
      if (initialRecipients && initialRecipients.length > 0) {
        const initialPhones = new Set(
          initialRecipients.map((r: any) => r.mobile || r.phone).filter(Boolean)
        );
        const matched = new Set<string>();
        for (const c of dedupedCandidates) {
          const ph = getNormalizedDestinationPhone(c);
          if (ph && initialPhones.has(ph)) {
            matched.add(c.id);
          }
        }
        if (matched.size > 0) {
          setSelectedIds(matched);
          return;
        }
      }
      // Default: select all deduplicated valid mobiles
      setSelectedIds(new Set(dedupedCandidates.map((c) => c.id)));
    }
  }, [dedupedCandidates, initialRecipients]);

  const handleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredCandidates.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const handleSelectNoneFiltered = () => {
    if (!contactSearchQuery.trim()) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredCandidates.forEach((c) => next.delete(c.id));
        return next;
      });
    }
  };

  const handleToggleCandidate = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // 3. Message Composer & Attachment State
  // ---------------------------------------------------------------------------
  const [campaignName, setCampaignName] = useState(() => {
    const d = new Date();
    return `WhatsApp Broadcast ${d.toLocaleDateString('id-ID')} ${d.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  });

  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [messageText, setMessageText] = useState(
    'Yth. {{contact_name}}\n{{company_name}}\n\nPerkenalkan kami dari PT Sinar Antjol Panca Jaya (SAPJ). Berikut informasi penawaran produk {{product_name}} terkini untuk perusahaan Bapak/Ibu.\n\nSilakan tinjau dokumen terlampir. Terima kasih!'
  );
  const [productName, setProductName] = useState('Bahan Baku Farmasi & API');
  const [waAttachment, setWaAttachment] = useState<WhatsAppCampaignAttachment | null>(null);
  const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);

  // Load message templates from database
  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const { data, error } = await supabase
          .from('crm_email_templates')
          .select('id, template_name, subject, body, category')
          .order('template_name');

        if (!error && data) {
          setTemplates(data);
        }
      } catch (err) {
        console.warn('Could not load templates:', err);
      }
    };
    fetchTemplates();
  }, []);

  const handleSelectTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const tmpl = templates.find((t) => t.id === templateId);
    if (tmpl && tmpl.body) {
      setMessageText(tmpl.body);
    }
  };

  const insertPlaceholder = (tag: string) => {
    setMessageText((prev) => `${prev} ${tag}`);
  };

  // Caption validation
  const captionLength = messageText.length;
  const isCaptionExceeded = Boolean(waAttachment && captionLength > WHATSAPP_MEDIA_CAPTION_LIMIT);

  // ---------------------------------------------------------------------------
  // 4. Live Message Preview
  // ---------------------------------------------------------------------------
  const selectedCandidatesList = useMemo(() => {
    return dedupedCandidates.filter((c) => selectedIds.has(c.id));
  }, [dedupedCandidates, selectedIds]);

  const [previewIndex, setPreviewIndex] = useState(0);

  // Keep preview index bounded
  useEffect(() => {
    if (previewIndex >= selectedCandidatesList.length) {
      setPreviewIndex(Math.max(0, selectedCandidatesList.length - 1));
    }
  }, [selectedCandidatesList.length, previewIndex]);

  const activePreviewCandidate = selectedCandidatesList[previewIndex] || selectedCandidatesList[0] || null;

  const renderedPreviewText = useMemo(() => {
    if (!activePreviewCandidate) {
      return formatPersonalizedWhatsAppMessage(messageText, null, { productName });
    }
    return formatPersonalizedWhatsAppMessage(
      messageText,
      {
        company_name: activePreviewCandidate.company_name,
        contact_name: activePreviewCandidate.contact_person,
        contact_person: activePreviewCandidate.contact_person,
        phone: getNormalizedDestinationPhone(activePreviewCandidate),
      },
      { productName }
    );
  }, [messageText, activePreviewCandidate, productName]);

  // ---------------------------------------------------------------------------
  // 5. Sending Settings & Sequential Execution Engine
  // ---------------------------------------------------------------------------
  const [delaySeconds, setDelaySeconds] = useState(20);
  const [isSending, setIsSending] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentSendingRecipient, setCurrentSendingRecipient] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const [_activeCampaignId, setActiveCampaignId] = useState<string | null>(null);

  // In-flight progress stats
  const [stats, setStats] = useState({
    total: 0,
    sent: 0,
    failed: 0,
    pending: 0,
  });



  const [recipientLogs, setRecipientLogs] = useState<CampaignRecipientLogItem[]>([]);

  // Execution controllers (refs to survive state closures across async loops)
  const isPausedRef = useRef(false);
  const isCancelledRef = useRef(false);
  const activeCampaignIdRef = useRef<string | null>(null);

  // Helper: Prepare media attachment storage URL if needed
  const prepareAttachmentMediaUrl = async (attachment: WhatsAppCampaignAttachment): Promise<string> => {
    if (attachment.url && !attachment.url.startsWith('blob:')) {
      return attachment.url;
    }

    if (attachment.source === 'upload' && attachment.file) {
      const cleanFileName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `campaigns/${Date.now()}_${cleanFileName}`;
      const { error: upErr } = await uploadOptimizedFile(
        supabase,
        'crm-documents',
        storagePath,
        attachment.file
      );
      if (upErr) {
        throw new Error(`Attachment upload to storage failed: ${upErr.message}`);
      }
      const { data: signData, error: signErr } = await supabase.storage
        .from('crm-documents')
        .createSignedUrl(storagePath, 86400);
      if (signErr || !signData?.signedUrl) {
        throw new Error(
          `Failed to generate signed download URL for uploaded attachment: ${
            signErr?.message || 'Unknown'
          }`
        );
      }
      return signData.signedUrl;
    }

    if (attachment.source === 'bank' && attachment.storagePath) {
      const bucket = attachment.storageBucket || 'crm-documents';
      const { data: signData, error: signErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(attachment.storagePath, 86400);
      if (signErr || !signData?.signedUrl) {
        throw new Error(
          `Failed to generate signed URL for document from Document Bank: ${
            signErr?.message || 'File not found'
          }`
        );
      }
      return signData.signedUrl;
    }

    if (attachment.previewUrl && !attachment.previewUrl.startsWith('blob:')) {
      return attachment.previewUrl;
    }

    throw new Error('Attachment does not have an accessible storage reference or file.');
  };

  // Start campaign dispatch
  const handleStartCampaign = async () => {
    if (selectedCandidatesList.length === 0) {
      showToast({
        type: 'warning',
        title: 'No Recipients Selected',
        message: 'Please select at least 1 contact to send to.',
      });
      return;
    }

    if (!messageText.trim()) {
      showToast({
        type: 'warning',
        title: 'Empty Message',
        message: 'Please write a message or select a template before sending.',
      });
      return;
    }

    if (isCaptionExceeded) {
      showToast({
        type: 'error',
        title: 'Caption Limit Exceeded',
        message: `WhatsApp limits captions with attachments to ${WHATSAPP_MEDIA_CAPTION_LIMIT} characters.`,
      });
      return;
    }

    // Check OpenWA status
    if (adapterHealth.status === 'disconnected') {
      showToast({
        type: 'error',
        title: 'OpenWA Adapter Offline',
        message:
          'OpenWA transport is unreachable at 127.0.0.1:3100. Please ensure the local service is running.',
      });
      return;
    }

    setIsSending(true);
    setIsPaused(false);
    isPausedRef.current = false;
    isCancelledRef.current = false;

    let mediaUrl: string | undefined = undefined;
    if (waAttachment) {
      try {
        mediaUrl = await prepareAttachmentMediaUrl(waAttachment);
      } catch (err: any) {
        setIsSending(false);
        showToast({
          type: 'error',
          title: 'Attachment Preparation Error',
          message: err.message || 'Could not prepare attachment for dispatch.',
        });
        return;
      }
    }

    // 1. Create campaign row in Supabase
    let campaignId: string;
    try {
      const { data: camp, error: campErr } = await supabase
        .from('whatsapp_campaigns')
        .insert({
          name: campaignName.trim() || 'Avira WhatsApp Campaign',
          message_template: messageText,
          attachment_url: mediaUrl || null,
          attachment_filename: waAttachment?.name || null,
          attachment_type: waAttachment?.mediaCategory === 'image' ? 'IMAGE' : waAttachment ? 'DOCUMENT' : null,
          status: 'in_progress',
          total_recipients: selectedCandidatesList.length,
          sent_count: 0,
          failed_count: 0,
          processing_delay_seconds: delaySeconds,
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (campErr) throw campErr;
      campaignId = camp.id;
      setActiveCampaignId(campaignId);
      activeCampaignIdRef.current = campaignId;
    } catch (err: any) {
      setIsSending(false);
      showToast({
        type: 'error',
        title: 'Campaign Creation Failed',
        message: err.message || 'Could not initialize campaign record in Supabase.',
      });
      return;
    }

    // 2. Insert recipient rows
    const initialLogs: CampaignRecipientLogItem[] = selectedCandidatesList.map((c) => {
      const phone = getNormalizedDestinationPhone(c);
      const personalized = formatPersonalizedWhatsAppMessage(
        messageText,
        {
          company_name: c.company_name,
          contact_name: c.contact_person,
          contact_person: c.contact_person,
          phone,
        },
        { productName }
      );
      return {
        id: c.id,
        company_name: c.company_name,
        contact_person: c.contact_person || null,
        phone,
        status: 'pending',
        personalized_caption: personalized,
      };
    });

    try {
      const recipientRows = initialLogs.map((log) => ({
        campaign_id: campaignId,
        contact_id: log.id.includes('_') ? null : log.id,
        company_name: log.company_name,
        contact_person: log.contact_person,
        phone: log.phone,
        status: 'pending',
        personalized_caption: log.personalized_caption,
      }));

      const { error: insErr } = await supabase
        .from('whatsapp_campaign_recipients')
        .insert(recipientRows);

      if (insErr) {
        console.warn('Recipients queue insert warning:', insErr);
      }
    } catch (err) {
      console.warn('Queue persistence warning:', err);
    }

    setRecipientLogs(initialLogs);
    setStats({
      total: initialLogs.length,
      sent: 0,
      failed: 0,
      pending: initialLogs.length,
    });

    showToast({
      type: 'success',
      title: 'Campaign Started',
      message: `Dispatching ${initialLogs.length} messages sequentially with ${delaySeconds}s delay.`,
    });

    // 3. Sequential Sending Loop
    await runSequentialSendingLoop(campaignId, initialLogs, mediaUrl);
  };

  // Loop execution logic
  const runSequentialSendingLoop = async (
    campaignId: string,
    recipients: CampaignRecipientLogItem[],
    mediaUrl?: string
  ) => {
    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < recipients.length; i++) {
      // Check cancellation
      if (isCancelledRef.current) {
        await supabase
          .from('whatsapp_campaigns')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', campaignId);
        break;
      }

      // Check pause
      while (isPausedRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (isCancelledRef.current) break;
      }

      if (isCancelledRef.current) break;

      const r = recipients[i];

      // Skip already completed recipients (e.g. on resume)
      if (r.status === 'sent' || r.status === 'delivered' || r.status === 'read') {
        sentCount++;
        continue;
      }

      setCurrentSendingRecipient(`${r.company_name} (${r.phone})`);

      // Update recipient status to 'sending'
      setRecipientLogs((prev) =>
        prev.map((item, idx) => (idx === i ? { ...item, status: 'sending' } : item))
      );

      // Dispatch via WhatsAppTransportService (OpenWA adapter)
      let sendSuccess = false;
      let messageId: string | null = null;
      let errorMessage: string | null = null;

      try {
        const result = await WhatsAppTransportService.sendMessage({
          to: r.phone,
          text: r.personalized_caption || messageText,
          caption: r.personalized_caption || messageText,
          documentUrl: waAttachment?.mediaCategory === 'document' ? mediaUrl : undefined,
          imageUrl: waAttachment?.mediaCategory === 'image' ? mediaUrl : undefined,
          filename: waAttachment?.name,
          consentVerified: true,
        });

        if (result.success) {
          sendSuccess = true;
          messageId = result.messageId || `wa_${Date.now()}`;
        } else {
          sendSuccess = false;
          errorMessage = result.error || 'OpenWA adapter rejected message';
        }
      } catch (err: any) {
        sendSuccess = false;
        errorMessage = err.message || 'Dispatch network error';
      }

      const nowIso = new Date().toISOString();

      if (sendSuccess) {
        sentCount++;
        setRecipientLogs((prev) =>
          prev.map((item, idx) =>
            idx === i
              ? {
                  ...item,
                  status: 'sent',
                  message_id: messageId,
                  sent_at: nowIso,
                  error_message: null,
                }
              : item
          )
        );

        // Update recipient in Supabase
        await supabase
          .from('whatsapp_campaign_recipients')
          .update({
            status: 'sent',
            message_id: messageId,
            sent_at: nowIso,
            updated_at: nowIso,
          })
          .eq('campaign_id', campaignId)
          .eq('phone', r.phone);
      } else {
        failedCount++;
        setRecipientLogs((prev) =>
          prev.map((item, idx) =>
            idx === i
              ? {
                  ...item,
                  status: 'failed',
                  failed_at: nowIso,
                  error_message: errorMessage,
                }
              : item
          )
        );

        // Update recipient in Supabase
        await supabase
          .from('whatsapp_campaign_recipients')
          .update({
            status: 'failed',
            failed_at: nowIso,
            error_message: errorMessage,
            updated_at: nowIso,
          })
          .eq('campaign_id', campaignId)
          .eq('phone', r.phone);
      }

      // Update local stats
      setStats({
        total: recipients.length,
        sent: sentCount,
        failed: failedCount,
        pending: Math.max(0, recipients.length - sentCount - failedCount),
      });

      // Update campaign in Supabase
      await supabase
        .from('whatsapp_campaigns')
        .update({
          sent_count: sentCount,
          failed_count: failedCount,
          updated_at: nowIso,
        })
        .eq('id', campaignId);

      // Countdown interval delay before next recipient (unless it's the last one)
      if (i < recipients.length - 1 && !isCancelledRef.current && !isPausedRef.current) {
        setCurrentSendingRecipient(null);
        for (let cd = delaySeconds; cd > 0; cd--) {
          setCountdown(cd);
          if (isPausedRef.current || isCancelledRef.current) break;
          await new Promise((res) => setTimeout(res, 1000));
        }
        setCountdown(0);
      }
    }

    setCurrentSendingRecipient(null);
    setIsSending(false);
    setIsPaused(false);

    if (!isCancelledRef.current) {
      const finalStatus =
        failedCount > 0 ? (sentCount > 0 ? 'partial' : 'failed') : 'completed';
      await supabase
        .from('whatsapp_campaigns')
        .update({
          status: finalStatus,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', campaignId);

      showToast({
        type: finalStatus === 'completed' ? 'success' : 'warning',
        title: finalStatus === 'completed' ? 'Campaign Completed' : 'Campaign Finished',
        message: `Finished: ${sentCount} sent successfully, ${failedCount} failed.`,
      });
    }
  };

  // Pause action
  const handlePauseCampaign = async () => {
    isPausedRef.current = true;
    setIsPaused(true);
    if (activeCampaignIdRef.current) {
      await supabase
        .from('whatsapp_campaigns')
        .update({ status: 'paused', updated_at: new Date().toISOString() })
        .eq('id', activeCampaignIdRef.current);
    }
    showToast({
      type: 'info',
      title: 'Campaign Paused',
      message: 'Dispatch is paused. You can resume at any time.',
    });
  };

  // Resume action
  const handleResumeCampaign = async () => {
    isPausedRef.current = false;
    setIsPaused(false);
    if (activeCampaignIdRef.current) {
      await supabase
        .from('whatsapp_campaigns')
        .update({ status: 'in_progress', updated_at: new Date().toISOString() })
        .eq('id', activeCampaignIdRef.current);
    }
    showToast({
      type: 'success',
      title: 'Campaign Resumed',
      message: 'Continuing sequential dispatch.',
    });
  };

  // Cancel action
  const handleCancelCampaign = async () => {
    if (!window.confirm('Are you sure you want to stop and cancel this WhatsApp campaign?')) {
      return;
    }
    isCancelledRef.current = true;
    isPausedRef.current = false;
    setIsSending(false);
    setIsPaused(false);
    setCurrentSendingRecipient(null);
    setCountdown(0);

    if (activeCampaignIdRef.current) {
      await supabase
        .from('whatsapp_campaigns')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', activeCampaignIdRef.current);

      await supabase
        .from('whatsapp_campaign_recipients')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('campaign_id', activeCampaignIdRef.current)
        .eq('status', 'pending');
    }

    showToast({
      type: 'warning',
      title: 'Campaign Cancelled',
      message: 'Sending stopped. Remaining pending recipients were cancelled.',
    });
  };

  // ---------------------------------------------------------------------------
  // 6. Campaign Report & Excel Export Modal
  // ---------------------------------------------------------------------------
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [reportSearch, setReportSearch] = useState('');
  const [reportStatusFilter, setReportStatusFilter] = useState<string>('all');

  const filteredLogsForReport = useMemo(() => {
    return recipientLogs.filter((r) => {
      if (reportStatusFilter !== 'all') {
        if (reportStatusFilter === 'sent' && r.status !== 'sent' && r.status !== 'delivered' && r.status !== 'read') return false;
        if (reportStatusFilter === 'failed' && r.status !== 'failed') return false;
        if (reportStatusFilter === 'pending' && r.status !== 'pending' && r.status !== 'sending') return false;
      }
      if (!reportSearch.trim()) return true;
      const q = reportSearch.toLowerCase().trim();
      return (
        r.company_name.toLowerCase().includes(q) ||
        (r.contact_person && r.contact_person.toLowerCase().includes(q)) ||
        r.phone.includes(q)
      );
    });
  }, [recipientLogs, reportStatusFilter, reportSearch]);

  const handleExportToExcel = () => {
    if (recipientLogs.length === 0) {
      showToast({
        type: 'warning',
        title: 'No Data to Export',
        message: 'There are no recipient records to export.',
      });
      return;
    }

    const rows = recipientLogs.map((r, i) => ({
      'No.': i + 1,
      'Company Name': r.company_name,
      'Contact Person': r.contact_person || '—',
      'Mobile Number': r.phone,
      'Status': r.status.toUpperCase(),
      'Message ID': r.message_id || '—',
      'Sent At': r.sent_at ? new Date(r.sent_at).toLocaleString() : '—',
      'Delivered At': r.delivered_at ? new Date(r.delivered_at).toLocaleString() : '—',
      'Read At': r.read_at ? new Date(r.read_at).toLocaleString() : '—',
      'Error / Reason': r.error_message || '—',
      'Personalized Message': r.personalized_caption || '—',
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'WhatsApp Campaign');

    const cleanName = campaignName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${cleanName}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(workbook, filename);

    showToast({
      type: 'success',
      title: 'Excel Export Complete',
      message: `Downloaded ${filename} (${rows.length} rows).`,
    });
  };

  // Progress percentage
  const completedCount = stats.sent + stats.failed;
  const progressPercent =
    stats.total > 0 ? Math.round((completedCount / stats.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------------ */}
      {/* TOP HEADER: Clean WA Sender Bar & OpenWA Status */}
      {/* ------------------------------------------------------------------ */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold shadow-xs">
            <MessageSquare className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-gray-900 tracking-tight">
                Avira WhatsApp Bulk Sender
              </h2>
              <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">
                WA Sender Style
              </span>
            </div>
            <p className="text-xs text-gray-500">
              Clean sequential dispatch &bull; Personalized placeholders &bull; Real-time delivery
            </p>
          </div>
        </div>

        {/* Status Pills & Report Button */}
        <div className="flex items-center flex-wrap gap-2">
          {/* OpenWA Connection Pill */}
          <button
            type="button"
            onClick={checkAdapterHealth}
            disabled={isCheckingAdapter}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
              adapterHealth.status === 'connected'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                : 'bg-rose-50 text-rose-800 border-rose-300 hover:bg-rose-100'
            }`}
            title="Click to re-verify local OpenWA connection"
          >
            {adapterHealth.status === 'connected' ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <Wifi className="w-3.5 h-3.5 text-emerald-600" />
                <span>OpenWA Connected ({adapterHealth.businessPhone || '+6285888600999'})</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-rose-500" />
                <WifiOff className="w-3.5 h-3.5 text-rose-600" />
                <span>OpenWA Offline (127.0.0.1:3100)</span>
              </>
            )}
            <RefreshCw
              className={`w-3 h-3 text-gray-400 ml-0.5 ${isCheckingAdapter ? 'animate-spin' : ''}`}
            />
          </button>

          {/* Report & Excel Export Button */}
          {recipientLogs.length > 0 && (
            <button
              type="button"
              data-testid="campaign-report-btn"
              onClick={() => setIsReportOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold shadow-2xs transition cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>Campaign Report ({recipientLogs.length})</span>
            </button>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* MAIN 2-COLUMN WORKSPACE: Contact Selection (Left) | Composer (Right) */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* LEFT COLUMN: Contact Selection & Filters (5 cols) */}
        <div className="lg:col-span-5 bg-white rounded-xl border border-slate-200 shadow-2xs p-3.5 flex flex-col h-[720px]">
          {/* Header & Stats */}
          <div className="border-b border-slate-200 pb-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-bold text-gray-900 uppercase tracking-wide">
                  Contact Selection
                </span>
              </div>
              <span className="text-xs font-bold font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
                {selectedIds.size} / {dedupedCandidates.length} Selected
              </span>
            </div>

            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-gray-400" />
              <input
                type="text"
                value={contactSearchQuery}
                onChange={(e) => setContactSearchQuery(e.target.value)}
                placeholder="Search company, person, mobile..."
                className="w-full pl-8 pr-7 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:outline-emerald-500 text-gray-900"
              />
              {contactSearchQuery && (
                <button
                  type="button"
                  onClick={() => setContactSearchQuery('')}
                  className="absolute right-2 top-2 text-gray-400 hover:text-gray-600 p-0.5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Quick Action Buttons */}
            <div className="flex items-center justify-between gap-2 pt-0.5 text-xs">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleSelectAllFiltered}
                  className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded font-semibold text-[11px] transition cursor-pointer"
                >
                  Select All ({filteredCandidates.length})
                </button>
                <button
                  type="button"
                  onClick={handleSelectNoneFiltered}
                  className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 rounded text-[11px] transition cursor-pointer"
                >
                  Clear Selection
                </button>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {duplicateCount > 0 && (
                  <span className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200" title="Same company duplicate numbers automatically consolidated to one message">
                    {duplicateCount} Dups Auto-Excluded
                  </span>
                )}
                {ambiguousSharedList.length > 0 && (
                  <span
                    className="text-[10px] text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200 font-medium"
                    title={ambiguousSharedList.map(s => `${s.phone}: ${s.reason} (${s.companies.join(', ')})`).join('\n')}
                  >
                    {ambiguousSharedList.length} Shared Switchboard(s) Excluded
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Contact Table / List (Scrollable) */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 py-1 font-sans">
            {loadingContacts ? (
              <div className="p-8 text-center text-xs text-gray-400">
                <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin text-emerald-600" />
                Loading CRM contacts directory...
              </div>
            ) : filteredCandidates.length === 0 ? (
              <div className="p-8 text-center text-xs text-gray-400">
                No matching valid mobile contacts found.
              </div>
            ) : (
              filteredCandidates.map((c) => {
                const isSelected = selectedIds.has(c.id);
                const phone = getNormalizedDestinationPhone(c);
                return (
                  <label
                    key={c.id}
                    className={`flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition select-none ${
                      isSelected ? 'bg-emerald-50/50 hover:bg-emerald-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleToggleCandidate(c.id)}
                      className="mt-1 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-bold text-gray-900 truncate">
                          {c.company_name}
                        </span>
                        <span className="text-[10px] font-mono text-emerald-700 font-semibold bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 shrink-0">
                          {phone}
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-500 truncate flex items-center gap-1.5 mt-0.5">
                        <span>{c.contact_person || 'General Contact'}</span>
                        {c.city && <span>&bull; {c.city}</span>}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          {/* Bottom Note */}
          <div className="pt-2 border-t border-slate-200 text-[10px] text-gray-500 flex items-center justify-between">
            <span>
              <strong>{dedupedCandidates.length}</strong> unique valid mobile numbers loaded from CRM.
            </span>
            <span className="text-emerald-700 font-medium">Safe Deduplicated</span>
          </div>
        </div>

        {/* RIGHT COLUMN: Message Composer & Live Preview (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-4 space-y-3.5">
            {/* Campaign Name */}
            <div className="space-y-1">
              <label className="text-[11px] font-bold text-gray-700 uppercase tracking-wide">
                Campaign Name:
              </label>
              <input
                type="text"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="e.g. Broadcast Penawaran Paracetamol USP"
                className="w-full text-xs p-2 bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:outline-emerald-500 text-gray-900 font-medium"
              />
            </div>

            {/* Template Selector */}
            <div className="space-y-1">
              <label className="text-[11px] font-bold text-gray-700 uppercase tracking-wide flex items-center justify-between">
                <span>Message Template:</span>
                <span className="text-[10px] text-gray-400 font-normal">
                  (Optional - select existing template)
                </span>
              </label>
              <select
                value={selectedTemplateId}
                onChange={(e) => handleSelectTemplate(e.target.value)}
                className="w-full text-xs p-2 bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:outline-emerald-500 text-gray-800"
              >
                <option value="">-- Write Custom Message or Pick Template --</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.template_name} {t.category ? `(${t.category})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Placeholder Variable Buttons (1-Click Insert) */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-bold text-gray-700 uppercase tracking-wide">
                  Insert Placeholders:
                </span>
                <span className="text-[10px] text-gray-400">Click to insert tag at end</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => insertPlaceholder('{{contact_name}}')}
                  className="px-2.5 py-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-300 rounded-md font-mono font-semibold hover:bg-emerald-100 transition shadow-2xs cursor-pointer"
                  title="Insert contact person's name"
                >
                  &#123;&#123;contact_name&#125;&#125;
                </button>
                <button
                  type="button"
                  onClick={() => insertPlaceholder('{{company_name}}')}
                  className="px-2.5 py-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-300 rounded-md font-mono font-semibold hover:bg-emerald-100 transition shadow-2xs cursor-pointer"
                  title="Insert company name"
                >
                  &#123;&#123;company_name&#125;&#125;
                </button>
                <button
                  type="button"
                  onClick={() => insertPlaceholder('{{product_name}}')}
                  className="px-2.5 py-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-300 rounded-md font-mono font-semibold hover:bg-emerald-100 transition shadow-2xs cursor-pointer"
                  title="Insert featured product name"
                >
                  &#123;&#123;product_name&#125;&#125;
                </button>
              </div>
            </div>

            {/* Product Name Input */}
            <div className="space-y-1">
              <label className="text-[11px] font-bold text-gray-700 uppercase tracking-wide">
                Product Name Focus:
              </label>
              <input
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="e.g. Paracetamol USP / Metformin HCl"
                className="w-full text-xs p-2 bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:outline-emerald-500 text-gray-900"
              />
            </div>

            {/* Message Textarea with Character / Caption Limit */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <label className="font-bold text-gray-700 uppercase tracking-wide">
                  {waAttachment ? 'Message Caption (Sent with Media):' : 'Message Body:'}
                </label>
                <span
                  className={`font-mono text-xs ${
                    isCaptionExceeded ? 'text-rose-600 font-bold' : 'text-gray-500'
                  }`}
                >
                  {captionLength}{' '}
                  {waAttachment
                    ? `/ ${WHATSAPP_MEDIA_CAPTION_LIMIT} chars max`
                    : '/ 4096 chars'}
                </span>
              </div>
              <textarea
                rows={6}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Write your WhatsApp message here..."
                className={`w-full text-xs p-3 border rounded-lg focus:outline-emerald-500 leading-relaxed font-sans ${
                  isCaptionExceeded
                    ? 'border-rose-400 bg-rose-50/20'
                    : 'border-slate-300 bg-white'
                }`}
              />

              {isCaptionExceeded && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div>
                    <strong>WhatsApp Caption Limit Exceeded:</strong> WhatsApp captions are limited
                    to {WHATSAPP_MEDIA_CAPTION_LIMIT} characters (currently {captionLength}). Please
                    shorten your message before dispatching.
                  </div>
                </div>
              )}
            </div>

            {/* Attachment Section: Photo / Document Modal & Selected Card */}
            <div className="space-y-2 pt-1 border-t border-slate-100">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-bold text-gray-700 uppercase tracking-wide flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5 text-emerald-600" />
                  Attachment (Photo / Document):
                </span>
                {waAttachment && (
                  <button
                    type="button"
                    onClick={() => setWaAttachment(null)}
                    className="text-[10px] text-rose-600 hover:text-rose-800 font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove
                  </button>
                )}
              </div>

              {!waAttachment ? (
                <button
                  type="button"
                  onClick={() => setIsAttachmentModalOpen(true)}
                  className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-slate-50 hover:bg-emerald-50/50 border border-dashed border-slate-300 hover:border-emerald-500 text-gray-700 hover:text-emerald-900 rounded-xl text-xs font-semibold transition group shadow-2xs cursor-pointer"
                >
                  <Paperclip className="w-4 h-4 text-gray-400 group-hover:text-emerald-600 transition" />
                  <span>Attach Photo / Document</span>
                  <span className="text-[10px] text-gray-400 group-hover:text-emerald-700 font-normal">
                    (Document Bank or Local File)
                  </span>
                </button>
              ) : (
                <div className="p-3 bg-emerald-50/70 border border-emerald-300 rounded-xl text-xs space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {waAttachment.mediaCategory === 'image' ? (
                        <div className="w-12 h-12 rounded-lg overflow-hidden border border-emerald-200 bg-white shrink-0">
                          {waAttachment.previewUrl || waAttachment.url ? (
                            <img
                              src={waAttachment.previewUrl || waAttachment.url}
                              alt={waAttachment.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full bg-blue-100 text-blue-700 flex items-center justify-center">
                              <ImageIcon className="w-5 h-5" />
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-red-100 text-red-700 flex items-center justify-center shrink-0 border border-red-200">
                          <FileText className="w-6 h-6" />
                        </div>
                      )}

                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-gray-900 truncate">
                            {waAttachment.name}
                          </span>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-emerald-200 text-emerald-900">
                            {waAttachment.documentType}
                          </span>
                        </div>
                        <div className="text-[11px] text-gray-600 flex flex-wrap items-center gap-x-2">
                          <span>{waAttachment.formattedSize || 'Document'}</span>
                          <span>&bull;</span>
                          <span className="text-emerald-700 font-semibold">
                            {waAttachment.source === 'bank' ? 'Universal Document Bank' : 'Uploaded File'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => setIsAttachmentModalOpen(true)}
                        className="px-2.5 py-1 text-[11px] font-semibold bg-white border border-gray-300 hover:border-emerald-500 rounded-lg text-gray-700 hover:text-emerald-800 transition cursor-pointer"
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        onClick={() => setWaAttachment(null)}
                        className="p-1 text-gray-400 hover:text-rose-600 rounded-lg hover:bg-white transition cursor-pointer"
                        title="Remove Attachment"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="text-[10px] text-emerald-800 bg-white/80 px-2 py-0.5 rounded-md border border-emerald-200 font-medium">
                    ✓ Single attachment attached. Will be dispatched with message text as caption.
                  </div>
                </div>
              )}
            </div>

            {/* Live Message Preview Accordion / Box */}
            <div className="pt-2 border-t border-slate-100 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-gray-800 uppercase tracking-wide flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5 text-emerald-600" />
                  Live Customer Preview:
                </span>
                {selectedCandidatesList.length > 0 && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewIndex((p) =>
                          p > 0 ? p - 1 : selectedCandidatesList.length - 1
                        )
                      }
                      className="p-1 rounded hover:bg-slate-100 text-gray-600 cursor-pointer"
                      title="Previous recipient"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-[10px] font-mono text-gray-500">
                      {previewIndex + 1} / {selectedCandidatesList.length}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewIndex((p) =>
                          p < selectedCandidatesList.length - 1 ? p + 1 : 0
                        )
                      }
                      className="p-1 rounded hover:bg-slate-100 text-gray-600 cursor-pointer"
                      title="Next recipient"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {/* Chat Bubble Mockup */}
              <div className="rounded-xl overflow-hidden border border-slate-300 shadow-2xs font-sans">
                <div className="bg-[#075e54] text-white px-3 py-1.5 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 truncate">
                    <div className="w-6 h-6 rounded-full bg-emerald-200 text-[#075e54] flex items-center justify-center font-bold text-[10px] shrink-0">
                      {(activePreviewCandidate?.company_name || 'C')[0]}
                    </div>
                    <div className="truncate">
                      <div className="font-bold text-[11px] truncate">
                        {activePreviewCandidate?.company_name || 'PT Farmasi Indonesia'}
                      </div>
                      <div className="text-[9px] text-emerald-100 truncate">
                        {resolvePersonalizedGreeting(activePreviewCandidate?.contact_person, activePreviewCandidate?.company_name)} &bull;{' '}
                        {activePreviewCandidate ? getNormalizedDestinationPhone(activePreviewCandidate) : '+628123456789'}
                      </div>
                    </div>
                  </div>
                  <span className="text-[9px] bg-emerald-800/80 px-1.5 py-0.5 rounded text-emerald-100 font-semibold uppercase">
                    Preview
                  </span>
                </div>

                <div className="bg-[#efeae2] p-3 space-y-2">
                  <div className="flex justify-end">
                    <div className="bg-[#d9fdd3] text-gray-900 rounded-lg rounded-tr-none p-3 max-w-[90%] shadow-2xs space-y-2 text-xs">
                      {waAttachment && (
                        <div className="p-2 bg-white/70 rounded border border-emerald-300 flex items-center gap-2">
                          <FileText className="w-5 h-5 text-emerald-700 shrink-0" />
                          <div className="truncate text-[11px]">
                            <div className="font-bold truncate">{waAttachment.name}</div>
                            <div className="text-[9px] text-gray-500">
                              {waAttachment.documentType} &bull; {waAttachment.formattedSize}
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="whitespace-pre-wrap leading-relaxed text-[11px]">
                        {renderedPreviewText}
                      </div>
                      <div className="text-[9px] text-gray-500 text-right">
                        {new Date().toLocaleTimeString('id-ID', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        ✓
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* BOTTOM CARD: Sending Settings, Controls & Real-Time Progress */}
      {/* ------------------------------------------------------------------ */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3.5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
          {/* Interval Setting */}
          <div className="flex items-center gap-3 text-xs">
            <span className="font-bold text-gray-800 uppercase tracking-wide">
              Interval Pacing:
            </span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={5}
                max={300}
                value={delaySeconds}
                onChange={(e) => setDelaySeconds(Math.max(5, Number(e.target.value)))}
                disabled={isSending}
                className="w-16 p-1.5 text-xs text-center border border-slate-300 rounded bg-slate-50 font-bold focus:bg-white focus:outline-emerald-500"
              />
              <span className="text-gray-600 font-medium">seconds between messages</span>
            </div>
            <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 hidden sm:inline">
              Safe sequential pacing
            </span>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {!isSending ? (
              <button
                type="button"
                onClick={handleStartCampaign}
                disabled={
                  selectedIds.size === 0 ||
                  !messageText.trim() ||
                  isCaptionExceeded ||
                  adapterHealth.status === 'disconnected'
                }
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <Play className="w-4 h-4" />
                <span>Start Campaign ({selectedIds.size} Recipients)</span>
              </button>
            ) : isPaused ? (
              <>
                <button
                  type="button"
                  data-testid="resume-campaign-btn"
                  onClick={handleResumeCampaign}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition cursor-pointer"
                >
                  <Play className="w-4 h-4" />
                  <span>Resume Campaign</span>
                </button>
                <button
                  type="button"
                  data-testid="cancel-campaign-btn"
                  onClick={handleCancelCampaign}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded-lg text-xs font-semibold transition cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Cancel</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="pause-campaign-btn"
                  onClick={handlePauseCampaign}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold shadow-xs transition cursor-pointer"
                >
                  <Pause className="w-4 h-4" />
                  <span>Pause Campaign</span>
                </button>
                <button
                  type="button"
                  data-testid="cancel-campaign-btn"
                  onClick={handleCancelCampaign}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded-lg text-xs font-semibold transition cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Cancel</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Live Progress Bar & Status Counters */}
        {(isSending || recipientLogs.length > 0) && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="font-bold text-gray-900">
                  {isSending
                    ? isPaused
                      ? 'Campaign Paused'
                      : 'Campaign In Progress...'
                    : 'Campaign Finished'}
                </span>
                {currentSendingRecipient && (
                  <span className="text-[11px] text-emerald-700 flex items-center gap-1 font-medium animate-pulse">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    Sending to: {currentSendingRecipient}
                  </span>
                )}
                {countdown > 0 && (
                  <span className="text-[11px] text-amber-700 font-medium">
                    Next send in {countdown}s...
                  </span>
                )}
              </div>
              <span className="font-mono font-bold text-gray-700">{progressPercent}%</span>
            </div>

            {/* Visual Progress Bar */}
            <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200">
              <div
                className={`h-full transition-all duration-300 ${
                  isPaused ? 'bg-amber-500' : 'bg-emerald-600'
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            {/* Live KPI Metric Chips */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-center">
                <span className="text-[10px] uppercase font-bold text-gray-500 block">Total</span>
                <span className="text-sm font-extrabold text-gray-900">{stats.total}</span>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-center">
                <span className="text-[10px] uppercase font-bold text-emerald-800 block">
                  Sent Successfully
                </span>
                <span className="text-sm font-extrabold text-emerald-900">{stats.sent}</span>
              </div>
              <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 text-center">
                <span className="text-[10px] uppercase font-bold text-rose-800 block">Failed</span>
                <span className="text-sm font-extrabold text-rose-900">{stats.failed}</span>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-center">
                <span className="text-[10px] uppercase font-bold text-gray-500 block">Pending</span>
                <span className="text-sm font-extrabold text-gray-800">{stats.pending}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* ATTACHMENT MODAL */}
      {/* ------------------------------------------------------------------ */}
      <WhatsAppAttachmentModal
        isOpen={isAttachmentModalOpen}
        onClose={() => setIsAttachmentModalOpen(false)}
        currentAttachment={waAttachment}
        onSelectAttachment={(att) => {
          setWaAttachment(att);
          setIsAttachmentModalOpen(false);
          showToast({
            type: 'success',
            title: 'Attachment Added',
            message: `Selected: ${att.name}`,
          });
        }}
      />

      {/* ------------------------------------------------------------------ */}
      {/* CAMPAIGN REPORT & EXCEL EXPORT MODAL */}
      {/* ------------------------------------------------------------------ */}
      {isReportOpen && (
        <div
          data-testid="campaign-report-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2.5">
                <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
                <div>
                  <h3 className="text-sm font-bold text-gray-900">Campaign Dispatch Report</h3>
                  <p className="text-xs text-gray-500">{campaignName}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="export-excel-btn"
                  onClick={handleExportToExcel}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export to Excel</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsReportOpen(false)}
                  className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-slate-200 transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Modal Filter Bar */}
            <div className="p-3 border-b border-slate-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 bg-slate-50/50">
              <div className="relative flex-1 max-w-xs">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-gray-400" />
                <input
                  type="text"
                  value={reportSearch}
                  onChange={(e) => setReportSearch(e.target.value)}
                  placeholder="Filter report records..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-emerald-500"
                />
              </div>

              <div className="flex items-center gap-1 text-xs">
                {(['all', 'sent', 'failed', 'pending'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setReportStatusFilter(filter)}
                    className={`px-2.5 py-1 rounded text-xs font-semibold capitalize transition cursor-pointer ${
                      reportStatusFilter === filter
                        ? 'bg-slate-800 text-white shadow-xs'
                        : 'bg-white hover:bg-slate-100 text-gray-600 border border-gray-200'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </div>

            {/* Modal Table (Scrollable) */}
            <div className="flex-1 overflow-auto p-4">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 text-gray-700 font-bold uppercase text-[10px] border-b border-slate-200 sticky top-0">
                  <tr>
                    <th className="p-2.5">Company Name</th>
                    <th className="p-2.5">Contact Person</th>
                    <th className="p-2.5">Mobile Number</th>
                    <th className="p-2.5">Status</th>
                    <th className="p-2.5">Message ID</th>
                    <th className="p-2.5">Sent Time</th>
                    <th className="p-2.5">Error / Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-sans">
                  {filteredLogsForReport.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-gray-400">
                        No recipient logs match the current filter.
                      </td>
                    </tr>
                  ) : (
                    filteredLogsForReport.map((r, idx) => (
                      <tr key={idx} className="hover:bg-slate-50 transition">
                        <td className="p-2.5 font-bold text-gray-900">{r.company_name}</td>
                        <td className="p-2.5 text-gray-600">{r.contact_person || '—'}</td>
                        <td className="p-2.5 font-mono text-[11px] text-gray-800">{r.phone}</td>
                        <td className="p-2.5">
                          {r.status === 'sent' || r.status === 'delivered' || r.status === 'read' ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 uppercase">
                              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                              {r.status}
                            </span>
                          ) : r.status === 'failed' ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-800 bg-rose-50 px-2 py-0.5 rounded border border-rose-200 uppercase">
                              <XCircle className="w-3 h-3 text-rose-600" />
                              Failed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 bg-gray-50 px-2 py-0.5 rounded border border-gray-200 uppercase">
                              <Clock className="w-3 h-3" />
                              {r.status}
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 font-mono text-[10px] text-gray-500 max-w-[120px] truncate">
                          {r.message_id ? r.message_id.slice(0, 16) + '...' : '—'}
                        </td>
                        <td className="p-2.5 text-[11px] text-gray-600">
                          {r.sent_at ? new Date(r.sent_at).toLocaleTimeString() : '—'}
                        </td>
                        <td className="p-2.5 text-[11px] text-rose-600 max-w-[160px] truncate" title={r.error_message || ''}>
                          {r.error_message || '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-slate-200 flex items-center justify-between text-xs bg-slate-50 text-gray-600">
              <span>
                Total records: <strong>{filteredLogsForReport.length}</strong>
              </span>
              <button
                type="button"
                onClick={() => setIsReportOpen(false)}
                className="px-3 py-1.5 bg-white border border-slate-300 rounded text-gray-700 hover:bg-slate-100 font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
