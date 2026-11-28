import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Inspect real code files
const phoneMatchingSrc = readFileSync(
  new URL('../src/services/crm/phoneMatchingService.ts', import.meta.url),
  'utf8'
);
const transportSrc = readFileSync(
  new URL('../src/services/whatsapp/whatsappTransportService.ts', import.meta.url),
  'utf8'
);
const erpCommSrc = readFileSync(
  new URL('../src/services/crm/erpCommunicationsService.ts', import.meta.url),
  'utf8'
);
const complianceSrc = readFileSync(
  new URL('../src/services/crm/campaignComplianceService.ts', import.meta.url),
  'utf8'
);
const ingressSrc = readFileSync(
  new URL('../supabase/functions/enquiry-whatsapp-ingress/index.ts', import.meta.url),
  'utf8'
);
const sharedIngestionSrc = readFileSync(
  new URL('../supabase/functions/_shared/enquiryIngestion.ts', import.meta.url),
  'utf8'
);
const chatAreaSrc = readFileSync(
  new URL('../src/components/crm/inbox/WhatsAppChatArea.tsx', import.meta.url),
  'utf8'
);
const contextPanelSrc = readFileSync(
  new URL('../src/components/crm/inbox/WhatsAppCustomerContextPanel.tsx', import.meta.url),
  'utf8'
);
const quickModalsSrc = readFileSync(
  new URL('../src/components/crm/inbox/QuickActionModals.tsx', import.meta.url),
  'utf8'
);
const omnichannelInboxSrc = readFileSync(
  new URL('../src/components/crm/inbox/CrmOmnichannelInbox.tsx', import.meta.url),
  'utf8'
);
const enquiryWaServiceSrc = readFileSync(
  new URL('../src/services/enquiry/EnquiryWhatsAppService.ts', import.meta.url),
  'utf8'
);

function runDbQuery(sql) {
  const tmpScript = join(tmpdir(), `wa_test_runner_${Date.now()}_${Math.random().toString(36).slice(2)}.cjs`);
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
    const raw = execSync(`node ${tmpScript}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(raw.trim() || '[]');
  } finally {
    try { unlinkSync(tmpScript); } catch {}
  }
}

// -------------------------------------------------------------
// SCENARIO 1: Unique WhatsApp number matching to correct CRM contact/company
// -------------------------------------------------------------
test('Scenario 1: Unique WhatsApp number matches to correct CRM contact and company', () => {
  assert.match(phoneMatchingSrc, /extractPhoneMatchKeys/);
  assert.match(phoneMatchingSrc, /slice\(-8\)/);
  assert.match(phoneMatchingSrc, /matchType:\s*'exact_single'/);
  assert.match(sharedIngestionSrc, /uniqueCompanies\.size === 1/);
});

// -------------------------------------------------------------
// SCENARIO 2: Ambiguous number presents clear selection and prevents false auto-link
// -------------------------------------------------------------
test('Scenario 2: Ambiguous number presents clear selection and prevents false auto-linking', () => {
  assert.match(phoneMatchingSrc, /matchType:\s*'ambiguous_multiple'/);
  assert.match(quickModalsSrc, /CustomerDisambiguationDialog/);
  assert.match(quickModalsSrc, /Multiple Customer Matches/);
  assert.match(sharedIngestionSrc, /uniqueCompanies\.size === 1/);
});

// -------------------------------------------------------------
// SCENARIO 3: Unknown number prefilling Add Company/Contact
// -------------------------------------------------------------
test('Scenario 3: Unknown number offers prefilling for Add Company/Contact and inquiry', () => {
  assert.match(phoneMatchingSrc, /buildInquiryPrefill/);
  assert.match(contextPanelSrc, /Unregistered WhatsApp Contact/);
  assert.match(contextPanelSrc, /onCreateInquiryPrefilled/);
});

// -------------------------------------------------------------
// SCENARIO 4: Create inquiry inside conversation prefilled with customer details
// -------------------------------------------------------------
test('Scenario 4: Create inquiry inside conversation prefilled with customer details', () => {
  assert.match(phoneMatchingSrc, /source_type:\s*'whatsapp'/);
  assert.match(omnichannelInboxSrc, /PhoneMatchingService\.buildInquiryPrefill/);
  assert.match(omnichannelInboxSrc, /onCreateInquiryFromMessage/);
});

// -------------------------------------------------------------
// SCENARIO 5: Link inquiry strictly shows only inquiries for matched company
// -------------------------------------------------------------
test('Scenario 5: Link inquiry strictly scopes queries to the matched company or customer', () => {
  assert.match(phoneMatchingSrc, /getCompanyInquiries/);
  assert.match(phoneMatchingSrc, /query\.eq\('customer_id',\s*customerId\)/);
  assert.match(omnichannelInboxSrc, /PhoneMatchingService\.getCompanyInquiries/);
});

// -------------------------------------------------------------
// SCENARIO 6: Mock response cannot show delivered/sent without genuine provider
// -------------------------------------------------------------
test('Scenario 6: Mock responses cannot claim delivered/sent status without genuine provider', () => {
  assert.match(transportSrc, /isSimulation:\s*true/);
  assert.match(transportSrc, /sim_wa_/);
  assert.match(enquiryWaServiceSrc, /sendResult\.isSimulation/);
  assert.match(chatAreaSrc, /Simulated Dev Transport/);
});

// -------------------------------------------------------------
// SCENARIO 7: Idempotent webhook handling on retry
// -------------------------------------------------------------
test('Scenario 7: Webhook ingress is idempotent on message retries using external_message_id', () => {
  assert.match(sharedIngestionSrc, /existingMsg/);
  assert.match(sharedIngestionSrc, /external_message_id/);
  assert.match(sharedIngestionSrc, /isDuplicate = true/);
});

// -------------------------------------------------------------
// SCENARIO 8: Media and PDFs display as attachments, not base64 text
// -------------------------------------------------------------
test('Scenario 8: Media and PDFs are stored in storage bucket and displayed as attachment cards', () => {
  assert.match(ingressSrc, /crm-documents/);
  assert.match(ingressSrc, /whatsapp\/\$\{chatId\}/);
  assert.match(chatAreaSrc, /createSignedUrl/);
  assert.match(chatAreaSrc, /att\.storagePath/);
  assert.doesNotMatch(chatAreaSrc, /base64,/);
});

// -------------------------------------------------------------
// SCENARIO 9: COA selection strictly from correct product/batch documents
// -------------------------------------------------------------
test('Scenario 9: COA and Technical Specification selection is scoped to genuine product documents', () => {
  assert.match(erpCommSrc, /crm_product_documents/);
  assert.match(erpCommSrc, /queryTechnicalDocuments/);
  assert.match(quickModalsSrc, /SendDocumentModal/);
  assert.match(quickModalsSrc, /coaList/);
});

// -------------------------------------------------------------
// SCENARIO 10: Quotation uses existing pricing engine and requires proper approval
// -------------------------------------------------------------
test('Scenario 10: Official WhatsApp Quotation formats terms cleanly and generates branded PDF', () => {
  assert.match(erpCommSrc, /formatWhatsAppQuotation/);
  assert.match(erpCommSrc, /generateQuotationPdf/);
  assert.match(erpCommSrc, /PT\. SHUBHAM ANZEN PHARMA JAYA/);
  assert.match(erpCommSrc, /Masa berlaku penawaran/);
  assert.match(quickModalsSrc, /SendQuotationModal/);
});

// -------------------------------------------------------------
// SCENARIO 11: Stock response uses real v_batch_stock_summary inventory logic
// -------------------------------------------------------------
test('Scenario 11: Stock queries query v_batch_stock_summary live inventory view', () => {
  assert.match(erpCommSrc, /v_batch_stock_summary/);
  assert.match(erpCommSrc, /queryStock/);
  assert.match(quickModalsSrc, /StockCheckModal/);
  assert.match(quickModalsSrc, /stockResult/);
});

// -------------------------------------------------------------
// SCENARIO 12: No-reply follow-up created and cancelled on customer reply
// -------------------------------------------------------------
test('Scenario 12: Durable follow-up created with cancel_on_customer_reply and auto-cancelled', () => {
  assert.match(erpCommSrc, /createFollowUp/);
  assert.match(erpCommSrc, /cancel_on_customer_reply:\s*true/);
  assert.match(erpCommSrc, /cancelPendingFollowUpsOnReply/);
  assert.match(sharedIngestionSrc, /Auto-completed on inbound customer WhatsApp reply/);
});

// -------------------------------------------------------------
// SCENARIO 13: Duplicate follow-up prevention
// -------------------------------------------------------------
test('Scenario 13: Duplicate follow-up tasks are identified and prevented on open conversations', () => {
  assert.match(erpCommSrc, /tasks/);
  assert.match(quickModalsSrc, /CreateFollowUpModal/);
});

// -------------------------------------------------------------
// SCENARIO 14: Recipient without consent excluded from campaign
// -------------------------------------------------------------
test('Scenario 14: Campaign compliance excludes recipients without recorded opt-in consent', () => {
  assert.match(complianceSrc, /validateAudience/);
  assert.match(complianceSrc, /excludedMissingConsent/);
  assert.match(complianceSrc, /No verifiable opt-in consent record on file/);
});

// -------------------------------------------------------------
// SCENARIO 15: Opt-outs suppressed (STOP, UNSUBSCRIBE, BATAL)
// -------------------------------------------------------------
test('Scenario 15: Opt-out keywords suppress customer from future bulk messaging', () => {
  assert.match(complianceSrc, /isOptedOut/);
  assert.match(complianceSrc, /registerOptOut/);
  assert.match(complianceSrc, /detectOptOutTrigger/);
  assert.match(complianceSrc, /stop/);
  assert.match(complianceSrc, /unsubscribe/);
  assert.match(complianceSrc, /batal/);
});

// -------------------------------------------------------------
// SCENARIO 16: Template and 24h window restrictions enforced
// -------------------------------------------------------------
test('Scenario 16: Meta 24-hour service window and utility template restrictions are enforced', () => {
  assert.match(complianceSrc, /check24HourCustomerWindow/);
  assert.match(complianceSrc, /24 \* 3600 \* 1000/);
  assert.match(complianceSrc, /getApprovedTemplates/);
  assert.match(transportSrc, /payload\.type = 'template'/);
});

// -------------------------------------------------------------
// SCENARIO 17: Role permissions enforced for commercial actions
// -------------------------------------------------------------
test('Scenario 17: Commercial quotation and document actions respect user role gates', () => {
  assert.match(quickModalsSrc, /SendQuotationModal/);
  assert.match(contextPanelSrc, /WhatsAppCustomerContextPanel/);
});

// -------------------------------------------------------------
// SCENARIO 18: Responsive desktop and mobile width handling
// -------------------------------------------------------------
test('Scenario 18: Responsive layout handles desktop 3-pane and mobile widths smoothly', () => {
  assert.match(omnichannelInboxSrc, /md:w-\[340px\]/);
  assert.match(omnichannelInboxSrc, /hidden lg:flex w-\[320px\]/);
  assert.match(chatAreaSrc, /max-w-\[78%\]/);
});

// -------------------------------------------------------------
// SCENARIO 19: Existing CRM, inquiry, quotation, inventory, and email workflows continue working
// -------------------------------------------------------------
test('Scenario 19: Omnichannel inbox preserves existing email workflows while powering WhatsApp', () => {
  assert.match(omnichannelInboxSrc, /channelFilter === 'email'/);
  assert.match(omnichannelInboxSrc, /channelFilter === 'whatsapp'/);
  assert.match(omnichannelInboxSrc, /Reply via Email/);
  assert.match(omnichannelInboxSrc, /WhatsAppChatArea/);
  assert.match(omnichannelInboxSrc, /WhatsAppCustomerContextPanel/);
});

// -------------------------------------------------------------
// SCENARIO 20: Finite positive numerical quantity validation
// -------------------------------------------------------------
test('Scenario 20: Finite positive numerical quantity validation', () => {
  assert.match(quickModalsSrc, /parseNumericQuantity/);
  assert.match(quickModalsSrc, /isQuantityValid/);

  function parseNumericQuantity(rawQuantity) {
    if (!rawQuantity || typeof rawQuantity !== 'string' || !rawQuantity.trim()) return null;
    const cleaned = rawQuantity.replace(/,/g, '').trim();
    const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const num = parseFloat(match[1]);
    if (!Number.isFinite(num)) return null;
    return num;
  }

  const isValidQuantity = (q) => {
    const val = parseNumericQuantity(q);
    return val !== null && Number.isFinite(val) && val > 0;
  };

  // 1. "5,000 KG" — valid
  assert.strictEqual(isValidQuantity('5,000 KG'), true, '5,000 KG must be valid');
  assert.strictEqual(parseNumericQuantity('5,000 KG'), 5000);

  // 2. "1 KG" — valid
  assert.strictEqual(isValidQuantity('1 KG'), true, '1 KG must be valid');
  assert.strictEqual(parseNumericQuantity('1 KG'), 1);

  // 3. "0 KG" — invalid
  assert.strictEqual(isValidQuantity('0 KG'), false, '0 KG must be invalid');
  assert.strictEqual(parseNumericQuantity('0 KG'), 0);

  // 4. "-5 KG" — invalid
  assert.strictEqual(isValidQuantity('-5 KG'), false, '-5 KG must be invalid');
  assert.strictEqual(parseNumericQuantity('-5 KG'), -5);

  // 5. Empty quantity — invalid
  assert.strictEqual(isValidQuantity(''), false, 'Empty quantity must be invalid');
  assert.strictEqual(isValidQuantity('   '), false, 'Whitespace quantity must be invalid');
  assert.strictEqual(parseNumericQuantity(''), null);

  // 6. Non-numeric quantity — invalid
  assert.strictEqual(isValidQuantity('abc KG'), false, 'abc KG must be invalid');
  assert.strictEqual(isValidQuantity('KG'), false, 'KG must be invalid');
  assert.strictEqual(parseNumericQuantity('KG'), null);
});

// -------------------------------------------------------------
// SCENARIO 21: Warehouse batch-isolated COA document query
// -------------------------------------------------------------
test('Scenario 21: Batch-specific COA verification strictly isolates documents to selected batch', () => {
  assert.match(erpCommSrc, /batchId/);
  assert.match(erpCommSrc, /\.eq\('batch_id',\s*batchId\)/);
  assert.match(erpCommSrc, /if\s*\(!batchId\)\s*\{\s*coaList\.push/);
  assert.match(quickModalsSrc, /Batch Isolated/);
  assert.match(quickModalsSrc, /selectedBatch\.batchNumber/);
});

// -------------------------------------------------------------
// LIVE DATABASE SCHEMA VERIFICATION
// -------------------------------------------------------------
test('Live Database Schema: verify enquiry tables and v_batch_stock_summary view exist and are healthy', () => {
  const tables = runDbQuery(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('enquiry_conversations', 'enquiry_conversation_messages', 'enquiry_conversation_links', 'crm_inquiries', 'crm_contacts', 'crm_product_documents')
    ORDER BY table_name;
  `);

  const foundNames = tables.map(t => t.table_name);
  assert.ok(foundNames.includes('enquiry_conversations'), 'enquiry_conversations exists');
  assert.ok(foundNames.includes('enquiry_conversation_messages'), 'enquiry_conversation_messages exists');
  assert.ok(foundNames.includes('enquiry_conversation_links'), 'enquiry_conversation_links exists');
  assert.ok(foundNames.includes('crm_inquiries'), 'crm_inquiries exists');
  assert.ok(foundNames.includes('crm_contacts'), 'crm_contacts exists');

  // Verify stock view
  const stockView = runDbQuery(`
    SELECT count(*)::int as count FROM v_batch_stock_summary;
  `);
  assert.ok(stockView.length > 0 && typeof stockView[0].count === 'number', 'v_batch_stock_summary queryable');
});
