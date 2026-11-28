// tests/crm-customer-creation-and-phone-normalization.test.mjs
//
// Regression test suite for:
// 1. Customer creation mapping (company_type vs customer_type = 'prospect')
// 2. Phone normalization (08112230374 -> +628112230374, preserving international prefixes, eliminating double CC)
// 3. PT ERRITA BANDUNG verification (raw 08112230374 -> +628112230374)
// 4. Verification that live DB insert with company_type = 'Pharma Manufacturer' succeeds without constraint error

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import createJiti from 'jiti';
import pg from 'pg';

const jiti = createJiti(import.meta.url);

const {
  classifyCanonicalPhone,
  sanitizeDoubleCountryCode,
  ISO_COUNTRY_NAMES,
  getNormalizedDestinationPhone,
} = jiti('../src/services/crm/canonicalPhoneService.ts');

const {
  auditContactsMultiPhone,
} = jiti('../src/utils/phoneValidation.ts');

const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');

describe('Avira CRM Customer Creation & Phone Normalization Fixes', () => {

  describe('Fix 1: Customer Type Mapping & Database Constraint Compliance', () => {
    test('Static source code verification: crm_contacts receives company_type and customer_type: prospect', () => {
      const workspaceSrc = readFileSync('src/components/crm/customers/CrmCustomersWorkspace.tsx', 'utf8');
      const modalSrc = readFileSync('src/components/crm/inbox/CreateNewCustomerModal.tsx', 'utf8');

      // In CrmCustomersWorkspace.tsx
      assert.match(workspaceSrc, /company_type:\s*newType/, 'Maps company classification to company_type');
      assert.match(workspaceSrc, /customer_type:\s*['"]prospect['"]/, 'Sets customer_type to prospect');

      // In CreateNewCustomerModal.tsx
      assert.match(modalSrc, /company_type:\s*customerType/, 'Maps company classification to company_type in CreateNewCustomerModal');
      assert.match(modalSrc, /customer_type:\s*['"]prospect['"]/, 'Sets customer_type to prospect in CreateNewCustomerModal');
    });

    test('Live PostgreSQL verification: Insert customer with Type = Pharma Manufacturer succeeds without crm_contacts_customer_type_check violation', async () => {
      const pool = new pg.Pool({ connectionString: DB_CONN });
      const testCompanyName = `PT Test Pharma Solusi AutoTest ${Date.now()}`;
      let insertedId = null;

      try {
        // Test insertion with the exact mapped schema
        const res = await pool.query(
          `INSERT INTO crm_contacts (
            company_name,
            contact_person,
            email,
            phone,
            mobile,
            city,
            country,
            company_type,
            customer_type,
            is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id, company_name, company_type, customer_type, phone, mobile, country`,
          [
            testCompanyName,
            'Dr. Budi Santoso',
            'test.budi@pharmasolusi.co.id',
            '+628112230374',
            '+628112230374',
            'Bandung',
            'Indonesia',
            'Pharma Manufacturer', // Company classification
            'prospect',            // Permitted status satisfying crm_contacts_customer_type_check
            true,
          ]
        );

        assert.equal(res.rowCount, 1, 'Customer insert returned 1 row');
        const row = res.rows[0];
        insertedId = row.id;

        assert.equal(row.company_name, testCompanyName);
        assert.equal(row.company_type, 'Pharma Manufacturer', 'company_type is Pharma Manufacturer');
        assert.equal(row.customer_type, 'prospect', 'customer_type is prospect');
        assert.equal(row.country, 'Indonesia');
        assert.equal(row.phone, '+628112230374');

        // Insert matching crm_contact_phones record
        const phoneRes = await pool.query(
          `INSERT INTO crm_contact_phones (
            contact_id,
            company_name,
            contact_person,
            department,
            raw_phone,
            normalized_phone,
            country_code,
            country_name,
            phone_type,
            is_whatsapp_eligible,
            is_primary,
            consent_status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING id, raw_phone, normalized_phone, country_code, country_name`,
          [
            insertedId,
            testCompanyName,
            'Dr. Budi Santoso',
            'Purchasing',
            '08112230374',
            '+628112230374',
            '+62',
            'Indonesia',
            'valid_mobile',
            true,
            true,
            'pending',
          ]
        );

        assert.equal(phoneRes.rowCount, 1);
        const pRow = phoneRes.rows[0];
        assert.equal(pRow.raw_phone, '08112230374');
        assert.equal(pRow.normalized_phone, '+628112230374');
        assert.equal(pRow.country_code, '+62');
        assert.equal(pRow.country_name, 'Indonesia');

        // Query back from crm_contacts to ensure it appears in CRM
        const fetchRes = await pool.query(`SELECT id, company_name, company_type, customer_type FROM crm_contacts WHERE id = $1`, [insertedId]);
        assert.equal(fetchRes.rows.length, 1);
        assert.equal(fetchRes.rows[0].company_type, 'Pharma Manufacturer');
      } finally {
        // Clean up test records safely
        if (insertedId) {
          await pool.query(`DELETE FROM crm_contact_phones WHERE contact_id = $1`, [insertedId]);
          await pool.query(`DELETE FROM crm_contacts WHERE id = $1`, [insertedId]);
        }
        await pool.end();
      }
    });
  });

  describe('Fix 2: Country Code & Phone Normalization', () => {
    test('Indonesian 08 number normalizes to +62 mobile', () => {
      const res = classifyCanonicalPhone('08112230374', { trustedRegion: 'ID' });
      assert.equal(res.isValid, true);
      assert.equal(res.e164, '+628112230374');
      assert.equal(res.phoneType, 'mobile');
      assert.equal(res.callingCode, '+62');
      assert.equal(res.phoneCountryName, 'Indonesia');
      assert.equal(res.isWhatsAppEligibleCandidate, true);
    });

    test('Preserves international numbers entered with international prefixes', () => {
      const resIndia = classifyCanonicalPhone('+91 98235 33833', { trustedRegion: 'ID' });
      assert.equal(resIndia.isValid, true);
      assert.equal(resIndia.e164, '+919823533833');
      assert.equal(resIndia.phoneType, 'mobile');
      assert.equal(resIndia.callingCode, '+91');
      assert.equal(resIndia.phoneCountryName, 'India');
      assert.equal(resIndia.isWhatsAppEligibleCandidate, true);

      const resUK = classifyCanonicalPhone('+44 20 7946 0958');
      assert.equal(resUK.isValid, true);
      assert.equal(resUK.e164, '+442079460958');
      assert.equal(resUK.callingCode, '+44');
      assert.equal(resUK.phoneCountryName, 'United Kingdom');
    });

    test('Sanitizes and eliminates double country code prefixes', () => {
      const cases = [
        { raw: '+62+628112230374', expected: '+628112230374' },
        { raw: '+62 62 8112230374', expected: '+628112230374' },
        { raw: '+62-62-8112230374', expected: '+628112230374' },
        { raw: '+62628112230374', expected: '+628112230374' },
        { raw: '+62 08112230374', expected: '+628112230374' },
        { raw: '+6208112230374', expected: '+628112230374' },
        { raw: '62628112230374', expected: '+628112230374' },
        { raw: '++628112230374', expected: '+628112230374' },
        { raw: '+91+919823533833', expected: '+919823533833' },
        { raw: '+91 91 9823533833', expected: '+919823533833' },
      ];

      for (const c of cases) {
        const res = classifyCanonicalPhone(c.raw, { trustedRegion: 'ID' });
        assert.equal(res.e164, c.expected, `Raw "${c.raw}" should normalize to ${c.expected}`);
        assert.equal(res.isValid, true);
      }
    });

    test('PT ERRITA BANDUNG: original mobile 08112230374 resolves to WhatsApp destination +628112230374', async () => {
      const pool = new pg.Pool({ connectionString: DB_CONN });
      try {
        const contactRes = await pool.query(
          `SELECT id, company_name, contact_person, phone, mobile, landline FROM crm_contacts WHERE company_name ILIKE $1`,
          ['%ERRITA%']
        );
        assert.ok(contactRes.rows.length >= 1, 'PT ERRITA BANDUNG found in database');
        const contact = contactRes.rows[0];
        assert.equal(contact.company_name, 'PT ERRITA BANDUNG');

        // Check crm_contact_phones
        const phonesRes = await pool.query(
          `SELECT raw_phone, normalized_phone, phone_type, is_whatsapp_eligible FROM crm_contact_phones WHERE contact_id = $1`,
          [contact.id]
        );
        const mobileRow = phonesRes.rows.find(p => p.is_whatsapp_eligible);
        assert.ok(mobileRow, 'WhatsApp eligible phone found for PT ERRITA BANDUNG');
        assert.equal(mobileRow.raw_phone, '08112230374');
        assert.equal(mobileRow.normalized_phone, '+628112230374');

        // Audit contacts multi phone test
        const audit = auditContactsMultiPhone([contact], phonesRes.rows);
        const candidates = audit.items.filter(i => i.is_candidate);
        assert.equal(candidates.length, 1, 'PT ERRITA BANDUNG produces exactly 1 WhatsApp candidate');

        const candidate = candidates[0];
        const destPhone = getNormalizedDestinationPhone(candidate);
        assert.equal(destPhone, '+628112230374', 'Destination phone is normalized E.164 +628112230374');
      } finally {
        await pool.end();
      }
    });

    test('getNormalizedDestinationPhone always returns normalized E.164 and never raw local format', () => {
      // Raw local number without pre-validation
      const candidateRawOnly = {
        raw_phone: '08112230374',
      };
      assert.equal(getNormalizedDestinationPhone(candidateRawOnly), '+628112230374');

      // Candidate with validation.normalized
      const candidateWithVal = {
        raw_phone: '08112230374',
        validation: { normalized: '+628112230374' },
      };
      assert.equal(getNormalizedDestinationPhone(candidateWithVal), '+628112230374');

      // Candidate with double country code in raw_phone
      const candidateDoubleCC = {
        raw_phone: '+62+628112230374',
      };
      assert.equal(getNormalizedDestinationPhone(candidateDoubleCC), '+628112230374');
    });
  });
});
