import React, { useState } from 'react';
import DOMPurify from 'dompurify';
import {
  Mail,
  MessageSquare,
  Paperclip,
  ArrowDownLeft,
  ArrowUpRight,
  ExternalLink,
  Tag,
  Download,
  Calendar,
  Layers,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { getSignedUrlCached } from '../../../utils/signedUrlCache';
import { AiReplyDraftCard } from './AiReplyDraftCard';

export interface MessageAttachment {
  filename?: string;
  name?: string;
  display_file_name?: string;
  original_file_name?: string;
  file_name?: string;
  size?: number;
  content_type?: string;
  mime_type?: string;
  storage_path?: string;
  path?: string;
  bucket?: string;
}

export interface RequestMessageLink {
  request_id: string;
  relationship: 'originated' | 'clarified' | 'blocked' | 'resolved' | 'referenced';
  request_code?: string;
  request_title?: string;
}

export interface CanonicalMessageItem {
  id: string;
  conversation_id: string;
  channel: 'email' | 'whatsapp' | 'internal' | string;
  direction: 'inbound' | 'outbound' | 'internal';
  sender_address: string;
  sender_name?: string | null;
  recipient_addresses: string[];
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  attachments?: MessageAttachment[] | null;
  received_or_sent_at: string;
  actor_type?: string;
  // AI fields
  ai_processed?: boolean;
  ai_summary?: string | null;
  ai_proposal?: any | null;
  ai_reply_draft?: any | null;
  // Relationships
  linked_requests?: RequestMessageLink[];
}

export interface ConversationLinkedEnquiry {
  inquiry_id: string;
  inquiry_number: string;
  product_name?: string;
  link_type: 'primary' | 'related' | 'reference';
}

export interface CanonicalConversationSummary {
  id: string;
  channel: string;
  title: string;
  last_message_at: string;
  linked_enquiries: ConversationLinkedEnquiry[];
  messages: CanonicalMessageItem[];
}

interface ConversationTimelineProps {
  conversations: CanonicalConversationSummary[];
  currentInquiryId: string;
  currentInquiryNumber: string;
  loading?: boolean;
  onRefresh?: () => void;
  onOpenComposer?: (draft: { to: string; subject: string; body: string }) => void;
}

const CHANNEL_CONFIG: Record<string, { label: string; icon: React.FC<{ className?: string }>; bg: string; text: string }> = {
  email: { label: 'Email', icon: Mail, bg: 'bg-blue-50 text-blue-700 border-blue-200', text: 'text-blue-700' },
  whatsapp: { label: 'WhatsApp', icon: MessageSquare, bg: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'text-emerald-700' },
  internal: { label: 'Internal', icon: MessageSquare, bg: 'bg-purple-50 text-purple-700 border-purple-200', text: 'text-purple-700' },
};

const RELATIONSHIP_CONFIG: Record<string, { label: string; color: string }> = {
  originated: { label: 'Originated', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  clarified: { label: 'Clarified', color: 'bg-purple-100 text-purple-800 border-purple-200' },
  blocked: { label: 'Blocked', color: 'bg-rose-100 text-rose-800 border-rose-200' },
  resolved: { label: 'Resolved', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  referenced: { label: 'Referenced', color: 'bg-gray-100 text-gray-800 border-gray-200' },
};

export const ConversationTimeline: React.FC<ConversationTimelineProps> = ({
  conversations,
  currentInquiryId,
  currentInquiryNumber,
  loading = false,
  onRefresh,
  onOpenComposer,
}) => {
  const [expandedHtmlMessageIds, setExpandedHtmlMessageIds] = useState<Set<string>>(new Set());

  const toggleHtmlExpand = (messageId: string) => {
    setExpandedHtmlMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const handleDownloadAttachment = async (att: MessageAttachment) => {
    const bucket = att.bucket || 'crm-documents';
    const path = att.storage_path || att.path;
    const filename = att.filename || att.display_file_name || att.file_name || 'attachment';

    if (!path) {
      alert('Attachment path not found in canonical record.');
      return;
    }

    try {
      const signedUrl = await getSignedUrlCached(bucket, path, 3600, { download: filename });
      if (!signedUrl) {
        alert('Could not generate secure download URL for this attachment.');
        return;
      }
      const link = document.createElement('a');
      link.href = signedUrl;
      link.download = filename;
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      console.error('[ConversationTimeline] Attachment download error:', err);
      alert('Failed to download attachment.');
    }
  };

  // Flatten and sort all messages across linked conversations chronologically
  const allMessages: Array<CanonicalMessageItem & { conversation: CanonicalConversationSummary }> = [];
  for (const conv of conversations) {
    for (const msg of conv.messages || []) {
      allMessages.push({
        ...msg,
        conversation: conv,
      });
    }
  }

  // Deduplicate by message.id (if linked multiple ways) and order ascending
  const uniqueMessagesMap = new Map<string, typeof allMessages[0]>();
  for (const item of allMessages) {
    if (!uniqueMessagesMap.has(item.id)) {
      uniqueMessagesMap.set(item.id, item);
    }
  }
  const sortedMessages = Array.from(uniqueMessagesMap.values()).sort(
    (a, b) => new Date(a.received_or_sent_at).getTime() - new Date(b.received_or_sent_at).getTime()
  );

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500 space-y-2">
        <div className="inline-block w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-xs">Loading canonical communication threads...</p>
      </div>
    );
  }

  if (conversations.length === 0 || sortedMessages.length === 0) {
    return (
      <div className="p-8 text-center rounded-lg border border-dashed border-gray-300 bg-gray-50/50 space-y-2">
        <Mail className="w-8 h-8 text-gray-400 mx-auto" />
        <p className="text-gray-600 text-xs font-medium">
          No canonical conversation linked to this enquiry.
        </p>
        <p className="text-gray-400 text-[11px] max-w-sm mx-auto">
          Incoming and outgoing emails mapped to {currentInquiryNumber} will appear here chronologically once recorded in the canonical mirror.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Linked Conversation Overview Banner if Multi-Enquiry */}
      {conversations.map(conv => {
        const otherEnquiries = conv.linked_enquiries.filter(e => e.inquiry_id !== currentInquiryId);
        if (otherEnquiries.length === 0) return null;

        return (
          <div
            key={conv.id}
            className="p-2.5 rounded-md border border-blue-200 bg-blue-50/60 text-blue-900 text-xs flex items-start gap-2 shadow-2xs"
          >
            <Layers className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-0.5 min-w-0 flex-1">
              <span className="font-semibold text-blue-950">Multi-Enquiry Conversation Thread</span>
              <p className="text-[11px] text-blue-800">
                This thread also links to:{' '}
                {otherEnquiries.map(oe => (
                  <span
                    key={oe.inquiry_id}
                    className="inline-flex items-center gap-1 font-semibold underline decoration-blue-300 mr-1.5"
                  >
                    {oe.inquiry_number} ({oe.link_type})
                  </span>
                ))}
              </p>
            </div>
          </div>
        );
      })}

      {/* Message Timeline */}
      <div className="space-y-3">
        {sortedMessages.map((msg, idx) => {
          const isOutbound = msg.direction === 'outbound';
          const isInternal = msg.direction === 'internal' || msg.channel === 'internal';
          const channelMeta = CHANNEL_CONFIG[msg.channel] || CHANNEL_CONFIG.email;
          const ChannelIcon = channelMeta.icon;
          const isHtmlExpanded = expandedHtmlMessageIds.has(msg.id);

          const rawAttachments = Array.isArray(msg.attachments) ? msg.attachments : [];
          const hasAttachments = rawAttachments.length > 0;

          const dateObj = new Date(msg.received_or_sent_at);
          const formattedDate = dateObj.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
          const formattedTime = dateObj.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          });

          return (
            <div
              key={msg.id}
              className={`rounded-lg border transition shadow-2xs ${
                isOutbound
                  ? 'bg-blue-50/20 border-blue-200/80 ml-3 sm:ml-6'
                  : isInternal
                  ? 'bg-purple-50/20 border-purple-200/80 mx-2'
                  : 'bg-white border-gray-200 mr-3 sm:mr-6'
              }`}
            >
              {/* Message Header */}
              <div className="p-3 border-b border-gray-100 flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0 flex-1">
                  {/* Top Line: Channel badge, Direction badge, Date */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${channelMeta.bg}`}
                    >
                      <ChannelIcon className="w-3 h-3" />
                      <span>{channelMeta.label}</span>
                    </span>

                    <span
                      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider ${
                        isOutbound
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : isInternal
                          ? 'bg-purple-50 text-purple-700 border-purple-200'
                          : 'bg-sky-50 text-sky-700 border-sky-200'
                      }`}
                    >
                      {isOutbound ? (
                        <>
                          <ArrowUpRight className="w-3 h-3" /> Outbound
                        </>
                      ) : isInternal ? (
                        <>
                          <MessageSquare className="w-3 h-3" /> Internal
                        </>
                      ) : (
                        <>
                          <ArrowDownLeft className="w-3 h-3" /> Inbound
                        </>
                      )}
                    </span>

                    <span className="text-gray-400 text-[10px]">·</span>
                    <span className="text-gray-500 font-medium text-[11px]">
                      {formattedDate} at {formattedTime}
                    </span>
                  </div>

                  {/* Sender & Recipients */}
                  <div className="text-xs text-gray-700 flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5">
                    <div>
                      <span className="text-gray-400 text-[11px]">From: </span>
                      <strong className="text-gray-900">
                        {msg.sender_name ? `${msg.sender_name} <${msg.sender_address}>` : msg.sender_address}
                      </strong>
                    </div>

                    {msg.recipient_addresses && msg.recipient_addresses.length > 0 && (
                      <div>
                        <span className="text-gray-400 text-[11px]">To: </span>
                        <span className="text-gray-600 font-medium">
                          {msg.recipient_addresses.join(', ')}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Subject if applicable */}
                  {msg.subject && (
                    <div className="font-semibold text-gray-900 text-xs pt-1">
                      {msg.subject}
                    </div>
                  )}
                </div>
              </div>

              {/* Message Body */}
              <div className="p-3 text-xs text-gray-800 space-y-2">
                {msg.body_text ? (
                  <div className="whitespace-pre-wrap font-sans leading-relaxed text-gray-800 select-text">
                    {msg.body_text}
                  </div>
                ) : msg.body_html ? (
                  <div className="space-y-1">
                    <div
                      className={`text-gray-700 font-sans prose prose-xs max-w-none overflow-hidden ${
                        isHtmlExpanded ? '' : 'max-h-36'
                      }`}
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(msg.body_html) }}
                    />
                    <button
                      type="button"
                      onClick={() => toggleHtmlExpand(msg.id)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-800 cursor-pointer pt-1"
                    >
                      {isHtmlExpanded ? (
                        <>
                          <ChevronUp className="w-3 h-3" /> Show Less
                        </>
                      ) : (
                        <>
                          <ChevronDown className="w-3 h-3" /> Show Full Formatted Message
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <p className="text-gray-400 italic text-[11px]">No message body content.</p>
                )}

                {/* Attachments Section */}
                {hasAttachments && (
                  <div className="pt-2 border-t border-gray-100 space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-1">
                      <Paperclip className="w-3 h-3" />
                      <span>Attachments ({rawAttachments.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {rawAttachments.map((att, attIdx) => {
                        const filename = att.filename || att.display_file_name || att.file_name || `attachment-${attIdx + 1}`;
                        const sizeKb = att.size ? `${Math.round(att.size / 1024)} KB` : null;

                        return (
                          <button
                            key={attIdx}
                            type="button"
                            onClick={() => handleDownloadAttachment(att)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-gray-200 bg-gray-50 hover:bg-white hover:border-blue-400 text-gray-700 text-xs transition cursor-pointer shadow-2xs group"
                            title={`Download ${filename}`}
                          >
                            <Paperclip className="w-3 h-3 text-gray-400 group-hover:text-blue-600" />
                            <span className="font-medium truncate max-w-[200px]">{filename}</span>
                            {sizeKb && <span className="text-[10px] text-gray-400">({sizeKb})</span>}
                            <Download className="w-3 h-3 text-gray-400 group-hover:text-blue-600 ml-0.5" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Request Provenance Chips (enquiry_request_messages) */}
                {msg.linked_requests && msg.linked_requests.length > 0 && (
                  <div className="pt-2 border-t border-gray-100 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mr-1">
                      Requirement Context:
                    </span>
                    {msg.linked_requests.map((rel, relIdx) => {
                      const relConfig = RELATIONSHIP_CONFIG[rel.relationship] || RELATIONSHIP_CONFIG.referenced;
                      return (
                        <span
                          key={relIdx}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${relConfig.color}`}
                          title={`${relConfig.label}: ${rel.request_title || rel.request_code || 'Requirement'}`}
                        >
                          <Tag className="w-2.5 h-2.5" />
                          <strong className="font-semibold">{relConfig.label}:</strong>
                          <span>{rel.request_code || rel.request_title || 'Requirement'}</span>
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Phase 7.6D: AI Reply Drafter (Available for inbound canonical messages) */}
                {msg.direction === 'inbound' && (
                  <div className="pt-2 border-t border-gray-100">
                    <AiReplyDraftCard
                      messageId={msg.id}
                      inquiryId={currentInquiryId}
                      inquiryNumber={currentInquiryNumber}
                      senderAddress={msg.sender_address}
                      channel={msg.channel || 'email'}
                      conversationId={msg.conversation_id || msg.id}
                      initialDraft={msg.ai_reply_draft}
                      onOpenComposer={onOpenComposer}
                      onDraftUpdated={onRefresh}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
