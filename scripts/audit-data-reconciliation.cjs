const { Client } = require('pg');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

const COUNTRY_NAMES = {
  ID: 'Indonesia',
  IN: 'India',
  GB: 'United Kingdom',
  KR: 'South Korea',
  US: 'United States',
  CA: 'Canada',
  SG: 'Singapore',
  MY: 'Malaysia',
  CN: 'China',
  JP: 'Japan',
  DE: 'Germany',
  AU: 'Australia',
  FR: 'France',
  IT: 'Italy',
  CH: 'Switzerland',
  NL: 'Netherlands',
  TH: 'Thailand',
  VN: 'Vietnam',
  PH: 'Philippines',
  AE: 'United Arab Emirates'
};

function parsePhoneEntries(raw, defaultContact, defaultDept) {
  if (!raw) return [];
  const entries = [];
  const segments = raw.split(/[\n;,|]+|\s+\/\s+/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    let contactPerson = defaultContact || null;
    let department = defaultDept || null;
    let extension = undefined;
    let phonePart = trimmed;
    const extMatch = phonePart.match(/(?:ext\.?|x|ex)\s*[:#]?\s*(\d+)/i);
    if (extMatch) {
      extension = extMatch[1];
      phonePart = phonePart.replace(/(?:ext\.?|x|ex)\s*[:#]?\s*\d+/i, '').trim();
    }
    const cleanDigits = phonePart.replace(/[^\d+]/g, '');
    if (cleanDigits.length >= 5) {
      entries.push({ raw: trimmed, cleaned: cleanDigits, contactPerson, department, extension });
    }
  }
  return entries;
}

function classifyPhone(rawPhone, trustedRegion = 'ID') {
  if (!rawPhone || !rawPhone.trim()) {
    return {
      rawPhone: '',
      isValid: false,
      isPossible: false,
      e164: null,
      countryCode: null,
      callingCode: null,
      countryName: 'Missing',
      phoneType: 'missing',
      validationReason: 'No phone number provided',
      needsManualReview: false,
      isWhatsAppEligibleCandidate: false,
    };
  }

  const trimmed = rawPhone.trim();
  const digitsOnly = trimmed.replace(/[^\d+]/g, '');

  // Check for malformed +0 numbers, e.g. +021...
  if (digitsOnly.startsWith('+0')) {
    return {
      rawPhone,
      isValid: false,
      isPossible: false,
      e164: null,
      countryCode: null,
      callingCode: null,
      countryName: 'Needs Review',
      phoneType: 'invalid',
      validationReason: 'Malformed international format (+0 is not a valid country calling code)',
      needsManualReview: true,
      isWhatsAppEligibleCandidate: false,
    };
  }

  // If number starts with +, parse without forcing a region
  let parsed = null;
  if (digitsOnly.startsWith('+')) {
    parsed = parsePhoneNumberFromString(trimmed);
  } else {
    // National format without +: only use trustedRegion if available
    if (trustedRegion) {
      parsed = parsePhoneNumberFromString(trimmed, trustedRegion);
    } else {
      return {
        rawPhone,
        isValid: false,
        isPossible: false,
        e164: null,
        countryCode: null,
        callingCode: null,
        countryName: 'Needs Review',
        phoneType: 'needs_review',
        validationReason: 'National format number without a trusted regional setting',
        needsManualReview: true,
        isWhatsAppEligibleCandidate: false,
      };
    }
  }

  if (!parsed) {
    return {
      rawPhone,
      isValid: false,
      isPossible: false,
      e164: null,
      countryCode: null,
      callingCode: null,
      countryName: 'Unknown / Invalid',
      phoneType: 'invalid',
      validationReason: 'Failed to parse into an international or recognized national number',
      needsManualReview: true,
      isWhatsAppEligibleCandidate: false,
    };
  }

  const country = parsed.country || null;
  const callingCode = parsed.countryCallingCode ? '+' + parsed.countryCallingCode : null;
  const countryName = country && COUNTRY_NAMES[country] ? COUNTRY_NAMES[country] : (country || 'Unknown');
  const type = parsed.getType(); // MOBILE, FIXED_LINE, UAN, TOLL_FREE, etc.
  const isValid = parsed.isValid();
  const isPossible = parsed.isPossible();
  const e164 = isValid ? parsed.number : null;

  let phoneType = 'unknown';
  let isWhatsAppEligibleCandidate = false;
  let validationReason = '';

  if (type === 'MOBILE') {
    phoneType = 'mobile';
    if (isValid) {
      isWhatsAppEligibleCandidate = true;
      validationReason = 'Valid mobile number (' + countryName + ')';
    } else {
      validationReason = 'Invalid mobile number structure for ' + countryName;
    }
  } else if (type === 'FIXED_LINE') {
    phoneType = 'fixed_line';
    validationReason = 'Fixed line / Landline (' + countryName + ')';
  } else if (type === 'FIXED_LINE_OR_MOBILE') {
    phoneType = 'fixed_line_or_mobile';
    validationReason = 'Ambiguous fixed line or mobile (' + countryName + ')';
  } else if (type === 'UAN' || type === 'TOLL_FREE' || type === 'SHARED_COST' || type === 'PREMIUM_RATE' || type === 'VOIP' || type === 'PERSONAL_NUMBER') {
    phoneType = 'service_special';
    validationReason = 'Special / Service / UAN number (' + type + ', ' + countryName + ')';
  } else {
    if (!isValid) {
      phoneType = 'invalid';
      validationReason = 'Unrecognized or invalid number structure for ' + countryName;
    } else {
      phoneType = 'needs_review';
      validationReason = 'Number type undetermined (' + countryName + ')';
    }
  }

  return {
    rawPhone,
    isValid,
    isPossible,
    e164,
    countryCode: country,
    callingCode,
    countryName,
    phoneType,
    validationReason,
    needsManualReview: !isValid || phoneType === 'needs_review' || phoneType === 'fixed_line_or_mobile',
    isWhatsAppEligibleCandidate,
  };
}

async function runAudit() {
  const dbUrl = process.env.READONLY_AUDIT_DB_URL || process.env.READONLY_AUDIT_DB_URL;
  if (!dbUrl) {
    console.error('ERROR: SUPABASE_DB_URL environment variable is required.');
    process.exit(1);
  }
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  const { rows } = await client.query('SELECT id, company_name, contact_person, email, phone, mobile, landline, city, country, notes, customer_type, is_active FROM crm_contacts WHERE is_active = true ORDER BY company_name');
  await client.end();

  console.log('Auditing', rows.length, 'active contacts...');

  const allRecords = [];
  for (const c of rows) {
    const rawSources = [
      { raw: c.mobile, defaultDept: 'Purchasing' },
      { raw: c.phone, defaultDept: 'General Office' }
    ].filter(s => s.raw && s.raw.trim());

    const noteText = (c.notes || '').toLowerCase();
    const isOptedOut = noteText.includes('opt-out') || noteText.includes('optout') || noteText.includes('stop wa') || noteText.includes('unsubscribe');
    const isExplicitOptIn = noteText.includes('opt-in') || noteText.includes('verified wa');
    const consentStatus = isOptedOut ? 'OPTED_OUT' : isExplicitOptIn ? 'GRANTED' : 'UNKNOWN';

    const seenCleaned = new Set();
    const parsedList = [];
    for (const src of rawSources) {
      const parsed = parsePhoneEntries(src.raw, c.contact_person, src.defaultDept);
      for (const p of parsed) {
        if (!seenCleaned.has(p.cleaned)) {
          seenCleaned.add(p.cleaned);
          parsedList.push(p);
        }
      }
    }

    if (parsedList.length === 0) {
      allRecords.push({
        contactId: c.id,
        companyName: c.company_name,
        contactPerson: c.contact_person,
        city: c.city,
        rawPhone: '',
        classification: classifyPhone(''),
        consentStatus,
      });
    } else {
      for (const p of parsedList) {
        allRecords.push({
          contactId: c.id,
          companyName: c.company_name,
          contactPerson: p.contactPerson || c.contact_person,
          city: c.city,
          rawPhone: p.raw,
          classification: classifyPhone(p.raw, 'ID'),
          consentStatus,
        });
      }
    }
  }

  console.log('Total evaluated records:', allRecords.length);

  // Group by e164 / normalized
  const e164Map = new Map();
  for (const r of allRecords) {
    if (r.classification.e164) {
      const key = r.classification.e164;
      if (!e164Map.has(key)) e164Map.set(key, []);
      e164Map.get(key).push(r);
    }
  }

  // 1. Distinct CRM companies
  const distinctCompanies = new Set(rows.map(r => r.company_name)).size;
  // 2. Distinct CRM contact records
  const distinctContacts = rows.length;
  // 3. Distinct raw phone records
  const distinctRawPhoneRecords = allRecords.filter(r => r.rawPhone).length;
  // 4. Distinct non-empty raw phone values
  const distinctNonEmptyRawValues = new Set(allRecords.map(r => r.rawPhone).filter(Boolean)).size;
  // 5. Valid normalized E.164 records
  const validNormalizedE164Records = allRecords.filter(r => r.classification.e164).length;
  // 6. Unique normalized telephone numbers
  const uniqueNormalizedE164Numbers = e164Map.size;

  let duplicateGroups = 0;
  let excessDuplicateRecords = 0;
  for (const [e164, records] of e164Map.entries()) {
    if (records.length > 1) {
      duplicateGroups++;
      excessDuplicateRecords += (records.length - 1);
    }
  }

  const mobileRecords = allRecords.filter(r => r.classification.phoneType === 'mobile');
  const uniqueMobiles = new Set(mobileRecords.map(r => r.classification.e164).filter(Boolean)).size;
  const fixedLineRecords = allRecords.filter(r => r.classification.phoneType === 'fixed_line');
  const serviceRecords = allRecords.filter(r => r.classification.phoneType === 'service_special');
  const invalidRecords = allRecords.filter(r => r.classification.phoneType === 'invalid');
  const missingRecords = allRecords.filter(r => r.classification.phoneType === 'missing');
  const reviewRecords = allRecords.filter(r => r.classification.needsManualReview);

  // Distinct contacts linked to eligible mobile numbers
  const contactsWithEligibleMobile = new Set(mobileRecords.map(r => r.contactId)).size;

  // Consent stats
  const consentGranted = allRecords.filter(r => r.classification.phoneType === 'mobile' && r.consentStatus === 'GRANTED').length;
  const consentUnknown = allRecords.filter(r => r.classification.phoneType === 'mobile' && r.consentStatus === 'UNKNOWN').length;
  const consentOptedOut = allRecords.filter(r => r.classification.phoneType === 'mobile' && r.consentStatus === 'OPTED_OUT').length;

  // Duplicates with ambiguous company associations
  let ambiguousCompanyDuplicateRecords = 0;
  for (const [e164, records] of e164Map.entries()) {
    if (records.length > 1) {
      const comps = new Set(records.map(r => r.companyName));
      if (comps.size > 1) {
        ambiguousCompanyDuplicateRecords += records.length;
      }
    }
  }

  // Country counts
  const countryCounts = {};
  for (const r of allRecords) {
    const cName = r.classification.countryName;
    countryCounts[cName] = (countryCounts[cName] || 0) + 1;
  }

  console.log('--- 20 RECONCILED ENTITY COUNTS ---');
  console.log('1. Distinct CRM companies:', distinctCompanies);
  console.log('2. Distinct CRM contact records:', distinctContacts);
  console.log('3. Distinct raw phone records:', distinctRawPhoneRecords);
  console.log('4. Distinct non-empty raw phone values:', distinctNonEmptyRawValues);
  console.log('5. Valid normalized E.164 phone records:', validNormalizedE164Records);
  console.log('6. Unique normalized telephone numbers:', uniqueNormalizedE164Numbers);
  console.log('7. Duplicate phone-number groups:', duplicateGroups);
  console.log('8. Excess duplicate phone records:', excessDuplicateRecords);
  console.log('9. Distinct mobile numbers (unique E.164):', uniqueMobiles, '| mobile records:', mobileRecords.length);
  console.log('10. Distinct fixed-line records:', fixedLineRecords.length);
  console.log('11. Service/special records:', serviceRecords.length);
  console.log('12. Invalid numbers:', invalidRecords.length);
  console.log('13. Missing phone records:', missingRecords.length);
  console.log('14. Unknown/manual-review records:', reviewRecords.length);
  console.log('15. Distinct contacts linked to eligible mobile numbers:', contactsWithEligibleMobile);
  console.log('16. Unique campaign-recipient candidates after deduplication:', uniqueMobiles);
  console.log('17. Recipients with recorded individual WhatsApp consent (GRANTED):', consentGranted);
  console.log('18. Recipients excluded due to opt-out:', consentOptedOut);
  console.log('19. Recipients excluded due to unknown consent:', consentUnknown);
  console.log('20. Recipients with ambiguous cross-company association:', ambiguousCompanyDuplicateRecords);
  console.log('\n--- COUNTRY BREAKDOWN ---');
  console.log(countryCounts);
}

runAudit();

