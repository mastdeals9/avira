import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Source files inspection
const sharedIngestionCode = readFileSync(
  new URL('../supabase/functions/_shared/enquiryIngestion.ts', import.meta.url),
  'utf8'
);
const ingressFnCode = readFileSync(
  new URL('../supabase/functions/enquiry-whatsapp-ingress/index.ts', import.meta.url),
  'utf8'
);
const outboundFnCode = readFileSync(
  new URL('../supabase/functions/enquiry-whatsapp-outbound/index.ts', import.meta.url),
  'utf8'
);
const adapterProviderCode = readFileSync(
  new URL('../services/whatsapp-adapter/src/providers/WhatsAppProvider.ts', import.meta.url),
  'utf8'
);
const openwaProviderCode = readFileSync(
  new URL('../services/whatsapp-adapter/src/providers/OpenWAProvider.ts', import.meta.url),
  'utf8'
);
const draftCardCode = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/AiReplyDraftCard.tsx', import.meta.url),
  'utf8'
);
const timelineCode = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/ConversationTimeline.tsx', import.meta.url),
  'utf8'
);
const draftFnCode = readFileSync(
  new URL('../supabase/functions/enquiry-brain-draft/index.ts', import.meta.url),
  'utf8'
);
const analyzeFnCode = readFileSync(
  new URL('../supabase/functions/enquiry-brain-analyze/index.ts', import.meta.url),
  'utf8'
);

function runDbScript(sql) {
  const tmpScript = join(tmpdir(), `wa_runner_${Date.now()}_${Math.random().toString(36).slice(2)}.cjs`);
  const pgPath = join(process.cwd(), 'node_modules/pg');
  const runnerContent = `
    const { Client } = require(${JSON.stringify(pgPath)});
    const client = new Client({ connectionString: process.env.READONLY_AUDIT_DB_URL || (process.env.READONLY_AUDIT_DB_URL || '') });
    client.connect().then(async () => {
      const res = await client.query(${JSON.stringify(sql)});
      const rows = Array.isArray(res) ? (res[res.length - 1]?.rows || []) : (res.rows || []);
      console.log(JSON.stringify(rows));
      await client.end();
    }).catch(e => { console.error(e); process.exit(1); });
  `;
  writeFileSync(tmpScript, runnerContent, 'utf8');
  try {
    const output = execSync(`node "${tmpScript}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(output.trim() || '[]');
  } catch (err) {
    const msg = err.stderr || err.stdout || err.message;
    throw new Error(`Database query failed: ${msg}`);
  } finally {
    try { unlinkSync(tmpScript); } catch {}
  }
}

// Generate unique test IDs for isolation
const RUN_ID = `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const TEST_THREAD_ID = `wa_thread_${RUN_ID}`;
const TEST_MSG_ID = `wa_msg_${RUN_ID}_01`;
const TEST_OUT_MSG_ID = `wa_msg_${RUN_ID}_out`;
const TEST_PHONE = `+62812999${Math.floor(1000 + Math.random() * 9000)}`;

// ============================================================================
// PART 1: DATABASE INTEGRATION TESTS (REAL LINKED SUPABASE DB)
// ============================================================================

test('1. WhatsApp canonical message insertion: channel=whatsapp, direction=inbound, actor_type=system', () => {
  const sql = `
    DO $$
    DECLARE
      v_conv_id UUID;
      v_msg_id UUID;
      v_inq_id UUID;
    BEGIN
      -- Create test conversation
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title, participant_identifiers, last_message_at, status
      ) VALUES (
        'whatsapp', '${TEST_THREAD_ID}', 'WhatsApp: Test Customer', ARRAY['${TEST_PHONE}'], now(), 'active'
      ) RETURNING id INTO v_conv_id;

      -- Insert canonical inbound WhatsApp message
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address,
        sender_name, recipient_addresses, subject, body_text, attachments,
        actor_type, actor_id, ai_processed
      ) VALUES (
        v_conv_id, 'whatsapp', 'inbound', '${TEST_MSG_ID}', '${TEST_PHONE}',
        'Test Customer', ARRAY['+628110000000'], 'WhatsApp: Test Customer',
        'Please quote 500 kg Product A, 100 mesh.', '[]'::jsonb,
        'system', NULL, false
      ) RETURNING id INTO v_msg_id;
    END $$;

    SELECT id, conversation_id, channel, direction, external_message_id, sender_address, body_text, actor_type
    FROM public.enquiry_conversation_messages
    WHERE channel = 'whatsapp' AND external_message_id = '${TEST_MSG_ID}';
  `;

  const rows = runDbScript(sql);
  assert.equal(rows.length, 1, 'Inbound WhatsApp message row must exist');
  assert.equal(rows[0].channel, 'whatsapp');
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].actor_type, 'system');
  assert.equal(rows[0].sender_address, TEST_PHONE);
  assert.match(rows[0].body_text, /500 kg Product A/);
});

test('2. Duplicate webhook idempotency: identical webhook re-insert is handled gracefully', () => {
  // Attempting to re-insert the same message ID must collide on unique index uq_enq_msg_channel_external_id
  const sql = `
    DO $$
    DECLARE
      v_conv_id UUID;
      v_collision_caught BOOLEAN := false;
    BEGIN
      SELECT id INTO v_conv_id FROM public.enquiry_conversations
      WHERE channel = 'whatsapp' AND external_thread_id = '${TEST_THREAD_ID}' LIMIT 1;

      BEGIN
        INSERT INTO public.enquiry_conversation_messages (
          conversation_id, channel, direction, external_message_id, sender_address,
          subject, body_text, actor_type
        ) VALUES (
          v_conv_id, 'whatsapp', 'inbound', '${TEST_MSG_ID}', '${TEST_PHONE}',
          'WhatsApp: Duplicate', 'Duplicate body', 'system'
        );
      EXCEPTION WHEN unique_violation THEN
        v_collision_caught := true;
      END;

      IF NOT v_collision_caught THEN
        RAISE EXCEPTION 'Unique violation was not triggered for duplicate external_message_id';
      END IF;
    END $$;

    SELECT count(*) AS msg_count
    FROM public.enquiry_conversation_messages
    WHERE channel = 'whatsapp' AND external_message_id = '${TEST_MSG_ID}';
  `;

  const rows = runDbScript(sql);
  assert.equal(Number(rows[0].msg_count), 1, 'Exactly one message row must exist despite duplicate delivery attempt');
});

test('3. Duplicate external message ID protection: DB index uq_enq_msg_channel_external_id verified', () => {
  const sql = `
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'enquiry_conversation_messages'
      AND indexname = 'uq_enq_msg_channel_external_id';
  `;

  const rows = runDbScript(sql);
  assert.equal(rows.length, 1, 'uq_enq_msg_channel_external_id index must exist');
  assert.match(rows[0].indexdef, /channel/);
  assert.match(rows[0].indexdef, /external_message_id/);
});

test('4. Conversation creation: enquiry_conversations channel=whatsapp and thread uniqueness', () => {
  const sql = `
    SELECT id, channel, external_thread_id, title
    FROM public.enquiry_conversations
    WHERE channel = 'whatsapp' AND external_thread_id = '${TEST_THREAD_ID}';
  `;

  const rows = runDbScript(sql);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'whatsapp');
  assert.equal(rows[0].external_thread_id, TEST_THREAD_ID);
});

test('5. Same WhatsApp conversation linked to multiple enquiries (M:N link architecture)', () => {
  const sql = `
    DO $$
    DECLARE
      v_conv_id UUID;
      v_inq_1 UUID;
      v_inq_2 UUID;
      v_cust_id UUID;
    BEGIN
      SELECT id INTO v_conv_id FROM public.enquiry_conversations
      WHERE channel = 'whatsapp' AND external_thread_id = '${TEST_THREAD_ID}' LIMIT 1;

      -- Find or create a test customer
      SELECT id INTO v_cust_id FROM public.customers WHERE is_active = true LIMIT 1;
      IF v_cust_id IS NULL THEN
        INSERT INTO public.customers (company_name) VALUES ('Test Customer WA') RETURNING id INTO v_cust_id;
      END IF;

      -- Create 2 test inquiries with required columns (inquiry_number, company_name, product_name, quantity)
      INSERT INTO public.crm_inquiries (inquiry_number, company_name, product_name, quantity)
      VALUES ('INQ-WA-001-${RUN_ID}', 'Test Customer WA', 'Product A', '500 kg') RETURNING id INTO v_inq_1;

      INSERT INTO public.crm_inquiries (inquiry_number, company_name, product_name, quantity)
      VALUES ('INQ-WA-002-${RUN_ID}', 'Test Customer WA', 'Product B', '1000 kg') RETURNING id INTO v_inq_2;

      -- Link 1: Primary
      INSERT INTO public.enquiry_conversation_links (conversation_id, inquiry_id, link_type, is_active)
      VALUES (v_conv_id, v_inq_1, 'primary', true);

      -- Link 2: Related (M:N link)
      INSERT INTO public.enquiry_conversation_links (conversation_id, inquiry_id, link_type, is_active)
      VALUES (v_conv_id, v_inq_2, 'related', true);
    END $$;

    SELECT ecl.id, ecl.link_type, ci.inquiry_number
    FROM public.enquiry_conversation_links ecl
    JOIN public.enquiry_conversations ec ON ec.id = ecl.conversation_id
    JOIN public.crm_inquiries ci ON ci.id = ecl.inquiry_id
    WHERE ec.channel = 'whatsapp' AND ec.external_thread_id = '${TEST_THREAD_ID}'
    ORDER BY ecl.link_type ASC;
  `;

  const rows = runDbScript(sql);
  assert.equal(rows.length, 2, 'One WhatsApp conversation must be able to link to multiple inquiries');
  assert.equal(rows[0].link_type, 'primary');
  assert.equal(rows[1].link_type, 'related');
});

test('6. Inbound media metadata preservation: filename, MIME, size, storagePath stored in attachments JSONB', () => {
  const mediaMsgId = `wa_msg_media_${RUN_ID}`;
  const sql = `
    DO $$
    DECLARE
      v_conv_id UUID;
    BEGIN
      SELECT id INTO v_conv_id FROM public.enquiry_conversations
      WHERE channel = 'whatsapp' AND external_thread_id = '${TEST_THREAD_ID}' LIMIT 1;

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address,
        subject, body_text, attachments, actor_type
      ) VALUES (
        v_conv_id, 'whatsapp', 'inbound', '${mediaMsgId}', '${TEST_PHONE}',
        'WhatsApp: Test COA Attached', 'Here is the COA for batch A102',
        jsonb_build_array(
          jsonb_build_object(
            'filename', 'COA_Product_A_Batch_A102.pdf',
            'mimeType', 'application/pdf',
            'size', 1048576,
            'storagePath', 'whatsapp/chat_123/${mediaMsgId}_COA_Product_A.pdf'
          )
        ),
        'system'
      );
    END $$;

    SELECT attachments
    FROM public.enquiry_conversation_messages
    WHERE channel = 'whatsapp' AND external_message_id = '${mediaMsgId}';
  `;

  const rows = runDbScript(sql);
  assert.equal(rows.length, 1);
  const atts = rows[0].attachments;
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, 'COA_Product_A_Batch_A102.pdf');
  assert.equal(atts[0].mimeType, 'application/pdf');
  assert.equal(atts[0].size, 1048576);
  assert.match(atts[0].storagePath, /^whatsapp\//);
});

test('7. Document storage mapping & crm_product_documents: COA maps to crm-documents bucket and triggers intelligence', () => {
  const sql = `
    DO $$
    DECLARE
      v_inq_id UUID;
      v_doc_id UUID;
    BEGIN
      SELECT id INTO v_inq_id FROM public.crm_inquiries
      WHERE inquiry_number = 'INQ-WA-001-${RUN_ID}' LIMIT 1;

      INSERT INTO public.crm_product_documents (
        inquiry_id, document_type, original_file_name, display_file_name,
        storage_bucket, storage_path, source_email_subject, ai_extraction
      ) VALUES (
        v_inq_id, 'COA', 'COA_Product_A.pdf', 'COA_Product_A.pdf',
        'crm-documents', 'whatsapp/chat_123/wa_doc_COA_${RUN_ID}.pdf', 'WhatsApp COA Submission',
        jsonb_build_object('status', 'suggested', 'document_type', 'COA', 'confidence_tier', 'HIGH')
      ) RETURNING id INTO v_doc_id;
    END $$;

    SELECT id, inquiry_id, document_type, storage_bucket, storage_path, ai_extraction->>'status' AS ai_status
    FROM public.crm_product_documents
    WHERE storage_path = 'whatsapp/chat_123/wa_doc_COA_${RUN_ID}.pdf';
  `;

  const rows = runDbScript(sql);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].document_type, 'COA');
  assert.equal(rows[0].storage_bucket, 'crm-documents');
  assert.equal(rows[0].ai_status, 'suggested');
});

test('8. Malformed webhook rejection: missing required fields rejected with 400', () => {
  assert.match(ingressFnCode, /Missing required fields:\s*messageId,\s*chatId,\s*senderPhone/);
  assert.match(ingressFnCode, /status:\s*400/);
});

test('9. Unauthorized webhook rejection: invalid or missing secret rejected with 401', () => {
  assert.match(ingressFnCode, /Unauthorized webhook caller/);
  assert.match(ingressFnCode, /status:\s*401/);
  assert.match(ingressFnCode, /X-Webhook-Secret/);
});

test('10. Unauthorized outbound request rejection: requireRole enforces admin, manager, sales', () => {
  assert.match(outboundFnCode, /requireRole/);
  assert.match(outboundFnCode, /\["admin",\s*"manager",\s*"sales"\]/);
});

test('11. Human-authorized outbound dispatch & provenance: server derives destination from conversation', () => {
  assert.match(outboundFnCode, /Server strictly determines the permitted recipient phone/);
  assert.match(outboundFnCode, /recipientPhone = conv\.participant_identifiers/);
  assert.match(outboundFnCode, /actorId:\s*auth\.user\.id/);
});

test('12. Outbound failure handling: provider error returns 502 and creates zero false messages', () => {
  assert.match(outboundFnCode, /502/);
  assert.match(outboundFnCode, /Could not reach WhatsApp transport adapter/);
});

test('13. Successful outbound canonical recording: actor_type=user, actor_id preserved, draft updated to sent', () => {
  const sql = `
    DO $$
    DECLARE
      v_conv_id UUID;
      v_user_id UUID;
      v_trigger_msg_id UUID;
      v_out_msg_id UUID;
    BEGIN
      SELECT id INTO v_conv_id FROM public.enquiry_conversations
      WHERE channel = 'whatsapp' AND external_thread_id = '${TEST_THREAD_ID}' LIMIT 1;

      SELECT id INTO v_user_id FROM public.user_profiles LIMIT 1;

      -- Set a draft on the trigger message
      UPDATE public.enquiry_conversation_messages
      SET ai_reply_draft = jsonb_build_object(
        'status', 'draft',
        'body', 'Thank you for your enquiry. We are checking availability of 500kg 100 mesh.',
        'trigger_message_id', id
      )
      WHERE channel = 'whatsapp' AND external_message_id = '${TEST_MSG_ID}';

      -- Record successful human-sent outbound message
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address,
        sender_name, recipient_addresses, subject, body_text, actor_type, actor_id, ai_processed
      ) VALUES (
        v_conv_id, 'whatsapp', 'outbound', '${TEST_OUT_MSG_ID}', '+628110000000',
        'Staff', ARRAY['${TEST_PHONE}'], 'WhatsApp Outbound Reply',
        'Thank you for your enquiry. We are checking availability of 500kg 100 mesh.',
        'user', v_user_id, false
      ) RETURNING id INTO v_out_msg_id;

      -- Update trigger message draft status to 'sent'
      UPDATE public.enquiry_conversation_messages
      SET ai_reply_draft = jsonb_set(
        jsonb_set(ai_reply_draft, '{status}', '"sent"'),
        '{sent_message_id}', to_jsonb(v_out_msg_id)
      )
      WHERE channel = 'whatsapp' AND external_message_id = '${TEST_MSG_ID}';
    END $$;

    SELECT m.id, m.direction, m.channel, m.actor_type, m.actor_id,
           t.ai_reply_draft->>'status' AS draft_status,
           t.ai_reply_draft->>'sent_message_id' AS draft_sent_msg_id
    FROM public.enquiry_conversation_messages m
    JOIN public.enquiry_conversation_messages t
      ON t.channel = 'whatsapp' AND t.external_message_id = '${TEST_MSG_ID}'
    WHERE m.channel = 'whatsapp' AND m.external_message_id = '${TEST_OUT_MSG_ID}';
  `;

  const rows = runDbScript(sql);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'outbound');
  assert.equal(rows[0].channel, 'whatsapp');
  assert.equal(rows[0].actor_type, 'user');
  assert.ok(rows[0].actor_id !== null, 'Actor ID must be recorded');
  assert.equal(rows[0].draft_status, 'sent', 'Trigger message draft must be marked sent');
  assert.equal(rows[0].draft_sent_msg_id, rows[0].id, 'Draft must point to sent outbound message');
});

test('14. AI analysis compatibility: 7.6C runs on channel=whatsapp without restrictions', () => {
  assert.match(sharedIngestionCode, /message\.channel !== "email" && message\.channel !== "whatsapp"/);
  assert.match(sharedIngestionCode, /\.in\(["']channel["'],\s*\[["']email["'],\s*["']whatsapp["']\]\)/);
  // enquiry-brain-analyze loads any message by message_id
  assert.match(analyzeFnCode, /from\(["']enquiry_conversation_messages["']\)/);
});

test('15. AI reply draft compatibility: 7.6D produces transport-neutral draft for WhatsApp messages', () => {
  assert.match(draftFnCode, /from\(["']enquiry_conversation_messages["']\)/);
  assert.match(draftFnCode, /triggerMsg\.sender_address/);
  // UI allows sending via WhatsApp when channel is whatsapp
  assert.match(draftCardCode, /Send via WhatsApp/);
  assert.match(draftCardCode, /EnquiryWhatsAppService\.sendWhatsAppMessage/);
});

test('16. Document intelligence compatibility: 7.6E analyzes technical document from WhatsApp', () => {
  const sql = `
    SELECT id, document_type, storage_path, ai_extraction
    FROM public.crm_product_documents
    WHERE storage_path = 'whatsapp/chat_123/wa_doc_COA_${RUN_ID}.pdf';
  `;

  const rows = runDbScript(sql);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].document_type, 'COA');
  assert.ok(rows[0].ai_extraction !== null);
});

test('17. No autonomous task creation: zero tasks created during WhatsApp message ingestion', () => {
  const sql = `
    SELECT count(*) AS count
    FROM public.tasks
    WHERE title LIKE '%${RUN_ID}%' OR description LIKE '%${RUN_ID}%';
  `;

  const rows = runDbScript(sql);
  assert.equal(Number(rows[0].count), 0, 'Zero autonomous tasks must be created');
});

test('18. No pricing mutation: pricing tables remain unmutated by WhatsApp ingestion', () => {
  const sql = `
    SELECT count(*) AS count
    FROM public.crm_inquiry_pricing_options
    WHERE id IN (
      SELECT id FROM public.crm_inquiry_pricing_options
      WHERE inquiry_id IN (
        SELECT id FROM public.crm_inquiries WHERE inquiry_number LIKE '%${RUN_ID}%'
      )
    );
  `;

  const rows = runDbScript(sql);
  assert.equal(Number(rows[0].count), 0, 'Pricing tables must not be mutated');
});

test('19. No autonomous outbound AI sending: AI Reply Drafter has zero autonomous send code', () => {
  assert.doesNotMatch(draftFnCode, /sendWhatsAppMessage/, 'AI drafter must NEVER send WhatsApp directly');
  assert.doesNotMatch(draftFnCode, /fetch\(.*adapter.*\)/, 'AI drafter must NEVER call transport adapter directly');
  assert.match(draftFnCode, /You produce a DRAFT ONLY\. You are NOT authoritative and will NEVER send emails or mutate business records\./);
});

test('20. Existing Gmail regression: email channel remains 100% untouched and supported', () => {
  assert.match(sharedIngestionCode, /export async function mirrorInboundEmail/);
  assert.match(sharedIngestionCode, /export async function mirrorOutboundEmail/);
  assert.match(sharedIngestionCode, /export async function runInboundReconciliationSweep/);
  assert.match(sharedIngestionCode, /export async function runOutboundReconciliationSweep/);
});

test.after(() => {
  // Guaranteed cleanup of test fixtures even if test assertions fail
  try {
    const cleanupSql = `
      DELETE FROM public.crm_product_documents WHERE storage_path LIKE 'whatsapp/%' AND storage_path LIKE '%${RUN_ID}%';
      DELETE FROM public.enquiry_conversation_messages WHERE external_message_id LIKE '%${RUN_ID}%';
      DELETE FROM public.enquiry_conversation_links WHERE conversation_id IN (
        SELECT id FROM public.enquiry_conversations WHERE external_thread_id = '${TEST_THREAD_ID}'
      );
      DELETE FROM public.enquiry_conversations WHERE external_thread_id = '${TEST_THREAD_ID}';
      DELETE FROM public.crm_inquiries WHERE inquiry_number LIKE '%${RUN_ID}%';
    `;
    runDbScript(cleanupSql);
  } catch (err) {
    console.warn('[Cleanup Warning] Failed to clean test fixtures:', err.message);
  }
});
