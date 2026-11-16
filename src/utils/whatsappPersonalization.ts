// src/utils/whatsappPersonalization.ts
//
// Dynamic Personalisation Engine for WhatsApp Messages & Media Captions.
// Resolves placeholders for both text-only and photo/PDF/document messages.
// Enforces that every recipient receives their own resolved fields with sensible fallbacks,
// preventing any raw unresolved {{tag}} placeholders from being dispatched.

import { resolvePersonalizedGreeting } from './crmContactCleaners.ts';

export interface WhatsAppRecipientData {
  id?: string;
  company_name?: string | null;
  contact_person?: string | null;
  designation?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  city?: string | null;
  country?: string | null;
  customer_type?: string | null;
  sales_representative?: string | null;
  sales_rep?: string | null;
  [key: string]: any;
}

export interface PersonalizationOptions {
  productName?: string;
  defaultSalesRepresentative?: string;
  defaultCity?: string;
  defaultCountry?: string;
}

/**
 * Resolves all dynamic tags in a WhatsApp message template for a specific recipient.
 * Applied equally to normal text messages and media captions.
 */
export function formatPersonalizedWhatsAppMessage(
  template: string,
  recipient?: WhatsAppRecipientData | null,
  options?: PersonalizationOptions
): string {
  if (!template) return '';

  const companyName =
    (recipient?.customer_name || recipient?.company_name || '').trim() || 'Rekan Bisnis';
  const rawPerson = recipient?.contact_name || recipient?.contact_person;
  const contactPerson = resolvePersonalizedGreeting(rawPerson, companyName, {
    contextTemplate: template,
    language: (options as any)?.language,
  });
  const productName = (options?.productName || '').trim() || 'Bahan Baku Farmasi & API';
  const designation = (recipient?.designation || '').trim() || 'Purchasing';
  const city = (recipient?.city || '').trim() || (options?.defaultCity || 'Jakarta');
  const country = (recipient?.country || '').trim() || (options?.defaultCountry || 'Indonesia');
  const salesRep =
    (recipient?.sales_representative || recipient?.sales_rep || '').trim() ||
    (options?.defaultSalesRepresentative || '').trim() ||
    'Tim Sales SAPJ';

  let resolved = template
    .replace(/\{\{contact_name\}\}/gi, contactPerson)
    .replace(/\{\{contact_person\}\}/gi, contactPerson)
    .replace(/\{\{company_name\}\}/gi, companyName)
    .replace(/\{\{customer_name\}\}/gi, companyName)
    .replace(/\{\{product_name\}\}/gi, productName)
    .replace(/\{\{designation\}\}/gi, designation)
    .replace(/\{\{city\}\}/gi, city)
    .replace(/\{\{country\}\}/gi, country)
    .replace(/\{\{sales_representative\}\}/gi, salesRep)
    .replace(/\{\{sales_rep\}\}/gi, salesRep);

  // Safety net: Replace any remaining unmapped {{placeholder}} tags with an empty string
  // so no raw "{{placeholder}}" leaks into customer communications.
  resolved = resolved.replace(/\{\{[a-zA-Z0-9_-]+\}\}/g, '');

  return resolved;
}

/**
 * Maximum character limit for WhatsApp media captions across Meta Cloud API and WhatsApp Web.
 */
export const WHATSAPP_MEDIA_CAPTION_LIMIT = 1024;

/**
 * Validates whether a text message can be safely dispatched as a media caption.
 */
export function validateMediaCaption(
  caption: string,
  hasAttachment: boolean
): { isValid: boolean; length: number; maxLength: number; error?: string } {
  const length = (caption || '').length;
  if (!hasAttachment) {
    // Pure text message allows up to 4096 characters
    const maxLength = 4096;
    return {
      isValid: length <= maxLength,
      length,
      maxLength,
      error: length > maxLength ? `Text message exceeds ${maxLength} characters.` : undefined,
    };
  }

  // Media caption allows up to 1024 characters
  const maxLength = WHATSAPP_MEDIA_CAPTION_LIMIT;
  const isValid = length <= maxLength;
  return {
    isValid,
    length,
    maxLength,
    error: isValid
      ? undefined
      : `WhatsApp limits media captions to ${maxLength} characters (current: ${length}). Please shorten the message to dispatch with photo/document.`,
  };
}

