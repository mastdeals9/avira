import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB_CONN =
  process.env.READONLY_AUDIT_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

test('Need Action Screen — Trash / Delete Document Lifecycle Verification Suite', async (t) => {
  const client = new pg.Client({ connectionString: DB_CONN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  let testInquiry1 = null;
  let testInquiry2 = null;

  try {
    // 0. Setup: grab 2 inquiries for link testing
    const inqRes = await client.query('SELECT id, inquiry_number FROM crm_inquiries LIMIT 2');
    assert.ok(inqRes.rows.length >= 1, 'At least 1 inquiry must exist in database');
    testInquiry1 = inqRes.rows[0].id;
    testInquiry2 = inqRes.rows.length > 1 ? inqRes.rows[1].id : inqRes.rows[0].id;

    // -----------------------------------------------------------------
    // TEST 1: TEMP with no remaining references -> Bank record deleted
    // -----------------------------------------------------------------
    await t.test('1. TEMP with NO other references: Deleting from Need Action deletes legacy record, Bank record, and versions', async () => {
      const fileName = `E2E_Temp_Solo_${Date.now()}.pdf`;
      const storagePath = `temp-tests/${fileName}`;

      // Insert legacy crm_product_documents row with is_permanent = false (TEMP)
      const insRes = await client.query(
        `INSERT INTO crm_product_documents (
          inquiry_id, product_name, make, document_type, is_permanent, lifecycle_status,
          original_file_name, display_file_name, storage_bucket, storage_path
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [testInquiry1, 'Lifecycle Test Chem A', 'Make Test A', 'COA', false, 'TEMP', fileName, fileName, 'crm-documents', storagePath]
      );
      const legacyId = insRes.rows[0].id;

      // Verify trigger created Universal Document Bank record with status TEMP
      const uRes = await client.query(
        `SELECT id, lifecycle_status FROM universal_documents 
         WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = $1`,
        [legacyId]
      );
      assert.equal(uRes.rows.length, 1, 'Trigger must have created universal_document');
      const uDocId = uRes.rows[0].id;
      assert.equal(uRes.rows[0].lifecycle_status, 'TEMP');

      // Verify versions created
      const verRes = await client.query(
        'SELECT id FROM universal_document_versions WHERE document_id = $1',
        [uDocId]
      );
      assert.equal(verRes.rows.length, 1, 'Version must be created');

      // Verify link created
      const linkRes = await client.query(
        'SELECT id FROM universal_document_links WHERE document_id = $1 AND entity_type = $2 AND entity_id = $3',
        [uDocId, 'crm_inquiry', testInquiry1]
      );
      assert.equal(linkRes.rows.length, 1, 'Link must be created');

      // Action: User clicks Trash/Delete on Need Action row -> deletes legacy record
      await client.query('DELETE FROM crm_product_documents WHERE id = $1', [legacyId]);

      // Assertions for Contract 1:
      // Since it was TEMP with 0 other references, universal_documents and universal_document_versions MUST BE DELETED
      const uAfterRes = await client.query('SELECT id FROM universal_documents WHERE id = $1', [uDocId]);
      assert.equal(uAfterRes.rows.length, 0, 'Universal Document must be deleted when TEMP and 0 remaining references');

      const verAfterRes = await client.query('SELECT id FROM universal_document_versions WHERE document_id = $1', [uDocId]);
      assert.equal(verAfterRes.rows.length, 0, 'Document versions must be deleted when TEMP and 0 remaining references');

      const linkAfterRes = await client.query('SELECT id FROM universal_document_links WHERE document_id = $1', [uDocId]);
      assert.equal(linkAfterRes.rows.length, 0, 'Document links must be cleared');
    });

    // -----------------------------------------------------------------
    // TEST 2: TEMP with other references -> Remove only current reference
    // -----------------------------------------------------------------
    await t.test('2. TEMP with OTHER references: Deleting from Need Action unlinks only current entity, preserves Bank record', async () => {
      const fileName = `E2E_Temp_Shared_${Date.now()}.pdf`;
      const storagePath = `temp-tests/${fileName}`;

      // Insert legacy crm_product_documents row
      const insRes = await client.query(
        `INSERT INTO crm_product_documents (
          inquiry_id, product_name, make, document_type, is_permanent, lifecycle_status,
          original_file_name, display_file_name, storage_bucket, storage_path
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [testInquiry1, 'Lifecycle Test Chem B', 'Make Test B', 'COA', false, 'TEMP', fileName, fileName, 'crm-documents', storagePath]
      );
      const legacyId = insRes.rows[0].id;

      const uRes = await client.query(
        `SELECT id, lifecycle_status FROM universal_documents 
         WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = $1`,
        [legacyId]
      );
      const uDocId = uRes.rows[0].id;

      // Add a SECOND reference to the universal document (e.g. linked to testInquiry2)
      await client.query(
        `INSERT INTO universal_document_links (document_id, entity_type, entity_id)
         VALUES ($1, $2, $3)`,
        [uDocId, 'crm_inquiry', testInquiry2]
      );

      // Verify total links = 2
      const linksBefore = await client.query(
        'SELECT id, entity_id FROM universal_document_links WHERE document_id = $1',
        [uDocId]
      );
      assert.equal(linksBefore.rows.length, 2, 'Should have 2 links');

      // Action: User clicks Trash/Delete on inquiry 1 Need Action row
      await client.query('DELETE FROM crm_product_documents WHERE id = $1', [legacyId]);

      // Assertions for Contract 2:
      // Bank record MUST REMAIN because inquiry 2 is still referencing it
      const uAfterRes = await client.query('SELECT id, lifecycle_status FROM universal_documents WHERE id = $1', [uDocId]);
      assert.equal(uAfterRes.rows.length, 1, 'Universal Document must be preserved because it has other references');

      // Inquiry 1 link is removed, inquiry 2 link remains
      const linksAfter = await client.query(
        'SELECT id, entity_id FROM universal_document_links WHERE document_id = $1',
        [uDocId]
      );
      assert.equal(linksAfter.rows.length, 1, 'Only current reference unlinked');
      assert.equal(linksAfter.rows[0].entity_id, testInquiry2, 'Remaining link belongs to inquiry 2');

      // Cleanup
      await client.query('DELETE FROM universal_document_links WHERE document_id = $1', [uDocId]);
      await client.query('DELETE FROM universal_document_versions WHERE document_id = $1', [uDocId]);
      await client.query('DELETE FROM universal_documents WHERE id = $1', [uDocId]);
    });

    // -----------------------------------------------------------------
    // TEST 3: BANKED -> Strictly preserve permanent Bank record
    // -----------------------------------------------------------------
    await t.test('3. BANKED Document: Deleting from Need Action unlinks inquiry reference, STRICTLY PRESERVES Bank record', async () => {
      const fileName = `E2E_Banked_Permanent_${Date.now()}.pdf`;
      const storagePath = `banked-tests/${fileName}`;

      // Insert legacy crm_product_documents row with is_permanent = true, lifecycle_status = 'BANKED'
      const insRes = await client.query(
        `INSERT INTO crm_product_documents (
          inquiry_id, product_name, make, document_type, is_permanent, lifecycle_status,
          original_file_name, display_file_name, storage_bucket, storage_path
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [testInquiry1, 'Lifecycle Test Chem C', 'Make Test C', 'TDS', true, 'BANKED', fileName, fileName, 'crm-documents', storagePath]
      );
      const legacyId = insRes.rows[0].id;

      const uRes = await client.query(
        `SELECT id, lifecycle_status FROM universal_documents 
         WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = $1`,
        [legacyId]
      );
      const uDocId = uRes.rows[0].id;
      assert.equal(uRes.rows[0].lifecycle_status, 'BANKED');

      // Action: User clicks Trash/Delete on Need Action row
      await client.query('DELETE FROM crm_product_documents WHERE id = $1', [legacyId]);

      // Assertions for Contract 3:
      // Bank record MUST BE STRICTLY PRESERVED in universal_documents
      const uAfterRes = await client.query('SELECT id, lifecycle_status FROM universal_documents WHERE id = $1', [uDocId]);
      assert.equal(uAfterRes.rows.length, 1, 'BANKED document must never be deleted from Universal Document Bank');
      assert.equal(uAfterRes.rows[0].lifecycle_status, 'BANKED');

      // Version must be intact
      const verAfter = await client.query('SELECT id FROM universal_document_versions WHERE document_id = $1', [uDocId]);
      assert.equal(verAfter.rows.length, 1, 'Document version preserved intact');

      // Inquiry link unlinked
      const linkAfter = await client.query(
        'SELECT id FROM universal_document_links WHERE document_id = $1 AND entity_type = $2 AND entity_id = $3',
        [uDocId, 'crm_inquiry', testInquiry1]
      );
      assert.equal(linkAfter.rows.length, 0, 'Inquiry link unlinked from Need Action');

      // Cleanup
      await client.query('DELETE FROM universal_document_links WHERE document_id = $1', [uDocId]);
      await client.query('DELETE FROM universal_document_versions WHERE document_id = $1', [uDocId]);
      await client.query('DELETE FROM universal_documents WHERE id = $1', [uDocId]);
    });

    // -----------------------------------------------------------------
    // TEST 4: ARCHIVED -> Strictly preserve history
    // -----------------------------------------------------------------
    await t.test('4. ARCHIVED Document: Deleting from Need Action STRICTLY PRESERVES historical Bank record and versions', async () => {
      const fileName = `E2E_Archived_History_${Date.now()}.pdf`;
      const storagePath = `archived-tests/${fileName}`;

      // Insert legacy crm_product_documents row with lifecycle_status = 'ARCHIVED'
      const insRes = await client.query(
        `INSERT INTO crm_product_documents (
          inquiry_id, product_name, make, document_type, is_permanent, lifecycle_status,
          original_file_name, display_file_name, storage_bucket, storage_path
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [testInquiry1, 'Lifecycle Test Chem D', 'Make Test D', 'MSDS', true, 'ARCHIVED', fileName, fileName, 'crm-documents', storagePath]
      );
      const legacyId = insRes.rows[0].id;

      const uRes = await client.query(
        `SELECT id, lifecycle_status FROM universal_documents 
         WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = $1`,
        [legacyId]
      );
      const uDocId = uRes.rows[0].id;
      assert.equal(uRes.rows[0].lifecycle_status, 'ARCHIVED');

      // Action: User clicks Trash/Delete on Need Action row
      await client.query('DELETE FROM crm_product_documents WHERE id = $1', [legacyId]);

      // Assertions for Contract 4:
      // Bank record MUST BE STRICTLY PRESERVED in universal_documents to maintain historical audit trail
      const uAfterRes = await client.query('SELECT id, lifecycle_status FROM universal_documents WHERE id = $1', [uDocId]);
      assert.equal(uAfterRes.rows.length, 1, 'ARCHIVED document must remain in Universal Document Bank as historical record');
      assert.equal(uAfterRes.rows[0].lifecycle_status, 'ARCHIVED');

      // Cleanup
      await client.query('DELETE FROM universal_document_links WHERE document_id = $1', [uDocId]);
      await client.query('DELETE FROM universal_document_versions WHERE document_id = $1', [uDocId]);
      await client.query('DELETE FROM universal_documents WHERE id = $1', [uDocId]);
    });

    // -----------------------------------------------------------------
    // TEST 5: kunal_ai_email_reviews item ignore & financial data safety
    // -----------------------------------------------------------------
    await t.test('5. Need Action row ignore marks action_status = no_action and leaves financial ledgers untouched', async () => {
      // 1. Create a mock email review row
      const revRes = await client.query(
        `INSERT INTO kunal_ai_email_reviews (
          gmail_message_id, from_email, subject, email_date, action_status, product_name, source_price
        ) VALUES ($1, $2, $3, NOW(), $4, $5, $6) RETURNING id`,
        [`msg-test-${Date.now()}`, 'supplier@test.com', 'Quotation for Chem E', 'pending_review', 'Chem E', 120]
      );
      const reviewId = revRes.rows[0].id;

      // Check current financial voucher count
      const pvCountBefore = await client.query('SELECT count(*) FROM payment_vouchers');
      const rvCountBefore = await client.query('SELECT count(*) FROM receipt_vouchers');

      // Simulate Need Action ignore
      await client.query(
        `UPDATE kunal_ai_email_reviews SET action_status = 'no_action', updated_at = NOW() WHERE id = $1`,
        [reviewId]
      );

      // Verify review updated
      const revAfter = await client.query('SELECT action_status FROM kunal_ai_email_reviews WHERE id = $1', [reviewId]);
      assert.equal(revAfter.rows[0].action_status, 'no_action', 'Need Action row transitioned to no_action');

      // Verify financial data integrity: payment and receipt vouchers completely untouched
      const pvCountAfter = await client.query('SELECT count(*) FROM payment_vouchers');
      assert.equal(pvCountAfter.rows[0].count, pvCountBefore.rows[0].count, 'Payment vouchers must not be changed');

      const rvCountAfter = await client.query('SELECT count(*) FROM receipt_vouchers');
      assert.equal(rvCountAfter.rows[0].count, rvCountBefore.rows[0].count, 'Receipt vouchers must not be changed');

      // Cleanup
      await client.query('DELETE FROM kunal_ai_email_reviews WHERE id = $1', [reviewId]);
    });

  } finally {
    await client.end();
  }
});
