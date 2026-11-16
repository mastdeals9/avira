/**
 * universal_document_bank_sha256_backfill.mjs
 *
 * Offline, non-destructive utility to compute and backfill SHA-256 cryptographic hashes
 * for private compliance documents in public.universal_document_versions.
 *
 * SAFETY INVARIANTS:
 * 1. DRY-RUN BY DEFAULT: Pass `--apply` explicitly to perform updates.
 * 2. NO HARDCODED SECRETS: Reads strictly from process.env (SUPABASE_URL, SUPABASE_SERVICE_KEY / DATABASE_URL).
 * 3. AUTHENTICATED PRIVATE ACCESS: Uses Supabase storage download API (never generates public URLs).
 * 4. BINARY-DERIVED INTEGRITY: SHA-256 is computed strictly from downloaded binary bytes using crypto.createHash('sha256').
 * 5. SAFE BATCHING: Processes records in bounded batches (default: 20 per batch) with pacing delay.
 * 6. IDEMPOTENT: Only targets records where `sha256 IS NULL`.
 * 7. ZERO ASSUMPTIONS ON CURRENT FLAGS: Preserves `is_current`, `version_number`, and `document_id`.
 */

import crypto from 'crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const isDryRun = !process.argv.includes('--apply');
const batchSize = 20;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.DATABASE_URL;

async function main() {
  console.log('================================================================');
  console.log('UNIVERSAL DOCUMENT BANK — SHA-256 BINARY HASH BACKFILL TOOL');
  console.log(`Execution Mode: ${isDryRun ? 'DRY RUN (Simulated, No Changes)' : 'APPLY (Live Updates)'}`);
  console.log('================================================================\n');

  if (!supabaseUrl || !supabaseServiceKey || !dbUrl) {
    console.error('ERROR: Required environment variables missing:');
    if (!supabaseUrl) console.error('  - SUPABASE_URL');
    if (!supabaseServiceKey) console.error('  - SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY)');
    if (!dbUrl) console.error('  - DATABASE_URL');
    console.error('\nUsage:');
    console.error('  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... DATABASE_URL=... node universal_document_bank_sha256_backfill.mjs [--apply]');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const pgClient = new pg.Client({ connectionString: dbUrl });
  await pgClient.connect();

  try {
    // 1. Query unhashed versions
    const query = `
      SELECT id, document_id, version_number, storage_bucket, storage_path, file_size, original_file_name
      FROM public.universal_document_versions
      WHERE sha256 IS NULL
        AND storage_bucket IS NOT NULL
        AND storage_path IS NOT NULL
      ORDER BY created_at ASC
    `;

    const { rows: candidates } = await pgClient.query(query);
    console.log(`Found ${candidates.length} document version records lacking SHA-256 checksums.`);

    if (candidates.length === 0) {
      console.log('All document versions already possess valid SHA-256 hashes. Nothing to do.');
      return;
    }

    let processedCount = 0;
    let missingObjectCount = 0;
    let computedCount = 0;

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      console.log(`\nProcessing batch ${Math.floor(i / batchSize) + 1} (${batch.length} items)...`);

      for (const record of batch) {
        processedCount++;
        const { id, storage_bucket, storage_path } = record;

        try {
          // Download file binary from private bucket using authenticated storage client
          const { data: fileBlob, error: downloadError } = await supabase.storage
            .from(storage_bucket)
            .download(storage_path);

          if (downloadError || !fileBlob) {
            missingObjectCount++;
            console.warn(`  [MISSING OBJECT] Version ID ${id} (${storage_bucket}/${storage_path}): ${downloadError?.message || 'Empty file'}`);
            continue;
          }

          // Compute cryptographic hash of binary arrayBuffer
          const arrayBuffer = await fileBlob.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const computedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');

          computedCount++;
          console.log(`  [OK] Version ${id}: SHA-256 ${computedSha256} (${buffer.length} bytes)`);

          if (!isDryRun) {
            await pgClient.query(
              `UPDATE public.universal_document_versions 
               SET sha256 = $1 
               WHERE id = $2 AND sha256 IS NULL`,
              [computedSha256, id]
            );
          }
        } catch (itemErr) {
          console.error(`  [ERROR] Processing version ${id}:`, itemErr.message);
        }
      }

      // Small pacing delay between batches
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('\n================================================================');
    console.log('BACKFILL SUMMARY:');
    console.log(`  Total Unhashed Records Scanned : ${processedCount}`);
    console.log(`  Valid Objects & SHA-256 Computed: ${computedCount}`);
    console.log(`  Missing / Unreachable Objects  : ${missingObjectCount}`);
    console.log(`  Database Updates Executed      : ${isDryRun ? 0 : computedCount}`);
    console.log('================================================================');
  } finally {
    await pgClient.end();
  }
}

main().catch(err => {
  console.error('Fatal execution error:', err.message);
  process.exit(1);
});

