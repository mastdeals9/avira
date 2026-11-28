// scripts/deep_storage_forensics.mjs
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || '')
});

async function run() {
  console.log('=== STARTING DEEP SUPABASE STORAGE FORENSICS ===');

  // 1. Fetch all storage.objects
  const objRes = await pool.query(`
    SELECT 
      id, bucket_id, name,
      COALESCE((metadata->>'size')::bigint, 0) as size,
      COALESCE(metadata->>'mimetype', '') as mimetype,
      created_at, updated_at
    FROM storage.objects
    ORDER BY bucket_id, name;
  `);

  const allObjects = objRes.rows;
  console.log(`Total storage.objects found: ${allObjects.length}`);

  // 2. Fetch references across database
  const referencedPaths = new Set();
  const referencedFilenames = new Set();

  function addRef(val) {
    if (!val) return;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) return;
      referencedPaths.add(trimmed);
      // Also extract basename and relative path after bucket name
      const parts = trimmed.split('/');
      const basename = parts[parts.length - 1];
      if (basename) referencedFilenames.add(basename);

      // If URL contains supabase storage path: .../storage/v1/object/(public|authenticated|sign)/<bucket>/<path>
      const match = trimmed.match(/\/storage\/v1\/object\/(?:public|authenticated|sign)\/([^/?#]+)\/([^?#]+)/);
      if (match) {
        const decodedPath = decodeURIComponent(match[2]);
        referencedPaths.add(decodedPath);
        referencedPaths.add(`${match[1]}/${decodedPath}`);
        const b = decodedPath.split('/').pop();
        if (b) referencedFilenames.add(b);
      }
    } else if (Array.isArray(val)) {
      val.forEach(addRef);
    } else if (typeof val === 'object') {
      if (val.path) addRef(val.path);
      if (val.file_path) addRef(val.file_path);
      if (val.url) addRef(val.url);
      if (val.file_url) addRef(val.file_url);
      if (val.name) addRef(val.name);
      if (val.filename) addRef(val.filename);
      if (val.fileName) addRef(val.fileName);
      if (val.storage_path) addRef(val.storage_path);
      if (val.storagePath) addRef(val.storagePath);
      for (const k of Object.keys(val)) {
        if (typeof val[k] === 'string' && (val[k].includes('/') || val[k].includes('.'))) {
          addRef(val[k]);
        }
      }
    }
  }

  async function harvest(query, extractFn) {
    try {
      const res = await pool.query(query);
      for (const row of res.rows) {
        extractFn(row);
      }
    } catch (e) {
      console.warn('Harvest warning for query:', query.slice(0, 50), e.message);
    }
  }

  // Harvest all known columns
  await harvest('SELECT file_url FROM batch_documents WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT file_url FROM petty_cash_documents WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT file_url FROM petty_cash_files WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT file_url FROM product_documents WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT file_url FROM product_files WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT file_url FROM product_source_documents WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT file_url FROM customer_documents WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT file_url FROM faktur_pajak_files WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT file_url FROM tax_payment_files WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT storage_path FROM crm_product_documents WHERE storage_path IS NOT NULL', r => addRef(r.storage_path));
  await harvest('SELECT customer_po_file_url FROM sales_orders WHERE customer_po_file_url IS NOT NULL', r => addRef(r.customer_po_file_url));
  await harvest('SELECT customer_po_file_url FROM sales_invoices WHERE customer_po_file_url IS NOT NULL', r => addRef(r.customer_po_file_url));
  await harvest('SELECT customer_po_file_url FROM active_sales_invoices WHERE customer_po_file_url IS NOT NULL', r => addRef(r.customer_po_file_url));
  await harvest('SELECT attachments_context FROM bulk_email_campaigns WHERE attachments_context IS NOT NULL', r => addRef(r.attachments_context));
  await harvest('SELECT document_urls FROM purchase_invoices WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT document_urls FROM finance_expenses WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT document_urls FROM petty_cash_transactions WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT document_urls FROM payment_vouchers WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT document_urls FROM receipt_vouchers WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT document_urls FROM finance_payees WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT document_urls, bpjs_document_urls FROM finance_staff_master', r => { addRef(r.document_urls); addRef(r.bpjs_document_urls); });
  await harvest('SELECT document_urls FROM bpjs_monthly_registers WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT document_urls FROM import_cost_headers WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT document_urls FROM capital_contributions WHERE document_urls IS NOT NULL', r => addRef(r.document_urls));
  await harvest('SELECT attachments FROM crm_activity_logs WHERE attachments IS NOT NULL', r => addRef(r.attachments));
  await harvest('SELECT attachment_urls FROM crm_email_activities WHERE attachment_urls IS NOT NULL', r => addRef(r.attachment_urls));
  await harvest('SELECT attachment_urls FROM crm_email_inbox WHERE attachment_urls IS NOT NULL', r => addRef(r.attachment_urls));
  await harvest('SELECT attachments FROM enquiry_conversation_messages WHERE attachments IS NOT NULL', r => addRef(r.attachments));
  await harvest('SELECT file_url FROM bank_statement_uploads WHERE file_url IS NOT NULL', r => addRef(r.file_url));
  await harvest('SELECT company_logo_url, company_stamp_url FROM company_profiles', r => { addRef(r.company_logo_url); addRef(r.company_stamp_url); });
  await harvest('SELECT company_logo_url FROM app_settings WHERE company_logo_url IS NOT NULL', r => addRef(r.company_logo_url));
  await harvest('SELECT document_url FROM nota_retur WHERE document_url IS NOT NULL', r => addRef(r.document_url));
  await harvest('SELECT attachment_urls, proof_url FROM tasks', r => { addRef(r.attachment_urls); addRef(r.proof_url); });
  await harvest('SELECT attachment_urls FROM task_comments WHERE attachment_urls IS NOT NULL', r => addRef(r.attachment_urls));

  console.log(`Collected ${referencedPaths.size} path strings and ${referencedFilenames.size} unique filenames.`);

  // 3. Classify all 2,040 objects
  const confirmedDuplicates = [];
  const confirmedTemporary = [];
  const confirmedTest = [];
  const orphanedFiles = [];
  const unreferencedUseful = [];
  const unknownFiles = [];
  const directlyReferenced = [];

  // Group by size & name to find duplicate files
  const sizeMap = new Map();
  for (const obj of allObjects) {
    const size = parseInt(obj.size, 10);
    if (!sizeMap.has(size)) sizeMap.set(size, []);
    sizeMap.get(size).push(obj);
  }

  // Exact duplicates: same bucket, identical size and name pattern
  const duplicateIds = new Set();
  for (const [size, list] of sizeMap.entries()) {
    if (size > 0 && list.length > 1) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (a.bucket_id === b.bucket_id) {
            const baseA = a.name.split('/').pop();
            const baseB = b.name.split('/').pop();
            if (baseA === baseB) {
              duplicateIds.add(b.id);
              confirmedDuplicates.push({ duplicate: b, original: a, reason: 'Identical path and size' });
            } else if (
              baseB === baseA.replace(/(\.[^.]+)$/, ' (1)$1') ||
              baseB === baseA.replace(/(\.[^.]+)$/, '_copy$1') ||
              baseA === baseB.replace(/(\.[^.]+)$/, ' (1)$1')
            ) {
              duplicateIds.add(b.id);
              confirmedDuplicates.push({ duplicate: b, original: a, reason: 'Duplicate upload copy with identical size' });
            }
          }
        }
      }
    }
  }

  for (const obj of allObjects) {
    if (duplicateIds.has(obj.id)) {
      continue;
    }

    const nameLower = obj.name.toLowerCase();
    const basename = obj.name.split('/').pop();
    const basenameLower = basename.toLowerCase();
    const size = parseInt(obj.size, 10);

    const isDirectlyReferenced = 
      referencedPaths.has(obj.name) || 
      referencedPaths.has(`${obj.bucket_id}/${obj.name}`) ||
      referencedPaths.has(basename) ||
      referencedFilenames.has(basename);

    // 1. Confirmed Temporary files
    if (
      nameLower.includes('/tmp/') || 
      nameLower.startsWith('tmp/') ||
      nameLower.includes('/temp/') || 
      nameLower.startsWith('temp/') ||
      basenameLower.startsWith('tmp_') ||
      basenameLower.startsWith('temp_') ||
      basenameLower.endsWith('.tmp')
    ) {
      confirmedTemporary.push(obj);
      continue;
    }

    // 2. Confirmed Test Attachments
    if (
      basenameLower.includes('wa_test_media') ||
      basenameLower.includes('dummy') ||
      basenameLower.includes('test_upload') ||
      basenameLower.includes('sample_test') ||
      nameLower.includes('/test/') ||
      nameLower.includes('race_test')
    ) {
      confirmedTest.push(obj);
      continue;
    }

    if (isDirectlyReferenced) {
      directlyReferenced.push(obj);
      continue;
    }

    // 3. Orphaned placeholders
    if (size === 0) {
      orphanedFiles.push(obj);
      continue;
    }

    // 4. Potentially useful documents vs Unknown
    const isBusinessDoc = 
      /coa|msds|tds|spec|invoice|pib|peb|faktur|pajak|spt|bpjs|receipt|po[-_]|kwitansi|surat|jalan|do[-_]|spk|kontrak|batch|manifest|bl|bll|packing|gmp|iso|halal|pom/i.test(nameLower) ||
      obj.bucket_id === 'batch-documents' ||
      obj.bucket_id === 'expense-documents' ||
      obj.bucket_id === 'petty-cash-receipts' ||
      obj.bucket_id === 'product-documents' ||
      obj.bucket_id === 'product-source-documents' ||
      obj.bucket_id === 'sales-order-documents';

    if (isBusinessDoc) {
      unreferencedUseful.push(obj);
    } else {
      unknownFiles.push(obj);
    }
  }

  const formatSize = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes.toLocaleString()} bytes)`;
  const sumBytes = (list) => list.reduce((sum, o) => sum + parseInt(o.size || 0, 10), 0);

  const report = {
    totalObjects: allObjects.length,
    totalBytes: sumBytes(allObjects),
    categories: {
      directlyReferenced: { count: directlyReferenced.length, bytes: sumBytes(directlyReferenced) },
      confirmedDuplicates: { count: confirmedDuplicates.length, bytes: sumBytes(confirmedDuplicates.map(d=>d.duplicate)) },
      confirmedTemporary: { count: confirmedTemporary.length, bytes: sumBytes(confirmedTemporary) },
      confirmedTest: { count: confirmedTest.length, bytes: sumBytes(confirmedTest) },
      orphanedFiles: { count: orphanedFiles.length, bytes: sumBytes(orphanedFiles) },
      unreferencedUseful: { count: unreferencedUseful.length, bytes: sumBytes(unreferencedUseful) },
      unknownFiles: { count: unknownFiles.length, bytes: sumBytes(unknownFiles) }
    }
  };

  console.log('\n=== AUDIT ACCOUNTING SUMMARY ===');
  console.log(`Total Objects: ${report.totalObjects} | Total Size: ${formatSize(report.totalBytes)}`);
  console.log(`1. Directly Referenced: ${report.categories.directlyReferenced.count} files | ${formatSize(report.categories.directlyReferenced.bytes)}`);
  console.log(`2. Confirmed Duplicate Files: ${report.categories.confirmedDuplicates.count} files | ${formatSize(report.categories.confirmedDuplicates.bytes)}`);
  console.log(`3. Confirmed Temporary Files: ${report.categories.confirmedTemporary.count} files | ${formatSize(report.categories.confirmedTemporary.bytes)}`);
  console.log(`4. Confirmed Test Attachments: ${report.categories.confirmedTest.count} files | ${formatSize(report.categories.confirmedTest.bytes)}`);
  console.log(`5. Orphaned Files: ${report.categories.orphanedFiles.count} files | ${formatSize(report.categories.orphanedFiles.bytes)}`);
  console.log(`6. Unreferenced Potentially Useful: ${report.categories.unreferencedUseful.count} files | ${formatSize(report.categories.unreferencedUseful.bytes)}`);
  console.log(`7. Unknown Files: ${report.categories.unknownFiles.count} files | ${formatSize(report.categories.unknownFiles.bytes)}`);

  console.log('\n--- Unknown files sample ---');
  console.log(unknownFiles.slice(0, 10).map(f => ({ bucket: f.bucket_id, name: f.name, size: f.size })));

  fs.writeFileSync('scripts/storage_accounting_detailed.json', JSON.stringify({
    report,
    confirmedDuplicates,
    confirmedTemporary,
    confirmedTest,
    orphanedFiles,
    unknownFiles
  }, null, 2));

  await pool.end();
}

run().catch(console.error);
