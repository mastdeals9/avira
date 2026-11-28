// scripts/safe_cleanup_test_data.mjs
import pg from 'pg';
import fs from 'fs';

const { Client } = pg;
const client = new Client({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || ''),
  ssl: { rejectUnauthorized: false }
});

async function safeClean() {
  await client.connect();
  console.log('--- EXECUTING SAFE CLEANUP OF CONFIRMED TEST INQUIRIES ---');

  if (!fs.existsSync('backups')) {
    fs.mkdirSync('backups', { recursive: true });
  }

  // 1. Fetch exact records to be backed up
  const targetIds = [
    '0b6cdd91-f58e-4355-b739-83751f6ab97e', // INQ-RACE-846
    '0c7d8f2e-ff7e-443b-8f2c-8b93a95234f1'  // INQ-RACE-787
  ];

  const fetchRes = await client.query(`
    SELECT * FROM public.crm_inquiries
    WHERE id IN ($1, $2);
  `, targetIds);

  if (fetchRes.rows.length === 0) {
    console.log('Target test inquiries already cleaned or not found.');
    await client.end();
    return;
  }

  // 2. Write full pre-deletion JSON backup
  const backupPayload = {
    backup_date: new Date().toISOString(),
    source_table: 'public.crm_inquiries',
    records_count: fetchRes.rows.length,
    records: fetchRes.rows
  };

  const backupFilePath = 'backups/confirmed_test_data_backup_20261104.json';
  fs.writeFileSync(backupFilePath, JSON.stringify(backupPayload, null, 2));
  console.log(`Saved pre-deletion backup to ${backupFilePath}`);

  // 3. Perform safe deletion
  const deleteRes = await client.query(`
    DELETE FROM public.crm_inquiries
    WHERE id IN ($1, $2)
    RETURNING id, inquiry_number, company_name;
  `, targetIds);

  console.log(`Successfully deleted ${deleteRes.rowCount} confirmed test inquiries:`, deleteRes.rows);

  // 4. Verify post-cleanup inquiry count
  const countRes = await client.query('SELECT count(*) FROM public.crm_inquiries;');
  console.log(`Total remaining genuine CRM inquiries: ${countRes.rows[0].count}`);

  await client.end();
}

safeClean().catch(err => {
  console.error('Cleanup error:', err);
  process.exit(1);
});

