import pg from 'pg';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const envFile = fs.readFileSync('.env', 'utf8');
const anonMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const SUPABASE_ANON_KEY = anonMatch ? anonMatch[1].trim() : '';
const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';

const AUDIT_OUT_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2';
const PLAN_PATH = path.join(AUDIT_OUT_DIR, 'crm_duplicate_reconciliation_plan.json');

async function main() {
  console.log('=== DRY-RUN DUPLICATE RECONCILIATION PLANNER ===\n');

  const client = new pg.Client({ connectionString: DB_CONN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  await sb.auth.signInWithPassword({
    email: 'warehouse@pharma.com',
    password: 'warehouse123'
  });

  // Query all crm_product_documents
  const crmDocs = await client.query(`
    SELECT d.id, d.product_name, d.make, d.document_type, d.specification,
           d.is_permanent, d.original_file_name, d.display_file_name,
           d.storage_bucket, d.storage_path, d.file_size, d.mime_type,
           d.inquiry_id, d.pricing_option_id, d.enquiry_request_id,
           d.source_gmail_message_id, d.created_at,
           i.inquiry_number
    FROM crm_product_documents d
    LEFT JOIN crm_inquiries i ON d.inquiry_id = i.id
    ORDER BY d.created_at ASC
  `);

  console.log(`Auditing ${crmDocs.rows.length} total crm_product_documents records for SHA-256 duplicates...`);

  // Download and compute SHA-256 for each unique storage_path
  const pathShaMap = new Map();
  const uniquePaths = Array.from(new Set(crmDocs.rows.map(d => d.storage_path).filter(Boolean)));
  console.log(`Fetching ${uniquePaths.length} unique storage paths...`);

  for (const sp of uniquePaths) {
    try {
      const { data, error } = await sb.storage.from('crm-documents').download(sp);
      if (data) {
        const buf = Buffer.from(await data.arrayBuffer());
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        pathShaMap.set(sp, hash);
      }
    } catch (e) {
      console.warn(`Could not compute hash for ${sp}:`, e.message);
    }
  }

  // Group crm_product_documents by SHA-256
  const shaGroups = new Map();
  for (const doc of crmDocs.rows) {
    const hash = pathShaMap.get(doc.storage_path);
    if (!hash) continue;
    if (!shaGroups.has(hash)) shaGroups.set(hash, []);
    shaGroups.get(hash).push(doc);
  }

  const duplicatePlans = [];
  let totalReclaimableBytes = 0;

  for (const [hash, docs] of shaGroups.entries()) {
    if (docs.length > 1) {
      // Pick canonical: oldest record or one marked is_permanent
      const canonical = docs.find(d => d.is_permanent) || docs[0];
      const duplicates = docs.filter(d => d.id !== canonical.id);

      // Check if different physical paths exist
      const uniquePhysicalPaths = Array.from(new Set(docs.map(d => d.storage_path)));
      const redundantPaths = uniquePhysicalPaths.filter(p => p !== canonical.storage_path);

      const groupBytes = canonical.file_size || 0;
      const reclaimableForGroup = redundantPaths.length * groupBytes;
      totalReclaimableBytes += reclaimableForGroup;

      duplicatePlans.push({
        sha256: hash,
        document_type: canonical.document_type,
        canonical_record_id: canonical.id,
        canonical_product_name: canonical.product_name,
        canonical_make: canonical.make,
        canonical_storage_path: canonical.storage_path,
        canonical_inquiry: canonical.inquiry_number || canonical.inquiry_id || 'NONE',
        file_name: canonical.display_file_name || canonical.original_file_name,
        file_size_bytes: groupBytes,
        file_size_kb: (groupBytes / 1024).toFixed(1),
        total_references_count: docs.length,
        redundant_physical_paths_count: redundantPaths.length,
        reclaimable_bytes: reclaimableForGroup,
        reclaimable_kb: (reclaimableForGroup / 1024).toFixed(1),
        references_to_redirect: duplicates.map(dup => ({
          record_id: dup.id,
          inquiry: dup.inquiry_number || dup.inquiry_id || 'NONE',
          current_path: dup.storage_path,
          proposed_canonical_path: canonical.storage_path,
          created_at: dup.created_at
        })),
        physical_paths_to_remove_after_redirection: redundantPaths
      });
    }
  }

  duplicatePlans.sort((a, b) => b.reclaimable_bytes - a.reclaimable_bytes);

  console.log(`\nFound ${duplicatePlans.length} duplicate groups across crm_product_documents.`);
  console.log(`Total Reclaimable Duplicate Storage (via safe aliasing): ${(totalReclaimableBytes / 1024 / 1024).toFixed(2)} MB (${totalReclaimableBytes} bytes)\n`);

  console.table(duplicatePlans.map(p => ({
    name: p.file_name?.substring(0, 32),
    type: p.document_type,
    refs: p.total_references_count,
    redundant_files: p.redundant_physical_paths_count,
    size_kb: p.file_size_kb,
    saved_kb: p.reclaimable_kb,
    sha: p.sha256.substring(0, 12) + '...'
  })));

  const finalPlan = {
    plan_mode: 'DRY_RUN_RECONCILIATION_PLAN',
    generated_at: new Date().toISOString(),
    total_duplicate_groups: duplicatePlans.length,
    total_reclaimable_bytes: totalReclaimableBytes,
    total_reclaimable_mb: (totalReclaimableBytes / 1024 / 1024).toFixed(2),
    execution_policy: 'SAFE_ALIASING_FIRST (Zero physical deletion during dry-run; requires redirection before physical prune)',
    groups: duplicatePlans
  };

  fs.writeFileSync(PLAN_PATH, JSON.stringify(finalPlan, null, 2));
  console.log(`\nReconciliation plan saved to: ${PLAN_PATH}`);

  await client.end();
}

main().catch(console.error);

