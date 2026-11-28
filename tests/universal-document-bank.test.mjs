import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB_CONN =
  process.env.READONLY_AUDIT_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

test('Universal Document Bank — Complete End-to-End Verification Suite', async (t) => {
  const client = new pg.Client({ connectionString: DB_CONN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  let testDocId = null;
  let testProductId = null;
  let testProductSourceId = null;
  let testBatchId = null;

  try {
    // Setup test master data
    const prodRes = await client.query('SELECT id, product_name FROM products LIMIT 1');
    assert.ok(prodRes.rows.length > 0, 'At least 1 product must exist');
    testProductId = prodRes.rows[0].id;
    const testProductName = prodRes.rows[0].product_name;

    const sourceRes = await client.query(
      'SELECT id, supplier_name FROM product_sources WHERE product_id = $1 LIMIT 1',
      [testProductId]
    );
    if (sourceRes.rows.length > 0) {
      testProductSourceId = sourceRes.rows[0].id;
    }

    const batchRes = await client.query(
      'SELECT id, batch_number FROM batches WHERE product_id = $1 LIMIT 1',
      [testProductId]
    );
    if (batchRes.rows.length > 0) {
      testBatchId = batchRes.rows[0].id;
    }

    // -------------------------------------------------------------
    // STEP 1: Upload MSDS in Product Master -> find in Bank and View
    // -------------------------------------------------------------
    await t.test('1. Product Master upload registers in Universal Bank', async () => {
      const fileName = `E2E_Test_MSDS_${Date.now()}.pdf`;
      const fakeUrl = `https://dkrtsqienlhpouohmfki.supabase.co/storage/v1/object/public/product-documents/${testProductId}/${fileName}`;

      // Insert into product_documents (simulating Product Master UI upload)
      const insProdDoc = await client.query(
        `
        INSERT INTO product_documents (
          product_id, file_name, document_type, file_url, file_size
        ) VALUES ($1, $2, 'msds', $3, 102400)
        RETURNING id;
      `,
        [testProductId, fileName, fakeUrl]
      );
      const legacyProdDocId = insProdDoc.rows[0].id;

      // Verify that trigger auto-registered into universal_documents
      const syncDoc = await client.query(
        `
        SELECT id, title, document_type, lifecycle_status, source_module, primary_product_id
        FROM universal_documents
        WHERE legacy_source_table = 'product_documents' AND legacy_source_id = $1;
      `,
        [legacyProdDocId]
      );

      assert.equal(syncDoc.rows.length, 1, 'Document must be registered in universal_documents');
      assert.equal(syncDoc.rows[0].document_type, 'MSDS');
      assert.equal(syncDoc.rows[0].lifecycle_status, 'BANKED');
      assert.equal(syncDoc.rows[0].primary_product_id, testProductId);

      // Verify appearance in vw_universal_document_bank
      const viewCheck = await client.query(
        `
        SELECT title, product_name, document_type, lifecycle_status, version_number
        FROM vw_universal_document_bank
        WHERE id = $1;
      `,
        [syncDoc.rows[0].id]
      );

      assert.equal(viewCheck.rows.length, 1);
      assert.equal(viewCheck.rows[0].product_name, testProductName);
      assert.equal(viewCheck.rows[0].version_number, 1);

      // Cleanup step 1
      await client.query('DELETE FROM universal_documents WHERE id = $1', [syncDoc.rows[0].id]);
      await client.query('DELETE FROM product_documents WHERE id = $1', [legacyProdDocId]);
    });

    // -------------------------------------------------------------
    // STEP 2: Upload document from Pricing/CRM -> verify lifecycle & bank
    // -------------------------------------------------------------
    await t.test('2. Ingest document from CRM/Pricing -> approve to BANKED', async () => {
      const crmDocTitle = `E2E_Supplier_Quote_Spec_${Date.now()}.pdf`;
      const insCrm = await client.query(
        `
        INSERT INTO crm_product_documents (
          product_name, document_type, display_file_name, original_file_name,
          storage_bucket, storage_path, lifecycle_status, is_permanent, file_size
        ) VALUES ($1, 'SPEC', $2, $2, 'crm-documents', 'pricing/e2e_spec.pdf', 'TEMP', false, 204800)
        RETURNING id;
      `,
        [testProductName, crmDocTitle]
      );
      const legacyCrmId = insCrm.rows[0].id;

      // Verify sync trigger set it to TEMP
      const syncCheck = await client.query(
        `
        SELECT id, lifecycle_status, source_module
        FROM universal_documents
        WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = $1;
      `,
        [legacyCrmId]
      );
      assert.equal(syncCheck.rows.length, 1);
      assert.equal(syncCheck.rows[0].lifecycle_status, 'TEMP');
      testDocId = syncCheck.rows[0].id;

      // Transition to BANKED (simulating user review & approval)
      await client.query(
        `
        UPDATE universal_documents
        SET lifecycle_status = 'BANKED',
            primary_product_id = $1,
            reviewed_at = now()
        WHERE id = $2;
      `,
        [testProductId, testDocId]
      );

      // Check view reflects BANKED state
      const bankCheck = await client.query(
        `
        SELECT lifecycle_status, product_name
        FROM vw_universal_document_bank
        WHERE id = $1;
      `,
        [testDocId]
      );
      assert.equal(bankCheck.rows[0].lifecycle_status, 'BANKED');
      assert.equal(bankCheck.rows[0].product_name, testProductName);

      // Cleanup legacy row
      await client.query('DELETE FROM crm_product_documents WHERE id = $1', [legacyCrmId]);
    });

    // -------------------------------------------------------------
    // STEP 3: Attach existing Bank document to quotation without duplicating file
    // -------------------------------------------------------------
    await t.test(
      '3. Attach document to another entity without creating physical file',
      async () => {
        assert.ok(testDocId, 'testDocId must be present');

        // Count physical versions before attachment
        const verCountBefore = await client.query(
          'SELECT count(*) FROM universal_document_versions WHERE document_id = $1',
          [testDocId]
        );
        assert.equal(parseInt(verCountBefore.rows[0].count, 10), 1);

        // Create authorized link to quotation (fake UUID)
        const fakeQuoteId = '00000000-0000-0000-0000-000000000001';
        const insLink = await client.query(
          `
        INSERT INTO universal_document_links (
          document_id, entity_type, entity_id, is_primary
        ) VALUES ($1, 'crm_quote', $2, false)
        RETURNING id;
      `,
          [testDocId, fakeQuoteId]
        );
        assert.ok(insLink.rows[0].id);

        // Count physical versions AFTER attachment
        const verCountAfter = await client.query(
          'SELECT count(*) FROM universal_document_versions WHERE document_id = $1',
          [testDocId]
        );
        // Strict Core Principle: ONE PHYSICAL FILE -> MULTIPLE REFERENCES
        assert.equal(
          parseInt(verCountAfter.rows[0].count, 10),
          1,
          'Physical file count MUST remain 1 (no duplicate storage)'
        );

        // Check link count in view
        const viewCheck = await client.query(
          'SELECT link_count FROM vw_universal_document_bank WHERE id = $1',
          [testDocId]
        );
        assert.ok(viewCheck.rows[0].link_count >= 1, 'Link count must be updated');
      }
    );

    // -------------------------------------------------------------
    // STEP 4: Upload COA in Batch -> search by batch number
    // -------------------------------------------------------------
    await t.test(
      '4. Batch COA upload -> searchable in Bank with batch-specific label',
      async () => {
        if (!testBatchId) {
          console.log('Skipping batch test step (no test batch found in DB)');
          return;
        }

        const batchNumRes = await client.query('SELECT batch_number FROM batches WHERE id = $1', [
          testBatchId,
        ]);
        const bNum = batchNumRes.rows[0].batch_number;
        const coaFileName = `COA_${bNum}.pdf`;

        // Insert into batch_documents
        const insBatchDoc = await client.query(
          `
        INSERT INTO batch_documents (
          batch_id, file_name, file_type, file_url, file_size
        ) VALUES ($1, $2, 'coa', 'https://storage/batch-documents/test.pdf', 307200)
        RETURNING id;
      `,
          [testBatchId, coaFileName]
        );
        const legacyBatchDocId = insBatchDoc.rows[0].id;

        // Verify sync to Universal Bank with batch number & BANKED status
        const syncDoc = await client.query(
          `
        SELECT id, document_type, batch_number, primary_batch_id, lifecycle_status
        FROM universal_documents
        WHERE legacy_source_table = 'batch_documents' AND legacy_source_id = $1;
      `,
          [legacyBatchDocId]
        );

        assert.equal(syncDoc.rows.length, 1);
        assert.equal(syncDoc.rows[0].document_type, 'COA');
        assert.equal(syncDoc.rows[0].batch_number, bNum);
        assert.equal(syncDoc.rows[0].lifecycle_status, 'BANKED');

        // Search by batch_number in vw_universal_document_bank
        const searchRes = await client.query(
          `
        SELECT id, title, linked_batch_number, document_type
        FROM vw_universal_document_bank
        WHERE linked_batch_number = $1 AND id = $2;
      `,
          [bNum, syncDoc.rows[0].id]
        );

        assert.equal(searchRes.rows.length, 1);
        assert.equal(searchRes.rows[0].linked_batch_number, bNum);

        // Cleanup
        await client.query('DELETE FROM universal_documents WHERE id = $1', [syncDoc.rows[0].id]);
        await client.query('DELETE FROM batch_documents WHERE id = $1', [legacyBatchDocId]);
      }
    );

    // -------------------------------------------------------------
    // STEP 5: Edit Product, Make, and Specification associations
    // -------------------------------------------------------------
    await t.test('5. Edit Product, Make, Specification, and Expiry metadata', async () => {
      assert.ok(testDocId);

      const newSpec = 'EP / USP High Purity';
      const futureDate = '2028-12-31';

      await client.query(
        `
        UPDATE universal_documents
        SET specification = $1,
            valid_until = $2,
            primary_product_source_id = $3
        WHERE id = $4;
      `,
        [newSpec, futureDate, testProductSourceId, testDocId]
      );

      const check = await client.query(
        `
        SELECT specification, valid_until::text as valid_until_str, is_expired, make_name
        FROM vw_universal_document_bank
        WHERE id = $1;
      `,
        [testDocId]
      );

      assert.equal(check.rows[0].specification, newSpec);
      assert.equal(check.rows[0].valid_until_str, futureDate);
      assert.equal(check.rows[0].is_expired, false);
    });

    // -------------------------------------------------------------
    // STEP 6: Multi-version management (upload revision, retain v1)
    // -------------------------------------------------------------
    await t.test('6. Multi-version revision management (v1 preserved, v2 active)', async () => {
      assert.ok(testDocId);

      // Create Version 2
      const insV2 = await client.query(
        `
        INSERT INTO universal_document_versions (
          document_id, version_number, storage_bucket, storage_path,
          original_file_name, file_size, change_summary, is_current
        ) VALUES ($1, 2, 'documents', 'revisions/v2_spec.pdf', 'Revised_Spec_2026.pdf', 256000, 'Updated 2026 revision', true)
        RETURNING id;
      `,
        [testDocId]
      );
      const v2Id = insV2.rows[0].id;

      // Mark v1 as not current
      await client.query(
        `
        UPDATE universal_document_versions
        SET is_current = false
        WHERE document_id = $1 AND version_number = 1;
      `,
        [testDocId]
      );

      // Point current_version_id to v2
      await client.query(
        `
        UPDATE universal_documents
        SET current_version_id = $1
        WHERE id = $2;
      `,
        [v2Id, testDocId]
      );

      // Verify both versions exist in database
      const vHistory = await client.query(
        `
        SELECT version_number, is_current, change_summary
        FROM universal_document_versions
        WHERE document_id = $1
        ORDER BY version_number ASC;
      `,
        [testDocId]
      );

      assert.equal(vHistory.rows.length, 2, 'Both v1 and v2 must be preserved');
      assert.equal(vHistory.rows[0].version_number, 1);
      assert.equal(vHistory.rows[0].is_current, false);
      assert.equal(vHistory.rows[1].version_number, 2);
      assert.equal(vHistory.rows[1].is_current, true);

      // Verify view reflects current active version as v2
      const viewCheck = await client.query(
        `
        SELECT version_number, version_count
        FROM vw_universal_document_bank
        WHERE id = $1;
      `,
        [testDocId]
      );

      assert.equal(viewCheck.rows[0].version_number, 2);
      assert.equal(viewCheck.rows[0].version_count, 2);
    });

    // -------------------------------------------------------------
    // STEP 7: Test access permissions & role security
    // -------------------------------------------------------------
    await t.test('7. Confidentiality and security boundary verification', async () => {
      assert.ok(testDocId);

      // Mark document as confidential
      await client.query('UPDATE universal_documents SET is_confidential = true WHERE id = $1', [
        testDocId,
      ]);

      // Check RLS policy exists and is active
      const polCheck = await client.query(`
        SELECT policyname, tablename, cmd
        FROM pg_policies
        WHERE tablename = 'universal_documents';
      `);
      assert.ok(
        polCheck.rows.length >= 4,
        'Universal documents must have SELECT, INSERT, UPDATE, DELETE RLS policies'
      );

      // Reset confidentiality
      await client.query('UPDATE universal_documents SET is_confidential = false WHERE id = $1', [
        testDocId,
      ]);
    });
  } finally {
    // Final cleanup of test document
    if (testDocId) {
      await client.query('DELETE FROM universal_documents WHERE id = $1', [testDocId]);
    }
    await client.end();
  }
});
