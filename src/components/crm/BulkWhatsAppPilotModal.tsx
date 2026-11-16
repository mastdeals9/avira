import React, { useState } from 'react';
import {
  X,
  MessageCircle,
  Users,
  Send,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Phone,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { showToast } from '../ToastNotification';
import { resolvePersonalizedGreeting } from '../../utils/crmContactCleaners';

export interface WhatsAppRecipient {
  id: string;
  company_name: string;
  contact_person?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  recipients: WhatsAppRecipient[];
  onComplete?: () => void;
}

export function BulkWhatsAppPilotModal({
  isOpen,
  onClose,
  recipients,
  onComplete,
}: Props) {
  const [messageTemplate, setMessageTemplate] = useState<string>(
    'Halo {{contact_person}} dari {{company_name}},\n\nKami dari PT Shubham Anzen Pharma Jaya ingin menginformasikan ketersediaan ready stock untuk bahan baku farmasi & API di gudang Jakarta.\n\nApakah saat ini sedang ada kebutuhan penawaran harga atau COA?\n\nSalam,\nTim Sales SAPJ'
  );

  // Safety Controls & Human Approval Gate
  const [consentVerified, setConsentVerified] = useState(false);
  const [optOutCheckConfirmed, setOptOutCheckConfirmed] = useState(false);
  const [testMode, setTestMode] = useState(true);
  const [testPhoneNumber, setTestPhoneNumber] = useState('+6285888600999');
  const [pacingDelaySeconds, setPacingDelaySeconds] = useState(20);

  // Sending State
  const [isSending, setIsSending] = useState(false);
  const [progressCount, setProgressCount] = useState(0);
  const [currentRecipient, setCurrentRecipient] = useState<string | null>(null);
  const [dispatchLogs, setDispatchLogs] = useState<
    Array<{ phone: string; name: string; status: 'sent' | 'failed'; error?: string; timestamp: string }>
  >([]);

  if (!isOpen) return null;

  // Filter recipients with valid phone numbers
  const validRecipients = recipients.filter((r) => {
    const raw = r.phone || r.mobile || '';
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 9;
  });

  const getCleanPhone = (r: WhatsAppRecipient): string => {
    let raw = (r.phone || r.mobile || '').trim();
    raw = raw.replace(/[^\d+]/g, '');
    if (raw.startsWith('08')) raw = '+628' + raw.slice(2);
    else if (raw.startsWith('628')) raw = '+' + raw;
    else if (!raw.startsWith('+') && raw.length > 8) raw = '+' + raw;
    return raw;
  };

  const previewFormattedMessage = (r: WhatsAppRecipient): string => {
    const contactName = resolvePersonalizedGreeting(r.contact_person, r.company_name, {
      contextTemplate: messageTemplate,
    });
    const company = (r.company_name || 'Rekan Bisnis').trim();
    return messageTemplate
      .replace(/\{\{contact_person\}\}/gi, contactName)
      .replace(/\{\{contact_name\}\}/gi, contactName)
      .replace(/\{\{company_name\}\}/gi, company);
  };

  const handleSendPilot = async () => {
    if (!consentVerified || !optOutCheckConfirmed) {
      showToast({
        type: 'warning',
        title: 'Consent Required',
        message: 'Please complete the consent verification and opt-out safeguard check before sending.',
      });
      return;
    }

    if (!messageTemplate.trim()) {
      showToast({
        type: 'warning',
        title: 'Empty Message',
        message: 'Please write a message template.',
      });
      return;
    }

    setIsSending(true);
    setProgressCount(0);
    setDispatchLogs([]);

    const proxyUrl = import.meta.env.VITE_WHATSAPP_PROXY_URL || '/api/whatsapp';

    try {
      if (testMode) {
        // Send single test message
        setCurrentRecipient(`Test Recipient (${testPhoneNumber})`);
        const formatted = messageTemplate
          .replace(/\{\{contact_person\}\}/gi, 'Test Partner')
          .replace(/\{\{company_name\}\}/gi, 'PT Test Laboratory');

        const res = await fetch(`${proxyUrl}/api/messages/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: testPhoneNumber,
            text: formatted,
          }),
        }).catch((err) => ({ ok: false, json: async () => ({ error: err.message }) }));

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data?.error || 'WhatsApp adapter returned error');
        }

        setProgressCount(1);
        setDispatchLogs([
          {
            phone: testPhoneNumber,
            name: 'Test Mode Recipient',
            status: 'sent',
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
        showToast({
          type: 'success',
          title: 'Test WhatsApp Sent',
          message: `Dispatched test message to ${testPhoneNumber}`,
        });
      } else {
        // Controlled Pilot Batch
        const targets = validRecipients.slice(0, 15); // limit to 15 for safety
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          const phone = getCleanPhone(target);
          const body = previewFormattedMessage(target);

          setCurrentRecipient(`${target.company_name} (${phone})`);

          try {
            const res = await fetch(`${proxyUrl}/api/messages/send`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                to: phone,
                text: body,
              }),
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            setDispatchLogs((prev) => [
              ...prev,
              {
                phone,
                name: target.company_name,
                status: 'sent',
                timestamp: new Date().toLocaleTimeString(),
              },
            ]);
          } catch (err: any) {
            setDispatchLogs((prev) => [
              ...prev,
              {
                phone,
                name: target.company_name,
                status: 'failed',
                error: err.message || 'Dispatch error',
                timestamp: new Date().toLocaleTimeString(),
              },
            ]);
          }

          setProgressCount(i + 1);

          // Pacing delay between pilot messages
          if (i < targets.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, pacingDelaySeconds * 1000));
          }
        }

        showToast({
          type: 'success',
          title: 'Pilot Batch Completed',
          message: `Finished dispatching ${targets.length} WhatsApp messages.`,
        });
        if (onComplete) onComplete();
      }
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'WhatsApp Pilot Notice',
        message: err.message || 'Could not communicate with WhatsApp adapter',
      });
    } finally {
      setIsSending(false);
      setCurrentRecipient(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full flex flex-col max-h-[90vh] overflow-hidden border border-gray-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-emerald-700 text-white">
          <div className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-emerald-200" />
            <div>
              <h3 className="font-bold text-sm">Bulk WhatsApp Pilot Sender</h3>
              <p className="text-[11px] text-emerald-100">
                Controlled, consent-based WhatsApp campaign with pacing & approval gate
              </p>
            </div>
          </div>
          <button onClick={onClose} disabled={isSending} className="text-emerald-200 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto space-y-4 text-xs font-sans">
          {/* Target Audience Summary */}
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-emerald-900 font-medium">
              <Users className="w-4 h-4 text-emerald-600" />
              <span>
                Target Audience: <strong>{validRecipients.length}</strong> contacts with verified phone numbers
                (out of {recipients.length} selected).
              </span>
            </div>
            <span className="text-[11px] bg-emerald-200 text-emerald-800 px-2 py-0.5 rounded-full font-semibold">
              Pilot Batch Max: 15
            </span>
          </div>

          {/* Template & Personalization Variables */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="font-bold text-gray-700">Message Template (Indonesian / English)</label>
              <div className="flex items-center gap-1 text-[11px] text-gray-500">
                <span>Variables:</span>
                <code className="bg-gray-100 px-1 py-0.5 rounded border border-gray-200">{'{{company_name}}'}</code>
                <code className="bg-gray-100 px-1 py-0.5 rounded border border-gray-200">{'{{contact_person}}'}</code>
              </div>
            </div>
            <textarea
              rows={5}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              disabled={isSending}
              className="w-full text-xs p-2.5 border border-gray-300 rounded-lg focus:ring-1 focus:ring-emerald-500 focus:outline-none font-mono"
            />
          </div>

          {/* Live Preview */}
          {validRecipients.length > 0 && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1">
              <div className="font-semibold text-gray-600 text-[11px]">
                Live Message Preview for: {validRecipients[0].company_name} ({getCleanPhone(validRecipients[0])})
              </div>
              <div className="bg-white p-2.5 rounded border border-gray-200 whitespace-pre-wrap text-gray-800 font-sans">
                {previewFormattedMessage(validRecipients[0])}
              </div>
            </div>
          )}

          {/* Test Mode & Pacing Controls */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-50 border border-slate-200 p-3 rounded-lg">
            <div>
              <label className="flex items-center gap-2 font-bold text-gray-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={testMode}
                  onChange={(e) => setTestMode(e.target.checked)}
                  disabled={isSending}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span>Safety Test Mode (Send to 1 number first)</span>
              </label>
              {testMode && (
                <div className="mt-2 flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-gray-400" />
                  <input
                    type="text"
                    value={testPhoneNumber}
                    onChange={(e) => setTestPhoneNumber(e.target.value)}
                    placeholder="+628..."
                    className="text-xs p-1.5 border border-gray-300 rounded w-full bg-white font-mono"
                  />
                </div>
              )}
            </div>

            <div>
              <label className="font-bold text-gray-800 block">Pacing Delay between messages</label>
              <div className="flex items-center gap-2 mt-2">
                <Clock className="w-3.5 h-3.5 text-gray-400" />
                <input
                  type="number"
                  min={10}
                  max={60}
                  value={pacingDelaySeconds}
                  onChange={(e) => setPacingDelaySeconds(Number(e.target.value))}
                  disabled={isSending || testMode}
                  className="w-20 text-xs p-1.5 border border-gray-300 rounded bg-white text-center font-mono"
                />
                <span className="text-gray-500">seconds (prevents spam blocking)</span>
              </div>
            </div>
          </div>

          {/* Human Approval Gate & Consent Checklist */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
            <div className="font-bold text-amber-900 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-amber-700" />
              <span>Human Approval & Consent Gate</span>
            </div>
            <label className="flex items-start gap-2 text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={consentVerified}
                onChange={(e) => setConsentVerified(e.target.checked)}
                disabled={isSending}
                className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500"
              />
              <span>
                I confirm that recipients are verified B2B pharmaceutical contacts and communication is compliant with commercial policies.
              </span>
            </label>
            <label className="flex items-start gap-2 text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={optOutCheckConfirmed}
                onChange={(e) => setOptOutCheckConfirmed(e.target.checked)}
                disabled={isSending}
                className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500"
              />
              <span>
                I have checked that no recipient in this batch has requested to opt out or unsubscribe from WhatsApp notifications.
              </span>
            </label>
          </div>

          {/* Progress & Dispatch Logs */}
          {dispatchLogs.length > 0 && (
            <div className="space-y-1.5">
              <div className="font-bold text-gray-700 flex justify-between">
                <span>Dispatch Logs ({dispatchLogs.length})</span>
                {isSending && currentRecipient && (
                  <span className="text-emerald-600 animate-pulse">Sending to: {currentRecipient}</span>
                )}
              </div>
              <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-lg p-2 bg-slate-50 space-y-1 font-mono text-[11px]">
                {dispatchLogs.map((log, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <span className="text-gray-700">
                      [{log.timestamp}] {log.name} ({log.phone})
                    </span>
                    <span
                      className={`px-1.5 py-0.2 rounded font-bold uppercase ${
                        log.status === 'sent'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {log.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <div className="text-[11px] text-gray-500">
            Adapter: <code className="text-emerald-700 font-mono">http://localhost:3100</code>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={isSending}
              className="px-3.5 py-1.5 border border-gray-300 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSendPilot}
              disabled={isSending || !consentVerified || !optOutCheckConfirmed}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold disabled:opacity-50 shadow-sm flex items-center gap-1.5 cursor-pointer"
            >
              {isSending ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Sending Pilot...</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>{testMode ? 'Send Test WhatsApp' : `Send Pilot to ${Math.min(15, validRecipients.length)} Contacts`}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

