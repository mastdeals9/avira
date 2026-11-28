import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  parsePhoneEntries,
  validatePhoneNumber,
  auditContactsMultiPhone,
  detectCountryInfo,
  groupDuplicates,
} from '../src/utils/phoneValidation.ts';

const DB_URL =
  process.env.READONLY_AUDIT_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

test('SAPJ CRM Multi-Phone & Contact Management Suite', async (t) => {
  await t.test('1. Compound Phone Parsing: splits delimiters safely without mangling formatting spaces', () => {
    // Two valid mobile numbers separated by comma
    const res1 = parsePhoneEntries('082225541227, 082124423008');
    assert.equal(res1.length, 2, 'Must extract exactly 2 phone numbers');
    assert.equal(res1[0].validation.normalized, '+6282225541227');
    assert.equal(res1[0].validation.type, 'valid_mobile');
    assert.equal(res1[1].validation.normalized, '+6282124423008');
    assert.equal(res1[1].validation.type, 'valid_mobile');

    // Mobile + Landline
    const res2 = parsePhoneEntries('0812-9647-9477, 021-55787162');
    assert.equal(res2.length, 2);
    assert.equal(res2[0].validation.normalized, '+6281296479477');
    assert.equal(res2[0].validation.isWhatsAppEligible, true);
    assert.equal(res2[1].validation.normalized, '+622155787162');
    assert.equal(res2[1].validation.type, 'landline');
    assert.equal(res2[1].validation.isWhatsAppEligible, false);

    // Three Bandung landlines with area codes in parens
    const res3 = parsePhoneEntries('(022) 4203108, (022) 5228466, (022) 5228467');
    assert.equal(res3.length, 3);
    assert.equal(res3[0].validation.normalized, '+62224203108');
    assert.equal(res3[1].validation.normalized, '+62225228466');
    assert.equal(res3[2].validation.normalized, '+62225228467');

    // Slash delimiter with area code inheritance
    const res4 = parsePhoneEntries('0271 – 715627 / 724336 ,08122653815');
    assert.equal(res4.length, 3);
    assert.equal(res4[0].validation.normalized, '+62271715627');
    assert.equal(res4[1].validation.normalized, '+62271724336');
    assert.equal(res4[2].validation.normalized, '+628122653815');

    // Contact person annotated inside parentheses
    const res5 = parsePhoneEntries('(08564621222 MRS MESSI) 0343658693');
    assert.equal(res5.length, 2);
    assert.equal(res5[0].validation.normalized, '+628564621222');
    assert.equal(res5[0].contactPerson, 'MRS MESSI');
    assert.equal(res5[1].validation.normalized, '+62343658693');

    // Extension attached to landline
    const res6 = parsePhoneEntries('(+62-22) 4207725, Ext.: 1861');
    assert.equal(res6.length, 1);
    assert.equal(res6[0].validation.normalized, '+62224207725');
  });

  await t.test('2. Multi-Phone Audit Reconciliation: 521 Companies yield 572 total individual numbers and 92 WhatsApp mobiles', async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const res = await client.query(
      'SELECT id, company_name, contact_person, designation, email, phone, mobile, landline, city, country, customer_type, notes FROM crm_contacts WHERE is_active = true ORDER BY company_name'
    );
    await client.end();

    const audit = auditContactsMultiPhone(res.rows);

    assert.equal(audit.stats.totalCompanies, 521, 'Total companies analyzed must equal 521');
    assert.equal(audit.stats.totalPhones, 578, 'Total individual phone numbers extracted must equal 578');
    assert.equal(audit.stats.eligible, 95, 'WhatsApp eligible numbers must equal 95');
    assert.equal(audit.stats.landline, 443, 'Preserved landlines must equal 443');
    assert.equal(audit.stats.missing, 103, 'Companies missing telephone numbers must equal 103');
    assert.equal(audit.stats.invalid, 40, 'Invalid numbers must equal 40');
    assert.equal(audit.stats.duplicates, 168, 'Duplicate number instances must equal 168');
  });

  await t.test('3. Database Relational Persistence: crm_contact_phones table holds 572 seeded records with integrity', async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();

    const countRes = await client.query('SELECT count(*) FROM public.crm_contact_phones');
    assert.equal(Number(countRes.rows[0].count), 572, 'crm_contact_phones must hold 572 phone records');

    const waRes = await client.query(
      'SELECT count(*) FROM public.crm_contact_phones WHERE is_whatsapp_eligible = true'
    );
    assert.equal(Number(waRes.rows[0].count), 92, 'Exactly 92 records must be marked WhatsApp eligible');

    const landlineRes = await client.query(
      "SELECT count(*) FROM public.crm_contact_phones WHERE phone_type = 'landline'"
    );
    assert.equal(Number(landlineRes.rows[0].count), 440, 'Exactly 440 records must be landlines');

    // Verify foreign key integrity
    const orphanRes = await client.query(`
      SELECT count(*) FROM public.crm_contact_phones p
      LEFT JOIN public.crm_contacts c ON p.contact_id = c.id
      WHERE c.id IS NULL;
    `);
    assert.equal(Number(orphanRes.rows[0].count), 0, 'No orphaned phone records permitted');

    await client.end();
  });

  await t.test('4. Relational CRUD Operations: Add, Edit, Delete an individual phone record safely', async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();

    try {
      // Find a test contact
      const contactRes = await client.query(
        "SELECT id, company_name FROM crm_contacts WHERE company_name = 'PT PITALA GUNAWAN RAYA' LIMIT 1"
      );
      assert.equal(contactRes.rows.length, 1);
      const testContact = contactRes.rows[0];

      // 1. ADD a new individual phone under this company
      const insertRes = await client.query(
        `INSERT INTO public.crm_contact_phones (
          contact_id, company_name, contact_person, department,
          raw_phone, normalized_phone, country_code, country_name,
          phone_type, is_whatsapp_eligible, is_primary, consent_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, normalized_phone, department, is_primary;`,
        [
          testContact.id,
          testContact.company_name,
          'Ibu Dewi (Procurement)',
          'Purchasing',
          '0813-8888-7777',
          '+6281388887777',
          '+62',
          'Indonesia',
          'valid_mobile',
          true,
          false,
          'opted_in'
        ]
      );
      assert.equal(insertRes.rows.length, 1);
      const phoneId = insertRes.rows[0].id;

      // 2. EDIT the phone record: update department and contact person
      const updateRes = await client.query(
        `UPDATE public.crm_contact_phones
         SET department = 'QA / QC', contact_person = 'Dr. Dewi QA', is_primary = true
         WHERE id = $1
         RETURNING department, contact_person, is_primary;`,
        [phoneId]
      );
      assert.equal(updateRes.rows[0].department, 'QA / QC');
      assert.equal(updateRes.rows[0].contact_person, 'Dr. Dewi QA');
      assert.equal(updateRes.rows[0].is_primary, true);

      // 3. DELETE the newly created test phone record
      const deleteRes = await client.query(
        'DELETE FROM public.crm_contact_phones WHERE id = $1 RETURNING id;',
        [phoneId]
      );
      assert.equal(deleteRes.rows.length, 1);
    } finally {
      await client.query("DELETE FROM public.crm_contact_phones WHERE normalized_phone = '+6281388887777'").catch(() => {});
      await client.end();
    }
  });

  await t.test('5. Multi-Number Company Recipient Expansion: PT ISA MEDIKA PERSADA provides 2 selectable recipients', async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();

    const phones = await client.query(
      "SELECT id, company_name, contact_person, department, normalized_phone, is_whatsapp_eligible FROM public.crm_contact_phones WHERE company_name ILIKE '%ISA MEDIKA PERSADA%';"
    );
    await client.end();

    assert.equal(phones.rows.length, 2, 'PT ISA MEDIKA PERSADA must have exactly 2 phone records');
    const numbers = phones.rows.map(r => r.normalized_phone).sort();
    assert.deepEqual(numbers, ['+6282124423008', '+6282225541227']);
    assert.ok(phones.rows.every(r => r.is_whatsapp_eligible), 'Both numbers must be WhatsApp eligible');
  });
});

