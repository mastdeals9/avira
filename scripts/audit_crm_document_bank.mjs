import pg from 'pg';

const pool = new pg.Pool({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || '')
});

async function main() {
  console.log('=== AUDITING CRM DOCUMENT BANK & CRM-DOCUMENTS BUCKET ===');

  // 1. Storage bucket summary
  const storageRes = await pool.query(`
    SELECT 
      COUNT(*) as total_objects,
      SUM((metadata->>'size')::bigint) as total_bytes
    FROM storage.objects
    WHERE bucket_id = 'crm-documents';
  `);
  console.log('crm-documents storage bucket:', storageRes.rows[0]);

  // 2. crm_product_documents summary
  const docSummary = await pool.query(`
    SELECT
      COUNT(*) as total_docs,
      COUNT(*) FILTER (WHERE source_gmail_message_id IS NOT NULL) as from_gmail,
      COUNT(*) FILTER (WHERE document_type = 'OTHER') as type_other,
      COUNT(*) FILTER (WHERE is_permanent = true) as permanent_count,
      COUNT(*) FILTER (WHERE inquiry_id IS NOT NULL) as linked_inquiry_count,
      COUNT(*) FILTER (WHERE pricing_option_id IS NOT NULL) as linked_pricing_option_count,
      COUNT(*) FILTER (
        WHERE document_type = 'OTHER' 
          AND (is_permanent = false OR is_permanent IS NULL) 
          AND inquiry_id IS NULL 
          AND pricing_option_id IS NULL
      ) as junk_other_count
    FROM crm_product_documents;
  `);
  console.log('crm_product_documents summary:', docSummary.rows[0]);

  // 3. Size of junk OTHER records in storage
  const junkSizeRes = await pool.query(`
    SELECT 
      COUNT(*) as matched_count,
      SUM((so.metadata->>'size')::bigint) as total_bytes
    FROM crm_product_documents cpd
    JOIN storage.objects so ON so.bucket_id = 'crm-documents' AND so.name = cpd.storage_path
    WHERE cpd.document_type = 'OTHER' 
      AND (cpd.is_permanent = false OR cpd.is_permanent IS NULL) 
      AND cpd.inquiry_id IS NULL 
      AND cpd.pricing_option_id IS NULL;
  `);
  console.log('Storage bytes of junk OTHER records:', junkSizeRes.rows[0]);

  // 4. Objects in crm-documents bucket not in crm_product_documents
  const unmappedObjects = await pool.query(`
    SELECT 
      so.id,
      so.name,
      (so.metadata->>'size')::bigint as size_bytes,
      so.metadata->>'mimetype' as mime_type,
      so.created_at
    FROM storage.objects so
    LEFT JOIN crm_product_documents cpd 
      ON so.bucket_id = 'crm-documents' AND so.name = cpd.storage_path
    WHERE so.bucket_id = 'crm-documents'
      AND cpd.id IS NULL;
  `);
  console.log('Unmapped objects count in crm-documents:', unmappedObjects.rows.length);
  const unmappedBytes = unmappedObjects.rows.reduce((acc, r) => acc + BigInt(r.size_bytes || 0), 0n);
  console.log('Unmapped objects total bytes:', unmappedBytes.toString(), `(${(Number(unmappedBytes) / (1024 * 1024)).toFixed(2)} MiB)`);

  // Let's see some samples of unmapped objects
  console.log('Sample unmapped objects (first 10):', unmappedObjects.rows.slice(0, 10));

  await pool.end();
}

main().catch(console.error);

