import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { optimizePdfBuffer } from '../../src/services/storage/uploadOptimizationService.ts';

const EXPECTED_PROJECT_REF = 'dkrtsqienlhpouohmfki';
const EXPECTED_COMPANY_PREFIX = 'PT. Shubham Anzen Pharma Jaya';
const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';

const envFile = fs.readFileSync('.env', 'utf8');
const anonMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const SUPABASE_ANON_KEY = anonMatch ? anonMatch[1].trim() : '';

async function main() {
  console.log('=== 1. VERIFYING LIVE ENVIRONMENT ===');
  const client = new pg.Client({
    connectionString: DB_CONN,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const company = await client.query('SELECT company_name FROM company_profiles LIMIT 1;');
  const companyName = company.rows[0]?.company_name || '';
  console.log('Target Company:', companyName);
  if (!companyName.startsWith(EXPECTED_COMPANY_PREFIX)) {
    throw new Error(`SECURITY STOP: Company ${companyName} does not match ${EXPECTED_COMPANY_PREFIX}`);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: authData, error: authErr } = await sb.auth.signInWithPassword({
    email: 'warehouse@pharma.com',
    password: 'warehouse123'
  });
  if (authErr) throw new Error(`Auth failed: ${authErr.message}`);
  console.log(`Authenticated with Storage API as: ${authData.user.email}`);

  console.log('\n=== 2. QUERYING ALL STORAGE OBJECTS ===');
  const allObjectsRes = await client.query(`
    SELECT 
      id,
      bucket_id,
      name,
      (metadata->>'size')::bigint as size,
      coalesce(metadata->>'mimetype', '') as mimetype,
      created_at
    FROM storage.objects
    ORDER BY (metadata->>'size')::bigint DESC;
  `);

  const objects = allObjectsRes.rows;
  console.log(`Total objects retrieved: ${objects.length}`);

  let totalBytes = 0n;
  const bucketStats = {};
  const typeStats = {};

  for (const obj of objects) {
    const s = BigInt(obj.size || 0);
    totalBytes += s;
    const b = obj.bucket_id;
    if (!bucketStats[b]) bucketStats[b] = { count: 0, bytes: 0n };
    bucketStats[b].count++;
    bucketStats[b].bytes += s;

    let ext = path.extname(obj.name).toLowerCase().replace('.', '');
    let cat = 'other';
    const mime = (obj.mimetype || '').toLowerCase();
    if (mime.includes('pdf') || ext === 'pdf') cat = 'pdf';
    else if (mime.startsWith('image/png') || ext === 'png') cat = 'image_png';
    else if (mime.startsWith('image/jp') || ext === 'jpg' || ext === 'jpeg') cat = 'image_jpeg';
    else if (mime.startsWith('image/webp') || ext === 'webp') cat = 'image_webp';
    else if (mime.startsWith('image/') || ['gif', 'svg', 'bmp', 'tiff'].includes(ext)) cat = 'image_other';
    else if (mime.includes('sheet') || mime.includes('excel') || ['xlsx', 'xls', 'csv'].includes(ext)) cat = 'excel';

    if (!typeStats[cat]) typeStats[cat] = { count: 0, bytes: 0n };
    typeStats[cat].count++;
    typeStats[cat].bytes += s;
  }

  console.log(`\nTotal Storage: ${(Number(totalBytes) / 1024 / 1024).toFixed(2)} MB (${(Number(totalBytes) / 1024 / 1024 / 1024).toFixed(3)} GiB)`);

  console.log('\n--- Usage by Bucket ---');
  console.table(Object.entries(bucketStats).map(([b, st]) => ({
    bucket: b,
    count: st.count,
    mb: (Number(st.bytes) / 1024 / 1024).toFixed(2),
    pct: ((Number(st.bytes) / Number(totalBytes)) * 100).toFixed(1) + '%'
  })));

  console.log('\n--- Usage by Category ---');
  console.table(Object.entries(typeStats).map(([t, st]) => ({
    category: t,
    count: st.count,
    mb: (Number(st.bytes) / 1024 / 1024).toFixed(2),
    pct: ((Number(st.bytes) / Number(totalBytes)) * 100).toFixed(1) + '%'
  })));

  // 3. Duplicate Detection
  console.log('\n=== 3. AUDITING DUPLICATES (WITHOUT DELETION) ===');
  const sizeMap = new Map();
  for (const obj of objects) {
    if (obj.size > 20000) { // check files > 20KB
      const list = sizeMap.get(obj.size) || [];
      list.push(obj);
      sizeMap.set(obj.size, list);
    }
  }

  const duplicates = [];
  let totalDuplicateWastedBytes = 0n;

  for (const [size, list] of sizeMap.entries()) {
    if (list.length > 1) {
      const wasted = BigInt(size) * BigInt(list.length - 1);
      totalDuplicateWastedBytes += wasted;
      duplicates.push({
        size_bytes: size,
        size_mb: (size / 1024 / 1024).toFixed(2),
        copies: list.length,
        wasted_mb: (Number(wasted) / 1024 / 1024).toFixed(2),
        buckets: [...new Set(list.map(o => o.bucket_id))],
        sample_name: path.basename(list[0].name)
      });
    }
  }

  duplicates.sort((a, b) => parseFloat(b.wasted_mb) - parseFloat(a.wasted_mb));
  console.log(`Found ${duplicates.length} duplicate groups across buckets.`);
  console.log(`Total duplicate wasted storage: ${(Number(totalDuplicateWastedBytes) / 1024 / 1024).toFixed(2)} MB`);
  console.log('Top 15 duplicate groups:');
  console.table(duplicates.slice(0, 15));

  // 4. Sample Recompression Analysis for Images
  console.log('\n=== 4. SAMPLE IMAGE RECOMPRESSION TESTING ===');
  // Find top images
  const sampleImages = objects.filter(o => {
    const ext = path.extname(o.name).toLowerCase();
    const mime = (o.mimetype || '').toLowerCase();
    return (mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) && o.size > 100 * 1024;
  }).slice(0, 10);

  console.log(`Testing sharp compression on ${sampleImages.length} real sample images...`);
  const imageTestResults = [];

  for (const sample of sampleImages) {
    try {
      const { data: blob, error } = await sb.storage.from(sample.bucket_id).download(sample.name);
      if (error) {
        imageTestResults.push({ name: path.basename(sample.name), status: 'download_error: ' + error.message });
        continue;
      }

      const inputBuf = Buffer.from(await blob.arrayBuffer());
      const metadata = await sharp(inputBuf).metadata();

      // Test A: JPEG 82% max 2048px
      const jpegPipeline = sharp(inputBuf).rotate(); // auto-orient
      if (metadata.width > 2048 || metadata.height > 2048) {
        jpegPipeline.resize(2048, 2048, { fit: 'inside', withoutEnlargement: true });
      }
      const jpegBuf = await jpegPipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();

      // Test B: WebP 82% max 2048px
      const webpPipeline = sharp(inputBuf).rotate();
      if (metadata.width > 2048 || metadata.height > 2048) {
        webpPipeline.resize(2048, 2048, { fit: 'inside', withoutEnlargement: true });
      }
      const webpBuf = await webpPipeline.webp({ quality: 82, effort: 4 }).toBuffer();

      const origKb = (inputBuf.length / 1024).toFixed(1);
      const jpegKb = (jpegBuf.length / 1024).toFixed(1);
      const webpKb = (webpBuf.length / 1024).toFixed(1);
      const jpegSavedPct = (((inputBuf.length - jpegBuf.length) / inputBuf.length) * 100).toFixed(1);
      const webpSavedPct = (((inputBuf.length - webpBuf.length) / inputBuf.length) * 100).toFixed(1);

      imageTestResults.push({
        bucket: sample.bucket_id,
        filename: path.basename(sample.name).substring(0, 30),
        dimensions: `${metadata.width}x${metadata.height}`,
        origKb,
        jpegKb,
        jpegSavedPct: jpegSavedPct + '%',
        webpKb,
        webpSavedPct: webpSavedPct + '%'
      });
    } catch (err) {
      imageTestResults.push({
        bucket: sample.bucket_id,
        filename: path.basename(sample.name).substring(0, 30),
        status: 'error: ' + err.message
      });
    }
  }

  console.table(imageTestResults);

  await client.end();
}

main().catch(err => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
