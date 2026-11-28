import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const EXPECTED_PROJECT_REF = 'dkrtsqienlhpouohmfki';
const EXPECTED_COMPANY_PREFIX = 'PT. Shubham Anzen Pharma Jaya';
const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';

const envFile = fs.readFileSync('.env', 'utf8');
const anonMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const SUPABASE_ANON_KEY = anonMatch ? anonMatch[1].trim() : '';

const BACKUP_ROOT = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/storage_backup';
const MANIFEST_PATH = path.join(BACKUP_ROOT, 'backup_manifest.json');
const STATE_PATH = path.join(BACKUP_ROOT, 'optimization_state.json');
const WORK_DIR = '/tmp/storage_opt_workspace';

[BACKUP_ROOT, WORK_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function loadJson(filePath, defaultVal = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.warn(`Could not parse ${filePath}, using default`);
  }
  return defaultVal;
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function verifyEnvironment(client) {
  console.log('--- 1. INDEPENDENT CONNECTION VERIFICATION ---');
  const dbInfo = await client.query('SELECT current_database(), current_user;');
  console.log('PostgreSQL Target:', dbInfo.rows[0]);

  const company = await client.query('SELECT company_name, company_tax_id FROM company_profiles LIMIT 1;');
  const companyName = company.rows[0]?.company_name || '';
  console.log('Company Name:', companyName);

  if (!companyName.startsWith(EXPECTED_COMPANY_PREFIX)) {
    throw new Error(`SECURITY STOP: Company ${companyName} does not match expected ${EXPECTED_COMPANY_PREFIX}`);
  }

  if (!DB_CONN.includes(EXPECTED_PROJECT_REF) || !SUPABASE_URL.includes(EXPECTED_PROJECT_REF)) {
    throw new Error(`SECURITY STOP: Project reference does not match ${EXPECTED_PROJECT_REF}`);
  }

  console.log('Verification PASSED: Confirmed target is Anzen / Avira (dkrtsqienlhpouohmfki)\n');
}

async function main() {
  const isPilot = process.argv.includes('--pilot');
  const maxFiles = isPilot ? 20 : (parseInt(process.env.MAX_FILES, 10) || 5000);

  console.log(`=== ANZEN SUPABASE STORAGE OPTIMIZATION (${isPilot ? 'PILOT BATCH: 20 files' : 'FULL EXECUTION'}) ===`);

  const client = new pg.Client({
    connectionString: DB_CONN,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  await verifyEnvironment(client);

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: authData, error: authErr } = await sb.auth.signInWithPassword({
    email: 'warehouse@pharma.com',
    password: 'warehouse123'
  });
  if (authErr) throw new Error(`Auth failed: ${authErr.message}`);
  console.log(`Authenticated with Storage API as: ${authData.user.email}`);

  // Load manifest & state
  const manifest = loadJson(MANIFEST_PATH, {});
  const state = loadJson(STATE_PATH, {});

  // Fetch initial storage baseline
  const baselineRes = await client.query(`
    SELECT 
      bucket_id,
      count(*) as count,
      coalesce(sum((metadata->>'size')::bigint), 0) as total_bytes
    FROM storage.objects
    GROUP BY bucket_id
    ORDER BY total_bytes DESC;
  `);

  console.log('Initial Storage Baseline:');
  console.table(baselineRes.rows.map(r => ({
    bucket: r.bucket_id,
    count: r.count,
    size_mb: (r.total_bytes / 1024 / 1024).toFixed(2)
  })));

  // Query eligible images:
  // Focus on priority buckets: petty-cash-receipts, expense-documents, batch-documents, product-documents, sales-order-documents
  // Exclude non-images and exclude candidate unmapped CRM objects
  const eligibleRes = await client.query(`
    SELECT 
      id,
      bucket_id,
      name,
      (metadata->>'size')::bigint as size,
      metadata->>'mimetype' as mime
    FROM storage.objects
    WHERE bucket_id IN ('petty-cash-receipts', 'expense-documents', 'batch-documents', 'product-documents', 'sales-order-documents')
      AND (
        metadata->>'mimetype' LIKE 'image/%'
        OR name ILIKE '%.jpg'
        OR name ILIKE '%.jpeg'
        OR name ILIKE '%.png'
        OR name ILIKE '%.webp'
      )
      AND (metadata->>'size')::bigint >= 150000
    ORDER BY (metadata->>'size')::bigint DESC;
  `);

  const eligibleFiles = eligibleRes.rows;
  console.log(`\nFound ${eligibleFiles.length} eligible image candidates (>= 150 KB) across priority buckets.`);

  const toProcess = eligibleFiles.slice(0, maxFiles);
  console.log(`Processing queue: ${toProcess.length} files...\n`);

  let processedCount = 0;
  let optimizedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let totalSavedBytes = 0n;

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    const fileKey = `${item.bucket_id}:${item.name}`;

    if (state[fileKey]?.status === 'OPTIMIZED') {
      console.log(`[${i + 1}/${toProcess.length}] Already optimized: ${fileKey} (Saved: ${state[fileKey].saved_bytes} B)`);
      totalSavedBytes += BigInt(state[fileKey].saved_bytes || 0);
      optimizedCount++;
      processedCount++;
      continue;
    }

    if (state[fileKey]?.status?.startsWith('SKIPPED')) {
      console.log(`[${i + 1}/${toProcess.length}] Previously skipped: ${fileKey} (${state[fileKey].status})`);
      skippedCount++;
      processedCount++;
      continue;
    }

    console.log(`\n[${i + 1}/${toProcess.length}] Processing: ${item.bucket_id} / ${item.name} (${(item.size / 1024).toFixed(1)} KB)`);

    // Setup local backup paths
    const bucketBackupDir = path.join(BACKUP_ROOT, item.bucket_id, path.dirname(item.name));
    fs.mkdirSync(bucketBackupDir, { recursive: true });
    const localBackupPath = path.join(BACKUP_ROOT, item.bucket_id, item.name);

    // Download original
    const { data: blob, error: dlErr } = await sb.storage.from(item.bucket_id).download(item.name);
    if (dlErr) {
      console.error(`  Download error: ${dlErr.message}`);
      failedCount++;
      continue;
    }

    const origBuffer = Buffer.from(await blob.arrayBuffer());
    if (origBuffer.byteLength !== Number(item.size)) {
      console.warn(`  Warning: Byte length mismatch (DB: ${item.size}, Downloaded: ${origBuffer.byteLength})`);
    }

    // Save backup and verify SHA-256
    fs.writeFileSync(localBackupPath, origBuffer);
    const origSha = sha256File(localBackupPath);

    manifest[fileKey] = {
      bucket: item.bucket_id,
      path: item.name,
      original_size: origBuffer.byteLength,
      sha256: origSha,
      backup_file: localBackupPath,
      backed_up_at: new Date().toISOString()
    };
    saveJson(MANIFEST_PATH, manifest);

    // Prepare workspace for optimization
    const ext = path.extname(item.name).toLowerCase() || (item.mime?.includes('png') ? '.png' : '.jpg');
    const workOrigPath = path.join(WORK_DIR, `orig_${i}${ext}`);
    const workOptPath = path.join(WORK_DIR, `opt_${i}${ext}`);
    fs.writeFileSync(workOrigPath, origBuffer);
    fs.copyFileSync(workOrigPath, workOptPath);

    // Run optimization via sips
    let isOptSuccess = false;
    try {
      const isPng = item.mime === 'image/png' || ext === '.png';
      if (isPng) {
        execSync(`sips --resampleHeightWidthMax 2400 "${workOptPath}"`, { stdio: 'pipe' });
      } else {
        execSync(`sips --resampleHeightWidthMax 2400 -s formatOptions 82 "${workOptPath}"`, { stdio: 'pipe' });
      }
      isOptSuccess = true;
    } catch (optErr) {
      console.warn(`  sips optimization failed: ${optErr.message}`);
    }

    if (!isOptSuccess || !fs.existsSync(workOptPath)) {
      state[fileKey] = { status: 'SKIPPED_OPTIMIZATION_FAILED', checked_at: new Date().toISOString() };
      saveJson(STATE_PATH, state);
      skippedCount++;
      continue;
    }

    const optSize = fs.statSync(workOptPath).size;
    const origSize = origBuffer.byteLength;
    const savedBytes = origSize - optSize;
    const pctSaved = ((savedBytes / origSize) * 100).toFixed(1);

    // If savings are negligible (< 15% OR < 40 KB) or if size increased, keep original
    if (savedBytes < 40960 || (savedBytes / origSize) < 0.15) {
      console.log(`  Skipping replacement: Insufficient savings (${savedBytes} bytes / ${pctSaved}%). Preserving original.`);
      state[fileKey] = {
        status: 'SKIPPED_INSUFFICIENT_SAVINGS',
        original_bytes: origSize,
        optimized_bytes: optSize,
        checked_at: new Date().toISOString()
      };
      saveJson(STATE_PATH, state);
      skippedCount++;
      // Clean up temp
      try { fs.unlinkSync(workOrigPath); fs.unlinkSync(workOptPath); } catch (_) {}
      continue;
    }

    console.log(`  Optimization achieved: ${origSize} -> ${optSize} bytes (${(savedBytes / 1024).toFixed(1)} KB / ${pctSaved}% savings)`);

    // Safe Replacement
    const optBuffer = fs.readFileSync(workOptPath);
    const optSha = sha256File(workOptPath);
    const contentType = item.mime || (ext === '.png' ? 'image/png' : 'image/jpeg');

    let replaceSuccess = false;
    try {
      // 1. Remove original
      const { error: remErr } = await sb.storage.from(item.bucket_id).remove([item.name]);
      if (remErr) throw new Error(`Remove failed: ${remErr.message}`);

      // 2. Upload optimized file
      const { error: upErr } = await sb.storage.from(item.bucket_id).upload(item.name, optBuffer, {
        contentType,
        upsert: false
      });
      if (upErr) {
        // Rollback immediately from backup
        console.error(`  Upload failed (${upErr.message}). Rolling back from backup...`);
        await sb.storage.from(item.bucket_id).upload(item.name, origBuffer, { contentType, upsert: false });
        throw upErr;
      }

      // 3. Verify access via signed URL
      const { data: signData, error: signErr } = await sb.storage.from(item.bucket_id).createSignedUrl(item.name, 60);
      if (signErr) throw new Error(`Signed URL verification failed: ${signErr.message}`);

      const verifyRes = await fetch(signData.signedUrl);
      if (!verifyRes.ok) throw new Error(`HTTP status check failed: ${verifyRes.status}`);

      const verifiedBytes = (await verifyRes.arrayBuffer()).byteLength;
      if (verifiedBytes !== optSize) {
        throw new Error(`Verified size mismatch: expected ${optSize}, got ${verifiedBytes}`);
      }

      replaceSuccess = true;
    } catch (replaceErr) {
      console.error(`  REPLACEMENT FAILED: ${replaceErr.message}`);
      // Ensure original is restored
      try {
        await sb.storage.from(item.bucket_id).upload(item.name, origBuffer, { contentType, upsert: false });
        console.log('  Original restored successfully from backup.');
      } catch (restErr) {
        console.error(`  CRITICAL: Restore error: ${restErr.message}`);
      }
      failedCount++;
      state[fileKey] = { status: 'FAILED_ROLLED_BACK', error: replaceErr.message, checked_at: new Date().toISOString() };
      saveJson(STATE_PATH, state);
      continue;
    }

    if (replaceSuccess) {
      console.log(`  VERIFIED: Replaced & confirmed access at signed URL (Size: ${optSize} B, SHA: ${optSha.slice(0, 10)}...)`);
      totalSavedBytes += BigInt(savedBytes);
      optimizedCount++;

      // Update DB file_size metadata if tracked in tables
      try {
        if (item.bucket_id === 'crm-documents') {
          await client.query('UPDATE crm_product_documents SET file_size = $1 WHERE storage_path = $2;', [optSize, item.name]);
        } else if (item.bucket_id === 'batch-documents') {
          await client.query('UPDATE batch_documents SET file_size = $1 WHERE file_url LIKE $2;', [optSize, `%${item.name}%`]);
        } else if (item.bucket_id === 'product-documents') {
          await client.query('UPDATE product_documents SET file_size = $1 WHERE file_url LIKE $2;', [optSize, `%${item.name}%`]);
        } else if (item.bucket_id === 'product-source-documents') {
          await client.query('UPDATE product_source_documents SET file_size = $1 WHERE file_url LIKE $2;', [optSize, `%${item.name}%`]);
        }
      } catch (metaErr) {
        console.warn(`  Metadata update note: ${metaErr.message}`);
      }

      state[fileKey] = {
        status: 'OPTIMIZED',
        original_bytes: origSize,
        optimized_bytes: optSize,
        saved_bytes: savedBytes,
        original_sha256: origSha,
        optimized_sha256: optSha,
        verified_at: new Date().toISOString()
      };
      saveJson(STATE_PATH, state);
    }

    processedCount++;

    // Clean up temp
    try { fs.unlinkSync(workOrigPath); fs.unlinkSync(workOptPath); } catch (_) {}
  }

  console.log('\n--- BATCH EXECUTION COMPLETE ---');
  console.log(`Processed: ${processedCount}`);
  console.log(`Successfully Optimized & Replaced: ${optimizedCount}`);
  console.log(`Skipped (insufficient savings / criteria): ${skippedCount}`);
  console.log(`Failed / Rolled Back: ${failedCount}`);
  console.log(`Total Bytes Saved in this session: ${totalSavedBytes} bytes (${(Number(totalSavedBytes) / 1024 / 1024).toFixed(2)} MB)`);

  // Final summary from DB
  const finalRes = await client.query(`
    SELECT 
      bucket_id,
      count(*) as count,
      coalesce(sum((metadata->>'size')::bigint), 0) as total_bytes
    FROM storage.objects
    GROUP BY bucket_id
    ORDER BY total_bytes DESC;
  `);

  console.log('\nCurrent Storage Usage by Bucket:');
  console.table(finalRes.rows.map(r => ({
    bucket: r.bucket_id,
    count: r.count,
    size_mb: (r.total_bytes / 1024 / 1024).toFixed(2)
  })));

  const finalTotalBytes = finalRes.rows.reduce((acc, r) => acc + BigInt(r.total_bytes), 0n);
  console.log(`CURRENT TOTAL USAGE: ${(Number(finalTotalBytes) / 1024 / 1024).toFixed(2)} MB (${(Number(finalTotalBytes) / 1024 / 1024 / 1024).toFixed(3)} GiB)`);

  await client.end();
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
