import pg from 'pg';

const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');

function normalizeDocType(raw) {
  if (!raw) return 'OTHER';
  const u = raw.toUpperCase().trim();
  if (u.includes('COA')) return 'COA';
  if (u.includes('MSDS') || u.includes('SDS')) return 'MSDS';
  if (u.includes('GMP')) return 'GMP';
  if (u.includes('HALAL')) return 'HALAL';
  if (u.includes('SPEC')) return 'SPECIFICATION';
  if (u.includes('TDS')) return 'TDS';
  if (u.includes('DMF')) return 'DMF';
  if (u.includes('LICEN')) return 'MANUFACTURING LICENCE';
  if (u.includes('CATALOG')) return 'PRODUCT CATALOGUE';
  if (u.includes('PURCHASE_ORDER') || u.includes('PURCHASE ORDER')) return 'PURCHASE ORDER';
  if (u.includes('INVOICE') || u.includes('SALES_INVOICE')) return 'SALES INVOICE';
  if (u.includes('EXPENSE')) return 'EXPENSE RECEIPT';
  if (u.includes('REGULATORY') || u.includes('TECHNICAL') || u.includes('BILL_OF_LADING') || u.includes('PACKING_LIST')) return 'OTHER TECHNICAL';
  return 'OTHER';
}

function extractBucketAndPath(fileUrl, defaultBucket) {
  if (!fileUrl) return { bucket: defaultBucket, path: '' };
  try {
    const marker = '/storage/v1/object/public/';
    const idx = fileUrl.indexOf(marker);
    if (idx !== -1) {
      const rest = fileUrl.substring(idx + marker.length);
      const firstSlash = rest.indexOf('/');
      const bucket = rest.substring(0, firstSlash);
      const path = decodeURIComponent(rest.substring(firstSlash + 1));
      return { bucket, path };
    }
  } catch (err) {
    // fallback
  }
  return { bucket: defaultBucket, path: fileUrl };
}

async function runMigration() {
  const client = new pg.Client({ connectionString: DB_CONN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('--- STARTING UNIVERSAL DOCUMENT BANK MIGRATION ---');
  await client.query('BEGIN');

  try {
    // Check if already populated
    const existingCount = await client.query('SELECT count(*) FROM universal_documents');
    if (parseInt(existingCount.rows[0].count, 10) > 0) {
      console.log(`Found ${existingCount.rows[0].count} existing documents in universal_documents. Clearing for fresh migration...`);
      await client.query('DELETE FROM universal_document_links');
      await client.query('DELETE FROM universal_document_versions');
      await client.query('DELETE FROM universal_documents');
    }

    let totalDocs = 0;
    let totalVersions = 0;
    let totalLinks = 0;

    // 1. MIGRATING crm_product_documents
    console.log('1. Migrating crm_product_documents...');
    const crmDocs = await client.query('SELECT * FROM crm_product_documents ORDER BY created_at ASC');
    for (const row of crmDocs.rows) {
      const docType = normalizeDocType(row.document_type);
      const title = row.display_file_name || row.original_file_name || 'CRM Document';

      const insDoc = await client.query(`
        INSERT INTO universal_documents (
          title, document_type, specification, document_date, valid_until,
          lifecycle_status, source_module, notes, is_confidential,
          primary_product_id, primary_product_source_id, primary_batch_id, batch_number,
          legacy_source_table, legacy_source_id, created_by, created_at, updated_at,
          reviewed_by, reviewed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        RETURNING id;
      `, [
        title, docType, row.specification || null,
        row.created_at ? new Date(row.created_at).toISOString().split('T')[0] : null,
        row.valid_until || null,
        row.lifecycle_status || (row.is_permanent ? 'BANKED' : 'TEMP'),
        'crm',
        row.source_email_subject ? `Email subject: ${row.source_email_subject}` : null,
        false,
        row.product_id || null,
        row.product_source_id || null,
        row.batch_id || null,
        row.batch_number || null,
        'crm_product_documents',
        row.id,
        row.uploaded_by || null,
        row.created_at || new Date(),
        row.created_at || new Date(),
        row.reviewed_by || null,
        row.reviewed_at || null
      ]);

      const docId = insDoc.rows[0].id;
      totalDocs++;

      // Version
      const insVer = await client.query(`
        INSERT INTO universal_document_versions (
          document_id, version_number, storage_bucket, storage_path,
          original_file_name, file_size, mime_type, sha256, change_summary,
          is_current, uploaded_by, created_at
        ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)
        RETURNING id;
      `, [
        docId,
        row.storage_bucket || 'crm-documents',
        row.storage_path || '',
        row.original_file_name || title,
        row.file_size || 0,
        row.mime_type || null,
        row.sha256 || null,
        'Migrated from CRM Document Bank',
        row.uploaded_by || null,
        row.created_at || new Date()
      ]);
      const verId = insVer.rows[0].id;
      totalVersions++;

      // Link current_version_id
      await client.query('UPDATE universal_documents SET current_version_id = $1 WHERE id = $2', [verId, docId]);

      // Links
      if (row.inquiry_id) {
        await client.query(`
          INSERT INTO universal_document_links (
            document_id, document_version_id, entity_type, entity_id,
            product_id, product_source_id, batch_id, batch_number, is_primary, created_by, created_at
          ) VALUES ($1, $2, 'crm_inquiry', $3, $4, $5, $6, $7, false, $8, $9)
        `, [docId, verId, row.inquiry_id, row.product_id || null, row.product_source_id || null, row.batch_id || null, row.batch_number || null, row.uploaded_by, row.created_at]);
        totalLinks++;
      }

      if (row.pricing_option_id) {
        await client.query(`
          INSERT INTO universal_document_links (
            document_id, document_version_id, entity_type, entity_id,
            product_id, product_source_id, batch_id, batch_number, is_primary, created_by, created_at
          ) VALUES ($1, $2, 'crm_quote', $3, $4, $5, $6, $7, false, $8, $9)
        `, [docId, verId, row.pricing_option_id, row.product_id || null, row.product_source_id || null, row.batch_id || null, row.batch_number || null, row.uploaded_by, row.created_at]);
        totalLinks++;
      }

      if (row.product_id) {
        await client.query(`
          INSERT INTO universal_document_links (
            document_id, document_version_id, entity_type, entity_id,
            product_id, product_source_id, batch_id, batch_number, is_primary, created_by, created_at
          ) VALUES ($1, $2, 'product', $3, $4, $5, $6, $7, true, $8, $9)
        `, [docId, verId, row.product_id, row.product_id, row.product_source_id || null, row.batch_id || null, row.batch_number || null, row.uploaded_by, row.created_at]);
        totalLinks++;
      }
    }
    console.log(`Migrated ${crmDocs.rows.length} records from crm_product_documents.`);

    // 2. MIGRATING product_documents
    console.log('2. Migrating product_documents...');
    const prodDocs = await client.query('SELECT * FROM product_documents ORDER BY uploaded_at ASC');
    for (const row of prodDocs.rows) {
      const docType = normalizeDocType(row.document_type);
      const title = row.file_name || 'Product Document';
      const { bucket, path } = extractBucketAndPath(row.file_url, 'product-documents');

      const insDoc = await client.query(`
        INSERT INTO universal_documents (
          title, document_type, lifecycle_status, source_module,
          primary_product_id, legacy_source_table, legacy_source_id,
          created_by, created_at, updated_at
        ) VALUES ($1, $2, 'BANKED', 'products', $3, 'product_documents', $4, $5, $6, $7)
        RETURNING id;
      `, [
        title, docType, row.product_id, row.id,
        row.uploaded_by || null,
        row.uploaded_at || new Date(),
        row.uploaded_at || new Date()
      ]);
      const docId = insDoc.rows[0].id;
      totalDocs++;

      const insVer = await client.query(`
        INSERT INTO universal_document_versions (
          document_id, version_number, storage_bucket, storage_path, file_url,
          original_file_name, file_size, change_summary, is_current, uploaded_by, created_at
        ) VALUES ($1, 1, $2, $3, $4, $5, $6, 'Migrated from Product Master', true, $7, $8)
        RETURNING id;
      `, [
        docId, bucket, path, row.file_url,
        title, row.file_size || 0,
        row.uploaded_by || null,
        row.uploaded_at || new Date()
      ]);
      const verId = insVer.rows[0].id;
      totalVersions++;

      await client.query('UPDATE universal_documents SET current_version_id = $1 WHERE id = $2', [verId, docId]);

      await client.query(`
        INSERT INTO universal_document_links (
          document_id, document_version_id, entity_type, entity_id,
          product_id, is_primary, created_by, created_at
        ) VALUES ($1, $2, 'product', $3, $3, true, $4, $5)
      `, [docId, verId, row.product_id, row.uploaded_by, row.uploaded_at]);
      totalLinks++;
    }
    console.log(`Migrated ${prodDocs.rows.length} records from product_documents.`);

    // 3. MIGRATING product_source_documents
    console.log('3. Migrating product_source_documents...');
    const psDocs = await client.query(`
      SELECT psd.*, ps.product_id 
      FROM product_source_documents psd
      LEFT JOIN product_sources ps ON psd.source_id = ps.id
      ORDER BY psd.uploaded_at ASC
    `);
    for (const row of psDocs.rows) {
      const docType = normalizeDocType(row.doc_type);
      const title = row.original_filename || 'Source Document';
      const { bucket, path } = extractBucketAndPath(row.file_url, 'product-source-documents');

      const insDoc = await client.query(`
        INSERT INTO universal_documents (
          title, document_type, lifecycle_status, source_module, notes,
          primary_product_id, primary_product_source_id,
          legacy_source_table, legacy_source_id, created_by, created_at, updated_at
        ) VALUES ($1, $2, 'BANKED', 'products', $3, $4, $5, 'product_source_documents', $6, $7, $8, $9)
        RETURNING id;
      `, [
        title, docType, row.notes || null,
        row.product_id || null,
        row.source_id,
        row.id,
        row.uploaded_by || null,
        row.uploaded_at || new Date(),
        row.uploaded_at || new Date()
      ]);
      const docId = insDoc.rows[0].id;
      totalDocs++;

      const insVer = await client.query(`
        INSERT INTO universal_document_versions (
          document_id, version_number, storage_bucket, storage_path, file_url,
          original_file_name, file_size, change_summary, is_current, uploaded_by, created_at
        ) VALUES ($1, 1, $2, $3, $4, $5, $6, 'Migrated from Product Source Master', true, $7, $8)
        RETURNING id;
      `, [
        docId, bucket, path, row.file_url,
        title, row.file_size || 0,
        row.uploaded_by || null,
        row.uploaded_at || new Date()
      ]);
      const verId = insVer.rows[0].id;
      totalVersions++;

      await client.query('UPDATE universal_documents SET current_version_id = $1 WHERE id = $2', [verId, docId]);

      await client.query(`
        INSERT INTO universal_document_links (
          document_id, document_version_id, entity_type, entity_id,
          product_id, product_source_id, is_primary, created_by, created_at
        ) VALUES ($1, $2, 'product_source', $3, $4, $3, true, $5, $6)
      `, [docId, verId, row.source_id, row.product_id, row.uploaded_by, row.uploaded_at]);
      totalLinks++;
    }
    console.log(`Migrated ${psDocs.rows.length} records from product_source_documents.`);

    // 4. MIGRATING batch_documents
    console.log('4. Migrating batch_documents...');
    const batchDocs = await client.query(`
      SELECT bd.*, b.batch_number, b.product_id, b.make_id
      FROM batch_documents bd
      JOIN batches b ON bd.batch_id = b.id
      ORDER BY bd.uploaded_at ASC
    `);
    for (const row of batchDocs.rows) {
      const docType = normalizeDocType(row.file_type);
      const title = row.file_name || 'Batch Document';
      const { bucket, path } = extractBucketAndPath(row.file_url, 'batch-documents');

      const insDoc = await client.query(`
        INSERT INTO universal_documents (
          title, document_type, lifecycle_status, source_module,
          primary_product_id, primary_product_source_id, primary_batch_id, batch_number,
          legacy_source_table, legacy_source_id, created_by, created_at, updated_at
        ) VALUES ($1, $2, 'BANKED', 'batches', $3, $4, $5, $6, 'batch_documents', $7, $8, $9, $10)
        RETURNING id;
      `, [
        title, docType,
        row.product_id || null,
        row.make_id || null,
        row.batch_id,
        row.batch_number,
        row.id,
        row.uploaded_by || null,
        row.uploaded_at || new Date(),
        row.uploaded_at || new Date()
      ]);
      const docId = insDoc.rows[0].id;
      totalDocs++;

      const insVer = await client.query(`
        INSERT INTO universal_document_versions (
          document_id, version_number, storage_bucket, storage_path, file_url,
          original_file_name, file_size, change_summary, is_current, uploaded_by, created_at
        ) VALUES ($1, 1, $2, $3, $4, $5, $6, 'Migrated from Batch Documents', true, $7, $8)
        RETURNING id;
      `, [
        docId, bucket, path, row.file_url,
        title, row.file_size || 0,
        row.uploaded_by || null,
        row.uploaded_at || new Date()
      ]);
      const verId = insVer.rows[0].id;
      totalVersions++;

      await client.query('UPDATE universal_documents SET current_version_id = $1 WHERE id = $2', [verId, docId]);

      // Link to batch
      await client.query(`
        INSERT INTO universal_document_links (
          document_id, document_version_id, entity_type, entity_id,
          product_id, product_source_id, batch_id, batch_number, is_primary, created_by, created_at
        ) VALUES ($1, $2, 'batch', $3, $4, $5, $3, $6, true, $7, $8)
      `, [docId, verId, row.batch_id, row.product_id, row.make_id, row.batch_number, row.uploaded_by, row.uploaded_at]);
      totalLinks++;
    }
    console.log(`Migrated ${batchDocs.rows.length} records from batch_documents.`);

    await client.query('COMMIT');
    console.log(`--- MIGRATION COMPLETED SUCCESSFULLY! ---`);
    console.log(`Total universal_documents: ${totalDocs}`);
    console.log(`Total universal_document_versions: ${totalVersions}`);
    console.log(`Total universal_document_links: ${totalLinks}`);

    // Quick verification query on vw_universal_document_bank
    const vCheck = await client.query('SELECT count(*), count(product_name) as with_prod_name, count(make_name) as with_make_name, count(linked_batch_number) as with_batch FROM vw_universal_document_bank');
    console.log('Verification on vw_universal_document_bank:', vCheck.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed, rolled back:', error);
    throw error;
  } finally {
    await client.end();
  }
}

runMigration().catch(console.error);
