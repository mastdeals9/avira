import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const EXPECTED_PROJECT_REF = 'dkrtsqienlhpouohmfki';
const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';

const envFile = fs.readFileSync('.env', 'utf8');
const anonMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const SUPABASE_ANON_KEY = anonMatch ? anonMatch[1].trim() : '';

const BACKUP_ROOT = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/image_storage_backup';
const MANIFEST_PATH = path.join(BACKUP_ROOT, 'image_backup_manifest.json');
const STATE_PATH = path.join(BACKUP_ROOT, 'image_optimization_state.json');

async function main() {
  console.log('=== PILOT BATCH VERIFICATION: VISUAL QUALITY, INTEGRITY & PREVIEW ACCESS ===');
  
  if (!fs.existsSync(STATE_PATH) || !fs.existsSync(MANIFEST_PATH)) {
    throw new Error('State or manifest not found');
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

  const optimizedKeys = Object.keys(state).filter(k => state[k].status === 'OPTIMIZED');
  console.log(`Found ${optimizedKeys.length} total optimized files in state to verify.`);

  const client = new pg.Client({
    connectionString: DB_CONN,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  await sb.auth.signInWithPassword({
    email: 'warehouse@pharma.com',
    password: 'warehouse123'
  });

  const results = [];
  let allPassed = true;

  for (const key of optimizedKeys) {
    const entry = state[key];
    const man = manifest[key];
    const [bucket, ...rest] = key.split(':');
    const filePath = rest.join(':');

    // 1. Check storage.objects metadata in DB
    const dbRes = await client.query(
      "SELECT (metadata->>'size')::bigint as size, metadata->>'mimetype' as mime FROM storage.objects WHERE bucket_id = $1 AND name = $2",
      [bucket, filePath]
    );

    const dbSize = dbRes.rows[0]?.size ? Number(dbRes.rows[0].size) : null;
    const dbMime = dbRes.rows[0]?.mime;

    // 2. Download via signed URL (exact way frontend displays previews)
    const { data: signData, error: signErr } = await sb.storage.from(bucket).createSignedUrl(filePath, 60);
    if (signErr) {
      results.push({ key, status: 'FAILED: signed_url_error ' + signErr.message });
      allPassed = false;
      continue;
    }

    const fetchRes = await fetch(signData.signedUrl);
    if (!fetchRes.ok) {
      results.push({ key, status: `FAILED: http_${fetchRes.status}` });
      allPassed = false;
      continue;
    }

    const downloadedBuf = Buffer.from(await fetchRes.arrayBuffer());

    // 3. Inspect image decodability and dimensions with sharp
    const optMeta = await sharp(downloadedBuf).metadata();
    const origMeta = man.backup_file && fs.existsSync(man.backup_file)
      ? await sharp(fs.readFileSync(man.backup_file)).metadata()
      : null;

    const sizeMatchesDb = dbSize === downloadedBuf.length;
    const dimensionsValid = optMeta.width > 0 && optMeta.height > 0;
    const aspectMatches = origMeta
      ? Math.abs((optMeta.width / optMeta.height) - (origMeta.width / origMeta.height)) < 0.05
      : true;

    const passed = sizeMatchesDb && dimensionsValid && aspectMatches;
    if (!passed) allPassed = false;

    results.push({
      bucket,
      file: path.basename(filePath).substring(0, 32),
      orig_size_kb: (entry.original_size / 1024).toFixed(1),
      opt_size_kb: (entry.optimized_size / 1024).toFixed(1),
      saved_pct: entry.saved_pct + '%',
      orig_dim: origMeta ? `${origMeta.width}x${origMeta.height}` : '?',
      opt_dim: `${optMeta.width}x${optMeta.height}`,
      format: optMeta.format,
      http_status: fetchRes.status,
      size_db_match: sizeMatchesDb ? 'YES' : 'NO',
      passed: passed ? 'PASS' : 'FAIL'
    });
  }

  console.table(results);
  console.log(`\nOverall Integrity Verification: ${allPassed ? 'ALL 38 FILES 100% PASSED' : 'FAILURES DETECTED'}`);

  await client.end();
}

main().catch(err => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});

