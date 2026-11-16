/**
 * crmContactCleaners.ts
 *
 * Dedicated utilities for CRM contact person hygiene, company-name deduplication,
 * multi-primary phone resolution, and language-aware personalized greetings.
 */

// Common Indonesian legal/corporate prefixes and suffixes
const CORPORATE_TOKENS = new RegExp(
  '\\b(pt|cv|ud|tbk|persero|fa|firma|yayasan|koperasi|lembaga|indonesia|pharma|pharmaceutical|pharmaceuticals|laboratories|lab|kemas|group|site|site-)\\b',
  'gi'
);

/**
 * Normalizes a company or contact name for comparison by removing corporate entity
 * tokens, punctuation, and extra whitespace.
 */
export function normalizeEntityName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(CORPORATE_TOKENS, ' ')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether a candidate string looks like a telephone number.
 */
export function isPhoneNumberString(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  // If it's mostly digits and phone symbols (+, -, (, ), spaces)
  const stripped = trimmed.replace(/[0-9+() -]/g, '');
  if (stripped.length === 0 && trimmed.replace(/[^0-9]/g, '').length >= 5) {
    return true;
  }
  return false;
}

/**
 * Cleans a contact person name.
 * Returns `null` if:
 * - Empty or whitespace
 * - It is a telephone number
 * - It is identical to or trivially matches the company name (e.g. PT Holi Pharma -> Holi Pharma)
 *
 * Preserves legitimate multi-person strings (e.g. "Halimatus Zein, Agnes Febrita, Erwin Hin" or "Bpk Budi / Ibu Siti").
 */
export function cleanContactPerson(
  contactPerson: string | null | undefined,
  companyName: string | null | undefined
): string | null {
  if (!contactPerson) return null;
  const trimmed = contactPerson.trim();
  if (!trimmed || trimmed === '—' || trimmed === '-' || trimmed.toLowerCase() === 'null') {
    return null;
  }

  // 1. Guard against telephone numbers stored in person field
  if (isPhoneNumberString(trimmed)) {
    return null;
  }

  // 2. Guard against company name copied into contact_person field
  if (companyName) {
    const normCompany = normalizeEntityName(companyName);
    const normPerson = normalizeEntityName(trimmed);

    // If normalized person is identical to normalized company or vice-versa
    if (normCompany && normPerson && normCompany === normPerson) {
      return null;
    }

    // Exact direct match case-insensitive
    if (trimmed.toLowerCase() === companyName.trim().toLowerCase()) {
      return null;
    }
  }

  return trimmed;
}

/**
 * Determines whether a message template or text is primarily English or Indonesian.
 */
export function detectLanguage(text: string | null | undefined, defaultLang: 'id' | 'en' = 'id'): 'id' | 'en' {
  if (!text) return defaultLang;

  const lower = text.toLowerCase();
  const englishIndicators = ['dear', 'hello', 'sincerely', 'best regards', 'thank you', 'inquiry', 'quote', 'quotation', 'please find'];
  const indonesianIndicators = ['yth', 'yth.', 'bapak', 'ibu', 'bapak/ibu', 'selamat', 'terima kasih', 'perkenalkan', 'penawaran', 'bahan baku'];

  let enScore = 0;
  let idScore = 0;

  for (const w of englishIndicators) {
    if (lower.includes(w)) enScore += 2;
  }
  for (const w of indonesianIndicators) {
    if (lower.includes(w)) idScore += 2;
  }

  if (enScore === 0 && idScore === 0) {
    return defaultLang;
  }

  return enScore > idScore ? 'en' : 'id';
}

/**
 * Resolves a language-appropriate greeting for customer communications.
 * If a valid contact person is present, returns the person's name (or multi-person string).
 * If no individual name is available, returns:
 * - Indonesian: "Bapak/Ibu" or "Yth. Bapak/Ibu"
 * - English: "Sir/Madam" or "Dear Sir/Madam"
 */
export function resolvePersonalizedGreeting(
  contactPerson: string | null | undefined,
  companyName: string | null | undefined,
  options?: {
    language?: 'id' | 'en';
    contextTemplate?: string;
    includePrefix?: boolean;
  }
): string {
  const validPerson = cleanContactPerson(contactPerson, companyName);
  if (validPerson) {
    return validPerson;
  }

  const lang = options?.language || detectLanguage(options?.contextTemplate, 'id');
  const includePrefix = options?.includePrefix ?? false;

  if (lang === 'en') {
    return includePrefix ? 'Dear Sir/Madam' : 'Sir/Madam';
  } else {
    return includePrefix ? 'Yth. Bapak/Ibu' : 'Bapak/Ibu';
  }
}

/**
 * Audits a company's phone list to detect multiple primary phone records.
 */
export function auditCompanyPrimaryPhones(
  phones: Array<{ id?: string; raw_phone?: string; normalized_phone?: string; is_primary?: boolean; is_whatsapp_eligible?: boolean }>
): {
  hasMultiplePrimary: boolean;
  primaryCount: number;
  primaryPhones: typeof phones;
  needsReview: boolean;
} {
  const primaryPhones = phones.filter(p => Boolean(p.is_primary));
  const primaryCount = primaryPhones.length;
  const hasMultiplePrimary = primaryCount > 1;

  return {
    hasMultiplePrimary,
    primaryCount,
    primaryPhones,
    needsReview: hasMultiplePrimary,
  };
}

/**
 * Deduplicates email campaign recipients within a single campaign run.
 * Preserves the first instance and collects duplicate items for reporting.
 */
export function deduplicateCampaignEmailRecipients<
  T extends { id?: string; email?: string | null; company_name?: string | null }
>(recipients: T[]): {
  unique: T[];
  duplicates: T[];
  duplicateCount: number;
} {
  const seen = new Set<string>();
  const unique: T[] = [];
  const duplicates: T[] = [];

  for (const r of recipients) {
    const raw = (r.email || '').trim().toLowerCase();
    if (!raw || !raw.includes('@')) {
      continue;
    }
    if (seen.has(raw)) {
      duplicates.push(r);
    } else {
      seen.add(raw);
      unique.push(r);
    }
  }

  return {
    unique,
    duplicates,
    duplicateCount: duplicates.length,
  };
}

/**
 * Helper to extract stable company/contact identifier from recipient objects.
 */
function getCompanyIdentifier(item: any): string {
  if (item?.company_id && typeof item.company_id === 'string') return item.company_id.trim();
  if (item?.contact_id && typeof item.contact_id === 'string') return item.contact_id.trim();
  if (item?.companyId && typeof item.companyId === 'string') return item.companyId.trim();
  if (item?.id && typeof item.id === 'string' && !item.id.includes('_phone_') && !item.id.includes('_missing')) {
    return item.id.trim();
  }
  return '';
}

/**
 * Deduplicates WhatsApp campaign recipients by canonical/normalized phone number
 * while enforcing cross-company shared-switchboard safety and stable company identity.
 */
export function deduplicateCampaignPhoneRecipients<
  T extends {
    id?: string;
    contact_id?: string;
    company_id?: string | null;
    company_name?: string | null;
    phone?: string | null;
    mobile?: string | null;
    raw_phone?: string | null;
    normalized_phone?: string | null;
    is_candidate?: boolean;
    validation?: { normalized?: string };
  }
>(
  recipients: T[]
): {
  unique: T[];
  duplicates: T[];
  ambiguousShared: Array<{ phone: string; companies: string[]; items: T[]; reason: string }>;
} {
  const phoneToItems = new Map<string, T[]>();

  for (const item of recipients) {
    const key =
      item.validation?.normalized ||
      item.normalized_phone ||
      item.mobile ||
      item.raw_phone ||
      item.phone ||
      '';
    const cleanKey = key.trim().replace(/[^0-9+]/g, '');
    if (!cleanKey) continue;

    const list = phoneToItems.get(cleanKey) || [];
    list.push(item);
    phoneToItems.set(cleanKey, list);
  }

  const unique: T[] = [];
  const duplicates: T[] = [];
  const ambiguousShared: Array<{ phone: string; companies: string[]; items: T[]; reason: string }> = [];

  for (const [phone, items] of phoneToItems.entries()) {
    // 1. Guard against missing or blank company identity (missing company ID or blank company name)
    const hasMissingCompanyIdentity = items.some(i => {
      const compId = getCompanyIdentifier(i);
      const compName = (i.company_name || '').trim();
      return !compId || !compName;
    });

    if (hasMissingCompanyIdentity) {
      ambiguousShared.push({
        phone,
        companies: items.map(i => (i.company_name || '').trim() || 'Unknown Company'),
        items,
        reason: 'Excluded from automated broadcast: missing or ambiguous company identity (missing company ID or blank company name)',
      });
      continue;
    }

    if (items.length === 1) {
      unique.push(items[0]);
    } else {
      // 2. Multiple items share the same canonical phone number.
      // Extract stable company identifiers and normalized company names
      const companyIds = items.map(i => getCompanyIdentifier(i)).filter(Boolean);
      const distinctCompanyIds = Array.from(new Set(companyIds));

      const distinctCompanyNames = Array.from(
        new Set(items.map(i => (i.company_name || '').trim().toLowerCase()).filter(Boolean))
      );

      // Check for shared switchboard across distinct legal entities or conflicting identities:
      // A) Different company IDs (even with identical or similar company name!)
      // B) Different company names (conflicting company identities!)
      if (distinctCompanyIds.length > 1 || distinctCompanyNames.length > 1) {
        let reason = 'Excluded from automated broadcast: shared telephone number across distinct legal entities';
        if (distinctCompanyIds.length > 1 && distinctCompanyNames.length === 1) {
          reason = `Excluded from automated broadcast: shared telephone number across distinct company IDs (${distinctCompanyIds.join(', ')}) with identical company name`;
        } else if (distinctCompanyIds.length === 1 && distinctCompanyNames.length > 1) {
          reason = 'Excluded from automated broadcast: conflicting company identities under same company ID';
        }

        ambiguousShared.push({
          phone,
          companies: items.map(i => i.company_name || 'Unknown Company'),
          items,
          reason,
        });
      } else {
        // Exactly same verified company ID and same company name:
        // Consolidate safely: queue exactly one message, mark the rest as duplicates
        unique.push(items[0]);
        for (let i = 1; i < items.length; i++) {
          duplicates.push(items[i]);
        }
      }
    }
  }

  return {
    unique,
    duplicates,
    ambiguousShared,
  };
}
