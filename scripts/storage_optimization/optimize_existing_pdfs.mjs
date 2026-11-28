import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { optimizePdfBuffer } from '../../src/services/storage/uploadOptimizationService.ts';

const EXPECTED_PROJECT_REF = 'dkrtsqienlhpouohmfki';
const EXPECTED_COMPANY_PREFIX = 'PT. Shubham Anzen Pharma Jaya';
const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';

const envFile = fs.readFileSync('.env', 'utf8');
const anonMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const SUPABASE_ANON_KEY = anonMatch ? anonMatch[1].trim() : '';

const BACKUP_ROOT = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/pdf_storage_backup';
const MANIFEST_PATH = path.join(BACKUP_ROOT, 'pdf_backup_manifest.json');
const STATE_PATH = path.join(BACKUP_ROOT, 'pdf_optimization_state.json');

if (!fs.existsSync(BACKUP_ROOT)) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
}

function sha256Buffer(buf) {
  const hash = crypto.createHash('sha256');
  hash.update(buf);
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

let saveTimer = null;
let pendingState = null;
let pendingManifest = null;

function scheduleSave(manifest, state) {
  pendingManifest = manifest;
  pendingState = state;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      if (pendingManifest) fs.writeFileSync(MANIFEST_PATH, JSON.stringify(pendingManifest, null, 2), 'utf8');
      if (pendingState) fs.writeFileSync(STATE_PATH, JSON.stringify(pendingState, null, 2), 'utf8');
      saveTimer = null;
    }, 1000);
  }
}

function flushSave(manifest, state) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function verifyEnvironment(client) {
  console.log('--- 1. INDEPENDENT CONNECTION & SAFETY VERIFICATION ---');
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

  console.log('Verification PASSED: Target is confirmed Anzen / Avira (dkrtsqienlhpouohmfki)\n');
}

async function updateDbMetadata(client, bucket, filePath, newSize) {
  try {
    if (bucket === 'crm-documents') {
      await client.query(
        'UPDATE crm_product_documents SET file_size = $1 WHERE storage_path = $2 OR storage_path = $3',
        [newSize, filePath, filePath.replace(/^crm-documents\//, '')]
      );
    } else if (bucket === 'batch-documents') {
      await client.query(
        'UPDATE batch_documents SET file_size = $1 WHERE file_url LIKE $2',
        [newSize, `%${filePath}%`]
      );
    } else if (bucket === 'product-documents') {
      await client.query(
        'UPDATE product_documents SET file_size = $1 WHERE file_url LIKE $2',
        [newSize, `%${filePath}%`]
      );
    } else if (bucket === 'product-source-documents') {
      await client.query(
        'UPDATE product_source_documents SET file_size = $1 WHERE file_url LIKE $2',
        [newSize, `%${filePath}%`]
      );
    } else if (bucket === 'petty-cash-receipts') {
      await client.query(
        'UPDATE petty_cash_documents SET file_size = $1 WHERE file_url LIKE $2',
        [newSize, `%${filePath}%`]
      );
    }
  } catch (err) {
    console.warn(`  Warning updating DB metadata for ${bucket}/${filePath}:`, err.message);
  }
}

async function processPdf(item, index, total, manifest, state, sb, client, stats) {
  const fileKey = `${item.bucket_id}:${item.name}`;

  if (state[fileKey]?.status === 'OPTIMIZED') {
    const saved = BigInt(state[fileKey].saved_bytes || 0);
    stats.totalSavedBytes += saved;
    stats.countOptimized++;
    stats.countProcessed++;
    stats.savingsByBucket[item.bucket_id] = (stats.savingsByBucket[item.bucket_id] || 0n) + saved;
    return;
  }

  if (state[fileKey]?.status?.startsWith('SKIPPED')) {
    const reason = state[fileKey].reason || state[fileKey].status;
    stats.skipReasons[reason] = (stats.skipReasons[reason] || 0) + 1;
    stats.countSkipped++;
    stats.countProcessed++;
    return;
  }

  try {
    const { data: blob, error: dlErr } = await sb.storage.from(item.bucket_id).download(item.name);
    if (dlErr) {
      console.error(`[${index + 1}/${total}] Download error ${item.bucket_id}/${item.name}: ${dlErr.message}`);
      stats.countFailed++;
      return;
    }

    const origBuffer = Buffer.from(await blob.arrayBuffer());
    const origSha = sha256Buffer(origBuffer);
    const origSize = origBuffer.byteLength;

    // Secure local backup
    const bucketBackupDir = path.join(BACKUP_ROOT, item.bucket_id, path.dirname(item.name));
    fs.mkdirSync(bucketBackupDir, { recursive: true });
    const localBackupPath = path.join(BACKUP_ROOT, item.bucket_id, item.name);
    fs.writeFileSync(localBackupPath, origBuffer);

    manifest[fileKey] = {
      bucket: item.bucket_id,
      path: item.name,
      original_size: origSize,
      sha256: origSha,
      backup_file: localBackupPath,
      backed_up_at: new Date().toISOString()
    };

    // Lossless PDF stream & object structure optimization
    const optResult = await optimizePdfBuffer(origBuffer, {
      minSavingsBytes: 10 * 1024,
      minSavingsPercent: 5
    });

    if (!optResult.isOptimized) {
      const reason = optResult.skipReason || 'not_optimized';
      stats.skipReasons[reason] = (stats.skipReasons[reason] || 0) + 1;
      state[fileKey] = {
        status: `SKIPPED_${reason.toUpperCase()}`,
        reason,
        original_size: origSize,
        checked_at: new Date().toISOString()
      };
      scheduleSave(manifest, state);
      stats.countSkipped++;
      stats.countProcessed++;
      if (stats.countProcessed % 50 === 0 || reason === 'digitally_signed') {
        console.log(`[${index + 1}/${total}] ${item.bucket_id}/${path.basename(item.name)} -> Skipped: ${reason}`);
      }
      return;
    }

    // PDF meets >= 5% savings and >= 10 KB reduction
    const optBuffer = Buffer.from(optResult.optimizedBuffer);
    const optSize = optBuffer.byteLength;
    const savedBytes = origSize - optSize;
    const pctSaved = ((savedBytes / origSize) * 100).toFixed(1);
    const optSha = sha256Buffer(optBuffer);

    console.log(`[${index + 1}/${total}] OPTIMIZING: ${item.bucket_id}/${path.basename(item.name)}: ${(origSize / 1024).toFixed(1)} KB -> ${(optSize / 1024).toFixed(1)} KB (${pctSaved}% saved)`);

    // Safe Replacement via authenticated Supabase Storage API
    const { error: upErr } = await sb.storage.from(item.bucket_id).upload(item.name, optBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

    if (upErr) throw upErr;

    // Verify signed URL access and byte length
    const { data: signData, error: signErr } = await sb.storage.from(item.bucket_id).createSignedUrl(item.name, 60);
    if (signErr) throw signErr;

    const verifyRes = await fetch(signData.signedUrl);
    if (!verifyRes.ok) throw new Error(`HTTP status check failed: ${verifyRes.status}`);
    const verifiedBytes = (await verifyRes.arrayBuffer()).byteLength;
    if (verifiedBytes !== optSize) throw new Error(`Size mismatch after upload: expected ${optSize}, got ${verifiedBytes}`);

    // Update DB row
    await updateDbMetadata(client, item.bucket_id, item.name, optSize);

    state[fileKey] = {
      status: 'OPTIMIZED',
      original_bytes: origSize,
      optimized_bytes: optSize,
      saved_bytes: savedBytes,
      savings_percent: pctSaved,
      page_count: optResult.pageCount,
      sha256_orig: origSha,
      sha256_opt: optSha,
      optimized_at: new Date().toISOString()
    };
    scheduleSave(manifest, state);

    stats.totalSavedBytes += BigInt(savedBytes);
    stats.savingsByBucket[item.bucket_id] = (stats.savingsByBucket[item.bucket_id] || 0n) + BigInt(savedBytes);
    stats.countOptimized++;
    stats.countProcessed++;
  } catch (err) {
    console.error(`[${index + 1}/${total}] FAILED ${item.bucket_id}/${item.name}: ${err.message}`);
    stats.countFailed++;
    state[fileKey] = { status: 'FAILED', error: err.message, checked_at: new Date().toISOString() };
    scheduleSave(manifest, state);
  }
}

async function main() {
  console.log('=== ANZEN SUPABASE PDF LOSSLESS OPTIMIZATION EXECUTION ===');

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
  console.log(`Authenticated with Storage API as: ${authData.user.email}\n`);

  const manifest = loadJson(MANIFEST_PATH, {});
  const state = loadJson(STATE_PATH, {});

  const priorityBuckets = [
    'batch-documents',
    'crm-documents',
    'expense-documents',
    'product-documents',
    'product-source-documents',
    'documents',
    'sales-order-documents',
    'petty-cash-receipts'
  ];

  const candidateRes = await client.query(`
    SELECT 
      id,
      bucket_id,
      name,
      (metadata->>'size')::bigint as size,
      metadata->>'mimetype' as mime
    FROM storage.objects
    WHERE bucket_id = ANY($1)
      AND metadata->>'size' IS NOT NULL
      AND (
        metadata->>'mimetype' = 'application/pdf'
        OR name ILIKE '%.pdf'
      )
    ORDER BY (metadata->>'size')::bigint DESC;
  `, [priorityBuckets]);

  const candidates = candidateRes.rows;
  console.log(`Total valid physical PDF objects in target buckets: ${candidates.length}`);

  const stats = {
    countProcessed: 0,
    countOptimized: 0,
    countSkipped: 0,
    countFailed: 0,
    totalSavedBytes: 0n,
    skipReasons: {},
    savingsByBucket: {}
  };

  const CONCURRENCY = 6;
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < candidates.length) {
      const idx = currentIndex++;
      await processPdf(candidates[idx], idx, candidates.length, manifest, state, sb, client, stats);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  flushSave(manifest, state);

  console.log('\n========================================');
  console.log('FINAL PDF STORAGE OPTIMIZATION REPORT');
  console.log('========================================');
  console.log(`Total PDF Objects Audited: ${candidates.length}`);
  console.log(`Total Processed:           ${stats.countProcessed}`);
  console.log(`Optimized & Replaced:      ${stats.countOptimized}`);
  console.log(`Skipped (Preserved):       ${stats.countSkipped}`);
  console.log(`Failed / Errors:           ${stats.countFailed}`);
  console.log(`Total Measured Savings:    ${(Number(stats.totalSavedBytes) / 1024 / 1024).toFixed(2)} MB (${stats.totalSavedBytes} bytes)`);

  console.log('\n--- Itemized Skip Reasons ---');
  console.table(stats.skipReasons);

  console.log('\n--- Measured Savings by Bucket ---');
  const bucketSummary = Object.entries(stats.savingsByBucket).map(([b, s]) => ({
    bucket: b,
    saved_mb: (Number(s) / 1024 / 1024).toFixed(2),
    saved_bytes: s.toString()
  }));
  console.table(bucketSummary);

  await client.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
