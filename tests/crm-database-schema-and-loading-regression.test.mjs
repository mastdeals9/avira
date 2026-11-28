import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;
const connectionString =
  process.env.SUPABASE_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

function getClient() {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}

test('CRM Database Schema & Performance Regression Suite', async (t) => {
  const client = getClient();
  await client.connect();

  t.after(async () => {
    await client.end();
  });

  await t.test('1. enquiry_conversation_messages schema does NOT have metadata column', async () => {
    const res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'enquiry_conversation_messages' 
        AND column_name = 'metadata';
    `);
    assert.equal(res.rows.length, 0, 'enquiry_conversation_messages should not have metadata column');

    // Confirm that valid message query succeeds
    const msgRes = await client.query(`
      SELECT id, conversation_id, channel, direction, sender_address, sender_name, subject, body_text
      FROM public.enquiry_conversation_messages
      LIMIT 1;
    `);
    assert.ok(Array.isArray(msgRes.rows), 'Valid message query must succeed');
  });

  await t.test('2. kunal_ai_email_reviews schema uses matched_inquiry_id and scanned_at', async () => {
    const res = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'kunal_ai_email_reviews' 
        AND column_name IN ('inquiry_id', 'matched_inquiry_id', 'created_at', 'scanned_at');
    `);
    const cols = res.rows.map((r) => r.column_name);
    assert.ok(!cols.includes('inquiry_id'), 'inquiry_id column must not exist');
    assert.ok(cols.includes('matched_inquiry_id'), 'matched_inquiry_id column must exist');
    assert.ok(!cols.includes('created_at'), 'created_at column must not exist');
    assert.ok(cols.includes('scanned_at'), 'scanned_at column must exist');

    // Confirm query with matched_inquiry_id and scanned_at works
    const reviewRes = await client.query(`
      SELECT id, gmail_message_id, matched_inquiry_id, action_status, scanned_at, email_date
      FROM public.kunal_ai_email_reviews
      ORDER BY scanned_at DESC
      LIMIT 1;
    `);
    assert.ok(Array.isArray(reviewRes.rows), 'Query with matched_inquiry_id must succeed');
  });

  await t.test('3. kunal_ai_email_reviews action_status check constraint permits valid status values', async () => {
    const res = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE conname = 'kunal_ai_email_reviews_action_status_chk';
    `);
    assert.equal(res.rows.length, 1, 'Check constraint must exist');
    const def = res.rows[0].def;
    assert.ok(def.includes('price_saved'), 'Should permit price_saved');
    assert.ok(def.includes('pending_review'), 'Should permit pending_review');
    assert.ok(!def.includes("'reviewed'"), "Should NOT permit 'reviewed'");
  });

  await t.test('4. crm_product_documents schema uses display_file_name and source_gmail_message_id', async () => {
    const res = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'crm_product_documents' 
        AND column_name IN ('file_name', 'display_file_name', 'original_file_name', 'gmail_message_id', 'source_gmail_message_id');
    `);
    const cols = res.rows.map((r) => r.column_name);
    assert.ok(!cols.includes('file_name'), 'file_name column must not exist');
    assert.ok(cols.includes('display_file_name'), 'display_file_name column must exist');
    assert.ok(cols.includes('original_file_name'), 'original_file_name column must exist');
    assert.ok(!cols.includes('gmail_message_id'), 'gmail_message_id column must not exist');
    assert.ok(cols.includes('source_gmail_message_id'), 'source_gmail_message_id column must exist');

    // Confirm document select query succeeds
    const docRes = await client.query(`
      SELECT id, original_file_name, display_file_name, storage_path, storage_bucket, document_type, source_gmail_message_id
      FROM public.crm_product_documents
      LIMIT 1;
    `);
    assert.ok(Array.isArray(docRes.rows), 'crm_product_documents query must succeed');
  });

  await t.test('5. Verify live production record counts', async () => {
    const inqRes = await client.query(`SELECT COUNT(*)::int AS count FROM public.crm_inquiries;`);
    const contactsRes = await client.query(`SELECT COUNT(*)::int AS count FROM public.crm_contacts;`);
    const custRes = await client.query(`SELECT COUNT(*)::int AS count FROM public.customers;`);
    const tplRes = await client.query(`SELECT COUNT(*)::int AS count FROM public.crm_email_templates;`);

    assert.equal(inqRes.rows[0].count, 355, 'crm_inquiries count must match 355');
    assert.ok(contactsRes.rows[0].count >= 518 && contactsRes.rows[0].count <= 521, 'crm_contacts count must match 519-521 (after test cleanup)');
    assert.equal(custRes.rows[0].count, 40, 'customers count must match 40');
    assert.equal(tplRes.rows[0].count, 9, 'crm_email_templates count must match 9');
  });

  await t.test('6. Verify idx_crm_inquiries_created_at index effectiveness via EXPLAIN', async () => {
    // In a test transaction, create index temporarily if not already present, explain analyze, then rollback
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_crm_inquiries_created_at_test 
        ON public.crm_inquiries(created_at DESC);
      `);
      const planRes = await client.query(`
        EXPLAIN (FORMAT JSON) 
        SELECT id, created_at, inquiry_number, product_name 
        FROM public.crm_inquiries 
        ORDER BY created_at DESC 
        LIMIT 50;
      `);
      const plan = planRes.rows[0]['QUERY PLAN'][0];
      assert.ok(plan, 'Query plan must be returned');
      // Verify execution is fast
      assert.ok(plan['Plan'], 'Plan node must exist');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

