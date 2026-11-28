import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');

const demotions = [
  { company: 'DJAMU DJAGO', contact_id: '28afdb31-babd-4975-a100-26f81dd0fa16', demote_id: '1f503482-4f9c-47f1-a572-51df76a59361', keep_id: 'e1a9a8f1-3e29-48a6-afd2-7882927114d1' },
  { company: 'PT BAHTERA SENTRA NIAGATAMA', contact_id: '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82', demote_id: 'f6a9cd15-7e04-4a61-88b8-d4654652e18e', keep_id: '957fd44a-1d7a-4bd0-a360-1aaf630505ae' },
  { company: 'PT COMBIPHAR', contact_id: 'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b', demote_id: 'b1d0edf0-01a3-475f-9d59-5656d2c0141f', keep_id: 'ee79eea6-d631-4c94-86fa-f0fb75b86fec' },
  { company: 'PT Lloyd Pharma Indonesia', contact_id: 'd6830ce1-7904-4c01-afdd-392205293f40', demote_id: 'ce170f91-fe35-4729-945c-a73fa22e5e0b', keep_id: '633c42a3-d976-43af-897b-638f4cfb8089' },
  { company: 'PT Perusahaan Dagang dan Industri Kaliroto', contact_id: '177e9c47-7c57-438a-911b-5ffca8652ab8', demote_id: '086bdf95-f282-4c80-80a6-c0c7f84885a8', keep_id: '279e459b-0b22-4ec0-b253-6587308afbb8' },
  { company: 'PT Prima Cita Prasada', contact_id: '78958f07-0fdf-4c87-a93d-9a8454f9eb1c', demote_id: '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76', keep_id: 'f1f13dad-d70d-40b1-beb6-170b1126c458' },
  { company: 'PT Roi Surya Prima Farma', contact_id: 'ef17e387-502c-4506-8ad7-3dc59e4b2f49', demote_id: '20272510-d496-4aa8-8d33-c22d3e5c778c', keep_id: 'e3db634a-8ecf-4dd1-bb19-563d408d9020' },
  { company: 'PT Shubham Anzen Pharma Jaya', contact_id: 'b768af4b-dd06-4a0e-841f-5a6aa4dd188e', demote_id: 'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1', keep_id: 'a4b63186-6fab-4c81-8de1-da9df64bd1b1' },
  { company: 'PT Synergi Mitra Abadi', contact_id: '2a53b06c-67d1-45da-9c38-edde3be7dc93', demote_id: 'df629243-0d0d-44ca-af04-a1edb39f3d9a', keep_id: 'f5ff2c11-8056-4574-9531-236808e86e92' },
  { company: 'PT. SANBE FARMA (Demote 1)', contact_id: 'c5d7c938-5878-4bfa-bf44-36e81dddc1a4', demote_id: '17da83bf-c7ba-4d0e-9723-e30e49f080c5', keep_id: '121900ba-053f-4511-874a-30ad153dfef4' },
  { company: 'PT. SANBE FARMA (Demote 2)', contact_id: 'c5d7c938-5878-4bfa-bf44-36e81dddc1a4', demote_id: 'aab97f7e-2f24-4a1f-977f-0b0e44625171', keep_id: '121900ba-053f-4511-874a-30ad153dfef4' },
  { company: 'PT.Medion Farma Jaya', contact_id: '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a', demote_id: 'db76ee70-1c78-4e95-9b31-8b9c79e85394', keep_id: '1a3e642d-6f9a-4974-9abe-861442cba7ff' },
  { company: 'PT.Rama Emerald Multi Sukses', contact_id: '3b61c088-4b91-4217-835b-3577da389fc0', demote_id: 'ec57e9b5-b66d-4840-a406-6f2a443a28ee', keep_id: '26dbb22b-c2ce-401c-a3c0-53951287fac1' }
];

async function run() {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('BEGIN READ ONLY;');

  console.log('=== VERIFYING ALL 13 DEMOTIONS AGAINST PRODUCTION ===\n');

  let allValid = true;
  const results = [];

  for (const item of demotions) {
    const demoteRes = await client.query(
      `SELECT p.id, p.contact_id, c.company_name, p.raw_phone, p.phone_type, p.is_primary, p.updated_at
       FROM public.crm_contact_phones p
       JOIN public.crm_contacts c ON c.id = p.contact_id
       WHERE p.id = $1`,
      [item.demote_id]
    );

    const keepRes = await client.query(
      `SELECT p.id, p.contact_id, c.company_name, p.raw_phone, p.phone_type, p.is_primary, p.updated_at
       FROM public.crm_contact_phones p
       JOIN public.crm_contacts c ON c.id = p.contact_id
       WHERE p.id = $1`,
      [item.keep_id]
    );

    const demoteRow = demoteRes.rows[0];
    const keepRow = keepRes.rows[0];

    const demoteOk = Boolean(demoteRow && demoteRow.contact_id === item.contact_id && demoteRow.is_primary === true);
    const keepOk = Boolean(keepRow && keepRow.contact_id === item.contact_id && keepRow.is_primary === true);

    if (!demoteOk || !keepOk) allValid = false;

    results.push({
      company: item.company,
      demote_id: item.demote_id,
      demote_phone: demoteRow?.raw_phone,
      demote_type: demoteRow?.phone_type,
      demote_primary: demoteRow?.is_primary,
      demote_ok: demoteOk,
      keep_id: item.keep_id,
      keep_phone: keepRow?.raw_phone,
      keep_type: keepRow?.phone_type,
      keep_primary: keepRow?.is_primary,
      keep_ok: keepOk
    });
  }

  console.table(results);
  console.log('\nALL 13 DEMOTIONS AND 12 KEPT PHONES VALID AND READY?', allValid);

  // Check current primary counts for the 12 companies
  const contactIds = [...new Set(demotions.map(d => d.contact_id))];
  const phoneCounts = await client.query(
    `SELECT p.contact_id, c.company_name, 
            COUNT(*) as total_phones,
            COUNT(*) FILTER (WHERE p.is_primary = true) as current_primary_count
     FROM public.crm_contact_phones p
     JOIN public.crm_contacts c ON c.id = p.contact_id
     WHERE p.contact_id = ANY($1::uuid[])
     GROUP BY p.contact_id, c.company_name
     ORDER BY c.company_name`,
    [contactIds]
  );

  console.log('\n=== CURRENT PRIMARY COUNTS FOR THE 12 COMPANIES ===');
  console.table(phoneCounts.rows);

  console.log('\n=== POST-DEMOTION PROJECTION ===');
  for (const pc of phoneCounts.rows) {
    const demotesForContact = demotions.filter(d => d.contact_id === pc.contact_id).length;
    const postPrimaryCount = Number(pc.current_primary_count) - demotesForContact;
    console.log(`${pc.company_name}: current ${pc.current_primary_count} - ${demotesForContact} demotions = ${postPrimaryCount} primary remaining`);
    if (postPrimaryCount !== 1) {
      console.error(`ERROR: Post-demotion count is not 1 for ${pc.company_name}!`);
      allValid = false;
    }
  }

  console.log('\nFINAL PREFLIGHT STATUS: allValid =', allValid);

  // Check the 6 commercial cases to confirm they have NOT changed
  const commercialCases = [
    '80ee11cf-7eb3-4054-bd65-b1bafcf2686b', // PT Afifarma
    'caad7c41-ad40-47ba-bde0-bf3f505390fa', // PT ANUGRAH VISI BERSAMA
    'e53d1921-62fa-4310-b0da-91535adbe194', // PT Konimex
    '6b4325d8-b79a-4602-9fd0-91e0df65bd03', // PT Medikon Prima Laboratories
    '987b5d43-e04d-419b-a399-a5240096cfdd', // PT. Mahakam Beta Farma
    '17feb96c-4506-4913-87ae-81f778f101cc'  // PT. Meiji
  ];

  const commCounts = await client.query(
    `SELECT p.contact_id, c.company_name, 
            COUNT(*) as total_phones,
            COUNT(*) FILTER (WHERE p.is_primary = true) as current_primary_count
     FROM public.crm_contact_phones p
     JOIN public.crm_contacts c ON c.id = p.contact_id
     WHERE p.contact_id = ANY($1::uuid[])
     GROUP BY p.contact_id, c.company_name
     ORDER BY c.company_name`,
    [commercialCases]
  );

  console.log('\n=== COMMERCIAL CONFIRMATION CASES (MUST REMAIN MULTI-PRIMARY) ===');
  console.table(commCounts.rows);

  await client.query('COMMIT;');
  await client.end();
}

run().catch(console.error);
