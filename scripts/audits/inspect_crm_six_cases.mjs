import pg from 'pg';

const client = new pg.Client({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || '')
});

await client.connect();

const cases = [
  { name: 'Afifarma', id: '80ee11cf-7eb3-4054-bd65-b1bafcf2686b' },
  { name: 'Anugrah Visi Bersama', id: 'caad7c41-ad40-47ba-bde0-bf3f505390fa' },
  { name: 'Konimex', id: 'e53d1921-62fa-4310-b0da-91535adbe194' },
  { name: 'Medikon', id: '6b4325d8-b79a-4602-9fd0-91e0df65bd03' },
  { name: 'Mahakam', id: '987b5d43-e04d-419b-a399-a5240096cfdd' },
  { name: 'Meiji', id: '17feb96c-4506-4913-87ae-81f778f101cc' }
];

for (const c of cases) {
  const contactRes = await client.query('SELECT * FROM crm_contacts WHERE id = $1', [c.id]);
  const phonesRes = await client.query('SELECT * FROM crm_contact_phones WHERE contact_id = $1 ORDER BY is_primary DESC, created_at ASC', [c.id]);
  console.log('==================================================');
  console.log('COMPANY:', contactRes.rows[0]?.company_name, 'ID:', c.id);
  console.log('City/Address:', contactRes.rows[0]?.city, contactRes.rows[0]?.address);
  console.log('Phones:');
  for (const p of phonesRes.rows) {
    console.log({
      id: p.id,
      raw_phone: p.raw_phone,
      phone_type: p.phone_type,
      is_primary: p.is_primary,
      contact_person: p.contact_person,
      department: p.department,
      extension: p.extension,
      created_at: p.created_at,
      updated_at: p.updated_at
    });
  }
}

await client.end();

