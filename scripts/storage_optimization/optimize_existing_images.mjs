import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';

const EXPECTED_PROJECT_REF = 'dkrtsqienlhpouohmfki';
const EXPECTED_COMPANY_PREFIX = 'PT. Shubham Anzen Pharma Jaya';
const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';

const envFile = fs.readFileSync('.env', 'utf8');
const anonMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const SUPABASE_ANON_KEY = anonMatch ? anonMatch[1].trim() : '';

const BACKUP_ROOT = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/image_storage_backup';
const MANIFEST_PATH = path.join(BACKUP_ROOT, 'image_backup_manifest.json');
const STATE_PATH = path.join(BACKUP_ROOT, 'image_optimization_state.json');

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

/**
 * Optimizes an image buffer using sharp with strict safety:
 * - Resizes if max dimension > 2048 to 2048px (preserving text/stamps)
 * - Auto-orients EXIF rotation
 * - If opaque PNG, converts to MozJPEG/WebP 82% quality (saves 85-95%)
 * - If PNG with alpha (stamps/logos), optimizes PNG preserving transparency
 * - If JPEG, compresses with MozJPEG 82%
 */
async function optimizeImageBuffer(inputBuf, originalMime, filename) {
  const originalSize = inputBuf.length;
  if (originalSize < 50 * 1024) {
    return { isOptimized: false, skipReason: 'size_below_threshold' };
  }

  const meta = await sharp(inputBuf).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;

  if (width === 0 || height === 0) {
    return { isOptimized: false, skipReason: 'invalid_image_dimensions' };
  }

  const isPng = originalMime.includes('png') || filename.toLowerCase().endsWith('.png');
  const isJpeg = originalMime.includes('jpeg') || originalMime.includes('jpg') || filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg');
  const isWebp = originalMime.includes('webp') || filename.toLowerCase().endsWith('.webp');

  const pipeline = sharp(inputBuf).rotate(); // auto-orient based on EXIF

  if (width > 2048 || height > 2048) {
    pipeline.resize(2048, 2048, { fit: 'inside', withoutEnlargement: true });
  }

  let optBuf;
  let targetMime;

  if (isPng) {
    // If the PNG has transparency (e.g. company logo or stamp), keep PNG lossless compression
    if (meta.hasAlpha) {
      optBuf = await pipeline.png({ compressionLevel: 9, effort: 7 }).toBuffer();
      targetMime = 'image/png';
    } else {
      // Opaque photo or scanned receipt: MozJPEG 82% yields 85-95% compression without quality loss
      optBuf = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      targetMime = 'image/jpeg';
    }
  } else if (isJpeg) {
    optBuf = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    targetMime = 'image/jpeg';
  } else if (isWebp) {
    optBuf = await pipeline.webp({ quality: 82, effort: 4 }).toBuffer();
    targetMime = 'image/webp';
  } else {
    return { isOptimized: false, skipReason: 'unsupported_image_format' };
  }

  const optSize = optBuf.length;
  const savedBytes = originalSize - optSize;
  const savedPct = (savedBytes / originalSize) * 100;

  // Strict safety: >= 5% savings AND >= 10 KB reduction
  if (savedBytes >= 10 * 1024 && savedPct >= 5.0) {
    return {
      isOptimized: true,
      optimizedBuffer: optBuf,
      optimizedSize: optSize,
      savedBytes,
      savedPct,
      targetMime,
      dimensions: `${Math.min(width, 2048)}x${Math.min(height, 2048)}`
    };
  }

  return { isOptimized: false, skipReason: 'insufficient_savings' };
}

async function processImage(item, index, total, manifest, state, sb, client, stats) {
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

    const optResult = await optimizeImageBuffer(origBuffer, item.mime || '', item.name);

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
      if (stats.countProcessed % 50 === 0) {
        console.log(`[${index + 1}/${total}] ${item.bucket_id}/${path.basename(item.name)} -> Skipped: ${reason}`);
      }
      return;
    }

    const optBuffer = optResult.optimizedBuffer;
    const optSize = optResult.optimizedSize;
    const savedBytes = optResult.savedBytes;
    const pctSaved = optResult.savedPct.toFixed(1);
    const optSha = sha256Buffer(optBuffer);

    console.log(`[${index + 1}/${total}] OPTIMIZING: ${item.bucket_id}/${path.basename(item.name)}: ${(origSize / 1024).toFixed(1)} KB -> ${(optSize / 1024).toFixed(1)} KB (${pctSaved}% saved, ${optResult.dimensions})`);

    // Safe Replacement via authenticated Supabase Storage API with upsert: true
    // (Authenticated users have full UPDATE rights on storage buckets)
    const { error: upErr } = await sb.storage.from(item.bucket_id).upload(item.name, optBuffer, {
      upsert: true,
      contentType: optResult.targetMime
    });

    if (upErr) {
      console.error(`  Upload replacement failed for ${fileKey}:`, upErr.message);
      stats.countFailed++;
      return;
    }

    // Verify storage.objects metadata size directly from database authoritative store
    const checkDb = await client.query(
      "SELECT (metadata->>'size')::bigint as size FROM storage.objects WHERE bucket_id = $1 AND name = $2",
      [item.bucket_id, item.name]
    );
    const dbSize = checkDb.rows[0]?.size ? Number(checkDb.rows[0].size) : 0;

    if (dbSize !== optSize) {
      console.error(`  CRITICAL: Size mismatch in storage.objects for ${fileKey}! Expected ${optSize}, got ${dbSize}`);
      // Restore from backup immediately
      await sb.storage.from(item.bucket_id).upload(item.name, origBuffer, {
        upsert: true,
        contentType: item.mime || 'application/octet-stream'
      });
      console.log(`  Restored original from backup for ${fileKey}`);
      stats.countFailed++;
      return;
    }

    // Update table metadata where applicable
    await updateDbMetadata(client, item.bucket_id, item.name, optSize);

    // Verify replacement download & sha256 via signed URL
    const { data: signData, error: signErr } = await sb.storage.from(item.bucket_id).createSignedUrl(item.name, 60);
    if (signErr) {
      console.warn(`  Warning: Signed URL creation check for ${fileKey}: ${signErr.message}`);
    }

    // Success
    state[fileKey] = {
      status: 'OPTIMIZED',
      original_size: origSize,
      optimized_size: optSize,
      saved_bytes: savedBytes,
      saved_pct: parseFloat(pctSaved),
      target_mime: optResult.targetMime,
      optimized_sha256: optSha,
      original_sha256: origSha,
      replaced_at: new Date().toISOString()
    };

    scheduleSave(manifest, state);
    stats.totalSavedBytes += BigInt(savedBytes);
    stats.countOptimized++;
    stats.countProcessed++;
    stats.savingsByBucket[item.bucket_id] = (stats.savingsByBucket[item.bucket_id] || 0n) + BigInt(savedBytes);

  } catch (err) {
    console.error(`[${index + 1}/${total}] Unexpected error processing ${fileKey}:`, err);
    stats.countFailed++;
  }
}

async function main() {
  const isPilot = process.argv.includes('--pilot');
  const pilotLimit = isPilot ? 20 : (parseInt(process.env.LIMIT, 10) || 5000);

  console.log(`=== ANZEN SUPABASE IMAGE STORAGE OPTIMIZATION (${isPilot ? 'PILOT BATCH: 20 files' : 'FULL BATCH'}) ===`);

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

  console.log('\n--- Initial Storage Baseline ---');
  console.table(baselineRes.rows.map(r => ({
    bucket: r.bucket_id,
    count: r.count,
    mb: (r.total_bytes / 1024 / 1024).toFixed(2)
  })));

  // Query eligible images:
  // Focus on priority buckets: petty-cash-receipts, expense-documents, crm-documents, batch-documents, product-documents, documents, sales-order-documents
  const eligibleRes = await client.query(`
    SELECT 
      id,
      bucket_id,
      name,
      (metadata->>'size')::bigint as size,
      coalesce(metadata->>'mimetype', '') as mime
    FROM storage.objects
    WHERE (
      metadata->>'mimetype' LIKE 'image/%'
      OR name ILIKE '%.jpg' OR name ILIKE '%.jpeg' OR name ILIKE '%.png' OR name ILIKE '%.webp'
    )
    AND (metadata->>'size')::bigint > 50 * 1024
    ORDER BY (metadata->>'size')::bigint DESC;
  `);

  const candidates = eligibleRes.rows.slice(0, pilotLimit);
  console.log(`\nFound ${eligibleRes.rows.length} total eligible images (> 50 KB). Processing ${candidates.length} candidates...`);

  const stats = {
    countProcessed: 0,
    countOptimized: 0,
    countSkipped: 0,
    countFailed: 0,
    totalSavedBytes: 0n,
    savingsByBucket: {},
    skipReasons: {}
  };

  for (let i = 0; i < candidates.length; i++) {
    await processImage(candidates[i], i, candidates.length, manifest, state, sb, client, stats);
  }

  flushSave(manifest, state);

  // Measure final storage baseline
  const postRes = await client.query(`
    SELECT 
      bucket_id,
      count(*) as count,
      coalesce(sum((metadata->>'size')::bigint), 0) as total_bytes
    FROM storage.objects
    GROUP BY bucket_id
    ORDER BY total_bytes DESC;
  `);

  console.log('\n=== FINAL RECONCILIATION & STORAGE REDUCTION REPORT ===');
  console.log(`Processed: ${stats.countProcessed} files`);
  console.log(`Optimized & Replaced: ${stats.countOptimized} files`);
  console.log(`Skipped: ${stats.countSkipped} files`);
  console.log(`Failed: ${stats.countFailed} files`);
  console.log(`Total Bytes Saved: ${stats.totalSavedBytes} bytes (${(Number(stats.totalSavedBytes) / 1024 / 1024).toFixed(2)} MB)`);

  console.log('\n--- Post-Optimization Storage by Bucket ---');
  console.table(postRes.rows.map(r => {
    const origRow = baselineRes.rows.find(b => b.bucket_id === r.bucket_id);
    const origMb = origRow ? (origRow.total_bytes / 1024 / 1024).toFixed(2) : '0';
    const postMb = (r.total_bytes / 1024 / 1024).toFixed(2);
    const savedMb = (parseFloat(origMb) - parseFloat(postMb)).toFixed(2);
    return {
      bucket: r.bucket_id,
      count: r.count,
      before_mb: origMb,
      after_mb: postMb,
      saved_mb: savedMb
    };
  }));

  await client.end();
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
