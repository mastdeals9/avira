/**
 * SAPJ ERP — Intelligent Email-to-Inquiry Extraction & Normalization
 *
 * Restores structured extraction for pharmaceutical RFQ emails:
 * - Preserves HTML tables as pipe-delimited rows
 * - Separates primary message from quoted historical correspondence
 * - Extracts signatures, customer company, contact person, phone, email
 * - Distinguishes email receivedDate vs requested delivery/arrival date
 * - Produces clean Remarks (never copying the raw email body)
 */

export interface ExtractedProductLine {
  productName: string;
  specification: string | null;
  quantity: string;
  make: string | null;
  supplierName: string | null;
  supplierCountry: string | null;
  deliveryDate: string | null;
  deliveryTerms: string | null;
  purchasePrice: string | null;
  purchasePriceCurrency: string | null;
  offeredPrice: string | null;
  offeredPriceCurrency: string | null;
  itemNumber: string | null;
  etdPo: string | null;
}

export interface EmailAttachmentMeta {
  filename: string;
  mimeType?: string;
  size?: number;
}

export interface EmailExtractionInput {
  emailSubject: string;
  emailBody: string;
  emailBodyHtml?: string | null;
  fromEmail: string;
  fromName?: string | null;
  receivedDate?: string | null;
  attachments?: EmailAttachmentMeta[] | null;
  knownCompanyName?: string | null;
}

export interface ExtractedEmailInquiry {
  products: ExtractedProductLine[];
  productName: string;
  specification: string | null;
  quantity: string;
  supplierName: string | null;
  supplierCountry: string | null;
  companyName: string;
  contactPerson: string | null;
  contactEmail: string;
  contactPhone: string | null;
  coaRequested: boolean;
  msdsRequested: boolean;
  sampleRequested: boolean;
  priceRequested: boolean;
  agencyLetterRequested: boolean;
  otherRequests: boolean;
  purposeIcons: string[];
  deliveryDateExpected: string | null;
  deliveryTerms: string | null;
  purchasePrice: string | null;
  purchasePriceCurrency: string | null;
  offeredPrice: string | null;
  offeredPriceCurrency: string | null;
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  remarks: string | null;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  detectedLanguage: string;
  missingFields: string[];
  uncertainFields: string[];
}

const GENERIC_SENDER_NAMES = new Set([
  'email sender',
  'unknown',
  'unknown company',
  'no-reply',
  'noreply',
  'purchasing',
  'procurement',
  'info',
  'admin',
  'sales',
]);

const MONTH_MAP: Record<string, string> = {
  jan: '01', january: '01', januari: '01',
  feb: '02', february: '02', februari: '02',
  mar: '03', march: '03', maret: '03',
  apr: '04', april: '04',
  may: '05', mei: '05',
  jun: '06', june: '06', juni: '06',
  jul: '07', july: '07', juli: '07',
  aug: '08', august: '08', agustus: '08', agt: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10', oktober: '10', okt: '10',
  nov: '11', november: '11',
  dec: '12', december: '12', desember: '12', des: '12',
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

/**
 * Converts HTML email content into structured plain text while preserving
 * <table> rows as pipe-delimited Markdown tables (`| col1 | col2 |`).
 */
export function htmlToStructuredEmailText(html: string): string {
  if (!html) return '';
  let text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Convert tables into pipe-delimited rows
  text = text.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows: string[] = [];
    const trMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trMatches) {
      const cells = tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
      const cleanCells = cells.map((cell) =>
        decodeHtmlEntities(
          cell
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        )
      );
      if (cleanCells.some((c) => c.length > 0)) {
        rows.push(`| ${cleanCells.join(' | ')} |`);
      }
    }
    return rows.length > 0 ? `\n${rows.join('\n')}\n` : '\n';
  });

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');

  text = decodeHtmlEntities(text);
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits primary email content from quoted historical replies.
 */
export function splitPrimaryAndQuotedText(text: string): {
  primary: string;
  quoted: string;
} {
  if (!text) return { primary: '', quoted: '' };
  const markers = [
    /\n\s*On\s+.{10,80}\s+wrote:\s*\n/i,
    /\n\s*-{3,}\s*Original Message\s*-{3,}/i,
    /\n\s*From:\s*[^\n]+\n\s*(?:Sent|Date):\s*[^\n]+/i,
    /\n\s*Pada\s+.{10,80}\s+menulis:\s*\n/i,
  ];
  let splitIdx = -1;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && (splitIdx === -1 || m.index < splitIdx)) {
      splitIdx = m.index;
    }
  }
  if (splitIdx > 0) {
    return {
      primary: text.slice(0, splitIdx).trim(),
      quoted: text.slice(splitIdx).trim(),
    };
  }
  // Strip leading '>' quoted lines if mixed
  const lines = text.split('\n');
  const primaryLines: string[] = [];
  const quotedLines: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) {
      quotedLines.push(line.replace(/^\s*>+\s?/, ''));
    } else {
      primaryLines.push(line);
    }
  }
  return {
    primary: primaryLines.join('\n').trim(),
    quoted: quotedLines.join('\n').trim(),
  };
}

/**
 * Parses English, Indonesian, ISO, and numeric dates to YYYY-MM-DD.
 * Returns null if invalid or unparseable (never invents a date).
 */
export function parseFlexibleDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // YYYY-MM-DD
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // DD Month YYYY (e.g. "18 January 2027", "18 Jan 2027", "18 Januari 2027")
  const dmyText = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dmyText) {
    const day = dmyText[1].padStart(2, '0');
    const mon = MONTH_MAP[dmyText[2].toLowerCase()];
    const year = dmyText[3];
    if (mon) return `${year}-${mon}-${day}`;
  }

  // Month DD, YYYY (e.g. "January 18, 2027")
  const mdyText = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdyText) {
    const mon = MONTH_MAP[mdyText[1].toLowerCase()];
    const day = mdyText[2].padStart(2, '0');
    const year = mdyText[3];
    if (mon) return `${year}-${mon}-${day}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmyNum = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (dmyNum) {
    const day = Number(dmyNum[1]);
    const mon = Number(dmyNum[2]);
    let year = dmyNum[3];
    if (year.length === 2) year = `20${year}`;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

export function normalizeCompanyCandidate(raw: string | null | undefined, fallbackEmail?: string): string {
  const cleaned = (raw || '').replace(/<[^>]+>/g, '').trim();
  if (
    cleaned &&
    !GENERIC_SENDER_NAMES.has(cleaned.toLowerCase()) &&
    !cleaned.includes('@')
  ) {
    return cleaned;
  }
  if (fallbackEmail && fallbackEmail.includes('@')) {
    const domain = fallbackEmail.split('@')[1]?.toLowerCase() || '';
    const root = domain.split('.')[0] || '';
    if (root && !['gmail', 'yahoo', 'hotmail', 'outlook', 'ymail'].includes(root)) {
      return root.toUpperCase();
    }
  }
  return '';
}

function inferCompanyFromText(text: string): string | null {
  // Look for PT / CV / Tbk / Ltd / GmbH / Inc in signature or body
  const ptMatch = text.match(/\b((?:PT|CV)\.?\s+[A-Z][A-Za-z0-9.&'\- ]{2,45}(?:\s+Tbk\.?)?)/);
  if (ptMatch) {
    const cand = ptMatch[1].replace(/\s+/g, ' ').trim();
    // Avoid matching Indian/foreign manufacturers when labeled Factory/Manufacturer/Supplier
    const idx = ptMatch.index ?? 0;
    const prefix = text.slice(Math.max(0, idx - 30), idx).toLowerCase();
    if (!/(factory|manufacturer|supplier|maker|origin)\s*[:|-]?/i.test(prefix)) {
      return cand;
    }
  }
  return null;
}

function inferContactFromSignature(text: string, fromName?: string | null): {
  contactPerson: string | null;
  contactPhone: string | null;
} {
  let contactPerson: string | null = null;
  const cleanedFrom = (fromName || '').replace(/["<>]/g, '').trim();
  if (
    cleanedFrom &&
    !GENERIC_SENDER_NAMES.has(cleanedFrom.toLowerCase()) &&
    !cleanedFrom.includes('@')
  ) {
    contactPerson = cleanedFrom;
  }

  if (!contactPerson) {
    const sigMatch = text.match(
      /(?:best regards|regards|thanks|thank you|sincerely|hormat kami|salam),?\s*\n+\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i
    );
    if (sigMatch && !GENERIC_SENDER_NAMES.has(sigMatch[1].toLowerCase())) {
      contactPerson = sigMatch[1].trim();
    }
  }

  const phoneMatch = text.match(/(?:tel|phone|ph|hp|wa|whatsapp|mobile|call)\s*[:.]?\s*(\+?[\d][\d\s\-().]{7,18}\d)/i);
  const contactPhone = phoneMatch ? phoneMatch[1].replace(/\s+/g, ' ').trim() : null;

  return { contactPerson, contactPhone };
}

function parsePipeTables(text: string): ExtractedProductLine[] {
  const lines = text.split('\n');
  const products: ExtractedProductLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line.startsWith('|') || !line.endsWith('|')) {
      i += 1;
      continue;
    }

    const tableRows: string[][] = [];
    while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
      const cells = lines[i]
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      // Skip markdown separator rows like | --- | --- |
      if (!cells.every((c) => /^[-:\s]+$/.test(c))) {
        tableRows.push(cells);
      }
      i += 1;
    }

    if (tableRows.length < 2) continue;

    const headers = tableRows[0].map((h) => h.toLowerCase());
    const findCol = (patterns: RegExp[]) =>
      headers.findIndex((h) => patterns.some((p) => p.test(h)));

    const idxProd = findCol([/product|material|item\s*name|nama|description|chemical|api/]);
    const idxSpec = findCol([/spec|grade|pharmacop/]);
    const idxQty = findCol([/qty|quantity|jumlah|vol/]);
    const idxUnit = findCol([/unit|satuan|uom/]);
    const idxMaker = findCol([/factory|manufacturer|maker|supplier|brand|make/]);
    const idxOrigin = findCol([/origin|country|negara/]);
    const idxDate = findCol([/arrival|delivery\s*date|tgl\s*datang|eta|etd|due/]);
    const idxTerms = findCol([/term|incoterm|fob|cif/]);

    if (idxProd === -1 && idxQty === -1) continue;

    let lastProductName = '';
    for (let r = 1; r < tableRows.length; r += 1) {
      const row = tableRows[r];
      const rawName = idxProd >= 0 ? (row[idxProd] || '').trim() : '';
      const productName = rawName || lastProductName;
      if (rawName) lastProductName = rawName;
      if (!productName) continue;

      const qtyVal = idxQty >= 0 ? (row[idxQty] || '').trim() : '';
      const unitVal = idxUnit >= 0 ? (row[idxUnit] || '').trim() : '';
      const quantity = qtyVal && unitVal && !qtyVal.toLowerCase().includes(unitVal.toLowerCase())
        ? `${qtyVal} ${unitVal}`.trim()
        : qtyVal;

      const rawOrigin = idxOrigin >= 0 ? (row[idxOrigin] || '').trim() : '';
      const rawMaker = idxMaker >= 0 ? (row[idxMaker] || '').trim() : '';
      const rawDate = idxDate >= 0 ? (row[idxDate] || '').trim() : '';

      products.push({
        productName,
        specification: idxSpec >= 0 && row[idxSpec] ? row[idxSpec].trim() : null,
        quantity,
        make: rawMaker || null,
        supplierName: rawMaker || null,
        supplierCountry: rawOrigin || null,
        deliveryDate: parseFlexibleDateToIso(rawDate),
        deliveryTerms: idxTerms >= 0 && row[idxTerms] ? row[idxTerms].trim() : null,
        purchasePrice: null,
        purchasePriceCurrency: null,
        offeredPrice: null,
        offeredPriceCurrency: null,
        itemNumber: null,
        etdPo: null,
      });
    }
  }

  return products;
}

function parseKeyValueProduct(primaryText: string, subject: string): ExtractedProductLine | null {
  const getField = (re: RegExp): string | null => {
    const m = primaryText.match(re);
    return m && m[1] ? m[1].trim() : null;
  };

  let productName =
    getField(/(?:product(?:\s*name)?|material|item|nama\s*barang)\s*[:|-]\s*([^\n]+)/i) ||
    '';

  const qtyRaw = getField(/(?:quantity|qty|jumlah)\s*[:|-]\s*([^\n]+)/i) || '';
  const unitRaw = getField(/(?:unit|satuan)\s*[:|-]\s*([^\n]+)/i) || '';
  let quantity = qtyRaw;
  if (qtyRaw && unitRaw && !qtyRaw.toLowerCase().includes(unitRaw.toLowerCase())) {
    quantity = `${qtyRaw} ${unitRaw}`.trim();
  }
  if (!quantity) {
    const inlineQty = primaryText.match(/\b(\d+(?:[.,]\d+)?\s*(?:kg|kgs|g|gram|mt|tons?|l|liters?|ml|drums?|bags?))\b/i);
    if (inlineQty) quantity = inlineQty[1].toUpperCase();
  }

  const specification = getField(/(?:specification|spec|grade)\s*[:|-]\s*([^\n]+)/i);
  const supplierName = getField(/(?:factory|manufacturer|maker|supplier)\s*[:|-]\s*([^\n]+)/i);
  const supplierCountry = getField(/(?:origin|country(?:\s*of\s*origin)?)\s*[:|-]\s*([^\n]+)/i);
  const deliveryTerms = getField(/(?:delivery\s*terms?|incoterms?)\s*[:|-]\s*([^\n]+)/i);
  const dateRaw = getField(
    /(?:requested\s*arrival|expected\s*arrival|arrival\s*date|delivery\s*date|tgl\s*datang|eta|need\s*by)\s*[:|-]\s*([^\n]+)/i
  );
  const deliveryDate = parseFlexibleDateToIso(dateRaw);

  if (!productName && subject) {
    // e.g. Subject "Oxomemazine" or "Inquiry for Oxomemazine Hydrochloride"
    const cleanedSubj = subject
      .replace(/^(?:re|fwd|fw)\s*:\s*/gi, '')
      .replace(/^(?:inquiry|quotation|rfq|request(?:\s+for)?)\s*(?:for|of)?\s*/gi, '')
      .trim();
    if (cleanedSubj && cleanedSubj.length <= 80) {
      productName = cleanedSubj;
    }
  }

  if (!productName && !quantity && !supplierName) return null;

  return {
    productName,
    specification,
    quantity,
    make: supplierName,
    supplierName,
    supplierCountry,
    deliveryDate,
    deliveryTerms,
    purchasePrice: null,
    purchasePriceCurrency: null,
    offeredPrice: null,
    offeredPriceCurrency: null,
    itemNumber: null,
    etdPo: null,
  };
}

/**
 * Builds clean Remarks containing ONLY extra commercial/packaging/regulatory
 * notes not already captured in structured fields. Never dumps the email body.
 */
export function buildCleanRemarks(
  primaryText: string,
  attachments?: EmailAttachmentMeta[] | null
): string | null {
  const notes: string[] = [];

  const packagingMatch = primaryText.match(/(?:packaging|packing)\s*(?:requirement|note|detail)?\s*[:|-]\s*([^\n]+)/i);
  if (packagingMatch) {
    notes.push(`Packaging: ${packagingMatch[1].trim()}`);
  }

  const specialMatch = primaryText.match(/(?:special\s*(?:instruction|requirement|note)|commercial\s*condition|halal|gmp\s*cert)[^\n]*/i);
  if (specialMatch && !notes.some((n) => n.includes(specialMatch[0].trim()))) {
    notes.push(specialMatch[0].trim());
  }

  if (Array.isArray(attachments) && attachments.length > 0) {
    const names = attachments.map((a) => a.filename).filter(Boolean);
    if (names.length > 0) {
      notes.push(`Attachments: ${names.join(', ')}`);
    }
  }

  return notes.length > 0 ? notes.join('; ') : null;
}

/**
 * Deterministic email-to-inquiry extractor (works offline, in tests, and as
 * enrichment/fallback for parse-pharma-email).
 */
export function extractInquiryFromEmail(input: EmailExtractionInput): ExtractedEmailInquiry {
  const structuredBody = input.emailBodyHtml
    ? htmlToStructuredEmailText(input.emailBodyHtml)
    : input.emailBody || '';

  const { primary } = splitPrimaryAndQuotedText(structuredBody || input.emailBody || '');
  const searchText = primary || structuredBody || input.emailBody || '';

  const tableProducts = parsePipeTables(searchText);
  const kvProduct = tableProducts.length === 0 ? parseKeyValueProduct(searchText, input.emailSubject) : null;
  const products = tableProducts.length > 0 ? tableProducts : kvProduct ? [kvProduct] : [];
  const firstProd = products[0] || null;

  // Date intelligence: NEVER fall back to receivedDate
  let deliveryDateExpected = firstProd?.deliveryDate || null;
  if (!deliveryDateExpected) {
    const dateLineMatch = searchText.match(
      /(?:requested\s*arrival|expected\s*arrival|arrival\s*date|delivery\s*date|tgl\s*datang|eta|need\s*by)\s*[:|-]\s*([^\n]+)/i
    );
    if (dateLineMatch) {
      deliveryDateExpected = parseFlexibleDateToIso(dateLineMatch[1]);
    }
  }

  const coaRequested = /\bcoa\b|certificate\s+of\s+analysis/i.test(searchText);
  const msdsRequested = /\bmsds\b|\bsds\b|safety\s+data\s+sheet/i.test(searchText);
  const sampleRequested = /\bsample\b|\bsampel\b/i.test(searchText);
  const agencyLetterRequested = /agency\s+letter|surat\s+penunjukan|authorization\s+letter/i.test(searchText);
  const priceRequested =
    /\bprice\b|\bquot(?:e|ation)\b|\bpenawaran\b|\bharga\b|\brfq\b/i.test(searchText) ||
    (!coaRequested && !msdsRequested && !sampleRequested && !agencyLetterRequested);
  const otherRequests = /\bdmf\b|\bhalal\b|\bgmp\b|stability\s+data/i.test(searchText);

  const purposeIcons: string[] = [];
  if (priceRequested) purposeIcons.push('price');
  if (coaRequested) purposeIcons.push('coa');
  if (msdsRequested) purposeIcons.push('msds');
  if (sampleRequested) purposeIcons.push('sample');

  const inferredCompany = inferCompanyFromText(searchText);
  const companyName =
    normalizeCompanyCandidate(input.knownCompanyName) ||
    normalizeCompanyCandidate(inferredCompany) ||
    normalizeCompanyCandidate(input.fromName, input.fromEmail);

  const { contactPerson, contactPhone } = inferContactFromSignature(searchText, input.fromName);

  const missingFields: string[] = [];
  const uncertainFields: string[] = [];
  if (!companyName) missingFields.push('Customer Name');
  if (!firstProd?.productName) missingFields.push('Product Name');
  if (!firstProd?.quantity) missingFields.push('Quantity');
  if (!firstProd?.specification) missingFields.push('Specification');
  if (!firstProd?.purchasePrice) missingFields.push('Purchase Price');
  if (!firstProd?.offeredPrice) missingFields.push('Offered Price');
  if (!deliveryDateExpected) uncertainFields.push('Delivery Date');

  const isIndonesian = /\b(penawaran|harga|tgl\s*datang|satuan|jumlah|permintaan|bahan\s*baku)\b/i.test(searchText);
  const urgency: 'low' | 'medium' | 'high' | 'urgent' = /\burgent\b|\basap\b|\bsegera\b/i.test(searchText)
    ? 'urgent'
    : 'medium';

  const hasCore = Boolean(firstProd?.productName && firstProd?.quantity);
  const confidence: 'high' | 'medium' | 'low' = hasCore && companyName ? 'high' : hasCore ? 'medium' : 'low';
  const confidenceScore = confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.7 : 0.35;

  return {
    products,
    productName: firstProd?.productName || '',
    specification: firstProd?.specification || null,
    quantity: firstProd?.quantity || '',
    supplierName: firstProd?.supplierName || null,
    supplierCountry: firstProd?.supplierCountry || null,
    companyName,
    contactPerson,
    contactEmail: input.fromEmail || '',
    contactPhone,
    coaRequested,
    msdsRequested,
    sampleRequested,
    priceRequested,
    agencyLetterRequested,
    otherRequests,
    purposeIcons,
    deliveryDateExpected,
    deliveryTerms: firstProd?.deliveryTerms || null,
    purchasePrice: firstProd?.purchasePrice || null,
    purchasePriceCurrency: firstProd?.purchasePriceCurrency || null,
    offeredPrice: firstProd?.offeredPrice || null,
    offeredPriceCurrency: firstProd?.offeredPriceCurrency || null,
    urgency,
    remarks: buildCleanRemarks(searchText, input.attachments),
    confidence,
    confidenceScore,
    detectedLanguage: isIndonesian ? 'Indonesian' : 'English',
    missingFields,
    uncertainFields,
  };
}
