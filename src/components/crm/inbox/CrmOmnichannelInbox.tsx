import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { supabase } from '../../../lib/supabase';
import { EnquiryWhatsAppService } from '../../../services/enquiry/EnquiryWhatsAppService';
import { extractInquiryFromEmail } from '../../../utils/emailInquiryExtractor';
import { showToast } from '../../ToastNotification';
import { getSignedUrlCached } from '../../../utils/signedUrlCache';
import {
  Inbox,
  Mail,
  MessageSquare,
  Search,
  RefreshCw,
  Send,
  Paperclip,
  CheckCircle2,
  AlertTriangle,
  User,
  ArrowRight,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  FileText,
  Download,
  Eye,
  Sparkles,
  Link as LinkIcon,
  Tag,
  Clock,
  Check,
  X,
  Languages,
  Globe,
  Bot,
  Zap,
  Building,
  Phone,
  Calendar,
  CheckSquare,
  CornerDownLeft,
} from 'lucide-react';
import { analyzeWhatsAppMessage } from '../../../services/crm/whatsappIntelligenceService';
import { WhatsAppConversationList } from './WhatsAppConversationList';
import { WhatsAppChatArea } from './WhatsAppChatArea';
import { WhatsAppCustomerContextPanel } from './WhatsAppCustomerContextPanel';
import {
  SendQuotationModal,
  SendDocumentModal,
  StockCheckModal,
  CreateFollowUpModal,
  CustomerDisambiguationDialog,
} from './QuickActionModals';
import { PhoneMatchingService, PhoneMatchCandidate } from '../../../services/crm/phoneMatchingService';
import { ProductDocumentItem } from '../../../services/crm/erpCommunicationsService';

export type ChannelFilter = 'all' | 'email' | 'whatsapp' | 'unlinked';
export type ActiveMailbox = 'sales@avira.co.id' | 'kunal@avira.co.id';
export type FolderFilter = 'inbox' | 'sent';

export interface InboxConversation {
  id: string;
  channel: 'email' | 'whatsapp';
  senderName: string;
  senderAddress: string;
  recipientAddress?: string;
  subject: string;
  snippet: string;
  timestamp: string;
  unread: boolean;
  needsAction: boolean;
  actionReason?: string;
  inquiryId?: string | null;
  inquiryNumber?: string | null;
  productName?: string | null;
  customerName?: string | null;
  customerId?: string | null;
  ownerName?: string | null;
  direction?: 'inbound' | 'outbound';
  mailboxAccount?: string;
  gmailMessageId?: string;
  gmailThreadId?: string;
  whatsAppConversationId?: string;
  language?: 'id' | 'en' | 'mixed';
  languageLabel?: string;
  intent?: string;
  topic?: string;
  latestSummary?: string;
  englishTranslation?: string;
  linkedContextType?: string;
  entities?: Record<string, any>;
  suggestedReply?: string;
}

export interface ThreadMessage {
  id: string;
  from: string;
  to?: string;
  cc?: string;
  date: string | null;
  subject?: string;
  body: string;
  bodyHtml?: string;
  snippet?: string;
  attachments?: Array<{
    filename: string;
    mimeType?: string;
    size?: number;
    attachmentId?: string;
    storagePath?: string | null;
    documentType?: string;
  }>;
  direction?: 'inbound' | 'outbound';
  language?: 'id' | 'en' | 'mixed';
  englishTranslation?: string;
  entities?: Record<string, any>;
  intent?: string;
  aiSummary?: string;
  aiProposal?: Record<string, any>;
}

interface Props {
  onOpenInquiry?: (inquiryId: string) => void;
  onOpenCustomer?: (customerId: string) => void;
  onCreateInquiryFromMessage?: (
    msg: { subject: string; body: string; fromEmail: string; fromName: string; id?: string },
    parsed?: any
  ) => void;
}

export function CrmOmnichannelInbox({
  onOpenInquiry,
  onOpenCustomer,
  onCreateInquiryFromMessage,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlChannel = searchParams.get('channel')?.toLowerCase();
  const initialChannel: ChannelFilter =
    urlChannel && ['all', 'email', 'whatsapp', 'unlinked'].includes(urlChannel)
      ? (urlChannel as ChannelFilter)
      : 'all';
  const urlConversationId = searchParams.get('conversationId');

  const [activeMailbox, setActiveMailbox] = useState<ActiveMailbox>('sales@avira.co.id');
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('inbox');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>(initialChannel);
  const [showTestThreads, setShowTestThreads] = useState(false);
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(urlConversationId);

  const handleSelectConversation = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      const newParams = new URLSearchParams(searchParams);
      if (id) {
        newParams.set('conversationId', id);
      } else {
        newParams.delete('conversationId');
      }
      setSearchParams(newParams, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const handleChannelFilterChange = useCallback(
    (filter: ChannelFilter) => {
      setChannelFilter(filter);
      const newParams = new URLSearchParams(searchParams);
      if (filter !== 'all') {
        newParams.set('channel', filter);
      } else {
        newParams.delete('channel');
      }
      setSearchParams(newParams, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Detail view state
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<Record<string, boolean>>({});
  const [showAiDetails, setShowAiDetails] = useState(false);

  // Reply states
  const [replyText, setReplyText] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  // Right column contextual details
  const [linkedInquiryDetail, setLinkedInquiryDetail] = useState<any>(null);
  const [customerDetail, setCustomerDetail] = useState<any>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [reschedulingFollowUp, setReschedulingFollowUp] = useState(false);

  // Link dialog states
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkTargetType, setLinkTargetType] = useState<'inquiry' | 'customer'>('inquiry');
  const [allInquiries, setAllInquiries] = useState<
    Array<{
      id: string;
      inquiry_number: string;
      company_name: string;
      product_name: string;
      customer_id?: string;
    }>
  >([]);
  const [allCustomers, setAllCustomers] = useState<Array<{ id: string; company_name: string }>>([]);
  const [selectedInquiryToLink, setSelectedInquiryToLink] = useState('');
  const [selectedCustomerToLink, setSelectedCustomerToLink] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  const [isExtractingAi, setIsExtractingAi] = useState(false);

  // WhatsApp Smart CRM & Communications state
  const [phoneMatch, setPhoneMatch] = useState<{
    matchType: 'exact_single' | 'ambiguous_multiple' | 'none';
    candidate: PhoneMatchCandidate | null;
    candidates: PhoneMatchCandidate[];
  }>({ matchType: 'none', candidate: null, candidates: [] });
  const [matchingPhone, setMatchingPhone] = useState(false);
  const [mobileContextDrawerOpen, setMobileContextDrawerOpen] = useState(false);
  const [companyInquiries, setCompanyInquiries] = useState<any[]>([]);
  const [waFilter, setWaFilter] = useState<'all' | 'unread' | 'assigned_me' | 'priority' | 'unassigned'>('all');

  // WhatsApp Quick Action Modals
  const [quotationModalOpen, setQuotationModalOpen] = useState(false);
  const [documentModalOpen, setDocumentModalOpen] = useState(false);
  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [followUpModalOpen, setFollowUpModalOpen] = useState(false);
  const [disambiguationModalOpen, setDisambiguationModalOpen] = useState(false);

  const handleExtractAndCreate = async (conv: InboxConversation) => {
    setIsExtractingAi(true);
    try {
      // Duplicate prevention: if already linked to an inquiry, open it instead of creating a duplicate
      if (conv.inquiryId) {
        showToast({
          type: 'info',
          title: 'Inquiry Already Exists',
          message: `This email is already linked to Inquiry #${conv.inquiryNumber || ''}.`,
        });
        onOpenInquiry?.(conv.inquiryId);
        return;
      }

      if (conv.gmailMessageId) {
        const { data: existingInq } = await supabase
          .from('crm_inquiries')
          .select('id, inquiry_number')
          .eq('source_email_id', conv.gmailMessageId)
          .limit(1)
          .maybeSingle();
        if (existingInq?.id) {
          showToast({
            type: 'info',
            title: 'Inquiry Already Exists',
            message: `This email was already converted to Inquiry #${existingInq.inquiry_number}.`,
          });
          onOpenInquiry?.(existingInq.id);
          return;
        }
      }

      // Ensure full message (body, bodyHtml, attachments, date) is loaded even if user clicked before thread finished
      let latestMsg = threadMessages[threadMessages.length - 1];
      if ((!latestMsg || (!latestMsg.bodyHtml && !latestMsg.body)) && conv.channel === 'email' && (conv.gmailThreadId || conv.gmailMessageId)) {
        const threadMailbox = conv.mailboxAccount || activeMailbox;
        const { data: msgData } = await supabase.functions.invoke('gmail-inbox-message', {
          body: {
            account: threadMailbox === 'kunal@avira.co.id' ? 'pricing' : 'crm',
            emailAddress: threadMailbox,
            threadId: conv.gmailThreadId,
            messageId: conv.gmailMessageId,
            includeThread: true,
          },
        });
        if (msgData?.success && Array.isArray(msgData.thread_messages) && msgData.thread_messages.length > 0) {
          const m = msgData.thread_messages[msgData.thread_messages.length - 1];
          latestMsg = {
            id: m.messageId,
            from: m.from,
            to: m.to,
            cc: m.cc,
            date: m.date,
            subject: m.subject,
            body: m.bodyText || m.body || m.snippet || '',
            bodyHtml: m.bodyHtml,
            snippet: m.snippet,
            attachments: m.attachments || [],
            direction: 'inbound',
          };
        }
      }

      const emailBody = latestMsg?.body || conv.snippet || '';
      const emailBodyHtml = latestMsg?.bodyHtml || null;
      const emailSubject = conv.subject || latestMsg?.subject || '';
      const fromEmail = conv.senderAddress || latestMsg?.from || '';
      const fromName = conv.senderName && conv.senderName !== 'Email Sender' ? conv.senderName : '';
      const receivedDate = latestMsg?.date || conv.timestamp || undefined;
      const attachments = latestMsg?.attachments || [];

      let parsedResult: any = null;
      try {
        const { data, error } = await supabase.functions.invoke('parse-pharma-email', {
          body: {
            emailSubject,
            emailBody,
            emailBodyHtml,
            fromEmail,
            fromName,
            receivedDate,
            attachments,
          },
        });
        if (!error && data) {
          parsedResult = data.data || data.fallbackData || data;
        }
      } catch (invokeErr) {
        console.warn('AI extraction invoke failed, using deterministic HTML/email extractor:', invokeErr);
      }

      // Deterministic HTML-aware fallback/enrichment so raw email body is NEVER dumped into Remarks
      const deterministic = extractInquiryFromEmail({
        emailSubject,
        emailBody,
        emailBodyHtml,
        fromEmail,
        fromName,
        receivedDate,
        attachments,
        knownCompanyName: conv.customerName,
      });

      if (!parsedResult || (!parsedResult.productName && (!Array.isArray(parsedResult.products) || parsedResult.products.length === 0))) {
        parsedResult = {
          ...deterministic,
          ...(parsedResult || {}),
          products: (Array.isArray(parsedResult?.products) && parsedResult.products.length > 0) ? parsedResult.products : deterministic.products,
          productName: parsedResult?.productName || deterministic.productName,
          quantity: parsedResult?.quantity || deterministic.quantity,
          supplierName: parsedResult?.supplierName || deterministic.supplierName,
          supplierCountry: parsedResult?.supplierCountry || deterministic.supplierCountry,
          companyName: parsedResult?.companyName || deterministic.companyName,
          contactPerson: parsedResult?.contactPerson || deterministic.contactPerson,
          deliveryDateExpected: parsedResult?.deliveryDateExpected || deterministic.deliveryDateExpected,
          remarks: parsedResult?.remarks ?? deterministic.remarks,
          missingFields: deterministic.missingFields,
          uncertainFields: deterministic.uncertainFields,
        };
      } else {
        parsedResult = {
          ...parsedResult,
          companyName: parsedResult.companyName || deterministic.companyName,
          contactPerson: parsedResult.contactPerson || deterministic.contactPerson,
          deliveryDateExpected: parsedResult.deliveryDateExpected || deterministic.deliveryDateExpected,
          missingFields: deterministic.missingFields,
          uncertainFields: deterministic.uncertainFields,
        };
      }

      if (onCreateInquiryFromMessage) {
        onCreateInquiryFromMessage(
          {
            subject: emailSubject,
            body: emailBody,
            fromEmail,
            fromName,
            id: conv.gmailMessageId || conv.id,
          },
          parsedResult
        );
      }
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Extraction Error',
        message: err.message || 'Failed to extract inquiry details.',
      });
    } finally {
      setIsExtractingAi(false);
    }
  };

  // Load conversations list
  const loadConversations = async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const items: InboxConversation[] = [];

      // 1. Fetch Email conversations from Gmail API via edge function based on activeMailbox & folder
      try {
        const gmailQuery = folderFilter === 'sent' ? 'in:sent' : 'in:inbox';
        const { data: gmailData, error: gmailError } = await supabase.functions.invoke(
          'gmail-inbox-list',
          {
            body: {
              account: activeMailbox === 'kunal@avira.co.id' ? 'pricing' : 'crm',
              emailAddress: activeMailbox,
              query: gmailQuery,
              maxResults: 40,
            },
          }
        );

        if (!gmailError && gmailData?.success && Array.isArray(gmailData.messages)) {
          const messageIds = gmailData.messages.map((m: any) => m.messageId).filter(Boolean);
          const { data: linkedReviews } = await supabase
            .from('kunal_ai_email_reviews')
            .select(
              'gmail_message_id, matched_inquiry_id, crm_inquiries:matched_inquiry_id(id, inquiry_number, product_name, company_name, customer_id)'
            )
            .in('gmail_message_id', messageIds);

          const linkMap = new Map();
          (linkedReviews || []).forEach((r: any) => {
            if (r.gmail_message_id && r.crm_inquiries) {
              linkMap.set(r.gmail_message_id, r.crm_inquiries);
            }
          });

          for (const m of gmailData.messages) {
            const inq = linkMap.get(m.messageId);
            items.push({
              id: `email-${m.messageId || m.threadId}`,
              channel: 'email',
              direction: folderFilter === 'sent' ? 'outbound' : 'inbound',
              mailboxAccount: activeMailbox,
              senderName: m.fromName || m.fromEmail || '',
              senderAddress: m.fromEmail || '',
              recipientAddress: m.toEmail || '',
              subject: m.subject || '(No Subject)',
              snippet: m.snippet || '',
              timestamp: m.date || new Date().toISOString(),
              unread: m.isUnread ?? false,
              needsAction: false,
              inquiryId: inq ? inq.id : null,
              inquiryNumber: inq ? inq.inquiry_number : null,
              productName: inq ? inq.product_name : null,
              customerName: inq ? inq.company_name : null,
              customerId: inq ? inq.customer_id : null,
              gmailMessageId: m.messageId,
              gmailThreadId: m.threadId,
            });
          }
        }
      } catch (gErr) {
        console.warn('[CrmOmnichannelInbox] Gmail fetch notice:', gErr);
      }

      // 2. Fetch WhatsApp & Canonical ERP conversations from enquiry_conversations
      try {
        const { data: dbConversations, error: convError } = await supabase
          .from('enquiry_conversations')
          .select(
            `
            id,
            channel,
            title,
            external_thread_id,
            status,
            customer_id,
            last_message_at,
            created_at,
            metadata,
            participant_identifiers,
            customers:customer_id (
              id,
              company_name
            ),
            enquiry_conversation_links (
              inquiry_id,
              is_active,
              crm_inquiries:inquiry_id (
                id,
                inquiry_number,
                product_name,
                company_name
              )
            ),
            enquiry_conversation_messages (
              id,
              sender_name,
              sender_address,
              recipient_addresses,
              subject,
              body_text,
              direction,
              received_or_sent_at,
              external_message_id,
              raw_payload,
              ai_proposal,
              ai_summary
            )
          `
          )
          .order('last_message_at', { ascending: false })
          .limit(60);

        if (!convError && dbConversations) {
          for (const c of dbConversations) {
            const msgs = (c.enquiry_conversation_messages || []).sort(
              (a: any, b: any) =>
                new Date(a.received_or_sent_at).getTime() -
                new Date(b.received_or_sent_at).getTime()
            );
            const lastMsg = msgs[msgs.length - 1];

            const activeLinks = (c.enquiry_conversation_links || []).filter(
              (l: any) => l.is_active
            );
            const link = activeLinks[0];
            const inq: any = Array.isArray(link?.crm_inquiries)
              ? link?.crm_inquiries[0]
              : link?.crm_inquiries;
            const cust: any = Array.isArray(c.customers) ? c.customers[0] : c.customers;

            const meta = c.metadata || {};
            const intel = lastMsg?.ai_proposal || meta.intelligence || null;

            const language = meta.language || intel?.language || 'id';
            const intent = meta.intent || intel?.intent || 'General Information';
            const topic = meta.topic || intel?.topic || c.title || 'WhatsApp Conversation';
            const needsAction = meta.needs_action ?? intel?.needs_action ?? false;
            const actionRequired = meta.action_required || intel?.action_required || null;
            const latestSummary =
              meta.latest_summary || intel?.running_summary || lastMsg?.ai_summary || null;
            const englishTranslation =
              meta.english_translation || intel?.english_translation || null;
            const linkedContextType = inq
              ? 'Inquiry'
              : cust
                ? 'Customer'
                : meta.linked_context_type || intel?.linked_context_type || 'Unlinked';
            const customerName = inq?.company_name || cust?.company_name || null;
            const suggestedReply = meta.suggested_reply || intel?.suggested_reply || null;

            const isOutbound =
              lastMsg?.direction === 'outbound' ||
              ['sales@avira.co.id', 'sales@sapharmajaya.co.id', 'kunal@avira.co.id'].some(
                (internal) => (lastMsg?.sender_address || '').toLowerCase().includes(internal)
              );
            const recipAddr = Array.isArray(lastMsg?.recipient_addresses)
              ? lastMsg.recipient_addresses[0]
              : lastMsg?.recipient_addresses || '';
            const extMsgId =
              lastMsg?.external_message_id || meta.gmail_message_id || meta.message_id || null;
            const extThreadId = meta.gmail_thread_id || meta.thread_id || extMsgId || null;

            const allParticipants = [
              lastMsg?.sender_address,
              recipAddr,
              ...(c.participant_identifiers || []),
            ]
              .filter(Boolean)
              .map((s: string) => s.toLowerCase());
            const canonicalMailbox = allParticipants.some((p: string) =>
              p.includes('kunal@avira.co.id')
            )
              ? 'kunal@avira.co.id'
              : 'sales@avira.co.id';

            items.push({
              id: `wa-${c.id}`,
              channel: c.channel === 'whatsapp' ? 'whatsapp' : 'email',
              direction: isOutbound ? 'outbound' : 'inbound',
              mailboxAccount: canonicalMailbox,
              senderName: isOutbound
                ? recipAddr || customerName || c.title || 'Contact'
                : customerName || lastMsg?.sender_name || c.title || 'WhatsApp Customer',
              senderAddress: lastMsg?.sender_address || '',
              recipientAddress: recipAddr,
              subject: topic,
              snippet: latestSummary || lastMsg?.body_text || '(No messages)',
              timestamp:
                c.last_message_at || lastMsg?.received_or_sent_at || new Date().toISOString(),
              unread: false,
              needsAction,
              actionReason: actionRequired || undefined,
              inquiryId: link?.inquiry_id || null,
              inquiryNumber: inq?.inquiry_number || null,
              productName: inq?.product_name || intel?.entities?.product || null,
              customerName,
              customerId: c.customer_id || null,
              whatsAppConversationId: c.id,
              gmailMessageId: extMsgId,
              gmailThreadId: extThreadId,
              language,
              languageLabel:
                language === 'id' ? 'Indonesian' : language === 'en' ? 'English' : 'Mixed ID/EN',
              intent,
              topic,
              latestSummary,
              englishTranslation,
              linkedContextType,
              entities: intel?.entities || meta.entities || undefined,
              suggestedReply,
            });
          }
        }
      } catch (wErr) {
        console.warn('[CrmOmnichannelInbox] WhatsApp fetch warning:', wErr);
      }

      // Sort by newest timestamp
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setConversations(items);

      if (items.length > 0) {
        const found = urlConversationId
          ? items.find(
              (i) =>
                i.id === urlConversationId ||
                i.id === `wa-${urlConversationId}` ||
                i.whatsAppConversationId === urlConversationId
            )
          : null;

        if (found) {
          setSelectedId(found.id);
        } else if (!selectedId || !items.some((i) => i.id === selectedId)) {
          const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
          if (!isMobile) {
            handleSelectConversation(items[0].id);
          }
        }
      }
    } catch (err: any) {
      console.error('[CrmOmnichannelInbox] Load error:', err);
      setListError(err.message || 'Failed to load conversations');
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    loadConversations();
  }, [activeMailbox, folderFilter]);

  // Pre-fetch inquiry and customer list for quick linking
  useEffect(() => {
    supabase
      .from('crm_inquiries')
      .select('id, inquiry_number, company_name, product_name, customer_id')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        if (data) setAllInquiries(data);
      });

    supabase
      .from('customers')
      .select('id, company_name')
      .order('company_name', { ascending: true })
      .limit(200)
      .then(({ data }) => {
        if (data) setAllCustomers(data);
      });
  }, []);

  // Filter conversations
  const isTestConversation = (c: InboxConversation) => {
    const sub = (c.subject || '').toLowerCase();
    const snd = (c.senderName || '').toLowerCase();
    const snp = (c.snippet || '').toLowerCase();
    return (
      sub.includes('test') ||
      snd.includes('test') ||
      snp.includes('test auto analysis') ||
      snp.includes('draft test')
    );
  };

  const testThreadsCount = useMemo(() => {
    return conversations.filter(isTestConversation).length;
  }, [conversations]);

  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      if (!showTestThreads && isTestConversation(c)) {
        return false;
      }

      if (c.mailboxAccount && c.mailboxAccount.toLowerCase() !== activeMailbox.toLowerCase()) {
        return false;
      }

      if (c.channel === 'email') {
        if (folderFilter === 'inbox' && c.direction === 'outbound') return false;
        if (folderFilter === 'sent' && c.direction !== 'outbound') return false;
      }

      if (channelFilter === 'email' && c.channel !== 'email') return false;
      if (channelFilter === 'whatsapp' && c.channel !== 'whatsapp') return false;
      if (channelFilter === 'unlinked' && c.inquiryId) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesText =
          c.senderName.toLowerCase().includes(q) ||
          c.senderAddress.toLowerCase().includes(q) ||
          c.subject.toLowerCase().includes(q) ||
          c.snippet.toLowerCase().includes(q) ||
          (c.inquiryNumber && c.inquiryNumber.toLowerCase().includes(q)) ||
          (c.productName && c.productName.toLowerCase().includes(q)) ||
          (c.customerName && c.customerName.toLowerCase().includes(q));
        if (!matchesText) return false;
      }

      return true;
    });
  }, [conversations, activeMailbox, folderFilter, channelFilter, searchQuery, showTestThreads]);

  const selectedConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedId) || null;
  }, [conversations, selectedId]);

  // Load contextual details for Column 3 (Customer 360 & Linked Inquiry)
  useEffect(() => {
    if (!selectedConversation) {
      setLinkedInquiryDetail(null);
      setCustomerDetail(null);
      return;
    }

    let isCancelled = false;
    setLoadingContext(true);

    const fetchContextData = async () => {
      try {
        // 1. Fetch linked inquiry if inquiryId is available
        if (selectedConversation.inquiryId) {
          const { data: inq } = await supabase
            .from('crm_inquiries')
            .select(
              `
              *,
              user_profiles:assigned_to (
                full_name
              )
            `
            )
            .eq('id', selectedConversation.inquiryId)
            .maybeSingle();

          if (!isCancelled) setLinkedInquiryDetail(inq);
        } else {
          if (!isCancelled) setLinkedInquiryDetail(null);
        }

        // 2. Fetch customer details
        let cust: any = null;
        if (selectedConversation.customerId) {
          const { data } = await supabase
            .from('crm_contacts')
            .select('*')
            .eq('id', selectedConversation.customerId)
            .maybeSingle();
          cust = data;
        }

        if (!cust && selectedConversation.customerName) {
          const { data } = await supabase
            .from('crm_contacts')
            .select('*')
            .eq('is_active', true)
            .ilike('company_name', selectedConversation.customerName.trim())
            .maybeSingle();
          cust = data;
        }

        if (!isCancelled) setCustomerDetail(cust);
      } catch (err) {
        console.warn('Error loading contextual sidebar details:', err);
      } finally {
        if (!isCancelled) setLoadingContext(false);
      }
    };

    fetchContextData();
    return () => {
      isCancelled = true;
    };
  }, [selectedConversation]);

  // Match phone number across ERP tables when WhatsApp conversation is selected
  useEffect(() => {
    if (!selectedConversation || selectedConversation.channel !== 'whatsapp') {
      setPhoneMatch({ matchType: 'none', candidate: null, candidates: [] });
      setCompanyInquiries([]);
      return;
    }

    const phone =
      selectedConversation.senderAddress || selectedConversation.recipientAddress || '';
    if (!phone) {
      setPhoneMatch({ matchType: 'none', candidate: null, candidates: [] });
      setCompanyInquiries([]);
      return;
    }

    let isCurrent = true;
    setMatchingPhone(true);
    PhoneMatchingService.matchPhoneNumber(phone)
      .then(async (res) => {
        if (!isCurrent) return;
        const matchedCand =
          res.matchType === 'exact_single' ? res.candidates[0] || null : null;
        setPhoneMatch({
          matchType: res.matchType,
          candidate: matchedCand,
          candidates: res.candidates,
        });

        if (matchedCand?.companyName) {
          const inqs = await PhoneMatchingService.getCompanyInquiries(
            matchedCand.companyName,
            matchedCand.customerId || undefined
          );
          if (isCurrent) setCompanyInquiries(inqs);
        } else {
          if (isCurrent) setCompanyInquiries([]);
        }
      })
      .finally(() => {
        if (isCurrent) setMatchingPhone(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [selectedConversation]);

  // Quick Reschedule Follow-up in Column 3
  const handleRescheduleFollowUp = async (daysToAdd: number) => {
    if (!linkedInquiryDetail?.id) return;
    setReschedulingFollowUp(true);
    try {
      const d = new Date();
      d.setDate(d.getDate() + daysToAdd);
      const iso = d.toISOString().split('T')[0];
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ next_follow_up: iso })
        .eq('id', linkedInquiryDetail.id);

      if (error) throw error;
      setLinkedInquiryDetail((prev: any) => ({ ...prev, next_follow_up: iso }));
      showToast({
        type: 'success',
        title: 'Follow-up Scheduled',
        message: `Rescheduled to ${iso}`,
      });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Update Failed', message: err.message });
    } finally {
      setReschedulingFollowUp(false);
    }
  };

  // Load selected conversation thread
  const loadThread = useCallback(async () => {
    if (!selectedConversation) {
      setThreadMessages([]);
      return;
    }

    setLoadingDetail(true);
    setDetailError(null);
    setReplyText('');
    setReplySubject(
      selectedConversation.subject.startsWith('Re:')
        ? selectedConversation.subject
        : `Re: ${selectedConversation.subject}`
    );

    try {
      if (selectedConversation.channel === 'email') {
        let fetchedMsgs: ThreadMessage[] = [];
        let fetchError: string | null = null;

        if (selectedConversation.gmailThreadId || selectedConversation.gmailMessageId) {
          try {
            const threadMailbox = selectedConversation.mailboxAccount || activeMailbox;
            const { data, error } = await supabase.functions.invoke('gmail-inbox-message', {
              body: {
                account: threadMailbox === 'kunal@avira.co.id' ? 'pricing' : 'crm',
                emailAddress: threadMailbox,
                threadId: selectedConversation.gmailThreadId,
                messageId: selectedConversation.gmailMessageId,
                includeThread: true,
              },
            });

            if (error) {
              let errMsg = error.message;
              if ('context' in error && error.context) {
                try {
                  const errBody = await (error.context as Response).clone().json();
                  errMsg = errBody?.error || errBody?.code || errMsg;
                } catch {
                  /* ignore */
                }
              }
              fetchError = errMsg;
            } else if (!data?.success) {
              fetchError = data?.error || data?.code || 'Gmail message not found';
            } else if (Array.isArray(data.thread_messages) && data.thread_messages.length > 0) {
              fetchedMsgs = data.thread_messages.map((m: any) => ({
                id: m.messageId,
                from: m.from,
                to: m.to,
                cc: m.cc,
                date: m.date,
                subject: m.subject,
                body: m.bodyText || m.body || m.snippet || '(No body text)',
                bodyHtml: m.bodyHtml,
                snippet: m.snippet,
                attachments: m.attachments || [],
                direction: [
                  'sales@avira.co.id',
                  'sales@sapharmajaya.co.id',
                  'kunal@avira.co.id',
                ].some((internal) => (m.from || '').toLowerCase().includes(internal))
                  ? 'outbound'
                  : 'inbound',
              }));
            }
          } catch (invokeErr: any) {
            fetchError = invokeErr.message || 'Error connecting to Gmail service';
          }
        }

        if (fetchedMsgs.length === 0) {
          if (selectedConversation.whatsAppConversationId) {
            const { data: convMsgs } = await supabase
              .from('enquiry_conversation_messages')
              .select('*')
              .eq('conversation_id', selectedConversation.whatsAppConversationId)
              .order('received_or_sent_at', { ascending: true });

            if (Array.isArray(convMsgs) && convMsgs.length > 0) {
              fetchedMsgs = convMsgs.map((m: any) => ({
                id: m.id,
                from: m.sender_name ? `${m.sender_name} <${m.sender_address}>` : m.sender_address,
                to: Array.isArray(m.recipient_addresses)
                  ? m.recipient_addresses.join(', ')
                  : m.recipient_addresses,
                date: m.received_or_sent_at,
                subject: m.subject || selectedConversation.subject,
                body: m.body_text || m.body_html || '(No body text)',
                bodyHtml: m.body_html,
                direction: m.direction || 'inbound',
                attachments: m.attachments || [],
              }));
            }
          }

          if (
            fetchedMsgs.length === 0 &&
            (selectedConversation.gmailThreadId || selectedConversation.gmailMessageId)
          ) {
            let q = supabase.from('crm_email_inbox').select('*');
            if (selectedConversation.gmailThreadId) {
              q = q.eq('thread_id', selectedConversation.gmailThreadId);
            } else {
              q = q.eq('message_id', selectedConversation.gmailMessageId);
            }
            const { data: inboxRows } = await q.order('received_date', { ascending: true });
            if (Array.isArray(inboxRows) && inboxRows.length > 0) {
              fetchedMsgs = inboxRows.map((r: any) => ({
                id: r.message_id || r.id,
                from: r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email,
                to: r.to_email,
                date: r.received_date,
                subject: r.subject,
                body: r.body || r.body_html || '(No body text)',
                bodyHtml: r.body_html,
                direction: [
                  'sales@avira.co.id',
                  'sales@sapharmajaya.co.id',
                  'kunal@avira.co.id',
                ].some((internal) => (r.from_email || '').toLowerCase().includes(internal))
                  ? 'outbound'
                  : 'inbound',
                attachments: [],
              }));
            }
          }
        }

        if (fetchedMsgs.length > 0) {
          setThreadMessages(fetchedMsgs);
          const exp: Record<string, boolean> = {};
          exp[fetchedMsgs[fetchedMsgs.length - 1].id] = true;
          setExpandedMsgIds(exp);
        } else {
          setThreadMessages([]);
          setDetailError(
            fetchError ||
              'Conversation messages could not be retrieved from Gmail or local records.'
          );
        }
      } else {
        // WhatsApp messages
        const { data: waMsgs, error: waError } = await supabase
          .from('enquiry_conversation_messages')
          .select('*')
          .eq('conversation_id', selectedConversation.whatsAppConversationId)
          .order('received_or_sent_at', { ascending: true });

        if (waError) throw waError;

        const msgs: ThreadMessage[] = (waMsgs || []).map((m: any) => {
          let intel = m.ai_proposal || null;
          if (!intel && m.body_text) {
            intel = analyzeWhatsAppMessage(m.body_text, {
              senderName: m.sender_name,
              senderPhone: m.sender_address,
              hasAttachments: m.attachments?.length > 0,
            });
          }

          return {
            id: m.id,
            from: m.sender_name || m.sender_address,
            to: m.recipient_addresses?.[0],
            date: m.received_or_sent_at,
            body: m.body_text || m.body_html || '(No text)',
            bodyHtml: m.body_html,
            direction: m.direction || 'inbound',
            attachments: m.attachments || [],
            language: intel?.language,
            englishTranslation: intel?.english_translation,
            entities: intel?.entities,
            intent: intel?.intent,
            aiSummary: intel?.running_summary || m.ai_summary,
            aiProposal: intel,
          };
        });

        setThreadMessages(msgs);

        const exp: Record<string, boolean> = {};
        if (msgs.length > 0) {
          exp[msgs[msgs.length - 1].id] = true;
        }
        setExpandedMsgIds(exp);
      }
    } catch (err: any) {
      console.error('[CrmOmnichannelInbox] Thread load error:', err);
      setDetailError(err.message || 'Could not load complete conversation thread');
    } finally {
      setLoadingDetail(false);
    }
  }, [selectedConversation, activeMailbox]);

  useEffect(() => {
    loadThread();
  }, [loadThread]);

  const getReplyRecipient = () => {
    if (!selectedConversation) return '';
    const isOutbound =
      selectedConversation.direction === 'outbound' ||
      ['sales@avira.co.id', 'sales@sapharmajaya.co.id', 'kunal@avira.co.id'].some((internal) =>
        (selectedConversation.senderAddress || '').toLowerCase().includes(internal)
      );
    if (isOutbound && selectedConversation.recipientAddress) {
      return selectedConversation.recipientAddress;
    }
    return selectedConversation.senderAddress || selectedConversation.recipientAddress || '';
  };

  const handleSendWhatsApp = async (
    text: string,
    documentUrl?: string,
    filename?: string,
    imageUrl?: string
  ) => {
    if (!selectedConversation) return;
    setSendingReply(true);
    try {
      const res = await EnquiryWhatsAppService.sendWhatsAppMessage({
        conversationId: selectedConversation.whatsAppConversationId || '',
        text: text.trim(),
        documentUrl,
        filename,
        imageUrl,
      });

      if (!res.success) {
        throw new Error(res.error || 'Failed to dispatch WhatsApp message');
      }

      showToast({
        type: 'success',
        title: 'WhatsApp Dispatched',
        message: res.isSimulation
          ? 'Simulated send in development mode'
          : 'Message sent successfully.',
      });
      setReplyText('');
      await loadThread();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'WhatsApp Error',
        message: err.message || 'Failed to send WhatsApp message',
      });
    } finally {
      setSendingReply(false);
    }
  };

  const handleSendReply = async () => {
    if (!selectedConversation || !replyText.trim()) return;
    if (selectedConversation.channel === 'whatsapp') {
      await handleSendWhatsApp(replyText.trim());
      return;
    }
    setSendingReply(true);
    try {
      const replyRecipient = getReplyRecipient();
        if (!replyRecipient) {
          throw new Error('No recipient email address found for this conversation');
        }
        const replySubj =
          replySubject ||
          (selectedConversation.subject.startsWith('Re:')
            ? selectedConversation.subject
            : `Re: ${selectedConversation.subject}`);
        const replySender = (selectedConversation.mailboxAccount || activeMailbox).toLowerCase();
        const isPricingReply = replySender.includes('kunal@avira.co.id');
        const resolvedSender = isPricingReply ? 'kunal@avira.co.id' : 'sales@avira.co.id';
        const senderMailboxParam = isPricingReply
          ? { requiredSenderEmail: 'kunal@avira.co.id' }
          : { requiredSenderEmail: 'sales@avira.co.id' };

        const { data: fnData, error: fnErr } = await supabase.functions.invoke('send-bulk-email', {
          body: {
            ...senderMailboxParam,
            senderEmail: resolvedSender,
            replyTo: resolvedSender,
            workflowType: isPricingReply ? 'pricing_sourcing' : 'crm_bulk_email',
            toEmails: [replyRecipient],
            subject: replySubj,
            body: replyText.trim().replace(/\n/g, '<br/>'),
            isHtml: true,
            threadId:
              selectedConversation.gmailThreadId ||
              selectedConversation.gmailMessageId ||
              undefined,
            inReplyTo: selectedConversation.gmailMessageId || undefined,
            references: selectedConversation.gmailMessageId || undefined,
            inquiryId: selectedConversation.inquiryId || undefined,
          },
        });

        if (fnErr || !fnData?.success) {
          throw new Error(fnData?.error || fnErr?.message || 'Failed to dispatch email reply');
        }

        showToast({
          type: 'success',
          title: 'Email Sent',
          message: `Reply sent from ${resolvedSender} to ${replyRecipient}`,
        });
        setReplyText('');
        loadThread();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Send Failed',
        message: err.message || 'Could not send message',
      });
    } finally {
      setSendingReply(false);
    }
  };

  // Link / Unlink Handlers
  const handleConfirmLink = async () => {
    if (!selectedConversation) return;
    setIsLinking(true);
    try {
      if (linkTargetType === 'inquiry') {
        if (!selectedInquiryToLink) throw new Error('Please select an inquiry to link');
        const inq = allInquiries.find((i) => i.id === selectedInquiryToLink);
        if (!inq) throw new Error('Selected inquiry not found');

        if (selectedConversation.gmailMessageId) {
          await supabase.from('crm_email_inbox').upsert(
            {
              message_id: selectedConversation.gmailMessageId,
              thread_id: selectedConversation.gmailThreadId || selectedConversation.gmailMessageId,
              from_email: selectedConversation.senderAddress,
              from_name: selectedConversation.senderName,
              to_email: selectedConversation.recipientAddress || '',
              subject: selectedConversation.subject,
              body: selectedConversation.snippet,
              received_date: selectedConversation.timestamp,
              is_processed: true,
              converted_to_inquiry: inq.id,
            },
            { onConflict: 'message_id' }
          );
        }

        if (selectedConversation.whatsAppConversationId) {
          const { data: existingLink } = await supabase
            .from('enquiry_conversation_links')
            .select('id')
            .eq('conversation_id', selectedConversation.whatsAppConversationId)
            .eq('inquiry_id', inq.id)
            .maybeSingle();

          if (existingLink) {
            await supabase
              .from('enquiry_conversation_links')
              .update({ is_active: true, link_type: 'primary' })
              .eq('id', existingLink.id);
          } else {
            await supabase.from('enquiry_conversation_links').insert({
              conversation_id: selectedConversation.whatsAppConversationId,
              inquiry_id: inq.id,
              link_type: 'primary',
              is_active: true,
            });
          }
        }

        setConversations((prev) =>
          prev.map((c) =>
            c.id === selectedConversation.id
              ? {
                  ...c,
                  inquiryId: inq.id,
                  inquiryNumber: inq.inquiry_number,
                  customerName: inq.company_name,
                  productName: inq.product_name,
                  customerId: inq.customer_id || c.customerId,
                  linkedContextType: 'Inquiry',
                }
              : c
          )
        );

        setShowLinkDialog(false);
        showToast({
          type: 'success',
          title: 'Inquiry Linked',
          message: `Linked to ${inq.inquiry_number}`,
        });
      } else {
        if (!selectedCustomerToLink) throw new Error('Please select a customer to link');
        const cust = allCustomers.find((c) => c.id === selectedCustomerToLink);
        if (!cust) throw new Error('Selected customer not found');

        if (selectedConversation.whatsAppConversationId) {
          await supabase
            .from('enquiry_conversations')
            .update({ customer_id: cust.id })
            .eq('id', selectedConversation.whatsAppConversationId);
        }

        setConversations((prev) =>
          prev.map((c) =>
            c.id === selectedConversation.id
              ? {
                  ...c,
                  customerId: cust.id,
                  customerName: cust.company_name,
                  linkedContextType: 'Customer',
                }
              : c
          )
        );

        setShowLinkDialog(false);
        showToast({
          type: 'success',
          title: 'Customer Linked',
          message: `Linked to ${cust.company_name}`,
        });
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Link Failed', message: err.message || 'Could not link' });
    } finally {
      setIsLinking(false);
    }
  };

  const handleUnlinkConversation = async () => {
    if (!selectedConversation) return;
    setIsLinking(true);
    try {
      if (selectedConversation.whatsAppConversationId) {
        await supabase
          .from('enquiry_conversation_links')
          .update({ is_active: false })
          .eq('conversation_id', selectedConversation.whatsAppConversationId);
      }

      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedConversation.id
            ? {
                ...c,
                inquiryId: null,
                inquiryNumber: null,
                productName: null,
                linkedContextType: 'General Communication',
              }
            : c
        )
      );

      setShowLinkDialog(false);
      showToast({
        type: 'info',
        title: 'Unlinked',
        message: 'Marked as General Communication.',
      });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Unlink Failed', message: err.message });
    } finally {
      setIsLinking(false);
    }
  };

  const handleOpenDoc = async (storagePath?: string | null) => {
    if (!storagePath) {
      showToast({
        type: 'warning',
        title: 'File Missing',
        message: 'Attachment file path not recorded in storage.',
      });
      return;
    }
    const url = await getSignedUrlCached('crm-documents', storagePath, 600);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] min-h-[640px] bg-white border border-gray-200 rounded-lg overflow-hidden shadow-xs">
      {/* Top Mailbox, Channel & Sync Bar */}
      <div className="border-b border-gray-200 bg-gray-50/80 px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Mailbox Selector */}
          <div className="flex items-center gap-1.5 border-r border-gray-200 pr-3">
            <span className="text-xs font-bold text-gray-700 uppercase tracking-wide flex items-center gap-1">
              <Mail className="w-3.5 h-3.5 text-blue-600" />
              Mailbox:
            </span>
            <select
              aria-label="Active Mailbox"
              value={activeMailbox}
              onChange={(e) => setActiveMailbox(e.target.value as ActiveMailbox)}
              className="text-xs font-semibold bg-white border border-gray-300 rounded px-2 py-1 text-gray-800 focus:outline-blue-500 max-w-[190px] sm:max-w-none truncate"
            >
              <option value="sales@avira.co.id">sales@avira.co.id (Commercial Sales)</option>
              <option value="kunal@avira.co.id">kunal@avira.co.id (Pricing & Sourcing)</option>
            </select>
          </div>

          {/* Folder Filter */}
          <div className="flex items-center gap-1 border-r border-gray-200 pr-3">
            <button
              onClick={() => setFolderFilter('inbox')}
              className={`px-2.5 py-1 text-xs font-semibold rounded transition ${
                folderFilter === 'inbox'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              Inbox
            </button>
            <button
              onClick={() => setFolderFilter('sent')}
              className={`px-2.5 py-1 text-xs font-semibold rounded transition ${
                folderFilter === 'sent'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              Sent
            </button>
          </div>

          {/* Channel Filter */}
          <div className="flex items-center gap-1 flex-wrap">
            {(
              [
                ['all', 'All Channels'],
                ['whatsapp', 'WhatsApp'],
                ['email', 'Email'],
                ['unlinked', 'Unlinked Only'],
              ] as const
            ).map(([key, label]) => {
              const isActive = channelFilter === key;
              return (
                <button
                  key={key}
                  onClick={() => handleChannelFilterChange(key)}
                  className={`px-2.5 py-1 text-xs font-semibold rounded transition ${
                    isActive
                      ? 'bg-slate-800 text-white shadow-2xs'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {label}
                </button>
              );
            })}

            {/* Diagnostic Test Threads Toggle */}
            <button
              onClick={() => setShowTestThreads(!showTestThreads)}
              className={`px-2.5 py-1 text-xs font-semibold rounded transition flex items-center gap-1 ml-2 ${
                showTestThreads
                  ? 'bg-amber-100 text-amber-900 border border-amber-300 shadow-2xs'
                  : 'text-gray-500 hover:bg-gray-100 border border-dashed border-gray-300'
              }`}
              title={showTestThreads ? 'Hide Diagnostic Test Threads' : 'Show Diagnostic Test Threads'}
            >
              <span>🧪 Test Threads ({testThreadsCount})</span>
            </button>
          </div>
        </div>

        {/* Sync Button */}
        <button
          onClick={loadConversations}
          disabled={loadingList}
          className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 rounded text-xs font-semibold shadow-2xs cursor-pointer transition"
          title="Refresh Messages"
        >
          <RefreshCw className={`w-3 h-3 ${loadingList ? 'animate-spin' : ''}`} />
          <span>Sync</span>
        </button>
      </div>

      {/* 3-COLUMN MASTER-DETAIL WORKSPACE */}
      <div className="flex-1 flex overflow-hidden">
        {/* COLUMN 1: Conversation List */}
        <div
          className={`${
            selectedId ? 'hidden md:flex' : 'flex'
          } w-full md:w-[340px] shrink-0 border-r border-gray-200 flex-col bg-white overflow-hidden`}
        >
          {channelFilter === 'whatsapp' ? (
            <WhatsAppConversationList
              conversations={conversations}
              selectedId={selectedId}
              onSelect={(id: string) => handleSelectConversation(id)}
              activeFilter={waFilter}
              onFilterChange={setWaFilter}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
            />
          ) : (
            <div className="w-full flex flex-col bg-white flex-1 overflow-hidden">
            {/* Search Box */}
            <div className="p-2 border-b border-gray-200 bg-gray-50/50">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-2.5" />
                <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search sender, subject, product..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-gray-200 rounded-md focus:outline-blue-500"
              />
            </div>
          </div>

          {/* List Items */}
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {loadingList && conversations.length === 0 && (
              <div className="p-8 text-center text-xs text-gray-500">
                <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-blue-600" />
                Loading communications...
              </div>
            )}

            {!loadingList && listError && (
              <div className="p-6 text-center text-xs bg-red-50/50 m-2 rounded-lg border border-red-200">
                <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
                <p className="font-semibold text-red-800 mb-1">Failed to load communications</p>
                <p className="text-red-600 mb-3">{listError}</p>
                <button
                  onClick={loadConversations}
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-600 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
                >
                  <RefreshCw className="w-3 h-3" /> Retry
                </button>
              </div>
            )}

            {!loadingList && !listError && filteredConversations.length === 0 && (
              <div className="p-8 text-center text-xs text-gray-500">
                No conversations found in this filter.
              </div>
            )}

            {filteredConversations.map((conv) => {
              const isSelected = conv.id === selectedId;
              const isEmail = conv.channel === 'email';

              return (
                <div
                  key={conv.id}
                  onClick={() => handleSelectConversation(conv.id)}
                  className={`p-3 text-xs cursor-pointer transition select-none flex flex-col gap-1 ${
                    isSelected
                      ? 'bg-blue-50/80 border-l-3 border-blue-600'
                      : 'hover:bg-gray-50 border-l-3 border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`p-1 rounded flex-shrink-0 ${
                          isEmail ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
                        }`}
                        title={isEmail ? 'Gmail' : 'WhatsApp'}
                      >
                        {isEmail ? (
                          <Mail className="w-3 h-3" />
                        ) : (
                          <MessageSquare className="w-3 h-3" />
                        )}
                      </span>
                      <span
                        className={`font-semibold truncate ${isSelected ? 'text-blue-950 font-bold' : 'text-gray-900'}`}
                      >
                        {conv.senderName}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      {conv.channel === 'whatsapp' && conv.language && (
                        <span className="text-[9px] font-bold px-1 py-0.2 rounded border bg-emerald-50 text-emerald-700 border-emerald-200">
                          {conv.language.toUpperCase()}
                        </span>
                      )}
                      <span className="text-[10px] text-gray-400 whitespace-nowrap">
                        {new Date(conv.timestamp).toLocaleDateString([], {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                  </div>

                  <div
                    className={`truncate text-[11px] ${isSelected ? 'text-gray-900 font-medium' : 'text-gray-700'}`}
                  >
                    {conv.subject}
                  </div>

                  <div className="text-[10.5px] text-gray-500 truncate font-sans">
                    {conv.snippet}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    {conv.inquiryNumber ? (
                      <span className="text-[9px] font-bold bg-blue-100 text-blue-800 border border-blue-200 px-1.5 py-0.2 rounded flex items-center gap-0.5">
                        <Tag className="w-2.5 h-2.5" />
                        {conv.inquiryNumber}
                      </span>
                    ) : (
                      <span className="text-[9px] font-semibold bg-amber-100 text-amber-800 border border-amber-200 px-1 py-0.2 rounded">
                        UNLINKED
                      </span>
                    )}

                    {conv.needsAction && (
                      <span className="text-[9px] font-bold bg-rose-50 text-rose-700 border border-rose-200 px-1.5 py-0.2 rounded">
                        ⚡ Action Required
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        )}
      </div>

        {/* COLUMN 2: Conversation Thread & Quick Reply (flex-1) */}
        <div
          className={`${
            !selectedId ? 'hidden md:flex' : 'flex'
          } flex-1 flex-col bg-white overflow-hidden min-w-0 border-r border-gray-200`}
        >
          {!selectedConversation ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400 p-8 text-center">
              <Inbox className="w-12 h-12 text-gray-200 mb-3" />
              <div className="font-semibold text-gray-600 text-sm">Select a Conversation</div>
              <p className="text-xs max-w-sm mt-1">
                Choose an email or WhatsApp thread from the left panel to review message history,
                attachments, and reply.
              </p>
            </div>
          ) : selectedConversation.channel === 'whatsapp' ? (
            <WhatsAppChatArea
              conversationTitle={
                phoneMatch.candidate?.companyName ||
                selectedConversation.customerName ||
                selectedConversation.senderName ||
                'WhatsApp Contact'
              }
              recipientPhone={
                selectedConversation.senderAddress || selectedConversation.recipientAddress || ''
              }
              isWhatsApp={true}
              messages={threadMessages}
              loading={loadingDetail}
              error={detailError}
              onSendMessage={(text, docUrl, fn) => handleSendWhatsApp(text, docUrl, fn)}
              onOpenQuotationModal={() => setQuotationModalOpen(true)}
              onOpenDocumentModal={() => setDocumentModalOpen(true)}
              onOpenStockModal={() => setStockModalOpen(true)}
              onOpenFollowUpModal={() => setFollowUpModalOpen(true)}
              onToggleContextPanel={() => setMobileContextDrawerOpen(!mobileContextDrawerOpen)}
              onBack={() => handleSelectConversation(null)}
              suggestedReply={selectedConversation.suggestedReply}
              detectedIntent={selectedConversation.intent}
            />
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Header Action Bar */}
              <div className="p-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-900 truncate">
                      {selectedConversation.subject}
                    </span>
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase ${
                        selectedConversation.channel === 'email'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      {selectedConversation.channel}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-600 flex items-center gap-2 mt-0.5">
                    <span>
                      From:{' '}
                      <strong className="text-gray-900">{selectedConversation.senderName}</strong> (
                      {selectedConversation.senderAddress})
                    </span>
                    {selectedConversation.customerName && (
                      <span>
                        • Customer:{' '}
                        <strong className="text-gray-900">
                          {selectedConversation.customerName}
                        </strong>
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {selectedConversation.inquiryId ? (
                    <button
                      onClick={() =>
                        onOpenInquiry && onOpenInquiry(selectedConversation.inquiryId!)
                      }
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded shadow-2xs flex items-center gap-1 cursor-pointer"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>Inquiry #{selectedConversation.inquiryNumber}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleExtractAndCreate(selectedConversation)}
                        disabled={isExtractingAi}
                        className="px-2.5 py-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-xs font-semibold rounded shadow-2xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                        title="Extract products, quantities, specifications using AI"
                      >
                        <Sparkles
                          className={`w-3.5 h-3.5 ${isExtractingAi ? 'animate-spin' : ''}`}
                        />
                        <span>AI Extract & Create</span>
                      </button>
                      <button
                        onClick={() => setShowLinkDialog(true)}
                        className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded shadow-2xs flex items-center gap-1 cursor-pointer"
                      >
                        <LinkIcon className="w-3 h-3" />
                        <span>Link</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Compact Collapsible AI Intelligence Pill */}
              {Boolean(selectedConversation.latestSummary || selectedConversation.intent) && (
                <div className="bg-emerald-50/70 border-b border-emerald-200 px-4 py-2 flex flex-col gap-1.5 transition">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowAiDetails(!showAiDetails)}
                        title="Universal Communication Intelligence"
                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-100 transition cursor-pointer"
                      >
                        <Bot className="w-3 h-3 text-emerald-600" />
                        <span>
                          AI Intelligence (
                          {selectedConversation.languageLabel ||
                            selectedConversation.language?.toUpperCase() ||
                            'ID'}
                          )
                        </span>
                        {showAiDetails ? (
                          <ChevronUp className="w-3 h-3" />
                        ) : (
                          <ChevronDown className="w-3 h-3" />
                        )}
                      </button>
                      {selectedConversation.intent && (
                        <span className="text-[10px] font-semibold text-emerald-900 bg-emerald-100/80 px-2 py-0.5 rounded border border-emerald-300">
                          {selectedConversation.intent}
                        </span>
                      )}
                    </div>

                    {selectedConversation.latestSummary && (
                      <span className="text-[11px] text-emerald-950 font-medium truncate max-w-sm italic">
                        "{selectedConversation.latestSummary}"
                      </span>
                    )}
                  </div>

                  {showAiDetails && (
                    <div className="pt-2 border-t border-emerald-200/60 space-y-2">
                      {selectedConversation.englishTranslation && (
                        <div className="bg-white p-2 rounded border border-emerald-200 text-xs text-slate-800">
                          <strong className="text-[10px] text-emerald-800 uppercase block mb-0.5">
                            English Translation:
                          </strong>
                          <p>{selectedConversation.englishTranslation}</p>
                        </div>
                      )}

                      {selectedConversation.entities && (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {Object.entries(selectedConversation.entities).map(([k, v]) => (
                            <span
                              key={k}
                              className="text-[10px] bg-white border border-emerald-200 text-emerald-900 px-2 py-0.5 rounded font-medium"
                            >
                              <strong>{k}:</strong> {String(v)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Message Thread Scrollable */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/40">
                {loadingDetail && (
                  <div className="p-12 text-center text-xs text-gray-500">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                    Loading conversation thread...
                  </div>
                )}

                {detailError && (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start justify-between gap-3">
                    <div>
                      <div className="font-bold mb-1">Thread Retrieval Notice</div>
                      <div>{detailError}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => loadThread()}
                      className="px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-800 rounded font-medium flex items-center gap-1 cursor-pointer flex-shrink-0"
                    >
                      <RefreshCw className="w-3 h-3" /> Retry
                    </button>
                  </div>
                )}

                {!loadingDetail && threadMessages.length === 0 && !detailError && (
                  <div className="p-8 text-center text-xs text-gray-500 bg-white border border-gray-200 rounded">
                    No messages recorded in this conversation.
                  </div>
                )}

                {threadMessages.map((msg, idx) => {
                  const isExpanded = Boolean(expandedMsgIds[msg.id]);
                  const isWhatsApp = selectedConversation.channel === 'whatsapp';
                  const isOutbound = msg.direction === 'outbound';

                  // Render WhatsApp styled bubbles
                  if (isWhatsApp) {
                    return (
                      <div
                        key={msg.id || idx}
                        className={`flex flex-col ${isOutbound ? 'items-end' : 'items-start'} max-w-full`}
                      >
                        <div
                          className={`rounded-lg p-3 text-xs shadow-2xs max-w-[85%] font-sans leading-relaxed ${
                            isOutbound
                              ? 'bg-[#d9fdd3] text-gray-900 rounded-tr-none'
                              : 'bg-white text-gray-900 border border-gray-200 rounded-tl-none'
                          }`}
                        >
                          <div className="font-semibold text-[10px] text-gray-500 mb-1">
                            {isOutbound ? 'SAPJ (+6285888600999)' : msg.from}
                          </div>

                          <div className="whitespace-pre-wrap selection:bg-emerald-100">
                            {msg.body}
                          </div>

                          {msg.englishTranslation && !isOutbound && (
                            <div className="mt-2 pt-1.5 border-t border-gray-200 text-[11px] text-slate-700 bg-slate-50 p-1.5 rounded">
                              <span className="text-[9px] uppercase font-bold text-slate-500 block">
                                English Translation:
                              </span>
                              {msg.englishTranslation}
                            </div>
                          )}

                          <div className="text-[9px] text-gray-400 text-right mt-1.5">
                            {msg.date
                              ? new Date(msg.date).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                              : ''}
                            {isOutbound && ' ✓✓'}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Render Email Cards
                  return (
                    <div
                      key={msg.id || idx}
                      className="border border-gray-200 rounded-lg bg-white shadow-2xs overflow-hidden"
                    >
                      <div
                        onClick={() =>
                          setExpandedMsgIds((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))
                        }
                        className="p-3 bg-gray-50/60 hover:bg-gray-50 flex items-center justify-between gap-3 cursor-pointer select-none"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-800 font-bold text-[10px] flex items-center justify-center flex-shrink-0">
                            {msg.from.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <span className="font-semibold text-xs text-gray-900 truncate block">
                              {msg.from}
                            </span>
                            {!isExpanded && (
                              <span className="text-[11px] text-gray-500 truncate block font-sans">
                                {msg.snippet || msg.body?.slice(0, 80)}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[10px] text-gray-400">
                            {msg.date
                              ? new Date(msg.date).toLocaleString([], {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                              : 'N/A'}
                          </span>
                          {isExpanded ? (
                            <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="p-3.5 border-t border-gray-100 space-y-3">
                          {msg.subject && (
                            <div className="text-xs font-bold text-gray-900">
                              Subject: {msg.subject}
                            </div>
                          )}

                          {msg.bodyHtml ? (
                            <div
                              className="text-xs leading-relaxed text-gray-800 font-sans selection:bg-blue-100 overflow-x-auto"
                              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(msg.bodyHtml) }}
                            />
                          ) : (
                            <div className="text-xs leading-relaxed text-gray-800 whitespace-pre-wrap font-sans selection:bg-blue-100">
                              {msg.body}
                            </div>
                          )}

                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className="pt-2 border-t border-gray-100 space-y-1.5">
                              <div className="text-[10px] font-bold text-gray-600 uppercase flex items-center gap-1">
                                <Paperclip className="w-3 h-3" />
                                <span>Attachments ({msg.attachments.length}):</span>
                              </div>
                              <div className="space-y-1">
                                {msg.attachments.map((att, aIdx) => (
                                  <div
                                    key={att.attachmentId || aIdx}
                                    className="bg-gray-50 border border-gray-200 rounded p-1.5 px-2 flex items-center justify-between gap-2"
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <FileText className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                                      <span
                                        className="text-xs font-medium text-gray-800 truncate"
                                        title={att.filename}
                                      >
                                        {att.filename}
                                      </span>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => handleOpenDoc(att.storagePath)}
                                      className="px-2 py-0.5 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 rounded text-[10px] flex items-center gap-1 cursor-pointer"
                                    >
                                      <Eye className="w-3 h-3" />
                                      <span>View</span>
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Bottom Quick Reply Composer */}
              <div className="p-3 border-t border-gray-200 bg-white space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <span className="font-semibold flex items-center gap-1.5 flex-wrap">
                    <Mail className="w-3.5 h-3.5 text-blue-600" />
                    <span>Reply via Email to {getReplyRecipient()}</span>
                    <span className="text-[10px] text-gray-500 font-mono bg-gray-50 px-1 py-0.2 rounded border border-gray-200">
                      Sending from: sales@avira.co.id
                    </span>
                  </span>
                </div>

                <textarea
                  rows={2}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      handleSendReply();
                    }
                  }}
                  placeholder={`Type your reply (Cmd+Enter to send)...`}
                  className="w-full text-xs p-2.5 border border-gray-300 rounded-md focus:outline-blue-500 font-sans"
                />

                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={handleSendReply}
                    disabled={sendingReply || !replyText.trim()}
                    className="px-3.5 py-1.5 text-white text-xs font-bold rounded shadow-2xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50 bg-blue-600 hover:bg-blue-700"
                  >
                    <Send className="w-3 h-3" />
                    <span>{sendingReply ? 'Sending...' : 'Send Reply'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* COLUMN 3: Context & Customer 360 (~320px) */}
        <div className="hidden lg:flex w-[320px] bg-slate-50/70 flex-col overflow-y-auto flex-shrink-0 p-3 space-y-3">
          {!selectedConversation ? (
            <div className="text-center text-gray-400 py-12 text-xs">
              Context & Customer 360 will appear here.
            </div>
          ) : selectedConversation.channel === 'whatsapp' ? (
            <WhatsAppCustomerContextPanel
              companyName={
                phoneMatch.candidate?.companyName ||
                customerDetail?.company_name ||
                selectedConversation.customerName
              }
              contactPerson={
                phoneMatch.candidate?.contactPerson ||
                customerDetail?.contact_person
              }
              phone={
                selectedConversation.senderAddress ||
                selectedConversation.recipientAddress ||
                ''
              }
              email={
                phoneMatch.candidate?.email ||
                customerDetail?.email
              }
              designation={phoneMatch.candidate?.designation}
              customerId={
                phoneMatch.candidate?.customerId ||
                customerDetail?.id ||
                selectedConversation.customerId
              }
              crmContactId={phoneMatch.candidate?.crmContactId}
              matchType={phoneMatch.matchType}
              candidates={phoneMatch.candidates}
              loadingMatch={matchingPhone}
              onDisambiguate={() => setDisambiguationModalOpen(true)}
              inquiries={companyInquiries}
              onOpenInquiry={(inqId: string) => onOpenInquiry?.(inqId)}
              onCreateInquiryPrefilled={() => {
                const phone =
                  selectedConversation.senderAddress || selectedConversation.recipientAddress || '';
                const prefill = PhoneMatchingService.buildInquiryPrefill(
                  phone,
                  phoneMatch.candidate
                    ? {
                        id: phoneMatch.candidate.customerId,
                        crmContactId: phoneMatch.candidate.crmContactId,
                        companyName: phoneMatch.candidate.companyName,
                        contactPerson: phoneMatch.candidate.contactPerson,
                        email: phoneMatch.candidate.email,
                      }
                    : null,
                  selectedConversation.snippet
                );
                if (onCreateInquiryFromMessage) {
                  onCreateInquiryFromMessage(
                    {
                      subject: prefill.product_name
                        ? `Inquiry for ${prefill.product_name}`
                        : 'WhatsApp Inquiry',
                      body: prefill.remarks || selectedConversation.snippet,
                      fromEmail: prefill.contact_email || '',
                      fromName: prefill.contact_person || selectedConversation.senderName,
                    },
                    prefill
                  );
                }
              }}
              onOpenQuotationModal={() => setQuotationModalOpen(true)}
              onOpenDocumentModal={() => setDocumentModalOpen(true)}
              onOpenStockModal={() => setStockModalOpen(true)}
              onOpenFollowUpModal={() => setFollowUpModalOpen(true)}
              ownerName={selectedConversation.ownerName}
            />
          ) : (
            <>
              {/* Customer 360 Profile Box */}
              <div className="bg-white rounded-lg border border-gray-200 p-3 shadow-2xs space-y-2">
                <div className="flex items-center justify-between border-b pb-1.5">
                  <span className="text-[11px] font-bold text-gray-800 uppercase flex items-center gap-1.5">
                    <Building className="w-3.5 h-3.5 text-blue-600" />
                    Customer 360
                  </span>
                  {customerDetail?.id && (
                    <button
                      onClick={() => onOpenCustomer?.(customerDetail.id)}
                      className="text-[11px] text-blue-600 font-semibold hover:underline flex items-center gap-0.5"
                    >
                      <span>View</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <div className="space-y-1 text-xs">
                  <div className="font-bold text-gray-900">
                    {customerDetail?.company_name ||
                      selectedConversation.customerName ||
                      selectedConversation.senderName}
                  </div>
                  {customerDetail?.contact_person && (
                    <div className="text-gray-600 flex items-center gap-1">
                      <User className="w-3 h-3 text-gray-400" />
                      <span>{customerDetail.contact_person}</span>
                    </div>
                  )}
                  {customerDetail?.phone && (
                    <div className="text-gray-600 flex items-center gap-1">
                      <Phone className="w-3 h-3 text-gray-400" />
                      <span>{customerDetail.phone}</span>
                    </div>
                  )}
                  {customerDetail?.city && (
                    <div className="text-gray-500 text-[11px]">
                      📍 {customerDetail.city}, {customerDetail.country || 'Indonesia'}
                    </div>
                  )}
                </div>
              </div>

              {/* Linked Inquiry Card */}
              <div className="bg-white rounded-lg border border-gray-200 p-3 shadow-2xs space-y-2">
                <div className="flex items-center justify-between border-b pb-1.5">
                  <span className="text-[11px] font-bold text-gray-800 uppercase flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-emerald-600" />
                    Linked Sourcing Inquiry
                  </span>
                  {selectedConversation.inquiryId && (
                    <button
                      onClick={() => onOpenInquiry?.(selectedConversation.inquiryId!)}
                      className="text-[11px] text-blue-600 font-semibold hover:underline"
                    >
                      Open
                    </button>
                  )}
                </div>

                {linkedInquiryDetail ? (
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-blue-900">
                        {linkedInquiryDetail.inquiry_number}
                      </span>
                      <span className="text-[10px] bg-blue-50 text-blue-800 px-1.5 py-0.2 rounded font-semibold border border-blue-200">
                        {linkedInquiryDetail.pipeline_status || linkedInquiryDetail.status || 'New'}
                      </span>
                    </div>

                    <div className="text-gray-900 font-semibold">
                      📦 {linkedInquiryDetail.product_name}
                    </div>

                    {linkedInquiryDetail.quantity && (
                      <div className="text-gray-600 text-[11px]">
                        Qty: <strong>{linkedInquiryDetail.quantity}</strong>
                      </div>
                    )}

                    {linkedInquiryDetail.offered_price && (
                      <div className="text-gray-600 text-[11px]">
                        Offered:{' '}
                        <strong>
                          {linkedInquiryDetail.offered_price_currency || 'IDR'}{' '}
                          {Number(linkedInquiryDetail.offered_price).toLocaleString()}
                        </strong>
                      </div>
                    )}

                    {linkedInquiryDetail.user_profiles?.full_name && (
                      <div className="text-gray-500 text-[11px]">
                        Owner: <strong>{linkedInquiryDetail.user_profiles.full_name}</strong>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 py-2">
                    <p className="mb-2">No inquiry linked to this conversation.</p>
                    <button
                      onClick={() => setShowLinkDialog(true)}
                      className="w-full py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-xs font-semibold transition"
                    >
                      + Link Existing Inquiry
                    </button>
                  </div>
                )}
              </div>

              {/* Follow-up Tracker & Reschedule Buttons */}
              {linkedInquiryDetail && (
                <div className="bg-white rounded-lg border border-gray-200 p-3 shadow-2xs space-y-2">
                  <div className="flex items-center justify-between border-b pb-1.5">
                    <span className="text-[11px] font-bold text-gray-800 uppercase flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-amber-600" />
                      Follow-up Tracker
                    </span>
                    {linkedInquiryDetail.next_follow_up && (
                      <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-50 text-amber-800 border border-amber-200">
                        {linkedInquiryDetail.next_follow_up}
                      </span>
                    )}
                  </div>

                  <div className="text-[11px] text-gray-600">
                    Quick reschedule customer follow-up:
                  </div>

                  <div className="grid grid-cols-3 gap-1 pt-1">
                    <button
                      onClick={() => handleRescheduleFollowUp(1)}
                      disabled={reschedulingFollowUp}
                      className="p-1.5 bg-slate-50 hover:bg-slate-100 border border-gray-200 rounded text-[10px] font-bold text-gray-700 transition"
                    >
                      +1 Day
                    </button>
                    <button
                      onClick={() => handleRescheduleFollowUp(3)}
                      disabled={reschedulingFollowUp}
                      className="p-1.5 bg-slate-50 hover:bg-slate-100 border border-gray-200 rounded text-[10px] font-bold text-gray-700 transition"
                    >
                      +3 Days
                    </button>
                    <button
                      onClick={() => handleRescheduleFollowUp(7)}
                      disabled={reschedulingFollowUp}
                      className="p-1.5 bg-slate-50 hover:bg-slate-100 border border-gray-200 rounded text-[10px] font-bold text-gray-700 transition"
                    >
                      +1 Week
                    </button>
                  </div>
                </div>
              )}

              {/* Pending Items Commercial Checklist */}
              {linkedInquiryDetail && (
                <div className="bg-white rounded-lg border border-gray-200 p-3 shadow-2xs space-y-2">
                  <span className="text-[11px] font-bold text-gray-800 uppercase flex items-center gap-1.5 border-b pb-1.5">
                    <CheckSquare className="w-3.5 h-3.5 text-purple-600" />
                    Commercial Checklist
                  </span>

                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">Price Quoted:</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${linkedInquiryDetail.price_quoted || linkedInquiryDetail.quote_sent_at ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {linkedInquiryDetail.price_quoted || linkedInquiryDetail.quote_sent_at
                          ? '✓ Sent'
                          : 'Pending'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">COA Document:</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${linkedInquiryDetail.coa_sent ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {linkedInquiryDetail.coa_sent ? '✓ Sent' : 'Pending'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">MSDS Document:</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${linkedInquiryDetail.msds_sent ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {linkedInquiryDetail.msds_sent ? '✓ Sent' : 'Pending'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">Sample:</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${linkedInquiryDetail.sample_sent ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {linkedInquiryDetail.sample_sent ? '✓ Sent' : 'Pending'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Link Dialog */}
      {showLinkDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="text-sm font-bold text-gray-900">Link Communication</h3>
              <button
                onClick={() => setShowLinkDialog(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex border-b border-gray-200">
              <button
                type="button"
                onClick={() => setLinkTargetType('inquiry')}
                className={`py-1.5 px-3 text-xs font-semibold border-b-2 transition ${
                  linkTargetType === 'inquiry'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Link to Inquiry
              </button>
              <button
                type="button"
                onClick={() => setLinkTargetType('customer')}
                className={`py-1.5 px-3 text-xs font-semibold border-b-2 transition ${
                  linkTargetType === 'customer'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Link to Customer
              </button>
            </div>

            {linkTargetType === 'inquiry' ? (
              <div className="space-y-2">
                <p className="text-xs text-gray-600">
                  Select an inquiry to link with <strong>{selectedConversation?.senderName}</strong>
                  :
                </p>
                <select
                  value={selectedInquiryToLink}
                  onChange={(e) => setSelectedInquiryToLink(e.target.value)}
                  className="w-full text-xs border border-gray-300 rounded p-2 bg-white"
                >
                  <option value="">Select an Inquiry ▼</option>
                  {allInquiries.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.inquiry_number} — {i.company_name} ({i.product_name})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-600">
                  Select a customer to associate with{' '}
                  <strong>{selectedConversation?.senderName}</strong>:
                </p>
                <select
                  value={selectedCustomerToLink}
                  onChange={(e) => setSelectedCustomerToLink(e.target.value)}
                  className="w-full text-xs border border-gray-300 rounded p-2 bg-white"
                >
                  <option value="">Select a Customer ▼</option>
                  {allCustomers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.company_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="pt-2 flex justify-between items-center gap-2 border-t">
              <button
                onClick={handleUnlinkConversation}
                disabled={isLinking}
                className="text-xs text-rose-600 hover:underline"
              >
                Set as General
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowLinkDialog(false)}
                  className="px-3 py-1.5 border rounded text-xs text-gray-600 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmLink}
                  disabled={
                    (linkTargetType === 'inquiry'
                      ? !selectedInquiryToLink
                      : !selectedCustomerToLink) || isLinking
                  }
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold disabled:opacity-50"
                >
                  {isLinking ? 'Linking...' : 'Confirm Link'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* WhatsApp Quick Action Modals */}
      {selectedConversation && selectedConversation.channel === 'whatsapp' && (
        <>
          <SendQuotationModal
            isOpen={quotationModalOpen}
            onClose={() => setQuotationModalOpen(false)}
            onSend={async (text, docUrl, fn) => {
              await handleSendWhatsApp(text, docUrl, fn);
            }}
            companyName={
              phoneMatch.candidate?.companyName ||
              customerDetail?.company_name ||
              selectedConversation.customerName ||
              'Customer'
            }
            contactPerson={
              phoneMatch.candidate?.contactPerson || customerDetail?.contact_person
            }
            inquiries={companyInquiries}
          />

          <SendDocumentModal
            isOpen={documentModalOpen}
            onClose={() => setDocumentModalOpen(false)}
            onSend={async (text, docUrl, fn) => {
              await handleSendWhatsApp(text, docUrl, fn);
            }}
            productName={
              companyInquiries[0]?.product_name || selectedConversation.productName || ''
            }
            inquiryId={companyInquiries[0]?.id || selectedConversation.inquiryId}
          />

          <StockCheckModal
            isOpen={stockModalOpen}
            onClose={() => setStockModalOpen(false)}
            onInsertMessage={(text: string) => {
              handleSendWhatsApp(text);
            }}
            initialProduct={
              companyInquiries[0]?.product_name || selectedConversation.productName || ''
            }
          />

          <CreateFollowUpModal
            isOpen={followUpModalOpen}
            onClose={() => setFollowUpModalOpen(false)}
            conversationId={
              selectedConversation.whatsAppConversationId || selectedConversation.id
            }
            inquiryId={companyInquiries[0]?.id || selectedConversation.inquiryId}
            customerId={
              phoneMatch.candidate?.customerId ||
              customerDetail?.id ||
              selectedConversation.customerId
            }
            companyName={
              phoneMatch.candidate?.companyName ||
              customerDetail?.company_name ||
              selectedConversation.customerName ||
              'Customer'
            }
          />

          <CustomerDisambiguationDialog
            isOpen={disambiguationModalOpen}
            onClose={() => setDisambiguationModalOpen(false)}
            phone={
              selectedConversation.senderAddress || selectedConversation.recipientAddress || ''
            }
            candidates={phoneMatch.candidates}
            onSelectCandidate={(cand) => {
              setPhoneMatch({
                matchType: 'exact_single',
                candidate: cand,
                candidates: [cand],
              });
              if (cand.companyName) {
                PhoneMatchingService.getCompanyInquiries(
                  cand.companyName,
                  cand.customerId || undefined
                ).then(setCompanyInquiries);
              }
              setDisambiguationModalOpen(false);
            }}
          />

          {/* Mobile & Tablet Slide-Over Customer Context Drawer */}
          {mobileContextDrawerOpen && selectedConversation && (
            <div className="fixed inset-0 z-50 lg:hidden flex justify-end animate-in fade-in duration-150">
              <div
                className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs"
                onClick={() => setMobileContextDrawerOpen(false)}
              />
              <div className="relative w-full max-w-sm sm:max-w-md bg-white h-full shadow-2xl z-10 flex flex-col">
                <WhatsAppCustomerContextPanel
                  companyName={
                    phoneMatch.candidate?.companyName ||
                    customerDetail?.company_name ||
                    selectedConversation.customerName
                  }
                  contactPerson={
                    phoneMatch.candidate?.contactPerson ||
                    customerDetail?.contact_person
                  }
                  phone={
                    selectedConversation.senderAddress ||
                    selectedConversation.recipientAddress ||
                    ''
                  }
                  email={phoneMatch.candidate?.email || customerDetail?.email}
                  designation={phoneMatch.candidate?.designation}
                  customerId={
                    phoneMatch.candidate?.customerId ||
                    customerDetail?.id ||
                    selectedConversation.customerId
                  }
                  crmContactId={phoneMatch.candidate?.crmContactId}
                  matchType={phoneMatch.matchType}
                  candidates={phoneMatch.candidates}
                  loadingMatch={matchingPhone}
                  onDisambiguate={() => {
                    setMobileContextDrawerOpen(false);
                    setDisambiguationModalOpen(true);
                  }}
                  inquiries={companyInquiries}
                  onOpenInquiry={(inqId: string) => {
                    setMobileContextDrawerOpen(false);
                    onOpenInquiry?.(inqId);
                  }}
                  onCreateInquiryPrefilled={() => {
                    setMobileContextDrawerOpen(false);
                    const phone =
                      selectedConversation.senderAddress || selectedConversation.recipientAddress || '';
                    const prefill = PhoneMatchingService.buildInquiryPrefill(
                      phone,
                      phoneMatch.candidate
                        ? {
                            id: phoneMatch.candidate.customerId,
                            crmContactId: phoneMatch.candidate.crmContactId,
                            companyName: phoneMatch.candidate.companyName,
                            contactPerson: phoneMatch.candidate.contactPerson,
                            email: phoneMatch.candidate.email,
                          }
                        : null,
                      selectedConversation.snippet
                    );
                    if (onCreateInquiryFromMessage) {
                      onCreateInquiryFromMessage(
                        {
                          subject: prefill.product_name
                            ? `Inquiry for ${prefill.product_name}`
                            : 'WhatsApp Inquiry',
                          body: prefill.remarks || selectedConversation.snippet,
                          fromEmail: prefill.contact_email || '',
                          fromName: prefill.contact_person || selectedConversation.senderName,
                        },
                        prefill
                      );
                    }
                  }}
                  onOpenQuotationModal={() => {
                    setMobileContextDrawerOpen(false);
                    setQuotationModalOpen(true);
                  }}
                  onOpenDocumentModal={() => {
                    setMobileContextDrawerOpen(false);
                    setDocumentModalOpen(true);
                  }}
                  onOpenStockModal={() => {
                    setMobileContextDrawerOpen(false);
                    setStockModalOpen(true);
                  }}
                  onOpenFollowUpModal={() => {
                    setMobileContextDrawerOpen(false);
                    setFollowUpModalOpen(true);
                  }}
                  ownerName={selectedConversation.ownerName}
                  onCloseMobile={() => setMobileContextDrawerOpen(false)}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default CrmOmnichannelInbox;
