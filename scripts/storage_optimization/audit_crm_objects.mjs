import pg from 'pg';

const client = new pg.Client({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || ''),
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();

  // Get all objects in crm-documents
  const crmObjs = await client.query(`
    SELECT id, name, (metadata->>'size')::bigint as size, metadata->>'mimetype' as mime, created_at
    FROM storage.objects
    WHERE bucket_id = 'crm-documents'
    ORDER BY size DESC;
  `);
  console.log(`Total objects in crm-documents: ${crmObjs.rows.length}`);

  // Check crm_product_documents
  const prodDocs = await client.query(`SELECT id, storage_path, original_file_name, file_size FROM crm_product_documents;`);
  const mappedPaths = new Set(prodDocs.rows.map(r => r.storage_path));

  // Also check bulk email campaigns, inquiry messages, customer docs, whatsapp
  const emailAtts = await client.query(`
    SELECT id, attachments FROM bulk_email_campaigns WHERE attachments IS NOT NULL;
  `);
  const inquiryAtts = await client.query(`
    SELECT id, attachments FROM crm_inquiries WHERE attachments IS NOT NULL;
  `);

  console.log(`crm_product_documents count: ${prodDocs.rows.length}`);
  console.log(`bulk_email_campaigns with attachments: ${emailAtts.rows.length}`);
  console.log(`crm_inquiries with attachments: ${inquiryAtts.rows.length}`);

  let unmatched = 0;
  let unmatchedBytes = 0n;
  const unmatchedList = [];

  for (const obj of crmObjs.rows) {
    if (!mappedPaths.has(obj.name)) {
      unmatched++;
      unmatchedBytes += BigInt(obj.size || 0);
      unmatchedList.push({ name: obj.name, size: obj.size, mime: obj.mime });
    }
  }

  console.log(`\nUnmatched crm-documents objects: ${unmatched} (Total size: ${(Number(unmatchedBytes) / 1024 / 1024).toFixed(2)} MB)`);
  console.log('Sample unmatched objects:', unmatchedList.slice(0, 10));

  await client.end();
}

main().catch(console.error);
