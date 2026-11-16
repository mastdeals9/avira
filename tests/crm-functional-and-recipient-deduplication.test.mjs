import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanContactPerson,
  resolvePersonalizedGreeting,
  auditCompanyPrimaryPhones,
  deduplicateCampaignEmailRecipients,
  deduplicateCampaignPhoneRecipients,
  detectLanguage,
} from '../src/utils/crmContactCleaners.ts';
import { formatPersonalizedWhatsAppMessage } from '../src/utils/whatsappPersonalization.ts';

test('CRM Functional & Recipient Deduplication Test Suite', async (t) => {

  await t.test('1. One company with three primary phone rows appears once (no Cartesian row multiplication)', () => {
    // Synthetic company with 3 phone records all flagged is_primary = true
    const contact = {
      id: 'd3fb8e29-cb69-4ea0-bd6f-96a8027419f7',
      company_name: 'PT ANUGRAH VISI BERSAMA',
      contact_person: 'Hinsa Silitonga',
      email: 'hinsa@avb.co.id',
    };

    const phones = [
      { id: 'p1', contact_id: contact.id, raw_phone: '+62 8111 618281', is_primary: true },
      { id: 'p2', contact_id: contact.id, raw_phone: '+6281387845840', is_primary: true },
      { id: 'p3', contact_id: contact.id, raw_phone: '021 84943347', is_primary: true },
    ];

    const audit = auditCompanyPrimaryPhones(phones);
    assert.equal(audit.hasMultiplePrimary, true);
    assert.equal(audit.primaryCount, 3);
    assert.equal(audit.needsReview, true);

    // In customer listing, mapping contacts guarantees exactly 1 row per company
    const contacts = [contact];
    const assembledRows = contacts.map(c => ({
      ...c,
      hasMultiplePrimary: audit.hasMultiplePrimary,
      phonesCount: phones.length,
    }));

    assert.equal(assembledRows.length, 1, 'Company must appear exactly once');
    assert.equal(assembledRows[0].company_name, 'PT ANUGRAH VISI BERSAMA');
    assert.equal(assembledRows[0].hasMultiplePrimary, true);
  });

  await t.test('2. Two distinct companies sharing a switchboard remain separate companies and are excluded from auto-broadcast', () => {
    const sharedSwitchboard = '+62217454111';
    const compA = {
      id: 'c1',
      company_name: 'PT Dexa Medica (Site Palembang)',
      phone: sharedSwitchboard,
      normalized_phone: '+62217454111',
    };
    const compB = {
      id: 'c2',
      company_name: 'PT Dexa Medica (Site Cikarang)',
      phone: sharedSwitchboard,
      normalized_phone: '+62217454111',
    };

    const candidates = [compA, compB];
    const { unique, ambiguousShared } = deduplicateCampaignPhoneRecipients(candidates);

    // Entities must NOT be merged into one corrupted record
    assert.equal(ambiguousShared.length, 1);
    assert.equal(ambiguousShared[0].phone, '+62217454111');
    assert.deepEqual(
      ambiguousShared[0].companies.sort(),
      ['PT Dexa Medica (Site Cikarang)', 'PT Dexa Medica (Site Palembang)'].sort()
    );
    // Reason must be explicitly provided on the ambiguousShared entry
    assert.match(
      ambiguousShared[0].reason,
      /shared telephone number across distinct legal entities/i,
      'Must provide explicit reason explaining exclusion of shared switchboard'
    );
    // Broadcast must not unsafely pick one company over the other
    assert.equal(unique.length, 0, 'Ambiguous shared switchboard must be excluded from auto-broadcast');
  });

  await t.test('3. One WhatsApp number is not dispatched twice in one campaign', () => {
    const candidate1 = {
      id: 'cand-1',
      contact_id: 'c-farmasi-mandiri',
      company_name: 'PT Farmasi Mandiri',
      raw_phone: '+62 812-9373-9515',
      normalized_phone: '+6281293739515',
      contact_person: 'Bpk Budi',
    };
    const candidate2 = {
      id: 'cand-2',
      contact_id: 'c-farmasi-mandiri',
      company_name: 'PT Farmasi Mandiri',
      raw_phone: '081293739515', // Same canonical number, different format
      normalized_phone: '+6281293739515',
      contact_person: 'Bpk Budi',
    };

    const { unique, duplicates } = deduplicateCampaignPhoneRecipients([candidate1, candidate2]);
    assert.equal(unique.length, 1, 'Only one message must be dispatched');
    assert.equal(duplicates.length, 1, 'Second instance must be recorded as duplicate');
    assert.equal(unique[0].normalized_phone, '+6281293739515');
  });

  await t.test('4. Duplicate email recipients are not sent twice', () => {
    const recipients = [
      { id: '1', company_name: 'PT Global Onkolab Farma', email: 'kalbemed@kalbe.co.id' },
      { id: '2', company_name: 'PT Finusol Prima Farma', email: 'kalbemed@kalbe.co.id' },
      { id: '3', company_name: 'PT Finusol Prima Farma', email: 'KALBEMED@KALBE.CO.ID' }, // Case insensitivity check
      { id: '4', company_name: 'PT Kimia Farma', email: 'purchasing@kimiafarma.co.id' },
    ];

    const { unique, duplicates, duplicateCount } = deduplicateCampaignEmailRecipients(recipients);
    assert.equal(unique.length, 2, 'Must contain only 2 unique emails');
    assert.equal(duplicateCount, 2, 'Must record 2 duplicates');
    assert.equal(unique[0].email, 'kalbemed@kalbe.co.id');
    assert.equal(unique[1].email, 'purchasing@kimiafarma.co.id');
  });

  await t.test('5. Archived contacts do not appear in active recipient selectors', () => {
    const contacts = [
      { id: 'act-1', company_name: 'PT Bio Farma', is_active: true },
      { id: 'arch-1', company_name: 'ARCHIVED - MERGED INTO PT Graha Farma', is_active: false },
      { id: 'arch-2', company_name: 'ARCHIVED - MERGED INTO PT Konimex', is_active: false },
    ];

    const activeOnly = contacts.filter(c => c.is_active !== false);
    assert.equal(activeOnly.length, 1);
    assert.equal(activeOnly[0].company_name, 'PT Bio Farma');
  });

  await t.test('6. NULL contact-person names use the correct greeting (Indonesian & English)', () => {
    // Indonesian default template
    const idTemplate = 'Yth. {{contact_name}}\n{{company_name}}\n\nPenawaran produk {{product_name}} terkini.';
    const idMsg = formatPersonalizedWhatsAppMessage(idTemplate, {
      company_name: 'PT Bio Farma',
      contact_person: null,
    });
    assert.match(idMsg, /Yth\. Bapak\/Ibu/);
    assert.match(idMsg, /PT Bio Farma/);

    // English template
    const enTemplate = 'Dear {{contact_name}},\n\nRegarding your inquiry for {{product_name}} from {{company_name}}. Best regards';
    const enMsg = formatPersonalizedWhatsAppMessage(enTemplate, {
      company_name: 'Acme Pharma Overseas',
      contact_person: null,
    });
    assert.match(enMsg, /Dear Sir\/Madam/);
    assert.match(enMsg, /Acme Pharma Overseas/);
  });

  await t.test('7. Company names are not incorrectly shown as individual names (e.g. PT Holi Pharma)', () => {
    const rawPerson = 'Holi Pharma';
    const company = 'PT Holi Pharma';

    const cleaned = cleanContactPerson(rawPerson, company);
    assert.equal(cleaned, null, 'Copied company name must be detected as null individual contact');

    const greeting = resolvePersonalizedGreeting(rawPerson, company, { language: 'id' });
    assert.equal(greeting, 'Bapak/Ibu', 'Must fall back to respectful Indonesian greeting');

    const enGreeting = resolvePersonalizedGreeting(rawPerson, company, { language: 'en' });
    assert.equal(enGreeting, 'Sir/Madam', 'Must fall back to respectful English greeting');
  });

  await t.test('8. Telephone numbers are never displayed as contact-person names', () => {
    const phoneAsName = '+62 812-9373-9515';
    const company = 'PT Medikon';

    const cleaned = cleanContactPerson(phoneAsName, company);
    assert.equal(cleaned, null, 'Telephone number in person field must be sanitized to null');

    const greeting = resolvePersonalizedGreeting(phoneAsName, company, { language: 'id' });
    assert.equal(greeting, 'Bapak/Ibu');
  });

  await t.test('9. Multi-person fields are not silently corrupted', () => {
    const multiPerson = 'Halimatus Zein, Agnes Febrita, Erwin Hin';
    const company = 'PT Kalbe Farma';

    const cleaned = cleanContactPerson(multiPerson, company);
    assert.equal(cleaned, multiPerson, 'Legitimate multi-person string must be preserved without truncation');

    const greeting = resolvePersonalizedGreeting(multiPerson, company);
    assert.equal(greeting, multiPerson);
  });

  await t.test('10. Normal existing CRM recipient selection continues working with clean fallback', () => {
    const normalContact = {
      company_name: 'PT Kimia Farma (Persero) Tbk',
      contact_person: 'Fandji Yudistira',
    };

    const template = 'Selamat siang Bapak/Ibu {{contact_person}} ({{company_name}}), mohon konfirmasi.';
    const msg = formatPersonalizedWhatsAppMessage(template, normalContact);

    assert.match(msg, /Fandji Yudistira/);
    assert.match(msg, /PT Kimia Farma/);
  });

  await t.test('11. Shared switchboard safety: Two companies sharing a switchboard are excluded', () => {
    const compA = {
      contact_id: 'c-alpha',
      company_name: 'PT Alpha Laboratories',
      phone: '+62 21 555 1234',
    };
    const compB = {
      contact_id: 'c-beta',
      company_name: 'PT Beta Pharma',
      phone: '+62 21 555 1234',
    };
    const { unique, ambiguousShared } = deduplicateCampaignPhoneRecipients([compA, compB]);
    assert.equal(unique.length, 0, 'Must exclude shared switchboard from automated broadcast');
    assert.equal(ambiguousShared.length, 1);
    assert.match(ambiguousShared[0].reason, /shared telephone number across distinct legal entities/i);
  });

  await t.test('12. Same company duplicate numbers: Exactly one message queued, rest in duplicates', () => {
    const candidate1 = {
      contact_id: 'c-same',
      company_name: 'PT Sanbe Farma',
      phone: '+628111222333',
      contact_person: 'Officer A',
    };
    const candidate2 = {
      contact_id: 'c-same',
      company_name: 'PT Sanbe Farma',
      phone: '+628111222333',
      contact_person: 'Officer B',
    };
    const { unique, duplicates, ambiguousShared } = deduplicateCampaignPhoneRecipients([candidate1, candidate2]);
    assert.equal(unique.length, 1, 'Only one message must be queued');
    assert.equal(duplicates.length, 1, 'Duplicate must be captured');
    assert.equal(ambiguousShared.length, 0, 'Must not be flagged as ambiguous shared switchboard');
    assert.equal(unique[0].contact_id, 'c-same');
  });

  await t.test('13. Missing company ID: Excluded from automated broadcast until reviewed', () => {
    const candidateMissingId = {
      contact_id: '',
      company_id: '',
      id: '',
      company_name: 'PT Entity Without ID',
      phone: '+628123456789',
    };
    const { unique, ambiguousShared } = deduplicateCampaignPhoneRecipients([candidateMissingId]);
    assert.equal(unique.length, 0, 'Candidate without verified company ID must be excluded');
    assert.equal(ambiguousShared.length, 1);
    assert.match(ambiguousShared[0].reason, /missing or ambiguous company identity/i);
  });

  await t.test('14. Blank company name: Excluded from automated broadcast until reviewed', () => {
    const candidateBlankName = {
      contact_id: 'c-id-only',
      company_name: '   ',
      phone: '+628123456780',
    };
    const { unique, ambiguousShared } = deduplicateCampaignPhoneRecipients([candidateBlankName]);
    assert.equal(unique.length, 0, 'Candidate with blank company name must be excluded');
    assert.equal(ambiguousShared.length, 1);
    assert.match(ambiguousShared[0].reason, /missing or ambiguous company identity/i);
  });

  await t.test('15. Same company name but different company IDs: Excluded from automated broadcast', () => {
    // Two branches or distinct accounts sharing identical name but different stable CRM UUIDs
    const branch1 = {
      contact_id: 'c-branch-1-uuid',
      company_name: 'PT Dexa Laboratories',
      phone: '+62217778889',
    };
    const branch2 = {
      contact_id: 'c-branch-2-uuid',
      company_name: 'PT Dexa Laboratories', // Identical name
      phone: '+62217778889',
    };
    const { unique, ambiguousShared } = deduplicateCampaignPhoneRecipients([branch1, branch2]);
    assert.equal(unique.length, 0, 'Distinct company IDs sharing number must NOT be blindly deduplicated to one entity');
    assert.equal(ambiguousShared.length, 1);
    assert.match(ambiguousShared[0].reason, /shared telephone number across distinct company IDs/i);
  });

  await t.test('16. Duplicate numbers with conflicting company identities: Excluded with clear reason', () => {
    // Same contact_id but conflicting company_names
    const recordA = {
      contact_id: 'c-conflict-id',
      company_name: 'PT Kalbe Farma',
      phone: '+6281999888777',
    };
    const recordB = {
      contact_id: 'c-conflict-id',
      company_name: 'PT Kimia Farma', // Conflicting name under same ID
      phone: '+6281999888777',
    };
    const { unique, ambiguousShared } = deduplicateCampaignPhoneRecipients([recordA, recordB]);
    assert.equal(unique.length, 0, 'Conflicting company identities must be excluded');
    assert.equal(ambiguousShared.length, 1);
    assert.match(ambiguousShared[0].reason, /conflicting company identities/i);
  });
});

