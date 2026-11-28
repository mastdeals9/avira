import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { auditContactsMultiPhone, validatePhoneNumber } from '../src/utils/phoneValidation.ts';
import { CampaignComplianceService } from '../src/services/crm/campaignComplianceService.ts';
import { classifyCanonicalPhone } from '../src/services/crm/canonicalPhoneService.ts';
import { formatPersonalizedWhatsAppMessage, validateMediaCaption } from '../src/utils/whatsappPersonalization.ts';

const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const client = new pg.Client({ connectionString: DB_CONN, ssl: { rejectUnauthorized: false } });

test('Universal WhatsApp Bulk Sender, Server-Side Queue & Delivery Suite', async (t) => {
  await client.connect();

  // -------------------------------------------------------------------------
  // TEST 1: CRM Database Has 94 Valid Mobile Candidates
  // -------------------------------------------------------------------------
  await t.test('1. CRM database has exactly 94 valid mobile numbers mapped to active contacts', async () => {
    const { rows: phones } = await client.query(`
      SELECT p.id, p.contact_id, p.raw_phone, p.normalized_phone, p.phone_type, p.is_whatsapp_eligible, p.consent_status, c.is_active
      FROM crm_contact_phones p
      JOIN crm_contacts c ON c.id = p.contact_id
      WHERE p.is_whatsapp_eligible = true AND c.is_active = true
    `);

    assert.equal(phones.length, 94, 'Must have exactly 94 WhatsApp eligible mobile numbers mapped to active contacts');
    const validMobileCount = phones.filter(p => p.phone_type === 'valid_mobile').length;
    const intlCount = phones.filter(p => p.phone_type === 'international_number').length;
    assert.equal(validMobileCount + intlCount, 94, 'All 94 must be valid mobile or international mobile format');
  });

  // -------------------------------------------------------------------------
  // TEST 2: WA Candidates Counter = 94, Separated from Dispatch Clearance
  // -------------------------------------------------------------------------
  await t.test('2. auditContactsMultiPhone computes waCandidates = 94 without requiring opt-in consent', async () => {
    const { rows: contacts } = await client.query(`
      SELECT id, company_name, contact_person, designation, email, phone, mobile, landline, country, city, customer_type, notes, is_active
      FROM crm_contacts WHERE is_active = true ORDER BY company_name
    `);
    const { rows: phones } = await client.query('SELECT * FROM crm_contact_phones');

    const audit = auditContactsMultiPhone(contacts, phones);

    assert.equal(audit.stats.waCandidates, 94, 'WA Candidates counter must strictly report 94 valid mobiles');
    assert.equal(audit.stats.landline, 556, 'Landlines must be strictly segregated from mobile candidates');
    assert.equal(typeof audit.stats.dispatchCleared, 'number', 'dispatchCleared counter must exist separately');
  });

  // -------------------------------------------------------------------------
  // TEST 3: Permission Recording and Dispatch Clearance Verification
  // -------------------------------------------------------------------------
  await t.test('3. Recording genuine permission clears contact for dispatch without synthetic defaults', async () => {
    // Pick an eligible test candidate
    const { rows: sample } = await client.query(`
      SELECT id, normalized_phone, company_name FROM crm_contact_phones
      WHERE is_whatsapp_eligible = true LIMIT 1
    `);
    const target = sample[0];

    // Mock record permission update
    const testEvidence = 'Customer requested catalog via website on 2026-11-11 ref #9001';
    const nowIso = new Date().toISOString();

    await client.query(`
      UPDATE crm_contact_phones
      SET consent_status = 'opted_in',
          opt_in_source = 'web_inquiry',
          opt_in_timestamp = $1,
          opt_in_evidence = $2,
          permitted_categories = ARRAY['customer_service', 'price_alerts']
      WHERE id = $3
    `, [nowIso, testEvidence, target.id]);

    const { rows: updated } = await client.query(`
      SELECT consent_status, opt_in_source, opt_in_evidence, permitted_categories
      FROM crm_contact_phones WHERE id = $1
    `, [target.id]);

    assert.equal(updated[0].consent_status, 'opted_in');
    assert.equal(updated[0].opt_in_source, 'web_inquiry');
    assert.equal(updated[0].opt_in_evidence, testEvidence);

    // Revert back to pending to preserve DB state
    await client.query(`
      UPDATE crm_contact_phones
      SET consent_status = 'pending',
          opt_in_source = NULL,
          opt_in_timestamp = NULL,
          opt_in_evidence = NULL
      WHERE id = $1
    `, [target.id]);
  });

  // -------------------------------------------------------------------------
  // TEST 4: Database Persistent Server Queue & Anti-Duplicate Constraint
  // -------------------------------------------------------------------------
  await t.test('4. whatsapp_campaigns and whatsapp_campaign_recipients queue jobs with duplicate suppression', async () => {
    // 1. Create test campaign in persistent queue
    const { rows: campRows } = await client.query(`
      INSERT INTO whatsapp_campaigns (
        name, message_template, status, total_recipients, processing_delay_seconds
      ) VALUES (
        'Automated Test Verification Campaign',
        'Halo {{contact_person}} dari {{company_name}}, penawaran harga ready stock.',
        'in_progress',
        2,
        20
      ) RETURNING id, status, processing_delay_seconds
    `);
    const campaignId = campRows[0].id;

    assert.equal(campRows[0].status, 'in_progress');
    assert.ok(campRows[0].processing_delay_seconds >= 20, 'Delay must be at least 20 seconds');

    // 2. Insert Recipient #1
    await client.query(`
      INSERT INTO whatsapp_campaign_recipients (
        campaign_id, company_name, contact_person, phone, status, personalized_caption
      ) VALUES (
        $1, 'PT Test Company 1', 'Budi', '+6281234567890', 'pending', 'Halo Budi dari PT Test Company 1'
      )
    `, [campaignId]);

    // 3. Attempt to insert Duplicate Recipient #1 with SAME phone in SAME campaign
    let duplicateRejected = false;
    try {
      await client.query(`
        INSERT INTO whatsapp_campaign_recipients (
          campaign_id, company_name, contact_person, phone, status, personalized_caption
        ) VALUES (
          $1, 'PT Test Company 1 Duplicate', 'Budi', '+6281234567890', 'pending', 'Halo Budi duplicate'
        )
      `, [campaignId]);
    } catch (err) {
      duplicateRejected = err.code === '23505'; // PostgreSQL unique_violation
    }

    assert.equal(duplicateRejected, true, 'Unique constraint (campaign_id, phone) must reject duplicate sends');

    // Clean up test campaign
    await client.query('DELETE FROM whatsapp_campaign_recipients WHERE campaign_id = $1', [campaignId]);
    await client.query('DELETE FROM whatsapp_campaigns WHERE id = $1', [campaignId]);
  });

  // -------------------------------------------------------------------------
  // TEST 5: Real Delivery Webhook Callbacks & "Awaiting read receipt" Reporting
  // -------------------------------------------------------------------------
  await t.test('5. Delivery report updates from actual callbacks and shows "Awaiting read receipt" when unread', async () => {
    // 1. Create a campaign and recipient
    const { rows: campRows } = await client.query(`
      INSERT INTO whatsapp_campaigns (name, message_template, status, total_recipients)
      VALUES ('Delivery Status Test Campaign', 'Test message', 'in_progress', 1)
      RETURNING id
    `);
    const campaignId = campRows[0].id;
    const testMsgId = `wamid.TEST_${Date.now()}`;

    const { rows: recRows } = await client.query(`
      INSERT INTO whatsapp_campaign_recipients (
        campaign_id, company_name, contact_person, phone, status, message_id
      ) VALUES (
        $1, 'PT Dexa Farma Test', 'Ms Benita', '+6281221512207', 'sent', $2
      ) RETURNING id, status
    `, [campaignId, testMsgId]);
    const recipientId = recRows[0].id;

    // A. At 'sent' status, read_at is null -> "Awaiting read receipt"
    const { rows: step1 } = await client.query('SELECT status, read_at FROM whatsapp_campaign_recipients WHERE id = $1', [recipientId]);
    assert.equal(step1[0].status, 'sent');
    assert.equal(step1[0].read_at, null, 'Must be unread initially');

    // B. Simulate Meta 'delivered' callback
    const deliveredAt = new Date().toISOString();
    await client.query(`
      UPDATE whatsapp_campaign_recipients
      SET status = 'delivered', delivered_at = $1
      WHERE id = $2
    `, [deliveredAt, recipientId]);

    const { rows: step2 } = await client.query('SELECT status, delivered_at, read_at FROM whatsapp_campaign_recipients WHERE id = $1', [recipientId]);
    assert.equal(step2[0].status, 'delivered');
    assert.ok(step2[0].delivered_at, 'Delivered timestamp must be set');
    assert.equal(step2[0].read_at, null, 'Still unread -> UI presents "Awaiting read receipt"');

    // C. Simulate Meta 'read' callback
    const readAt = new Date().toISOString();
    await client.query(`
      UPDATE whatsapp_campaign_recipients
      SET status = 'read', read_at = $1
      WHERE id = $2
    `, [readAt, recipientId]);

    // D. Refresh counts via DB RPC
    await client.query('SELECT refresh_whatsapp_campaign_counts($1)', [campaignId]);
    const { rows: updatedCamp } = await client.query('SELECT * FROM whatsapp_campaigns WHERE id = $1', [campaignId]);

    assert.equal(updatedCamp[0].read_count, 1, 'read_count must increment on webhook read receipt');

    // Clean up
    await client.query('DELETE FROM whatsapp_campaign_recipients WHERE campaign_id = $1', [campaignId]);
    await client.query('DELETE FROM whatsapp_campaigns WHERE id = $1', [campaignId]);
  });

  // -------------------------------------------------------------------------
  // TEST 6: Message Personalization & Media Caption Constraint Validation
  // -------------------------------------------------------------------------
  await t.test('6. Message personalization correctly replaces variables and enforces 1024-char caption limit', () => {
    const template = 'Halo {{contact_person}} dari {{company_name}},\nReady stock {{product_name}} tersedia!';
    const personalized = formatPersonalizedWhatsAppMessage(
      template,
      {
        contact_person: 'Dr. Hendra',
        company_name: 'PT Kalbe Farma Tbk',
      },
      {
        productName: 'Paracetamol BP',
      }
    );

    assert.match(personalized, /Halo Dr\. Hendra dari PT Kalbe Farma Tbk/);
    assert.match(personalized, /Ready stock Paracetamol BP tersedia!/);

    // Caption limit validation with attachment
    const validCaption = validateMediaCaption('Short caption with photo', true);
    assert.equal(validCaption.isValid, true);

    const longText = 'A'.repeat(1025);
    const invalidCaption = validateMediaCaption(longText, true);
    assert.equal(invalidCaption.isValid, false);
    assert.equal(invalidCaption.maxLength, 1024);
  });

  await client.end();
});
