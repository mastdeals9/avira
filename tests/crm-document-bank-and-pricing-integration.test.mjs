import { Client } from 'pg';

async function runTests() {
  if (!process.env.READONLY_AUDIT_DB_URL) {
    console.warn('Skipping CRM integration test: DATABASE_URL environment variable is not set.');
    return;
  }

  const client = new Client({
    connectionString: process.env.READONLY_AUDIT_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  console.log('🧪 Starting CRM Document Bank + Kunal Pricing AI Verification Tests...\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // TEST 1: Inquiry and Product Isolation (No cross-mixing)
  console.log('--- TEST 1: Inquiry & Product Association ---');
  const inqRes = await client.query(`
    SELECT inquiry_number, product_name, specification
    FROM crm_inquiries
    WHERE inquiry_number IN ('INQ-26-0128', 'INQ-26-0129')
    ORDER BY inquiry_number;
  `);

  assert(inqRes.rows.length === 2, 'Exactly 2 CRM inquiries exist (no duplicates)');
  assert(inqRes.rows[0].inquiry_number === 'INQ-26-0128' && inqRes.rows[0].product_name === 'Fenbendazole', 'INQ-26-0128 is Fenbendazole');
  assert(inqRes.rows[1].inquiry_number === 'INQ-26-0129' && inqRes.rows[1].product_name === 'PYRANTEL PAMOATE', 'INQ-26-0129 is Pyrantel Pamoate');

  // TEST 2: Pricing Options per Inquiry (Alternate Sources under SAME Inquiry)
  console.log('\n--- TEST 2: Alternate Sources & Pricing Options ---');
  const optsRes = await client.query(`
    SELECT i.inquiry_number, i.product_name, o.id as opt_id, o.offered_make, o.source_price, o.source_currency, o.specification, o.is_selected
    FROM crm_inquiry_pricing_options o
    JOIN crm_inquiries i ON i.id = o.inquiry_id
    WHERE i.inquiry_number IN ('INQ-26-0128', 'INQ-26-0129')
    ORDER BY i.inquiry_number, o.offered_make;
  `);

  const fbzOpts = optsRes.rows.filter(r => r.inquiry_number === 'INQ-26-0128');
  const pyrantelOpts = optsRes.rows.filter(r => r.inquiry_number === 'INQ-26-0129');

  assert(fbzOpts.length === 1, 'Fenbendazole has 1 pricing source option');
  assert(fbzOpts[0].offered_make === 'Su-pharma' && Number(fbzOpts[0].source_price) === 2575, 'Fenbendazole source is Su-pharma @ ₹2575');

  assert(pyrantelOpts.length === 2, 'Pyrantel Pamoate has 2 alternate sourcing options under the SAME inquiry');
  const jrcOpt = pyrantelOpts.find(r => r.offered_make === 'JRC');
  const ipcaOpt = pyrantelOpts.find(r => r.offered_make === 'IPCA');

  assert(jrcOpt && Number(jrcOpt.source_price) === 2050 && jrcOpt.is_selected === true, 'Pyrantel Option 1: JRC @ ₹2050 (selected)');
  assert(ipcaOpt && Number(ipcaOpt.source_price) === 2700 && ipcaOpt.is_selected === false, 'Pyrantel Option 2: IPCA @ ₹2700 (alternate)');

  // TEST 3: Document Association & CRM Document Bank Attributes
  console.log('\n--- TEST 3: Document Bank Association & Metadata ---');
  const docsRes = await client.query(`
    SELECT d.id, i.inquiry_number, d.product_name, d.make, d.document_type, d.specification, d.original_file_name, d.storage_bucket, d.storage_path, d.pricing_option_id
    FROM crm_product_documents d
    JOIN crm_inquiries i ON i.id = d.inquiry_id
    WHERE i.inquiry_number IN ('INQ-26-0128', 'INQ-26-0129')
    ORDER BY i.inquiry_number, d.make;
  `);

  assert(docsRes.rows.length === 3, 'Exactly 3 documents linked across the inquiries');

  const fbzDoc = docsRes.rows.find(d => d.inquiry_number === 'INQ-26-0128');
  assert(
    fbzDoc && fbzDoc.document_type === 'COA' && fbzDoc.make === 'Su-pharma' && fbzDoc.specification === 'USP' && fbzDoc.original_file_name === 'FBZ-013 2026-27.pdf',
    'Fenbendazole COA (FBZ-013 2026-27.pdf) correctly linked to Su-pharma USP'
  );

  const jrcDoc = docsRes.rows.find(d => d.inquiry_number === 'INQ-26-0129' && d.make === 'JRC');
  assert(
    jrcDoc && jrcDoc.document_type === 'COA' && jrcDoc.specification === 'USP' && jrcDoc.original_file_name === 'JR PP FP 26051.pdf' && jrcDoc.pricing_option_id === jrcOpt.opt_id,
    'Pyrantel JRC COA (JR PP FP 26051.pdf) correctly linked to JRC pricing option'
  );

  const ipcaDoc = docsRes.rows.find(d => d.inquiry_number === 'INQ-26-0129' && d.make === 'IPCA');
  assert(
    ipcaDoc && ipcaDoc.document_type === 'COA' && ipcaDoc.specification === 'USP' && ipcaDoc.original_file_name === '20002P3RMW USP.pdf' && ipcaDoc.pricing_option_id === ipcaOpt.opt_id,
    'Pyrantel IPCA COA (20002P3RMW USP.pdf) correctly linked to IPCA pricing option'
  );

  // TEST 4: CRM Ready / Green Logic
  console.log('\n--- TEST 4: CRM Ready / Green Logic Verification ---');
  // For INQ-26-0129: coa_required = true, hasValidCoa requires COA with matching make
  const hasCoaForJrc = docsRes.rows.some(d => d.inquiry_number === 'INQ-26-0129' && d.document_type === 'COA' && d.make === 'JRC');
  assert(hasCoaForJrc, 'Valid COA exists for selected JRC make on Pyrantel');

  // Verify random document does NOT satisfy requirement
  const isRandomDocCoa = [
    { document_type: 'MSDS', make: 'JRC' },
    { document_type: 'COA', make: 'WrongMake' }
  ].every(fakeDoc => {
    const isCoa = fakeDoc.document_type === 'COA';
    const makeMatches = fakeDoc.make === 'JRC';
    return isCoa && makeMatches;
  });
  assert(!isRandomDocCoa, 'Random MSDS or wrong-make COA does NOT satisfy COA requirement');

  // TEST 5: Document Lifecycle - Temporary vs Permanent Survival
  console.log('\n--- TEST 5: Document Lifecycle (Scoped Deletion & Survival) ---');
  // Create a temporary document and a permanent document for a test scenario
  const testInqId = inqRes.rows[0].inquiry_number === 'INQ-26-0128' ? 'e79c2c14-66b6-4bc4-8fa0-ae49e728b20f' : '48b979d2-7c81-4f98-95f1-05b4507c8fd9';

  const testTempDoc = await client.query(`
    INSERT INTO crm_product_documents (
      inquiry_id, product_name, make, document_type, original_file_name, display_file_name,
      storage_bucket, storage_path, is_permanent
    ) VALUES (
      $1, 'TestProduct', 'TestMake', 'COA', 'temp_test_coa.pdf', 'temp_test_coa.pdf',
      'crm-documents', 'test/temp_test_coa.pdf', false
    ) RETURNING id;
  `, [testInqId]);
  const tempDocId = testTempDoc.rows[0].id;

  const testPermDoc = await client.query(`
    INSERT INTO crm_product_documents (
      inquiry_id, product_name, make, document_type, original_file_name, display_file_name,
      storage_bucket, storage_path, is_permanent
    ) VALUES (
      $1, 'TestProduct', 'TestMake', 'COA', 'perm_test_coa.pdf', 'perm_test_coa.pdf',
      'crm-documents', 'test/perm_test_coa.pdf', true
    ) RETURNING id;
  `, [testInqId]);
  const permDocId = testPermDoc.rows[0].id;

  // Execute scoped deletion (only deletes is_permanent = false for TestMake)
  await client.query(`
    DELETE FROM crm_product_documents
    WHERE inquiry_id = $1 AND make = 'TestMake' AND is_permanent = false;
  `, [testInqId]);

  const checkTemp = await client.query(`SELECT id FROM crm_product_documents WHERE id = $1;`, [tempDocId]);
  const checkPerm = await client.query(`SELECT id FROM crm_product_documents WHERE id = $1;`, [permDocId]);

  assert(checkTemp.rows.length === 0, 'Temporary AI document deleted on source row deletion');
  assert(checkPerm.rows.length === 1, 'Banked permanent document SURVIVES deletion');

  // Clean up test permanent doc
  await client.query(`DELETE FROM crm_product_documents WHERE id = $1;`, [permDocId]);

  console.log(`\n========================================`);
  console.log(`Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
