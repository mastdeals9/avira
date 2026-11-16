// tests/canonical-phone-and-campaign-safety.test.mjs
//
// Comprehensive Automated Regression Test Suite for:
// 1. Canonical Shared International Phone Classification Service (libphonenumber-js)
//    - Directly imports and executes production classifyCanonicalPhone from src/services/crm/canonicalPhoneService.ts
// 2. Strict Separation of Phone Country, Company City, and Phone Type
// 3. Complete Elimination of +62 -> +1 and Landline -> International Mobile Defects
// 4. Campaign Safety Gates (Deduplication, Consent Enforcement, Transport & UI Dispatch Blocking)
//    - Directly imports and executes CampaignComplianceService and WhatsAppTransportService
// 5. Tablet 768x1024 Toolbar Accessibility and Truthful Preview Mode

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import createJiti from 'jiti';

// Initialize jiti to dynamically import production TypeScript modules without test-only helpers
const jiti = createJiti(import.meta.url);

// 1. Import REAL production canonical phone parser and metadata
const {
  classifyCanonicalPhone,
  ISO_COUNTRY_NAMES,
  getCountryMetadata,
} = jiti('../src/services/crm/canonicalPhoneService.ts');

// 2. Import REAL production campaign compliance service
const {
  CampaignComplianceService,
} = jiti('../src/services/crm/campaignComplianceService.ts');

// 3. Import REAL production WhatsApp transport service
const {
  WhatsAppTransportService,
} = jiti('../src/services/whatsapp/whatsappTransportService.ts');

// Load source files for static architecture & invariant checks
const canonicalPhoneSrc = readFileSync('src/services/crm/canonicalPhoneService.ts', 'utf8');
const phoneValidationSrc = readFileSync('src/utils/phoneValidation.ts', 'utf8');
const complianceSrc = readFileSync('src/services/crm/campaignComplianceService.ts', 'utf8');
const transportSrc = readFileSync('src/services/whatsapp/whatsappTransportService.ts', 'utf8');
const campaignsWorkspaceSrc = readFileSync('src/components/crm/campaigns/CrmCampaignsWorkspace.tsx', 'utf8');
const phoneModalSrc = readFileSync('src/components/crm/campaigns/PhoneAuditCorrectionModal.tsx', 'utf8');
const chatAreaSrc = readFileSync('src/components/crm/inbox/WhatsAppChatArea.tsx', 'utf8');
const wasenderSrc = readFileSync('src/components/crm/campaigns/WASenderBulkWorkspace.tsx', 'utf8');

describe('Part 1 & 6: Mandatory 29 Canonical Phone Number Cases (Executing Real Production Parser)', () => {

  test('Case 1: Indonesian +62 mobile (+6282181111128)', () => {
    const raw = '+6282181111128';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw, 'Raw input must remain unchanged');
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneCountryName, 'Indonesia');
    assert.equal(res.phoneType, 'mobile');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+6282181111128');
    assert.equal(res.isWhatsAppEligibleCandidate, true);
    assert.equal(res.needsManualReview, false);
  });

  test('Case 2: Indonesian 08 national-format mobile with trusted ID region (081293739515)', () => {
    const raw = '081293739515';
    const res = classifyCanonicalPhone(raw, { trustedRegion: 'ID' });
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneCountryName, 'Indonesia');
    assert.equal(res.phoneType, 'mobile');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+6281293739515');
    assert.equal(res.isWhatsAppEligibleCandidate, true);
  });

  test('Case 3: Indonesian +62 21 fixed-line (+62 21 5678 1234)', () => {
    const raw = '+62 21 5678 1234';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneCountryName, 'Indonesia');
    assert.equal(res.phoneType, 'fixed_line');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+622156781234');
    assert.equal(res.isWhatsAppEligibleCandidate, false, 'Fixed line must NEVER be WA eligible');
  });

  test('Case 4: Indonesian 021 fixed-line with trusted ID region (021 5678 1234)', () => {
    const raw = '021 5678 1234';
    const res = classifyCanonicalPhone(raw, { trustedRegion: 'ID' });
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneCountryName, 'Indonesia');
    assert.equal(res.phoneType, 'fixed_line');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+622156781234');
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 5: Indonesian +62 22 Bandung fixed-line (+62 22 123 4567)', () => {
    const raw = '+62 22 123 4567';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneCountryName, 'Indonesia');
    assert.equal(res.phoneType, 'fixed_line');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+62221234567');
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 6: Indonesian 022 Bandung fixed-line with trusted ID region (022 123 4567)', () => {
    const raw = '022 123 4567';
    const res = classifyCanonicalPhone(raw, { trustedRegion: 'ID' });
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneCountryName, 'Indonesia');
    assert.equal(res.phoneType, 'fixed_line');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+62221234567');
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 7: Indonesian +62 1500 service/special number (+62 1500 123)', () => {
    const raw = '+62 1500 123';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneCountryName, 'Indonesia');
    assert.equal(res.phoneType, 'service_special');
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 8: Malformed +021 (+021 5678 1234) — invalid/review, NEVER foreign country', () => {
    const raw = '+021 5678 1234';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.isValid, false);
    assert.equal(res.countryCode, null, 'Must not assign foreign country');
    assert.equal(res.phoneType, 'invalid');
    assert.equal(res.needsManualReview, true);
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 9: Indian +91 22 Mumbai fixed-line (+91 22 2654 3210)', () => {
    const raw = '+91 22 2654 3210';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'IN');
    assert.equal(res.callingCode, '+91');
    assert.equal(res.phoneCountryName, 'India');
    assert.equal(res.phoneType, 'fixed_line');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+912226543210');
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 10: Indian +91 mobile (+91 98201 12345)', () => {
    const raw = '+91 98201 12345';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'IN');
    assert.equal(res.callingCode, '+91');
    assert.equal(res.phoneCountryName, 'India');
    assert.equal(res.phoneType, 'mobile');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+919820112345');
    assert.equal(res.isWhatsAppEligibleCandidate, true);
  });

  test('Case 11: UK +44 (+44 20 7946 0958)', () => {
    const raw = '+44 20 7946 0958';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'GB');
    assert.equal(res.callingCode, '+44');
    assert.equal(res.phoneCountryName, 'United Kingdom');
    assert.equal(res.phoneType, 'fixed_line');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+442079460958');
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 12: South Korean +82 mobile (+82 10 1234 5678)', () => {
    const raw = '+82 10 1234 5678';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'KR');
    assert.equal(res.callingCode, '+82');
    assert.equal(res.phoneCountryName, 'South Korea');
    assert.equal(res.phoneType, 'mobile');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+821012345678');
    assert.equal(res.isWhatsAppEligibleCandidate, true);
  });

  test('Case 13: Numbers with spaces (+62 857 8012 2860)', () => {
    const raw = '+62 857 8012 2860';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneType, 'mobile');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+6285780122860');
  });

  test('Case 14: Numbers with hyphens (+62-823-6819-8900)', () => {
    const raw = '+62-823-6819-8900';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneType, 'mobile');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+6282368198900');
  });

  test('Case 15: Numbers with brackets ((+62) 812 9373 9515)', () => {
    const raw = '(+62) 812 9373 9515';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.callingCode, '+62');
    assert.equal(res.phoneType, 'mobile');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+6281293739515');
  });

  test('Case 16: Leading/trailing whitespace ("  +6281293739515  ")', () => {
    const raw = '  +6281293739515  ';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.rawPhone, raw);
    assert.equal(res.countryCode, 'ID');
    assert.equal(res.phoneType, 'mobile');
    assert.equal(res.isValid, true);
    assert.equal(res.e164, '+6281293739515');
  });

  test('Case 17: Empty number ("")', () => {
    const raw = '';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.phoneType, 'missing');
    assert.equal(res.isValid, false);
    assert.equal(res.e164, null);
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 18: Whitespace-only number ("   ")', () => {
    const raw = '   ';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.phoneType, 'missing');
    assert.equal(res.isValid, false);
    assert.equal(res.e164, null);
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 19: Invalid characters ("N/A or None")', () => {
    const raw = 'N/A or None';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.phoneType, 'invalid');
    assert.equal(res.isValid, false);
    assert.equal(res.needsManualReview, true);
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 20: Impossible number length ("+62 812 3")', () => {
    const raw = '+62 812 3';
    const res = classifyCanonicalPhone(raw);
    assert.equal(res.isValid, false);
    assert.equal(res.phoneType, 'invalid');
    assert.equal(res.isWhatsAppEligibleCandidate, false);
  });

  test('Case 21: Shared +1 numbering plan region resolution (+1 202 555 0123 vs +1 416 555 0123)', () => {
    const usNum = '+1 202 555 0123';
    const caNum = '+1 416 555 0123';
    const usRes = classifyCanonicalPhone(usNum);
    const caRes = classifyCanonicalPhone(caNum);
    assert.equal(usRes.countryCode, 'US');
    assert.equal(usRes.phoneCountryName, 'United States');
    assert.equal(caRes.countryCode, 'CA');
    assert.equal(caRes.phoneCountryName, 'Canada');
  });

  test('Case 22: Multiple numbers for one company parsed independently', () => {
    const val1 = classifyCanonicalPhone('021 5678 1234', { trustedRegion: 'ID' });
    const val2 = classifyCanonicalPhone('081293739515', { trustedRegion: 'ID' });
    assert.equal(val1.phoneType, 'fixed_line');
    assert.equal(val1.isWhatsAppEligibleCandidate, false);
    assert.equal(val2.phoneType, 'mobile');
    assert.equal(val2.isWhatsAppEligibleCandidate, true);
  });

  test('Case 23: Duplicate number across two CRM contacts', () => {
    const num = '+6281293739515';
    const res1 = classifyCanonicalPhone(num);
    const res2 = classifyCanonicalPhone(num);
    assert.equal(res1.e164, res2.e164);
  });

  test('Case 24: Duplicate number across two companies', () => {
    const num = '+622156781234';
    const res1 = classifyCanonicalPhone(num);
    const res2 = classifyCanonicalPhone(num);
    assert.equal(res1.e164, res2.e164);
  });

  test('Case 25: One landline and one mobile on the same company', () => {
    const landline = classifyCanonicalPhone('024 1234567', { trustedRegion: 'ID' });
    const mobile = classifyCanonicalPhone('081293739515', { trustedRegion: 'ID' });
    assert.equal(landline.phoneType, 'fixed_line');
    assert.equal(mobile.phoneType, 'mobile');
  });

  test('Case 26: Invalid number with a company address in Indonesia (never converts to valid)', () => {
    const raw = '12345';
    const res = classifyCanonicalPhone(raw, { companyCity: 'Jakarta', trustedRegion: 'ID' });
    assert.equal(res.isValid, false);
    assert.equal(res.isWhatsAppEligibleCandidate, false);
    assert.equal(res.companyCity, 'Jakarta');
    assert.notEqual(res.phoneCountryName, 'Jakarta', 'City must never be returned as country');
  });

  test('Case 27: National number without a trusted default region (both omitted and explicit null)', () => {
    const raw = '021 5678 1234';
    // Sub-case A: explicitly null trustedRegion
    const resNull = classifyCanonicalPhone(raw, { trustedRegion: null });
    assert.equal(resNull.phoneType, 'needs_review');
    assert.equal(resNull.needsManualReview, true);
    assert.equal(resNull.isValid, false);
    assert.equal(resNull.isWhatsAppEligibleCandidate, false);
    assert.equal(resNull.phoneCountryName, 'Needs Review');
    assert.equal(resNull.phoneCountryFlag, '❓');

    // Sub-case B: completely omitted options (undefined)
    const resOmitted = classifyCanonicalPhone(raw);
    assert.equal(resOmitted.phoneType, 'needs_review');
    assert.equal(resOmitted.needsManualReview, true);
    assert.equal(resOmitted.isValid, false);
    assert.equal(resOmitted.isWhatsAppEligibleCandidate, false);
    assert.equal(resOmitted.phoneCountryName, 'Needs Review');
    assert.equal(resOmitted.phoneCountryFlag, '❓');

    // Sub-case C: Indonesian mobile format without trusted region also requires review
    const resMobileOmitted = classifyCanonicalPhone('081293739515');
    assert.equal(resMobileOmitted.phoneType, 'needs_review');
    assert.equal(resMobileOmitted.isValid, false);
    assert.equal(resMobileOmitted.isWhatsAppEligibleCandidate, false);
  });

  test('Case 28: International prefix must override company location', () => {
    const raw = '+91 98201 12345';
    const res = classifyCanonicalPhone(raw, { companyCity: 'Jakarta' });
    assert.equal(res.countryCode, 'IN');
    assert.equal(res.phoneCountryName, 'India');
    assert.equal(res.companyCity, 'Jakarta', 'Stored CRM address preserved independently');
    assert.notEqual(res.phoneCountryName, 'Jakarta');
  });

  test('Case 29: Cross-company duplicate number ambiguity is blocked in compliance service via real execution', () => {
    // Execute CampaignComplianceService.validateAudience with cross-company duplicate
    const testCandidates = [
      {
        phone: '+6281293739515',
        companyName: 'PT Alpha Farma',
        consent: {
          phone: '+6281293739515',
          companyName: 'PT Alpha Farma',
          optInSource: 'contract',
          optInTimestamp: new Date().toISOString(),
          permittedCategories: ['customer_service', 'price_alerts'],
          isOptedOut: false,
        },
      },
      {
        phone: '+6281293739515',
        companyName: 'PT Beta Laboratories',
        consent: {
          phone: '+6281293739515',
          companyName: 'PT Beta Laboratories',
          optInSource: 'contract',
          optInTimestamp: new Date().toISOString(),
          permittedCategories: ['customer_service', 'price_alerts'],
          isOptedOut: false,
        },
      },
    ];

    const result = CampaignComplianceService.validateAudience(testCandidates, {
      permittedCategory: 'price_alerts',
    });

    // Both candidates must be excluded due to ambiguous company association
    assert.equal(result.eligibleRecipients.length, 0, 'No candidate may be eligible when number belongs to >1 company');
    assert.equal(result.excludedMissingConsent.length, 2);
    assert.match(result.excludedMissingConsent[0].reason, /Ambiguous company association/);
    assert.match(result.excludedMissingConsent[1].reason, /Ambiguous company association/);
  });
});

describe('Part 4: Campaign Compliance Service Real Execution Verification', () => {

  test('Deduplicates multiple contacts within the same company sharing one mobile number', () => {
    const testCandidates = [
      {
        phone: '+6281211112222',
        companyName: 'PT Kimia Bersama',
        contactPerson: 'Budi (Purchasing)',
        consent: {
          phone: '+6281211112222',
          companyName: 'PT Kimia Bersama',
          contactPerson: 'Budi (Purchasing)',
          optInSource: 'explicit_form',
          optInTimestamp: new Date().toISOString(),
          permittedCategories: ['price_alerts'],
          isOptedOut: false,
        },
      },
      {
        phone: '+6281211112222',
        companyName: 'PT Kimia Bersama',
        contactPerson: 'Siti (QA)',
        consent: {
          phone: '+6281211112222',
          companyName: 'PT Kimia Bersama',
          contactPerson: 'Siti (QA)',
          optInSource: 'explicit_form',
          optInTimestamp: new Date().toISOString(),
          permittedCategories: ['price_alerts'],
          isOptedOut: false,
        },
      },
    ];

    const result = CampaignComplianceService.validateAudience(testCandidates, {
      permittedCategory: 'price_alerts',
    });

    assert.equal(result.eligibleRecipients.length, 1, 'Only one recipient per unique E.164 permitted');
    assert.equal(result.excludedMissingConsent.length, 1);
    assert.match(result.excludedMissingConsent[0].reason, /Duplicate recipient suppressed/);
  });

  test('Suppresses opted-out numbers via runtime suppression list', () => {
    const optOutPhone = '+628999888777';
    CampaignComplianceService.registerOptOut(optOutPhone);
    assert.equal(CampaignComplianceService.isOptedOut(optOutPhone), true);

    const testCandidates = [
      {
        phone: optOutPhone,
        companyName: 'PT Farmasi Sentosa',
        consent: {
          phone: optOutPhone,
          companyName: 'PT Farmasi Sentosa',
          optInSource: 'explicit_form',
          optInTimestamp: new Date().toISOString(),
          permittedCategories: ['price_alerts'],
          isOptedOut: false, // Stored as false, but runtime registered opt-out takes precedence
        },
      },
    ];

    const result = CampaignComplianceService.validateAudience(testCandidates, {
      permittedCategory: 'price_alerts',
    });

    assert.equal(result.eligibleRecipients.length, 0);
    assert.equal(result.suppressedOptOuts.length, 1);
    assert.equal(result.suppressedOptOuts[0].isOptedOut, true);
  });

  test('Rejects candidates with unknown / missing individual consent', () => {
    const testCandidates = [
      {
        phone: '+6281355556666',
        companyName: 'PT Unconsented Pharma',
        consent: null, // Unknown individual consent
      },
    ];

    const result = CampaignComplianceService.validateAudience(testCandidates, {
      permittedCategory: 'price_alerts',
    });

    assert.equal(result.eligibleRecipients.length, 0);
    assert.equal(result.excludedMissingConsent.length, 1);
    assert.match(result.excludedMissingConsent[0].reason, /No verifiable opt-in consent record on file/);
  });

  test('Rejects fixed-line landline candidates from mobile broadcast campaigns', () => {
    const testCandidates = [
      {
        phone: '+622156781234',
        companyName: 'PT Jakarta Office',
        consent: {
          phone: '+622156781234',
          companyName: 'PT Jakarta Office',
          optInSource: 'explicit_form',
          optInTimestamp: new Date().toISOString(),
          permittedCategories: ['price_alerts'],
          isOptedOut: false,
        },
      },
    ];

    const result = CampaignComplianceService.validateAudience(testCandidates, {
      permittedCategory: 'price_alerts',
    });

    assert.equal(result.eligibleRecipients.length, 0);
    assert.equal(result.excludedMissingConsent.length, 1);
    assert.match(result.excludedMissingConsent[0].reason, /Excluded non-mobile number \(fixed_line\)/);
  });
});

describe('Part 4: WhatsApp Transport Service Real Execution Verification', () => {

  test('Blocks bulk / campaign dispatches at runtime returning BULK_DISPATCH_DISABLED', async () => {
    const resCampaign = await WhatsAppTransportService.sendMessage({
      to: '+6281293739515',
      text: 'Broadcast message',
      isCampaign: true,
    });

    assert.equal(resCampaign.success, false);
    assert.equal(resCampaign.errorCode, 'BULK_DISPATCH_DISABLED');
    assert.match(resCampaign.error, /Bulk WhatsApp dispatch is disabled/);

    const resBulk = await WhatsAppTransportService.sendMessage({
      to: '+6281293739515',
      text: 'Bulk message',
      isBulk: true,
    });

    assert.equal(resBulk.success, false);
    assert.equal(resBulk.errorCode, 'BULK_DISPATCH_DISABLED');
  });

  test('Permitted individually authorised campaign dispatch succeeds when consent is verified', async () => {
    WhatsAppTransportService.setConfig({ providerType: 'simulation' });

    const resAuthorized = await WhatsAppTransportService.sendMessage({
      to: '+6281293739515',
      text: 'Individually authorised campaign message',
      isCampaign: true,
      consentVerified: true,
    });

    assert.equal(resAuthorized.success, true);
    assert.equal(resAuthorized.isSimulation, true);
    assert.equal(resAuthorized.status, 'queued');
    assert.notEqual(resAuthorized.errorCode, 'BULK_DISPATCH_DISABLED');
  });

  test('Simulation mode truthfully reports simulated delivery and never claims real delivery', async () => {
    WhatsAppTransportService.setConfig({ providerType: 'simulation' });

    const res = await WhatsAppTransportService.sendMessage({
      to: '+6281293739515',
      text: 'Simulated 1-on-1 test message',
    });

    assert.equal(res.success, true);
    assert.equal(res.isSimulation, true);
    assert.equal(res.status, 'queued');
    assert.equal(res.rawResponse?.simulated, true);
    assert.equal(res.rawResponse?.simulationNotice, 'SIMULATED — NOT SENT TO CUSTOMER');

    const health = await WhatsAppTransportService.checkHealth();
    assert.equal(health.provider, 'simulation');
    assert.equal(health.isSimulation, true);
    assert.match(health.details, /Simulation Mode Active/);
  });
});

describe('Architecture & Implementation Invariants Verification', () => {

  test('CanonicalPhoneService uses libphonenumber-js/max and distinguishes countries/types', () => {
    assert.match(canonicalPhoneSrc, /from 'libphonenumber-js\/max'/);
    assert.match(canonicalPhoneSrc, /export function classifyCanonicalPhone/);
    assert.match(canonicalPhoneSrc, /digitsOnly\.startsWith\('\+0'\)/, 'Explicit +0 prefix check');
  });

  test('phoneValidation.ts imports and delegates to canonicalPhoneService', () => {
    assert.match(phoneValidationSrc, /from '\.\.\/services\/crm\/canonicalPhoneService\.ts'/);
    assert.match(phoneValidationSrc, /classifyCanonicalPhone\(rawNumber/);
    assert.match(phoneValidationSrc, /detectCountryInfo/, 'Exports detectCountryInfo');
  });

  test('PhoneAuditCorrectionModal.tsx separates Country, City, and Phone Type', () => {
    assert.match(phoneModalSrc, /const \[countryFilter, setCountryFilter\]/);
    assert.match(phoneModalSrc, /const \[cityFilter, setCityFilter\]/);
    assert.match(phoneModalSrc, /const \[phoneTypeFilter, setPhoneTypeFilter\]/);
    assert.match(phoneModalSrc, /distinctCountries/, 'Distinct country filter');
    assert.match(phoneModalSrc, /distinctCities/, 'Distinct city filter');
  });

  test('Campaigns Workspace: Bulk WhatsApp Dispatch Workflow and Safety Gates', () => {
    assert.match(campaignsWorkspaceSrc, /WASenderBulkWorkspace/);
    assert.match(wasenderSrc, /handleStartCampaign/);
    assert.match(wasenderSrc, /WHATSAPP_MEDIA_CAPTION_LIMIT/);
    assert.match(wasenderSrc, /WhatsApp Caption Limit Exceeded/);
  });

  test('Campaign Preview: Truthful preview with zero fake ticks or fake incoming replies', () => {
    assert.match(campaignsWorkspaceSrc, /PREVIEW — NOT SENT/, 'Shows explicit PREVIEW — NOT SENT badge');
    assert.doesNotMatch(campaignsWorkspaceSrc, /<span className="text-sky-500 font-bold">✓✓<\/span>/, 'Zero fake double ticks');
    assert.doesNotMatch(campaignsWorkspaceSrc, /Baik Pak, kami review dulu penawarannya/, 'No fake incoming customer reply');
    assert.doesNotMatch(campaignsWorkspaceSrc, /&bull;\s*online/, 'No fake online presence');
  });

  test('WhatsApp Transport Service: Blocks bulk/campaign dispatches and prevents fake delivery', () => {
    assert.match(transportSrc, /BULK_DISPATCH_DISABLED/);
    assert.match(transportSrc, /SIMULATED — NOT SENT TO CUSTOMER/);
  });

  test('WhatsAppChatArea.tsx: Tablet toolbar uses responsive wrapping to prevent clipping at 768x1024', () => {
    assert.match(chatAreaSrc, /flex flex-wrap lg:flex-nowrap items-center gap-1.5/);
    assert.doesNotMatch(chatAreaSrc, /flex flex-wrap sm:flex-nowrap items-center gap-1.5/);
  });
});
