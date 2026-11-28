// scripts/seed-crm-contact-phones.mjs
import pg from 'pg';
import { parsePhoneEntriesAdvanced } from '../tests/test-phone-parsing.mjs';
import { detectCountryInfo } from '../src/utils/phoneValidation.ts';

const { Client } = pg;
const client = new Client({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || ''),
  ssl: { rejectUnauthorized: false }
});

async function seed() {
  await client.connect();
  console.log('Connected to Postgres DB. Seeding crm_contact_phones...');

  // Clear any partial data in crm_contact_phones
  await client.query('TRUNCATE TABLE public.crm_contact_phones RESTART IDENTITY CASCADE;');

  const contactsRes = await client.query(`
    SELECT id, company_name, contact_person, designation, phone, mobile, landline, country, city, notes
    FROM public.crm_contacts
    WHERE is_active = true
    ORDER BY company_name;
  `);

  console.log(`Fetched ${contactsRes.rows.length} active contacts.`);

  let totalInserted = 0;
  let totalWithPhones = 0;

  for (const c of contactsRes.rows) {
    const rawSources = [
      { raw: c.mobile, defaultDept: 'Purchasing' },
      { raw: c.phone, defaultDept: 'General Office' },
      { raw: c.landline, defaultDept: 'General Office' }
    ].filter(s => s.raw && s.raw.trim());

    const noteText = (c.notes || '').toLowerCase();
    const consentStatus =
      noteText.includes('opt-out') || noteText.includes('stop wa') || noteText.includes('unsubscribe')
        ? 'opted_out'
        : noteText.includes('opt-in') || noteText.includes('verified wa')
        ? 'opted_in'
        : 'pending';

    const seenCleaned = new Set();
    const parsedList = [];

    for (const src of rawSources) {
      const parsed = parsePhoneEntriesAdvanced(src.raw, c.contact_person, c.designation || src.defaultDept);
      for (const p of parsed) {
        const key = p.validation.normalized || p.cleaned;
        if (!seenCleaned.has(key)) {
          seenCleaned.add(key);
          parsedList.push(p);
        }
      }
    }

    if (parsedList.length > 0) {
      totalWithPhones++;
      // Determine primary: first valid mobile, or first item if no mobile
      const firstMobileIdx = parsedList.findIndex(p => p.validation.isWhatsAppEligible);
      const primaryIdx = firstMobileIdx >= 0 ? firstMobileIdx : 0;

      for (let i = 0; i < parsedList.length; i++) {
        const item = parsedList[i];
        const country = detectCountryInfo(item.validation.normalized || item.cleaned, c.country, c.city);

        await client.query(
          `INSERT INTO public.crm_contact_phones (
            contact_id, company_name, contact_person, department,
            raw_phone, normalized_phone, country_code, country_name,
            phone_type, is_whatsapp_eligible, is_primary, consent_status,
            extension, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);`,
          [
            c.id,
            c.company_name,
            item.contactPerson || c.contact_person || null,
            item.department || (item.validation.isWhatsAppEligible ? 'Purchasing' : 'General Office'),
            item.raw,
            item.validation.normalized || item.cleaned,
            country.code || '+62',
            country.name || 'Indonesia',
            item.validation.type,
            item.validation.isWhatsAppEligible,
            i === primaryIdx,
            consentStatus,
            item.extension || null,
            item.validation.reason
          ]
        );
        totalInserted++;
      }
    }
  }

  console.log(`Successfully seeded ${totalInserted} phone records across ${totalWithPhones} companies!`);
  await client.end();
}

seed().catch(err => {
  console.error('Seeding failed:', err);
  process.exit(1);
});

