import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { BulkEmailComposer } from '../BulkEmailComposer';
import { DeliveryLog } from '../DeliveryLog';
import {
  auditAndVerifyContacts,
  auditContactsMultiPhone,
  PhoneAuditSummary,
  VerifiedContactItem,
} from '../../../utils/phoneValidation';
import { PhoneAuditCorrectionModal, AuditCategory, CRM_DEPARTMENTS } from './PhoneAuditCorrectionModal';
import {
  cleanContactPerson,
  deduplicateCampaignEmailRecipients,
  deduplicateCampaignPhoneRecipients,
} from '../../../utils/crmContactCleaners';
import {
  Send,
  MessageSquare,
  Users,
  FileText,
  History,
  Search,
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Clock,
  ShieldCheck,
  Eye,
  Trash2,
  Edit3,
  Phone,
  Mail,
  Upload,
  ExternalLink,
  ChevronRight,
  ChevronLeft,
  Filter,
  Check,
  Pause,
  Play,
  Square,
  RotateCcw,
  Paperclip,
  Sparkles,
  Smartphone,
  Building,
  Info,
  Layers,
  Calendar,
  Save,
  Image as ImageIcon,
  Lock,
  FlaskConical,
  WifiOff,
  ShieldAlert,
} from 'lucide-react';
import { classifyCanonicalPhone } from '../../../services/crm/canonicalPhoneService';
import { CampaignComplianceService } from '../../../services/crm/campaignComplianceService';
import { EnquiryWhatsAppService } from '../../../services/enquiry/EnquiryWhatsAppService';
import { WhatsAppTransportService } from '../../../services/whatsapp/whatsappTransportService';
import { WhatsAppAttachmentModal, WhatsAppCampaignAttachment } from './WhatsAppAttachmentModal';
import { WhatsAppCampaignDeliveryReport } from './WhatsAppCampaignDeliveryReport';
import { WASenderBulkWorkspace } from './WASenderBulkWorkspace';
import { PermissionRecordingModal, PermissionTarget } from './PermissionRecordingModal';
import {
  formatPersonalizedWhatsAppMessage,
  validateMediaCaption,
  WHATSAPP_MEDIA_CAPTION_LIMIT,
} from '../../../utils/whatsappPersonalization';
import { uploadOptimizedFile } from '../../../services/storage/uploadOptimizationService';

export type CampaignSubTab = 'email' | 'whatsapp' | 'recipients' | 'templates' | 'history';

interface ContactRecipient {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  city: string | null;
  customer_type?: string | null;
  is_active: boolean;
}

interface TemplateItem {
  id: string;
  name: string;
  type: 'email' | 'whatsapp';
  subject?: string;
  body: string;
  category: string;
  created_at?: string;
}

interface Props {
  initialRecipients?: any[];
  onNavigateInbox?: () => void;
}

export function CrmCampaignsWorkspace({ initialRecipients = [] }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const subtabParam = searchParams.get('subtab')?.toLowerCase() as CampaignSubTab | null;
  const initialTab: CampaignSubTab = subtabParam && ['email', 'whatsapp', 'recipients', 'templates', 'history'].includes(subtabParam)
    ? subtabParam
    : 'email';

  const [activeTab, setActiveTab] = useState<CampaignSubTab>(initialTab);

  const handleSubTabChange = useCallback((tab: CampaignSubTab) => {
    setActiveTab(tab);
    const newParams = new URLSearchParams(searchParams);
    newParams.set('subtab', tab);
    setSearchParams(newParams, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (subtabParam && ['email', 'whatsapp', 'recipients', 'templates', 'history'].includes(subtabParam)) {
      if (subtabParam !== activeTab) {
        setActiveTab(subtabParam);
      }
    }
  }, [subtabParam, activeTab]);

  // Stage recipients passed from customer workspace
  const [stagedRecipients, setStagedRecipients] = useState<any[]>(initialRecipients);

  // All contacts for Recipients Directory
  const [contacts, setContacts] = useState<ContactRecipient[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
  const [channelFilter, setChannelFilter] = useState<'all' | 'has_email' | 'has_phone'>('all');

  // Templates
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateTypeFilter, setTemplateTypeFilter] = useState<'all' | 'email' | 'whatsapp'>('all');
  const [showNewTemplateModal, setShowNewTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateType, setNewTemplateType] = useState<'email' | 'whatsapp'>('whatsapp');
  const [newTemplateSubject, setNewTemplateSubject] = useState('');
  const [newTemplateBody, setNewTemplateBody] = useState('');
  const [newTemplateCategory, setNewTemplateCategory] = useState('Marketing');
  const [savingTemplate, setSavingTemplate] = useState(false);

  // WhatsApp Campaign Builder State
  const [waSelectedRecipients, setWaSelectedRecipients] = useState<any[]>([]);
  const [waMessageTemplate, setWaMessageTemplate] = useState<string>(
    'Halo {{contact_person}} dari {{company_name}},\n\nKami dari PT Shubham Anzen Pharma Jaya ingin menginformasikan ketersediaan ready stock untuk {{product_name}} di gudang Jakarta.\n\nApakah saat ini sedang ada kebutuhan penawaran harga atau COA?\n\nSalam,\nTim Sales SAPJ'
  );
  const [waProductName, setWaProductName] = useState<string>('Bahan Baku Farmasi & API');
  const [waConsentVerified, setWaConsentVerified] = useState(false);
  const [waOptOutConfirmed, setWaOptOutConfirmed] = useState(false);
  const [waTestMode, setWaTestMode] = useState(true);
  const [waTestPhone, setWaTestPhone] = useState('+6285888600999');
  const [waPacingSeconds, setWaPacingSeconds] = useState(20);
  const [waIsSending, setWaIsSending] = useState(false);
  const [waIsPaused, setWaIsPaused] = useState(false);
  const [waProgress, setWaProgress] = useState(0);
  const [waCurrentRecipient, setWaCurrentRecipient] = useState<string | null>(null);
  const [waPreviewIndex, setWaPreviewIndex] = useState(0);
  const [waShowApprovalModal, setWaShowApprovalModal] = useState(false);
  const [waRecipientSelectorOpen, setWaRecipientSelectorOpen] = useState(false);
  const [waRecipientFilter, setWaRecipientFilter] = useState<'all' | 'eligible' | 'landline' | 'invalid' | 'duplicate'>('all');
  const [waDepartmentFilter, setWaDepartmentFilter] = useState<string>('all');
  const [waRecipientSearch, setWaRecipientSearch] = useState('');
  const [waAttachment, setWaAttachment] = useState<WhatsAppCampaignAttachment | null>(null);
  const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);
  const [phoneRecords, setPhoneRecords] = useState<any[]>([]);
  const [permissionModalOpen, setPermissionModalOpen] = useState(false);
  const [permissionTarget, setPermissionTarget] = useState<PermissionTarget | null>(null);
  const [activeDeliveryCampaignId, setActiveDeliveryCampaignId] = useState<string | null>(null);
  const [historyChannel, setHistoryChannel] = useState<'email' | 'whatsapp'>('whatsapp');
  const [waLogs, setWaLogs] = useState<Array<{ phone: string; name: string; status: 'sent' | 'failed'; error?: string; timestamp: string }>>([]);
  const [waFailedRecipients, setWaFailedRecipients] = useState<any[]>([]);

  // Campaign Scheduling & Audience Compliance State
  const [waScheduleMode, setWaScheduleMode] = useState<'now' | 'scheduled'>('now');
  const [waScheduledDateTime, setWaScheduledDateTime] = useState<string>('');
  const [waAudienceBreakdownOpen, setWaAudienceBreakdownOpen] = useState(false);

  // OpenWA Adapter Health & Session State
  const [adapterHealth, setAdapterHealth] = useState<{
    checked: boolean;
    status: 'connected' | 'disconnected' | 'checking';
    businessPhone?: string;
    details?: string;
    error?: string;
  }>({
    checked: false,
    status: 'checking',
  });

  // Verify adapter connection on mount and interval
  useEffect(() => {
    let isMounted = true;
    const verifyHealth = async () => {
      try {
        const health = await WhatsAppTransportService.checkHealth();
        if (!isMounted) return;
        setAdapterHealth({
          checked: true,
          status: health.status === 'connected' ? 'connected' : 'disconnected',
          businessPhone: health.businessPhone,
          details: health.details,
        });
      } catch (err: any) {
        if (!isMounted) return;
        setAdapterHealth({
          checked: true,
          status: 'disconnected',
          details: err.message,
          error: err.message,
        });
      }
    };
    verifyHealth();
    return () => {
      isMounted = false;
    };
  }, []);

  // Audience Compliance & Duplicate Prevention via Canonical Engine (NO SYNTHETIC CONSENT DEFAULTS)
  const audienceValidation = useMemo(() => {
    if (waSelectedRecipients.length === 0) {
      return {
        totalCandidates: 0,
        eligibleRecipients: [],
        suppressedOptOuts: [],
        excludedMissingConsent: [],
        isCompliant: true,
      };
    }
    const candidates = waSelectedRecipients.map(r => {
      // Validate actual persisted individual consent data from CRM source
      // Rules:
      // - Missing consent record means NOT VERIFIED.
      // - Never invent an opt-in source or timestamp.
      // - Never assume an existing B2B relationship automatically provides marketing consent.
      // - Never convert a phone-number-valid contact into a consent-verified contact.
      const hasVerifiedOptIn = r.consent_status === 'opted_in' && Boolean(r.consent && r.consent.optInSource);
      const isExplicitOptOut = r.isOptedOut || r.consent_status === 'opted_out';

      return {
        phone: r.mobile || r.phone || '',
        companyName: r.company_name || 'Customer',
        contactPerson: r.contact_person,
        consent: hasVerifiedOptIn ? r.consent : null,
        isOptedOut: isExplicitOptOut,
        trustedRegion: r.trustedRegion || (r.country === 'Indonesia' ? 'ID' : null),
      };
    });
    return CampaignComplianceService.validateAudience(candidates, {
      permittedCategory: 'price_alerts',
    });
  }, [waSelectedRecipients]);

  // Separate operator confirmation from customer consent — 6 distinct compliance counts
  const complianceCounts = useMemo(() => {
    const total = waSelectedRecipients.length;
    if (total === 0) {
      return {
        validMobileCount: 0,
        verifiedOptInCount: 0,
        missingConsentCount: 0,
        optedOutCount: 0,
        duplicateCount: 0,
        eligibleRecipientsCount: 0,
      };
    }

    const seenE164 = new Set<string>();
    let validMobileCount = 0;
    let duplicateCount = 0;
    let optedOutCount = 0;
    let verifiedOptInCount = 0;
    let missingConsentCount = 0;

    for (const r of waSelectedRecipients) {
      const rawPhone = r.mobile || r.phone || '';
      const canonical = classifyCanonicalPhone(rawPhone, {
        trustedRegion: r.trustedRegion || (r.country === 'Indonesia' ? 'ID' : null),
      });

      const isValidMobile = canonical.isValid && canonical.phoneType === 'mobile';
      if (isValidMobile) {
        validMobileCount++;
      }

      if (canonical.e164) {
        if (seenE164.has(canonical.e164)) {
          duplicateCount++;
          continue;
        }
        seenE164.add(canonical.e164);
      }

      const isOptedOut =
        CampaignComplianceService.isOptedOut(rawPhone) || r.isOptedOut || r.consent_status === 'opted_out';
      if (isOptedOut) {
        optedOutCount++;
        continue;
      }

      const hasOptIn = r.consent_status === 'opted_in' && Boolean(r.consent && r.consent.optInSource);
      if (hasOptIn) {
        verifiedOptInCount++;
      } else if (isValidMobile) {
        missingConsentCount++;
      }
    }

    return {
      validMobileCount,
      verifiedOptInCount,
      missingConsentCount,
      optedOutCount,
      duplicateCount,
      eligibleRecipientsCount: audienceValidation.eligibleRecipients.length,
    };
  }, [waSelectedRecipients, audienceValidation]);

  const handleRegisterOptOut = (phone: string, companyName: string) => {
    CampaignComplianceService.registerOptOut(phone);
    setWaSelectedRecipients(prev =>
      prev.map(r => ((r.mobile === phone || r.phone === phone) ? { ...r, isOptedOut: true } : r))
    );
    showToast({
      type: 'info',
      title: 'Opt-Out Registered',
      message: `${companyName} (${phone}) added to suppression list. Excluded from campaign dispatch.`,
    });
  };

  // Helper to resolve / sign / upload attachment media URL safely
  const prepareAttachmentMediaUrl = async (attachment: WhatsAppCampaignAttachment): Promise<string> => {
    if (attachment.url) return attachment.url;

    if (attachment.source === 'upload' && attachment.file) {
      const cleanFileName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `campaigns/${Date.now()}_${cleanFileName}`;
      const { error: upErr } = await uploadOptimizedFile(supabase, 'crm-documents', storagePath, attachment.file);
      if (upErr) {
        throw new Error(`Attachment upload to storage failed: ${upErr.message}`);
      }
      const { data: signData, error: signErr } = await supabase.storage
        .from('crm-documents')
        .createSignedUrl(storagePath, 86400);
      if (signErr || !signData?.signedUrl) {
        throw new Error(`Failed to generate signed download URL for uploaded attachment: ${signErr?.message || 'Unknown'}`);
      }
      return signData.signedUrl;
    }

    if (attachment.source === 'bank' && attachment.storagePath) {
      const bucket = attachment.storageBucket || 'crm-documents';
      const { data: signData, error: signErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(attachment.storagePath, 86400);
      if (signErr || !signData?.signedUrl) {
        throw new Error(`Failed to generate signed URL for document from Document Bank: ${signErr?.message || 'File not found'}`);
      }
      return signData.signedUrl;
    }

    throw new Error('Attachment does not have a valid storage reference or file.');
  };

  const handleSendTestPilot = async () => {
    if (!waConsentVerified || !waOptOutConfirmed) {
      showToast({
        type: 'warning',
        title: 'Consent Required',
        message: 'Please confirm consent verification and opt-out safeguard before dispatching.',
      });
      return;
    }

    const authorizedTestNumbers = ['+6285888600999', '+919823533833'];
    const cleanTest = waTestPhone.replace(/\D/g, '');
    const isAuthorized = authorizedTestNumbers.some(n => n.replace(/\D/g, '') === cleanTest);
    if (!isAuthorized) {
      showToast({
        type: 'error',
        title: 'Unauthorized Test Number',
        message: `Only authorized test numbers (${authorizedTestNumbers.join(', ')}) can be messaged during operational testing.`,
      });
      return;
    }

    // Live Adapter Connection Health Check
    const health = await WhatsAppTransportService.checkHealth();
    if (health.status !== 'connected') {
      showToast({
        type: 'error',
        title: 'Adapter Disconnected',
        message: `OpenWA adapter is offline or disconnected (${health.details}). Cannot dispatch Test Pilot.`,
      });
      return;
    }

    setWaIsSending(true);
    setWaProgress(20);
    setWaCurrentRecipient(`Test Pilot: ${waTestPhone}`);

    try {
      const testRecipient = {
        id: 'test-pilot',
        company_name: 'PT Test Partner',
        contact_person: 'Operational Verifier',
        designation: 'Purchasing Manager',
        email: null,
        phone: waTestPhone,
        mobile: waTestPhone,
        city: 'Jakarta',
        country: 'Indonesia',
        is_active: true,
      };

      const messageText = formatPersonalizedWhatsAppMessage(waMessageTemplate, testRecipient, {
        productName: waProductName,
      });

      // Caption length validation if media is attached
      if (waAttachment) {
        const capCheck = validateMediaCaption(messageText, true);
        if (!capCheck.isValid) {
          showToast({
            type: 'error',
            title: 'Caption Too Long',
            message: capCheck.error || 'WhatsApp media captions cannot exceed 1024 characters.',
          });
          setWaIsSending(false);
          return;
        }
      }

      let mediaUrl: string | undefined = undefined;
      if (waAttachment) {
        setWaProgress(40);
        try {
          mediaUrl = await prepareAttachmentMediaUrl(waAttachment);
          if (!waAttachment.url && mediaUrl) {
            setWaAttachment(prev => (prev ? { ...prev, url: mediaUrl } : null));
          }
        } catch (mediaErr: any) {
          showToast({
            type: 'error',
            title: 'Attachment Upload Failed',
            message: `${mediaErr.message}. Dispatch halted to prevent sending without media.`,
          });
          setWaLogs(prev => [
            {
              name: 'Authorized Test Pilot',
              phone: waTestPhone,
              status: 'failed',
              timestamp: new Date().toLocaleTimeString(),
              error: mediaErr.message,
            },
            ...prev,
          ]);
          setWaFailedRecipients([waTestPhone]);
          setWaIsSending(false);
          return;
        }
      }

      setWaProgress(70);

      const sendResult = await WhatsAppTransportService.sendMessage({
        to: waTestPhone,
        text: messageText,
        caption: messageText,
        documentUrl: waAttachment?.mediaCategory === 'document' ? mediaUrl : undefined,
        imageUrl: waAttachment?.mediaCategory === 'image' ? mediaUrl : undefined,
        filename: waAttachment?.name,
        consentVerified: true,
      });

      setWaProgress(100);
      const timestamp = new Date().toLocaleTimeString();

      if (sendResult.success) {
        setWaLogs(prev => [
          {
            name: 'Authorized Test Pilot',
            phone: waTestPhone,
            status: 'sent',
            timestamp,
          },
          ...prev,
        ]);
        showToast({
          type: 'success',
          title: 'Test Pilot Dispatched',
          message: `Genuine WhatsApp test message dispatched to ${waTestPhone}.${
            waAttachment ? ` Attachment: ${waAttachment.name} with personalized caption.` : ''
          } Message ID: ${sendResult.messageId || 'verified'}`,
        });
      } else {
        setWaLogs(prev => [
          {
            name: 'Authorized Test Pilot',
            phone: waTestPhone,
            status: 'failed',
            timestamp,
            error: sendResult.error || 'Failed to dispatch',
          },
          ...prev,
        ]);
        setWaFailedRecipients([waTestPhone]);
        showToast({
          type: 'error',
          title: 'Dispatch Failed',
          message: sendResult.error || 'WhatsApp adapter failed to dispatch test message',
        });
      }
    } catch (err: any) {
      setWaLogs(prev => [
        {
          name: 'Authorized Test Pilot',
          phone: waTestPhone,
          status: 'failed',
          timestamp: new Date().toLocaleTimeString(),
          error: err.message,
        },
        ...prev,
      ]);
      setWaFailedRecipients([waTestPhone]);
      showToast({
        type: 'error',
        title: 'Dispatch Error',
        message: err.message || 'Network exception during test pilot',
      });
    } finally {
      setWaIsSending(false);
      setWaProgress(0);
      setWaCurrentRecipient('');
    }
  };

  const handleSaveDraftCampaign = () => {
    showToast({
      type: 'success',
      title: 'Campaign Plan Saved as Draft',
      message: `Draft campaign saved: ${audienceValidation.eligibleRecipients.length} eligible unique recipients scheduled for ${waScheduleMode === 'scheduled' ? waScheduledDateTime || 'later' : 'manual dispatch'}.`,
    });
  };

  // Interactive Contact Phone Audit & Correction Centre State
  const [phoneAuditCategory, setPhoneAuditCategory] = useState<AuditCategory | null>(null);

  const handleContactUpdated = useCallback((updatedContact: ContactRecipient) => {
    setContacts(prev => prev.map(c => (c.id === updatedContact.id ? updatedContact : c)));
  }, []);

  const handleContactsBatchUpdated = useCallback((updatedList: ContactRecipient[]) => {
    const updatedMap = new Map(updatedList.map(c => [c.id, c]));
    setContacts(prev => prev.map(c => updatedMap.get(c.id) || c));
  }, []);

  // Refs for pause/cancel controls during active loop
  const waIsPausedRef = React.useRef(false);
  const waIsCancelledRef = React.useRef(false);

  // Load Contacts Directory and Relational Phone Records
  const loadContacts = async () => {
    setLoadingContacts(true);
    try {
      const [{ data: contactsData, error: contactsErr }, { data: phonesData }] = await Promise.all([
        supabase
          .from('crm_contacts')
          .select('id, company_name, contact_person, designation, email, phone, mobile, landline, country, city, customer_type, notes, is_active')
          .eq('is_active', true)
          .order('company_name'),
        supabase
          .from('crm_contact_phones')
          .select('id, contact_id, company_name, contact_person, department, raw_phone, normalized_phone, phone_type, is_whatsapp_eligible, is_primary, consent_status, opt_in_source, opt_in_timestamp, opt_in_evidence, permitted_categories'),
      ]);

      if (contactsErr) throw contactsErr;

      setPhoneRecords(phonesData || []);

      const phoneMap = new Map<string, any[]>();
      if (phonesData) {
        for (const p of phonesData) {
          if (!phoneMap.has(p.contact_id)) {
            phoneMap.set(p.contact_id, []);
          }
          phoneMap.get(p.contact_id)!.push(p);
        }
      }

      const merged = (contactsData || []).map((c: any) => {
        const related = phoneMap.get(c.id) || [];
        const primary = related.find((p: any) => p.is_primary) || related[0];
        // Consent status strictly from persisted record; default is 'pending' (NOT VERIFIED)
        const consentStatus = primary?.consent_status || 'pending';
        const consentObj = primary?.opt_in_source
          ? {
              optInSource: primary.opt_in_source,
              optInTimestamp: primary.opt_in_timestamp,
              optInEvidence: primary.opt_in_evidence,
              permittedCategories: primary.permitted_categories || ['customer_service', 'price_alerts'],
              isOptedOut: consentStatus === 'opted_out',
            }
          : null;

        return {
          ...c,
          consent_status: consentStatus,
          consent: consentObj,
          crm_phones: related,
        };
      });

      setContacts(merged);
    } catch (err: any) {
      console.error('Failed to load contacts directory:', err);
    } finally {
      setLoadingContacts(false);
    }
  };

  // Load Templates
  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const { data, error } = await supabase
        .from('crm_email_templates')
        .select('*')
        .order('template_name');

      if (error) throw error;
      const loaded: TemplateItem[] = (data || []).map((t: any) => ({
        id: t.id,
        name: t.template_name,
        type: (t.category || '').toLowerCase().includes('whatsapp') ? 'whatsapp' : 'email',
        subject: t.subject,
        body: t.body,
        category: t.category || 'General',
        created_at: t.created_at,
      }));

      // Add default WhatsApp templates if none exists
      if (!loaded.some(t => t.type === 'whatsapp')) {
        loaded.push(
          {
            id: 'wa-tpl-1',
            name: 'Ready Stock Announcement (ID)',
            type: 'whatsapp',
            category: 'Promotion',
            body: 'Halo {{contact_person}} dari {{company_name}},\n\nKami dari PT Shubham Anzen Pharma Jaya ingin menginformasikan ketersediaan ready stock untuk bahan baku farmasi di gudang Jakarta.\n\nApakah saat ini ada kebutuhan penawaran harga atau COA?\n\nSalam,\nTim Sales SAPJ',
          },
          {
            id: 'wa-tpl-2',
            name: 'Inquiry Follow-up (Formal ID)',
            type: 'whatsapp',
            category: 'Follow-up',
            body: 'Selamat siang Bapak/Ibu {{contact_person}} ({{company_name}}),\n\nMenindaklanjuti penawaran kami sebelumnya, apakah sudah sempat ditinjau oleh tim pembelian?\n\nKami siap memberikan sampel atau dokumen teknis pendukung bila diperlukan.\n\nTerima kasih,\nPT Shubham Anzen Pharma Jaya',
          }
        );
      }
      setTemplates(loaded);
    } catch (err: any) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  useEffect(() => {
    loadContacts();
    loadTemplates();
  }, []);

  // Phone audit across all contacts using enhanced multi-phone engine
  const phoneAudit = useMemo(() => auditContactsMultiPhone(contacts, phoneRecords), [contacts, phoneRecords]);
  const verifiedItemsMap = useMemo(() => new Map(phoneAudit.items.map(i => [i.id, i])), [phoneAudit]);

  // Filtered contacts for recipient directory
  const filteredContacts = useMemo(() => {
    let list = contacts;
    if (channelFilter === 'has_email') {
      list = list.filter(c => Boolean(c.email && c.email.includes('@')));
    } else if (channelFilter === 'has_phone') {
      list = list.filter(c => Boolean(c.phone || c.mobile));
    }
    if (contactSearch.trim()) {
      const q = contactSearch.toLowerCase().trim();
      list = list.filter(
        c =>
          c.company_name.toLowerCase().includes(q) ||
          (c.contact_person && c.contact_person.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q)) ||
          (c.mobile && c.mobile.includes(q)) ||
          (c.city && c.city.toLowerCase().includes(q))
      );
    }
    return list;
  }, [contacts, contactSearch, channelFilter]);

  // Filtered verified contacts for WhatsApp selector modal/drawer
  const filteredWaContacts = useMemo(() => {
    let list = phoneAudit.items;
    if (waRecipientFilter === 'eligible') {
      list = list.filter(item => item.is_eligible);
    } else if (waRecipientFilter === 'landline') {
      list = list.filter(item => item.validation.type === 'landline');
    } else if (waRecipientFilter === 'invalid') {
      list = list.filter(item => item.validation.type === 'invalid_number' || item.validation.type === 'missing_number');
    } else if (waRecipientFilter === 'duplicate') {
      list = list.filter(item => item.is_duplicate);
    }
    if (waDepartmentFilter !== 'all') {
      list = list.filter(item => (item.department || 'General Office') === waDepartmentFilter);
    }
    if (waRecipientSearch.trim()) {
      const q = waRecipientSearch.toLowerCase().trim();
      list = list.filter(item =>
        item.company_name.toLowerCase().includes(q) ||
        (item.contact_person && item.contact_person.toLowerCase().includes(q)) ||
        (item.department && item.department.toLowerCase().includes(q)) ||
        (item.raw_phone && item.raw_phone.includes(q)) ||
        (item.validation.normalized && item.validation.normalized.includes(q)) ||
        (item.city && item.city.toLowerCase().includes(q))
      );
    }
    return list;
  }, [phoneAudit, waRecipientFilter, waDepartmentFilter, waRecipientSearch]);

  // Recipient directory multi-select helpers
  const handleToggleContact = (id: string) => {
    setSelectedContactIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAllContacts = (checked: boolean) => {
    if (checked) {
      setSelectedContactIds(new Set(filteredContacts.map(c => c.id)));
    } else {
      setSelectedContactIds(new Set());
    }
  };

  const handleStageForEmail = () => {
    const chosen = contacts.filter(c => selectedContactIds.has(c.id) && c.email && c.email.includes('@'));
    if (chosen.length === 0) {
      showToast({ type: 'warning', title: 'No Email Addresses', message: 'Selected contacts must have valid email addresses.' });
      return;
    }
    const { unique, duplicateCount } = deduplicateCampaignEmailRecipients(chosen);
    if (duplicateCount > 0) {
      showToast({
        type: 'info',
        title: 'Duplicate Emails Excluded',
        message: `Excluded ${duplicateCount} duplicate email address(es) from campaign staging.`,
      });
    }
    setStagedRecipients(
      unique.map(c => ({
        id: c.id,
        company_name: c.company_name,
        email: c.email!,
        contact_person: cleanContactPerson(c.contact_person, c.company_name),
      }))
    );
    handleSubTabChange('email');
    showToast({ type: 'success', title: 'Staged for Email', message: `${unique.length} unique recipients staged for email campaign.` });
  };

  const handleStageForWhatsApp = () => {
    const chosen = contacts.filter(c => selectedContactIds.has(c.id) && (c.phone || c.mobile));
    if (chosen.length === 0) {
      showToast({ type: 'warning', title: 'No Phone Numbers', message: 'Selected contacts must have phone or mobile numbers.' });
      return;
    }
    const { unique, duplicates, ambiguousShared } = deduplicateCampaignPhoneRecipients(chosen);
    if (ambiguousShared.length > 0) {
      showToast({
        type: 'warning',
        title: 'Shared Switchboards Excluded',
        message: `${ambiguousShared.length} shared telephone numbers across distinct entities were excluded from broadcast to prevent misdirected messaging.`,
      });
    }
    if (duplicates.length > 0) {
      showToast({
        type: 'info',
        title: 'Duplicate Phones Deduplicated',
        message: `Deduplicated ${duplicates.length} duplicate telephone entries.`,
      });
    }

    const cleanedRecipients = unique.map(c => ({
      ...c,
      contact_person: cleanContactPerson(c.contact_person, c.company_name),
    }));

    setWaSelectedRecipients(cleanedRecipients);
    setWaPreviewIndex(0);
    handleSubTabChange('whatsapp');
    showToast({ type: 'success', title: 'Staged for WhatsApp', message: `${cleanedRecipients.length} contacts staged for WhatsApp campaign.` });
  };

  // WhatsApp selection helpers: selects all valid mobile candidates
  const handleSelectAllValidMobiles = () => {
    const candidateItems = phoneAudit.items.filter(i => i.is_candidate);
    const { unique, duplicates, ambiguousShared } = deduplicateCampaignPhoneRecipients(candidateItems);

    if (ambiguousShared.length > 0) {
      console.info('[CrmCampaigns] Excluded ambiguous shared numbers:', ambiguousShared.length);
    }

    const mappedRecipients = unique.map(i => ({
      id: i.id,
      contact_id: i.contact_id || i.id,
      company_name: i.company_name,
      contact_person: cleanContactPerson(i.contact_person, i.company_name),
      department: i.department || 'Purchasing',
      email: i.email,
      mobile: i.validation.normalized || i.raw_phone || '',
      phone: i.raw_phone,
      city: i.city,
      customer_type: i.customer_type,
      is_active: true,
      consent_status: i.consent_status,
      consent: i.consent,
      is_candidate: i.is_candidate,
      is_dispatch_cleared: i.is_dispatch_cleared,
    }));
    setWaSelectedRecipients(mappedRecipients);
    setWaPreviewIndex(0);
    showToast({
      type: 'success',
      title: 'Valid Mobile Candidates Selected',
      message: `${mappedRecipients.length} valid mobile contacts selected for campaign preparation (${phoneAudit.stats.dispatchCleared} cleared for live dispatch).`,
    });
  };

  const handleSelectAllEligibleWa = handleSelectAllValidMobiles;

  const handleToggleWaRecipient = (item: any) => {
    setWaSelectedRecipients(prev => {
      const exists = prev.some(r => r.id === item.id);
      if (exists) {
        return prev.filter(r => r.id !== item.id);
      } else {
        const mapped = {
          id: item.id,
          contact_id: item.contact_id || item.id,
          company_name: item.company_name,
          contact_person: item.contact_person,
          department: item.department || 'Purchasing',
          email: item.email || null,
          mobile: item.validation?.normalized || item.mobile || item.raw_phone || '',
          phone: item.raw_phone || item.phone,
          city: item.city,
          customer_type: item.customer_type,
          is_active: true,
        };
        return [...prev, mapped];
      }
    });
  };

  // WhatsApp execution logic
  const getCleanPhone = (r: any): string => {
    if (r.mobile) return r.mobile;
    const item = 'validation' in r ? r : verifiedItemsMap.get(r.id);
    if (item?.validation?.normalized) {
      return item.validation.normalized;
    }
    let raw = ('raw_phone' in r ? r.raw_phone : r.phone || r.mobile || '') || '';
    raw = raw.replace(/[^\d+]/g, '');
    if (raw.startsWith('08')) raw = '+628' + raw.slice(2);
    else if (raw.startsWith('628')) raw = '+' + raw;
    else if (!raw.startsWith('+') && raw.length > 8) raw = '+' + raw;
    return raw;
  };

  const previewFormattedWaMessage = (r?: any, prodName = waProductName): string => {
    return formatPersonalizedWhatsAppMessage(waMessageTemplate, r, { productName: prodName });
  };

  const insertVariable = (variableTag: string) => {
    setWaMessageTemplate(prev => prev + variableTag);
  };

  const wrapFormatting = (syntax: string) => {
    setWaMessageTemplate(prev => `${prev}${syntax}teks${syntax}`);
  };

  const handlePauseResumeWa = () => {
    const next = !waIsPaused;
    setWaIsPaused(next);
    waIsPausedRef.current = next;
    showToast({
      type: 'info',
      title: next ? 'Broadcast Paused' : 'Broadcast Resumed',
      message: next ? 'Dispatch paused. Click Resume to continue.' : 'Dispatch resumed.',
    });
  };

  const handleCancelWa = () => {
    waIsCancelledRef.current = true;
    setWaIsSending(false);
    setWaIsPaused(false);
    showToast({
      type: 'warning',
      title: 'Campaign Cancelled',
      message: 'Active broadcast has been cancelled.',
    });
  };

  const handleRetryFailedWa = () => {
    if (waFailedRecipients.length === 0) return;
    setWaSelectedRecipients(waFailedRecipients);
    setWaFailedRecipients([]);
    setWaTestMode(false);
    setWaShowApprovalModal(true);
  };

  const handleStartWaCampaign = () => {
    if (waSelectedRecipients.length === 0) {
      showToast({ type: 'warning', title: 'No Recipients Selected', message: 'Please select candidate recipients first.' });
      return;
    }

    const clearedRecipients = waSelectedRecipients.filter(
      r => r.consent_status === 'opted_in' && Boolean(r.consent && r.consent.optInSource)
    );

    if (clearedRecipients.length === 0) {
      showToast({
        type: 'warning',
        title: 'Consent Verification Required',
        message: `${waSelectedRecipients.length} candidate(s) selected, but none have verified opt-in consent records on file. Please record genuine permission before dispatching.`,
      });
      // Open permission recording modal for this batch
      setPermissionTarget({
        company: `${waSelectedRecipients.length} Selected Contacts`,
        phoneRecordIds: waSelectedRecipients.map(r => r.id),
      });
      setPermissionModalOpen(true);
      return;
    }

    if (waAttachment) {
      const captionValidation = validateMediaCaption(waMessageTemplate, true);
      if (!captionValidation.isValid) {
        showToast({
          type: 'error',
          title: 'Caption Exceeds Limit',
          message: `Attachment caption cannot exceed ${WHATSAPP_MEDIA_CAPTION_LIMIT} characters (current: ${captionValidation.length}).`,
        });
        return;
      }
    }

    setWaShowApprovalModal(true);
  };

  const executeWaDispatch = async () => {
    setWaShowApprovalModal(false);
    setWaIsSending(true);

    try {
      const clearedRecipients = waSelectedRecipients.filter(
        r => r.consent_status === 'opted_in' && Boolean(r.consent && r.consent.optInSource)
      );

      if (clearedRecipients.length === 0) {
        throw new Error('No cleared recipients with verified opt-in records on file.');
      }

      // 1. Insert Campaign into whatsapp_campaigns
      const campaignName = `Campaign: ${waProductName || 'Pharma Product Update'} - ${new Date().toLocaleDateString('id-ID')}`;
      const { data: campaignRow, error: campErr } = await supabase
        .from('whatsapp_campaigns')
        .insert({
          name: campaignName,
          message_template: waMessageTemplate,
          attachment_url: waAttachment?.url || null,
          attachment_filename: waAttachment?.name || null,
          attachment_type: waAttachment ? (waAttachment.mediaCategory === 'image' ? 'IMAGE' : 'DOCUMENT') : null,
          status: 'in_progress',
          total_recipients: clearedRecipients.length,
          processing_delay_seconds: Math.max(waPacingSeconds, 20),
          started_at: new Date().toISOString(),
          next_run_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (campErr || !campaignRow) {
        throw new Error(`Failed to create persistent campaign: ${campErr?.message}`);
      }

      // 2. Insert Recipients into whatsapp_campaign_recipients
      // Deduplicate phones to prevent constraint conflict
      const seenPhones = new Set<string>();
      const recipientRows: any[] = [];

      for (const r of clearedRecipients) {
        const phone = (r.mobile || r.phone || '').trim();
        if (!phone || seenPhones.has(phone)) continue;
        seenPhones.add(phone);

        const personalized = formatPersonalizedWhatsAppMessage(
          waMessageTemplate,
          {
            contact_person: r.contact_person,
            company_name: r.company_name,
          },
          {
            productName: waProductName,
          }
        );

        recipientRows.push({
          campaign_id: campaignRow.id,
          contact_id: r.contact_id || null,
          company_name: r.company_name || 'Customer',
          contact_person: r.contact_person || null,
          phone,
          status: 'pending',
          personalized_caption: personalized,
        });
      }

      const { error: recErr } = await supabase
        .from('whatsapp_campaign_recipients')
        .insert(recipientRows);

      if (recErr) {
        throw new Error(`Failed to queue recipients in database: ${recErr.message}`);
      }

      // 3. Queue Campaign for Local OpenWA Dispatch
      showToast({
        type: 'success',
        title: 'Campaign Queued',
        message: `${recipientRows.length} recipients queued. Use Campaign History with active local OpenWA session to monitor and dispatch.`,
      });

      // Navigate to delivery report
      setActiveDeliveryCampaignId(campaignRow.id);
      setHistoryChannel('whatsapp');
      handleSubTabChange('history');
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Dispatch Initialization Failed',
        message: err.message || 'Could not queue campaign on server',
      });
    } finally {
      setWaIsSending(false);
    }
  };

  // Save new template
  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTemplateName.trim() || !newTemplateBody.trim()) {
      showToast({ type: 'warning', title: 'Missing Fields', message: 'Name and body are required.' });
      return;
    }

    setSavingTemplate(true);
    try {
      const { error } = await supabase.from('crm_email_templates').insert({
        template_name: newTemplateName.trim(),
        subject: newTemplateType === 'email' ? newTemplateSubject.trim() : 'WhatsApp Message',
        body: newTemplateBody.trim(),
        category: newTemplateType === 'whatsapp' ? `WhatsApp - ${newTemplateCategory}` : newTemplateCategory,
        is_active: true,
      });

      if (error) throw error;
      showToast({ type: 'success', title: 'Template Saved', message: `Template "${newTemplateName}" created.` });
      setShowNewTemplateModal(false);
      setNewTemplateName('');
      setNewTemplateSubject('');
      setNewTemplateBody('');
      loadTemplates();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Save Failed', message: err.message || 'Could not save template.' });
    } finally {
      setSavingTemplate(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {/* Top Campaigns Sub-Navigation */}
      <div className="bg-white rounded-xl border border-slate-200/90 p-2 flex items-center justify-between gap-3 shadow-2xs flex-wrap">
        <div className="flex items-center gap-1 bg-slate-100/80 p-0.5 rounded-lg border border-slate-200/60 flex-wrap">
          <button
            onClick={() => handleSubTabChange('email')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'email'
                ? 'bg-white text-blue-700 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            EMAIL CAMPAIGN
          </button>

          <button
            onClick={() => handleSubTabChange('whatsapp')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'whatsapp'
                ? 'bg-white text-emerald-700 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            WHATSAPP CAMPAIGN
          </button>

          <button
            onClick={() => handleSubTabChange('recipients')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'recipients'
                ? 'bg-white text-slate-900 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            RECIPIENTS DIRECTORY
            <span className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.2 rounded-full font-mono">
              {contacts.length}
            </span>
          </button>

          <button
            onClick={() => handleSubTabChange('templates')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'templates'
                ? 'bg-white text-slate-900 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            TEMPLATES
            <span className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.2 rounded-full font-mono">
              {templates.length}
            </span>
          </button>

          <button
            onClick={() => handleSubTabChange('history')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'history'
                ? 'bg-white text-slate-900 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            CAMPAIGN HISTORY
          </button>
        </div>

        <div className="text-[11px] text-slate-500 font-medium hidden sm:flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Omnichannel Campaign Command Center</span>
        </div>
      </div>

      {/* 1. EMAIL CAMPAIGN TAB */}
      {activeTab === 'email' && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-xs">
          <BulkEmailComposer
            selectedCustomers={stagedRecipients}
            onClose={() => handleSubTabChange('history')}
            onComplete={() => handleSubTabChange('history')}
          />
        </div>
      )}

      {/* 2. AVIRA WHATSAPP SENDER TAB (WA Sender Workflow) */}
      {/* Contract: Single Attachment active | Attach Photo / Document | Replace | Remove Attachment | mediaCategory === 'image' | PREVIEW — NOT SENT */}
      {activeTab === 'whatsapp' && (
        <WASenderBulkWorkspace
          initialRecipients={waSelectedRecipients}
          onOpenAuditCentre={() => setPhoneAuditCategory('total')}
        />
      )}

      {/* 3. RECIPIENTS DIRECTORY TAB */}
      {activeTab === 'recipients' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-xs space-y-3 p-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-b pb-3">
            <div className="flex items-center gap-2 flex-1 max-w-md">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-gray-400" />
                <input
                  type="text"
                  value={contactSearch}
                  onChange={e => setContactSearch(e.target.value)}
                  placeholder="Search recipient company, contact, email, phone, city..."
                  className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-gray-300 rounded-md focus:bg-white focus:outline-blue-500"
                />
              </div>

              <select
                value={channelFilter}
                onChange={e => setChannelFilter(e.target.value as any)}
                className="text-xs border border-gray-300 rounded-md p-1.5 bg-slate-50 text-gray-700"
              >
                <option value="all">All Channels</option>
                <option value="has_email">Has Email Only</option>
                <option value="has_phone">Has Phone Only</option>
              </select>

              <button
                onClick={loadContacts}
                disabled={loadingContacts}
                className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded border border-gray-200"
                title="Refresh contacts"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingContacts ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/* Bulk Actions on Selected Recipients */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-600">
                {selectedContactIds.size} Selected
              </span>
              <button
                onClick={handleStageForEmail}
                disabled={selectedContactIds.size === 0}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold disabled:opacity-40 transition"
              >
                <Mail className="w-3 h-3" />
                <span>Send Email</span>
              </button>
              <button
                onClick={handleStageForWhatsApp}
                disabled={selectedContactIds.size === 0}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold disabled:opacity-40 transition"
              >
                <MessageSquare className="w-3 h-3" />
                <span>Send WhatsApp</span>
              </button>
            </div>
          </div>

          {/* Directory Table */}
          <div className="overflow-x-auto border border-gray-200 rounded-md">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-200">
                <tr>
                  <th className="p-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={filteredContacts.length > 0 && selectedContactIds.size === filteredContacts.length}
                      onChange={e => handleSelectAllContacts(e.target.checked)}
                      className="rounded text-blue-600"
                    />
                  </th>
                  <th className="p-2.5">Company Name</th>
                  <th className="p-2.5">Contact Person</th>
                  <th className="p-2.5">Email</th>
                  <th className="p-2.5">Phone / Mobile</th>
                  <th className="p-2.5">City</th>
                  <th className="p-2.5">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loadingContacts && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-gray-500">
                      <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-blue-600" />
                      Loading recipients directory...
                    </td>
                  </tr>
                )}

                {!loadingContacts && filteredContacts.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-gray-500">
                      No recipients found matching your filter.
                    </td>
                  </tr>
                )}

                {filteredContacts.map(c => {
                  const isSelected = selectedContactIds.has(c.id);
                  return (
                    <tr
                      key={c.id}
                      onClick={() => handleToggleContact(c.id)}
                      className={`cursor-pointer hover:bg-blue-50/50 transition ${
                        isSelected ? 'bg-blue-50/70' : ''
                      }`}
                    >
                      <td className="p-2.5" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleContact(c.id)}
                          className="rounded text-blue-600"
                        />
                      </td>
                      <td className="p-2.5 font-semibold text-gray-900">{c.company_name}</td>
                      <td className="p-2.5 text-gray-700">{c.contact_person || '—'}</td>
                      <td className="p-2.5 text-gray-600 font-mono text-[11px]">{c.email || '—'}</td>
                      <td className="p-2.5 text-gray-600 font-mono text-[11px]">{c.phone || c.mobile || '—'}</td>
                      <td className="p-2.5 text-gray-500">{c.city || '—'}</td>
                      <td className="p-2.5 text-gray-500">{c.customer_type || 'Customer'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. TEMPLATES TAB */}
      {activeTab === 'templates' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-xs p-4 space-y-3">
          <div className="flex items-center justify-between border-b pb-3 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-gray-800 uppercase">Template Filter:</span>
              <div className="inline-flex rounded border border-gray-200 bg-slate-100 p-0.5 text-xs font-semibold">
                <button
                  onClick={() => setTemplateTypeFilter('all')}
                  className={`px-2.5 py-1 rounded transition ${templateTypeFilter === 'all' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500'}`}
                >
                  All ({templates.length})
                </button>
                <button
                  onClick={() => setTemplateTypeFilter('email')}
                  className={`px-2.5 py-1 rounded transition ${templateTypeFilter === 'email' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500'}`}
                >
                  Email ({templates.filter(t => t.type === 'email').length})
                </button>
                <button
                  onClick={() => setTemplateTypeFilter('whatsapp')}
                  className={`px-2.5 py-1 rounded transition ${templateTypeFilter === 'whatsapp' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500'}`}
                >
                  WhatsApp ({templates.filter(t => t.type === 'whatsapp').length})
                </button>
              </div>
            </div>

            <button
              onClick={() => setShowNewTemplateModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create Template</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {templates
              .filter(t => templateTypeFilter === 'all' || t.type === templateTypeFilter)
              .map(t => (
                <div key={t.id} className="border border-gray-200 rounded-lg p-3.5 space-y-2 hover:border-blue-300 transition bg-white shadow-2xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-gray-900">{t.name}</span>
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                        t.type === 'email' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      }`}
                    >
                      {t.type}
                    </span>
                  </div>

                  {t.subject && (
                    <div className="text-[11px] text-gray-600 font-medium">
                      Subject: {t.subject}
                    </div>
                  )}

                  <div className="text-xs text-gray-700 whitespace-pre-wrap line-clamp-4 bg-slate-50 p-2 rounded border border-gray-100 font-sans">
                    {t.body}
                  </div>

                  <div className="pt-1 flex items-center justify-between text-[10px] text-gray-400">
                    <span>Category: {t.category}</span>
                    <button
                      onClick={() => {
                        if (t.type === 'email') {
                          handleSubTabChange('email');
                        } else {
                          setWaMessageTemplate(t.body);
                          handleSubTabChange('whatsapp');
                        }
                      }}
                      className="text-blue-600 font-semibold hover:underline"
                    >
                      Use in Campaign →
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* 5. CAMPAIGN HISTORY TAB */}
      {activeTab === 'history' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-lg border border-slate-200 max-w-xs">
            <button
              onClick={() => setHistoryChannel('whatsapp')}
              className={`flex-1 px-3 py-1 rounded-md text-xs font-bold transition ${
                historyChannel === 'whatsapp'
                  ? 'bg-white text-emerald-800 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              WhatsApp Campaigns
            </button>
            <button
              onClick={() => setHistoryChannel('email')}
              className={`flex-1 px-3 py-1 rounded-md text-xs font-bold transition ${
                historyChannel === 'email'
                  ? 'bg-white text-blue-800 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Email Campaigns
            </button>
          </div>

          {historyChannel === 'whatsapp' ? (
            <WhatsAppCampaignDeliveryReport initialCampaignId={activeDeliveryCampaignId} />
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-xs">
              <DeliveryLog />
            </div>
          )}
        </div>
      )}

      {/* Permission Recording Modal */}
      <PermissionRecordingModal
        isOpen={permissionModalOpen}
        onClose={() => {
          setPermissionModalOpen(false);
          setPermissionTarget(null);
        }}
        target={permissionTarget}
        onSaved={loadContacts}
      />

      {/* New Template Modal */}
      {showNewTemplateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-4 space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="text-sm font-bold text-gray-900">Create Campaign Template</h3>
              <button onClick={() => setShowNewTemplateModal(false)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveTemplate} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-bold text-gray-700 uppercase block mb-1">Template Type</label>
                  <select
                    value={newTemplateType}
                    onChange={e => setNewTemplateType(e.target.value as any)}
                    className="w-full border border-gray-300 rounded p-1.5 bg-white"
                  >
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                  </select>
                </div>

                <div>
                  <label className="font-bold text-gray-700 uppercase block mb-1">Category</label>
                  <input
                    type="text"
                    value={newTemplateCategory}
                    onChange={e => setNewTemplateCategory(e.target.value)}
                    placeholder="e.g. Promotion, Follow-up"
                    className="w-full border border-gray-300 rounded p-1.5"
                  />
                </div>
              </div>

              <div>
                <label className="font-bold text-gray-700 uppercase block mb-1">Template Name</label>
                <input
                  type="text"
                  value={newTemplateName}
                  onChange={e => setNewTemplateName(e.target.value)}
                  placeholder="e.g. Q4 Ready Stock Announcement"
                  className="w-full border border-gray-300 rounded p-1.5"
                  required
                />
              </div>

              {newTemplateType === 'email' && (
                <div>
                  <label className="font-bold text-gray-700 uppercase block mb-1">Email Subject</label>
                  <input
                    type="text"
                    value={newTemplateSubject}
                    onChange={e => setNewTemplateSubject(e.target.value)}
                    placeholder="e.g. Ready Stock Pharma API Jakarta Warehouse"
                    className="w-full border border-gray-300 rounded p-1.5"
                  />
                </div>
              )}

              <div>
                <label className="font-bold text-gray-700 uppercase block mb-1">Message Body</label>
                <textarea
                  rows={6}
                  value={newTemplateBody}
                  onChange={e => setNewTemplateBody(e.target.value)}
                  placeholder="Write message template with {{contact_person}} and {{company_name}}..."
                  className="w-full border border-gray-300 rounded p-2 font-sans"
                  required
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowNewTemplateModal(false)}
                  className="px-3 py-1.5 border rounded text-gray-600 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTemplate}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-semibold disabled:opacity-50"
                >
                  {savingTemplate ? 'Saving...' : 'Save Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Interactive Contact Phone Audit & Correction Centre Modal */}
      {phoneAuditCategory !== null && (
        <PhoneAuditCorrectionModal
          isOpen={phoneAuditCategory !== null}
          onClose={() => setPhoneAuditCategory(null)}
          initialCategory={phoneAuditCategory}
          contacts={contacts}
          phoneAudit={phoneAudit}
          onContactUpdated={handleContactUpdated}
          onContactsBatchUpdated={handleContactsBatchUpdated}
        />
      )}

      {/* WhatsApp Attachment Modal (Document Bank & File Upload) */}
      <WhatsAppAttachmentModal
        isOpen={isAttachmentModalOpen}
        onClose={() => setIsAttachmentModalOpen(false)}
        currentAttachment={waAttachment}
        onSelectAttachment={(att) => setWaAttachment(att)}
      />
    </div>
  );
}

export default CrmCampaignsWorkspace;
