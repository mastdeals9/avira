import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB_CONN =
  process.env.READONLY_AUDIT_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

test('Universal Document Bank — Cross-Module Synchronization & Batch COA Verification Suite', async (t) => {
  const client = new pg.Client({ connectionString: DB_CONN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  let testProductId = null;
  let testProductName = null;
  let testProductSourceId = null;
  let testBatch1Id = null;
  let testBatch1Number = null;
  let testBatch2Id = null;
  let testBatch2Number = null;
  let testInquiryId = null;

  try {
    // 1. Fetch test product with at least 1 source and 2 batches
    const prodRes = await client.query('SELECT id, product_name FROM products LIMIT 1');
    assert.ok(prodRes.rows.length > 0, 'At least 1 product must exist');
    testProductId = prodRes.rows[0].id;
    testProductName = prodRes.rows[0].product_name;

    const sourceRes = await client.query(
      'SELECT id, supplier_name, grade FROM product_sources WHERE product_id = $1 LIMIT 1',
      [testProductId]
    );
    if (sourceRes.rows.length > 0) {
      testProductSourceId = sourceRes.rows[0].id;
    }

    const batchRes = await client.query(
      'SELECT id, batch_number FROM batches WHERE product_id = $1 LIMIT 2',
      [testProductId]
    );
    assert.ok(batchRes.rows.length >= 2, 'At least 2 batches required for batch-specificity test');
    testBatch1Id = batchRes.rows[0].id;
    testBatch1Number = batchRes.rows[0].batch_number;
    testBatch2Id = batchRes.rows[1].id;
    testBatch2Number = batchRes.rows[1].batch_number;

    // Fetch an inquiry
    const inqRes = await client.query('SELECT id, inquiry_number FROM crm_inquiries LIMIT 1');
    if (inqRes.rows.length > 0) {
      testInquiryId = inqRes.rows[0].id;
    }

    // -----------------------------------------------------------------
    // TEST 1: Product Source Document Bi-Directional Synchronization
    // -----------------------------------------------------------------
    await t.test('1. Product Source document synchronization (INSERT, UPDATE, DELETE)', async () => {
      if (!testProductSourceId) return;

      const testFileName = `E2E_Source_Doc_${Date.now()}.pdf`;
      const fakeUrl = `https://dkrtsqienlhpouohmfki.supabase.co/storage/v1/object/public/product-source-documents/${testProductSourceId}/${testFileName}`;

      // A. INSERT
      const insRes = await client.query(
        `INSERT INTO product_source_documents (
          source_id, doc_type, file_url, original_filename, file_size, notes
        ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [testProductSourceId, 'Regulatory', fakeUrl, testFileName, 45678, 'Initial notes']
      );
      const legacySourceDocId = insRes.rows[0].id;

      // Verify sync in Universal Document Bank
      const bankRes = await client.query(
        `SELECT id, title, document_type, lifecycle_status, primary_product_source_id, primary_product_id
         FROM universal_documents
         WHERE legacy_source_table = 'product_source_documents' AND legacy_source_id = $1`,
        [legacySourceDocId]
      );
      assert.equal(bankRes.rows.length, 1, 'Document should be automatically synced to Universal Bank');
      assert.equal(bankRes.rows[0].title, testFileName);
      assert.equal(bankRes.rows[0].document_type, 'OTHER TECHNICAL');
      assert.equal(bankRes.rows[0].lifecycle_status, 'BANKED');
      assert.equal(bankRes.rows[0].primary_product_source_id, testProductSourceId);
      const uDocId = bankRes.rows[0].id;

      // B. UPDATE
      const updatedFileName = `Updated_${testFileName}`;
      await client.query(
        `UPDATE product_source_documents SET original_filename = $1, notes = 'Updated notes' WHERE id = $2`,
        [updatedFileName, legacySourceDocId]
      );

      const bankUpdateRes = await client.query(
        `SELECT title, notes FROM universal_documents WHERE id = $1`,
        [uDocId]
      );
      assert.equal(bankUpdateRes.rows[0].title, updatedFileName, 'Universal document title must update');
      assert.equal(bankUpdateRes.rows[0].notes, 'Updated notes', 'Universal document notes must update');

      // C. DELETE (Verifying that banked technical assets are preserved permanently while unlinking)
      await client.query('DELETE FROM product_source_documents WHERE id = $1', [legacySourceDocId]);
      const bankDeleteRes = await client.query(
        `SELECT lifecycle_status, legacy_source_id FROM universal_documents WHERE id = $1`,
        [uDocId]
      );
      assert.equal(bankDeleteRes.rows[0].lifecycle_status, 'BANKED', 'Banked document status preserved permanently in library');
      assert.equal(bankDeleteRes.rows[0].legacy_source_id, null, 'Legacy source id unlinked');

      // Cleanup test row
      await client.query('DELETE FROM universal_document_versions WHERE document_id = $1', [uDocId]);
      await client.query('DELETE FROM universal_document_links WHERE document_id = $1', [uDocId]);
      await client.query('DELETE FROM universal_documents WHERE id = $1', [uDocId]);
    });

    // -----------------------------------------------------------------
    // TEST 2: Batch COA Upload, Linkage & Strict Batch Specificity
    // -----------------------------------------------------------------
    await t.test('2. Batch COA upload, correct batch linking & strict isolation', async () => {
      const coaFileName = `E2E_Batch_COA_${Date.now()}.pdf`;
      const fakeUrl = `https://dkrtsqienlhpouohmfki.supabase.co/storage/v1/object/public/batch-documents/${testBatch1Id}/${coaFileName}`;

      // Insert into batch_documents for Batch 1
      const insRes = await client.query(
        `INSERT INTO batch_documents (
          batch_id, file_url, file_name, file_type, file_size
        ) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [testBatch1Id, fakeUrl, coaFileName, 'coa', 78910]
      );
      const batchDocId = insRes.rows[0].id;

      // Check view vw_universal_document_bank
      const viewRes = await client.query(
        `SELECT id, title, document_type, primary_batch_id, batch_number, linked_batch_number, product_name
         FROM vw_universal_document_bank
         WHERE legacy_source_table = 'batch_documents' AND legacy_source_id = $1`,
        [batchDocId]
      );
      assert.equal(viewRes.rows.length, 1, 'COA must appear in vw_universal_document_bank');
      assert.equal(viewRes.rows[0].document_type, 'COA');
      assert.equal(viewRes.rows[0].primary_batch_id, testBatch1Id);
      assert.equal(viewRes.rows[0].batch_number, testBatch1Number);
      const coaUDocId = viewRes.rows[0].id;

      // Verify query matching:
      // A: Search by Batch 1 batch number -> MUST match
      const matchBatch1 = await client.query(
        `SELECT id FROM vw_universal_document_bank 
         WHERE primary_product_id = $1 AND (batch_number = $2 OR primary_batch_id = $3)`,
        [testProductId, testBatch1Number, testBatch1Id]
      );
      assert.ok(matchBatch1.rows.some(r => r.id === coaUDocId), 'Must find COA when querying Batch 1');

      // B: Search for general product documents (documents not bound to a different batch)
      // The COA of Batch 1 must NOT show up as a general or Batch 2 document!
      const matchBatch2 = await client.query(
        `SELECT id FROM vw_universal_document_bank 
         WHERE primary_product_id = $1 AND (batch_number = $2 OR primary_batch_id = $3)`,
        [testProductId, testBatch2Number, testBatch2Id]
      );
      assert.ok(!matchBatch2.rows.some(r => r.id === coaUDocId), 'Batch 1 COA must NEVER be returned for Batch 2');

      // Cleanup
      await client.query('DELETE FROM batch_documents WHERE id = $1', [batchDocId]);
      await client.query('DELETE FROM universal_document_versions WHERE document_id = $1', [coaUDocId]);
      await client.query('DELETE FROM universal_document_links WHERE document_id = $1', [coaUDocId]);
      await client.query('DELETE FROM universal_documents WHERE id = $1', [coaUDocId]);
    });

    // -----------------------------------------------------------------
    // TEST 3: Pricing Extraction Ingest, Review & Promote to Banked
    // -----------------------------------------------------------------
    await t.test('3. Pricing extraction ingest -> Review & Bank -> attachable to quote without file duplication', async () => {
      if (!testInquiryId) return;

      const pricingDocName = `Pricing_Extracted_${Date.now()}.pdf`;
      const fakeStoragePath = `inquiries/${testInquiryId}/${pricingDocName}`;

      // Ingest as TEMP
      const insRes = await client.query(
        `INSERT INTO crm_product_documents (
          inquiry_id, product_name, document_type, original_file_name, display_file_name,
          storage_bucket, storage_path, lifecycle_status, is_permanent, specification
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [testInquiryId, testProductName, 'SPEC', pricingDocName, pricingDocName, 'crm-documents', fakeStoragePath, 'TEMP', false, 'USP/BP']
      );
      const crmDocId = insRes.rows[0].id;

      // Verify created in Universal Bank as TEMP
      const bankRes1 = await client.query(
        `SELECT id, lifecycle_status, document_type, specification FROM universal_documents 
         WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = $1`,
        [crmDocId]
      );
      assert.equal(bankRes1.rows.length, 1);
      assert.equal(bankRes1.rows[0].lifecycle_status, 'TEMP');
      assert.equal(bankRes1.rows[0].document_type, 'SPECIFICATION');
      const pricingUDocId = bankRes1.rows[0].id;

      // Transition to BANKED (simulate Kunal clicking 'Bank' in Pricing Worksheet)
      await client.query(
        `UPDATE crm_product_documents 
         SET lifecycle_status = 'BANKED', is_permanent = true, product_id = $1
         WHERE id = $2`,
        [testProductId, crmDocId]
      );

      // Verify Universal Bank updated to BANKED
      const bankRes2 = await client.query(
        `SELECT lifecycle_status, primary_product_id FROM universal_documents WHERE id = $1`,
        [pricingUDocId]
      );
      assert.equal(bankRes2.rows[0].lifecycle_status, 'BANKED');
      assert.equal(bankRes2.rows[0].primary_product_id, testProductId);

      // Verify attachable to customer quote without creating another physical file
      // Count versions before link
      const verBefore = await client.query(
        `SELECT count(*) FROM universal_document_versions WHERE document_id = $1`,
        [pricingUDocId]
      );
      assert.equal(Number(verBefore.rows[0].count), 1);

      // Create relational link for customer quote
      await client.query(
        `INSERT INTO universal_document_links (
          document_id, document_version_id, entity_type, entity_id, is_primary
        ) VALUES ($1, (SELECT current_version_id FROM universal_documents WHERE id = $1), 'crm_quote', $2, false)`,
        [pricingUDocId, testInquiryId]
      );

      // Count versions after link: must remain exactly 1!
      const verAfter = await client.query(
        `SELECT count(*) FROM universal_document_versions WHERE document_id = $1`,
        [pricingUDocId]
      );
      assert.equal(Number(verAfter.rows[0].count), 1, 'Version count must remain 1 (no physical file duplication)');

      const linksRes = await client.query(
        `SELECT entity_type FROM universal_document_links WHERE document_id = $1`,
        [pricingUDocId]
      );
      assert.ok(linksRes.rows.some(r => r.entity_type === 'crm_quote'));
      assert.ok(linksRes.rows.some(r => r.entity_type === 'crm_inquiry'));

      // Cleanup
      await client.query('DELETE FROM crm_product_documents WHERE id = $1', [crmDocId]);
      await client.query('DELETE FROM universal_document_versions WHERE document_id = $1', [pricingUDocId]);
      await client.query('DELETE FROM universal_document_links WHERE document_id = $1', [pricingUDocId]);
      await client.query('DELETE FROM universal_documents WHERE id = $1', [pricingUDocId]);
    });
  } finally {
    await client.end();
  }
});
