import pg from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');

async function main() {
  const client = new pg.Client({
    connectionString: DB_CONN,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  console.log('=== PHASE 1: CRM DOCUMENT BANK & LIFECYCLE AUDIT ===\n');

  // 1. Audit crm_product_documents
  const crmDocs = await client.query(`
    SELECT d.id, d.product_name, d.make, d.document_type, d.specification,
           d.is_permanent, d.original_file_name, d.display_file_name,
           d.storage_bucket, d.storage_path, d.file_size, d.mime_type,
           d.inquiry_id, d.pricing_option_id, d.enquiry_request_id,
           d.source_gmail_message_id, d.created_at,
           i.inquiry_number
    FROM crm_product_documents d
    LEFT JOIN crm_inquiries i ON d.inquiry_id = i.id
    ORDER BY d.created_at DESC
  `);

  console.log(`Total crm_product_documents records: ${crmDocs.rows.length}`);
  const permDocs = crmDocs.rows.filter(d => d.is_permanent);
  const tempDocs = crmDocs.rows.filter(d => !d.is_permanent);
  console.log(`- Banked (is_permanent = true): ${permDocs.length}`);
  console.log(`- Temporary (is_permanent = false): ${tempDocs.length}`);

  // Check RLS policies on crm_product_documents
  const rlsRes = await client.query(`
    SELECT polname, polcmd, polroles::regrole[], polqual, polwithcheck
    FROM pg_policy
    WHERE polrelid = 'public.crm_product_documents'::regclass
  `);
  console.log('\n--- RLS Policies on crm_product_documents ---');
  for (const p of rlsRes.rows) {
    console.log(`- [${p.polname}] CMD: ${p.polcmd} | Roles: ${p.polroles}`);
  }

  // Check storage policies on crm-documents bucket
  const storageRls = await client.query(`
    SELECT polname, polcmd, polroles::regrole[], polqual, polwithcheck
    FROM pg_policy
    WHERE polrelid = 'storage.objects'::regclass
      AND (polqual::text ILIKE '%crm-documents%' OR polwithcheck::text ILIKE '%crm-documents%')
  `);
  console.log('\n--- Storage RLS Policies for crm-documents ---');
  for (const p of storageRls.rows) {
    console.log(`- [${p.polname}] CMD: ${p.polcmd} | Roles: ${p.polroles}`);
  }

  // 2. Audit all storage objects in crm-documents bucket
  const crmStorageObjs = await client.query(`
    SELECT id, name, (metadata->>'size')::bigint as size, metadata->>'mimetype' as mime, created_at, updated_at
    FROM storage.objects
    WHERE bucket_id = 'crm-documents'
    ORDER BY size DESC
  `);
  console.log(`\nTotal objects in crm-documents bucket: ${crmStorageObjs.rows.length} (${(crmStorageObjs.rows.reduce((s, r) => s + Number(r.size), 0) / 1024 / 1024).toFixed(2)} MB)`);

  // Map storage path to crm_product_documents
  const docByPath = new Map();
  for (const d of crmDocs.rows) {
    if (!docByPath.has(d.storage_path)) {
      docByPath.set(d.storage_path, []);
    }
    docByPath.get(d.storage_path).push(d);
  }

  const linkedStorage = [];
  const unlinkedStorage = [];
  for (const obj of crmStorageObjs.rows) {
    if (docByPath.has(obj.name)) {
      linkedStorage.push({ ...obj, docs: docByPath.get(obj.name) });
    } else {
      unlinkedStorage.push(obj);
    }
  }

  console.log(`- Linked to crm_product_documents: ${linkedStorage.length} objects (${(linkedStorage.reduce((s, r) => s + Number(r.size), 0) / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`- Unlinked in crm-documents bucket: ${unlinkedStorage.length} objects (${(unlinkedStorage.reduce((s, r) => s + Number(r.size), 0) / 1024 / 1024).toFixed(2)} MB)`);

  // Breakdown of unlinked storage by prefix/folder
  const unlinkedFolders = {};
  for (const obj of unlinkedStorage) {
    const folder = obj.name.includes('/') ? obj.name.split('/')[0] : 'root';
    if (!unlinkedFolders[folder]) {
      unlinkedFolders[folder] = { count: 0, bytes: 0 };
    }
    unlinkedFolders[folder].count++;
    unlinkedFolders[folder].bytes += Number(obj.size);
  }
  console.log('\n--- Unlinked Storage by Folder in crm-documents ---');
  for (const [folder, data] of Object.entries(unlinkedFolders)) {
    console.log(`  Folder "${folder}": ${data.count} objects, ${(data.bytes / 1024 / 1024).toFixed(2)} MB`);
  }

  // 3. PHASE 5: OUR CATALOG IDENTIFICATION & FORENSICS
  console.log('\n=== PHASE 5: OUR CATALOG AUDIT & FORENSICS ===');
  const catalogObjs = crmStorageObjs.rows.filter(o => 
    o.name.toLowerCase().includes('catalog') || 
    o.name.toLowerCase().includes('catalogue') || 
    o.name.toLowerCase().includes('katalog')
  );

  console.log(`Found ${catalogObjs.length} catalog objects in crm-documents bucket.`);
  const catalogDetails = [];

  for (const cat of catalogObjs) {
    // Check bulk_email_campaigns
    const folderMatch = cat.name.match(/^bulk-email\/([0-9a-f-]{36})\//);
    const campaignId = folderMatch ? folderMatch[1] : null;

    let campaignInfo = null;
    if (campaignId) {
      const campRes = await client.query(
        'SELECT id, subject, status, total_recipients, sent_count, completed_at, attachments_context FROM bulk_email_campaigns WHERE id = $1',
        [campaignId]
      );
      if (campRes.rows.length > 0) {
        campaignInfo = campRes.rows[0];
      }
    }

    catalogDetails.push({
      id: cat.id,
      name: cat.name,
      filename: path.basename(cat.name),
      size_bytes: Number(cat.size),
      size_mb: (Number(cat.size) / 1024 / 1024).toFixed(2),
      mime: cat.mime,
      created_at: cat.created_at,
      campaign_id: campaignId,
      campaign_subject: campaignInfo ? campaignInfo.subject : 'NO_CAMPAIGN',
      campaign_status: campaignInfo ? campaignInfo.status : 'N/A',
      campaign_completed_at: campaignInfo ? campaignInfo.completed_at : null
    });
  }

  console.table(catalogDetails.map(c => ({
    name: c.filename,
    size_mb: c.size_mb,
    campaign_status: c.campaign_status,
    campaign_id: c.campaign_id ? c.campaign_id.substring(0, 8) + '...' : 'none',
    created: new Date(c.created_at).toISOString().split('T')[0]
  })));

  const totalCatalogBytes = catalogDetails.reduce((s, c) => s + c.size_bytes, 0);
  console.log(`Total "Our Catalog" storage consumed: ${(totalCatalogBytes / 1024 / 1024).toFixed(2)} MB across ${catalogDetails.length} files.`);

  // 4. Check for duplicate content across catalog files
  // Group by filename / size
  const catSizeGroups = {};
  for (const c of catalogDetails) {
    if (!catSizeGroups[c.size_bytes]) catSizeGroups[c.size_bytes] = [];
    catSizeGroups[c.size_bytes].push(c);
  }
  console.log('\n--- Catalog Groupings by exact size ---');
  for (const [size, list] of Object.entries(catSizeGroups)) {
    console.log(`  Size ${size} bytes (${(Number(size)/1024/1024).toFixed(2)} MB): ${list.length} copies of "${list[0].filename}"`);
  }

  // 5. PHASE 4: DUPLICATE DETECTION ACROSS CRM_PRODUCT_DOCUMENTS
  console.log('\n=== PHASE 4: DUPLICATE RECONCILIATION IN CRM_PRODUCT_DOCUMENTS ===');
  // Group crm_product_documents by (product_name, make, document_type, file_size) or storage_path
  const sizeMap = new Map();
  for (const doc of crmDocs.rows) {
    const key = `${doc.file_size}_${doc.original_file_name}`;
    if (!sizeMap.has(key)) sizeMap.set(key, []);
    sizeMap.get(key).push(doc);
  }

  const crmDuplicates = [];
  for (const [key, group] of sizeMap.entries()) {
    if (group.length > 1) {
      crmDuplicates.push({
        key,
        filename: group[0].original_file_name,
        size_kb: (group[0].file_size / 1024).toFixed(1),
        count: group.length,
        product: group[0].product_name,
        make: group[0].make,
        paths: group.map(g => g.storage_path)
      });
    }
  }

  console.log(`Found ${crmDuplicates.length} duplicate groups within crm_product_documents:`);
  console.table(crmDuplicates);

  // 6. PHASE 3: PRODUCT + MAKE DATA STRUCTURE AUDIT
  console.log('\n=== PHASE 3: PRODUCT + MAKE DATA STRUCTURE AUDIT ===');
  const prods = await client.query(`
    SELECT id, product_name, product_code, category, is_active
    FROM products
    ORDER BY product_name
  `);
  console.log(`Total Master Products in ERP: ${prods.rows.length}`);

  // Match crm_product_documents product_name against master products
  const masterProdNames = new Map(prods.rows.map(p => [p.product_name.toLowerCase().trim(), p]));
  let matchedProds = 0;
  let unmatchedProds = 0;
  const unmatchedList = new Set();

  for (const doc of crmDocs.rows) {
    if (!doc.product_name) {
      unmatchedProds++;
      continue;
    }
    const clean = doc.product_name.toLowerCase().trim();
    if (masterProdNames.has(clean)) {
      matchedProds++;
    } else {
      unmatchedProds++;
      unmatchedList.add(doc.product_name);
    }
  }

  console.log(`crm_product_documents matching Master Products: ${matchedProds} / ${crmDocs.rows.length}`);
  console.log(`Unmatched product names: ${unmatchedList.size} distinct names:`, Array.from(unmatchedList).slice(0, 15));

  // Write full audit JSON for deep report generation
  const auditResult = {
    crm_product_documents_count: crmDocs.rows.length,
    banked_count: permDocs.length,
    temporary_count: tempDocs.length,
    crm_storage_objects_count: crmStorageObjs.rows.length,
    crm_storage_total_mb: (crmStorageObjs.rows.reduce((s, r) => s + Number(r.size), 0) / 1024 / 1024).toFixed(2),
    linked_storage_count: linkedStorage.length,
    linked_storage_mb: (linkedStorage.reduce((s, r) => s + Number(r.size), 0) / 1024 / 1024).toFixed(2),
    unlinked_storage_count: unlinkedStorage.length,
    unlinked_storage_mb: (unlinkedStorage.reduce((s, r) => s + Number(r.size), 0) / 1024 / 1024).toFixed(2),
    catalog_documents: catalogDetails,
    catalog_total_mb: (totalCatalogBytes / 1024 / 1024).toFixed(2),
    unlinked_folders: unlinkedFolders,
    crm_duplicates: crmDuplicates,
    master_products_count: prods.rows.length
  };

  fs.writeFileSync('scripts/crm_lifecycle_audit_results.json', JSON.stringify(auditResult, null, 2));
  console.log('\nAudit written to scripts/crm_lifecycle_audit_results.json');

  await client.end();
}

main().catch(console.error);

