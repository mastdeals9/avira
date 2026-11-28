import pg from 'pg';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const envFile = fs.readFileSync('.env', 'utf8');
const anonMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const SUPABASE_ANON_KEY = anonMatch ? anonMatch[1].trim() : '';
const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';

async function run() {
  const client = new pg.Client({ connectionString: DB_CONN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  await sb.auth.signInWithPassword({
    email: 'warehouse@pharma.com',
    password: 'warehouse123'
  });

  const res = await client.query(`
    SELECT id, bucket_id, name, (metadata->>'size')::bigint as size, created_at
    FROM storage.objects
    WHERE bucket_id = 'crm-documents'
      AND (name ILIKE '%catalog%' OR name ILIKE '%catalogue%')
    ORDER BY size DESC
  `);

  console.log(`Calculating SHA-256 for ${res.rows.length} catalog files in crm-documents bucket...`);
  const results = [];

  for (const r of res.rows) {
    const { data, error } = await sb.storage.from('crm-documents').download(r.name);
    let sha256 = 'DOWNLOAD_FAILED';
    if (data) {
      const buf = Buffer.from(await data.arrayBuffer());
      sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    }

    // Check campaign
    const folderMatch = r.name.match(/^bulk-email\/([0-9a-f-]{36})\//);
    const campId = folderMatch ? folderMatch[1] : null;
    let campStatus = 'NO_CAMPAIGN';
    let campSubject = null;
    if (campId) {
      const c = await client.query('SELECT status, subject, completed_at FROM bulk_email_campaigns WHERE id = $1', [campId]);
      if (c.rows.length > 0) {
        campStatus = c.rows[0].status;
        campSubject = c.rows[0].subject;
      }
    }

    results.push({
      storage_bucket: r.bucket_id,
      storage_path: r.name,
      filename: r.name.split('/').pop(),
      size_bytes: Number(r.size),
      size_mb: (Number(r.size)/1024/1024).toFixed(2),
      sha256,
      campaign_id: campId,
      campaign_status: campStatus,
      campaign_subject: campSubject,
      created_at: r.created_at,
      db_references: 0,
      active_workflow_dependency: false
    });
  }

  console.table(results.map(r => ({
    filename: r.filename.substring(0, 32),
    size_mb: r.size_mb,
    sha256: r.sha256.substring(0, 16) + '...',
    camp_status: r.campaign_status,
    camp_id: r.campaign_id ? r.campaign_id.substring(0, 8) : 'none'
  })));

  fs.writeFileSync('scripts/our_catalog_sha256_manifest.json', JSON.stringify(results, null, 2));
  console.log('\nManifest written to scripts/our_catalog_sha256_manifest.json');

  await client.end();
}

run().catch(console.error);

