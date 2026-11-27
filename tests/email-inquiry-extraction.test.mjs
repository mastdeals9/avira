import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

function loadExtractor() {
  const result = esbuild.buildSync({
    entryPoints: ['src/utils/emailInquiryExtractor.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const mod = { exports: {} };
  const fn = new Function('exports', 'require', 'module', result.outputFiles[0].text);
  fn(mod.exports, require, mod);
  return mod.exports;
}

const extractor = loadExtractor();

test('1. PT Erela Oxomemazine email extracts all structured fields accurately with clean Remarks', () => {
  const ptErelaHtml = `
    <div>
      <p>Dear Team,</p>
      <p>Please send us quotation price and COA for the following requirement:</p>
      <table>
        <thead>
          <tr>
            <th>Product Name</th>
            <th>Quantity</th>
            <th>Factory</th>
            <th>Origin</th>
            <th>Requested Arrival</th>
            <th>Documents</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>OXOMEMAZINE HYDROCHLORIDE</td>
            <td>1 KG</td>
            <td>DELTA FINOCHEM PVT. LTD.</td>
            <td>India</td>
            <td>18 January 2027</td>
            <td>COA</td>
          </tr>
        </tbody>
      </table>
      <p>Best regards,<br/>Maria Monica<br/>PT Erela</p>
    </div>
  `;

  const res = extractor.extractInquiryFromEmail({
    emailSubject: 'Oxomemazine',
    emailBody: '',
    emailBodyHtml: ptErelaHtml,
    fromEmail: 'maria.monica@erela.co.id',
    fromName: 'Maria Monica',
    receivedDate: '2026-11-27T08:00:00Z',
  });

  assert.equal(res.companyName, 'PT Erela');
  assert.equal(res.contactPerson, 'Maria Monica');
  assert.equal(res.contactEmail, 'maria.monica@erela.co.id');
  assert.equal(res.productName, 'OXOMEMAZINE HYDROCHLORIDE');
  assert.equal(res.quantity, '1 KG');
  assert.equal(res.supplierName, 'DELTA FINOCHEM PVT. LTD.');
  assert.equal(res.supplierCountry, 'India');
  assert.equal(res.deliveryDateExpected, '2027-01-18');
  assert.equal(res.coaRequested, true);
  assert.equal(res.priceRequested, true);
  assert.equal(res.specification, null);
  assert.equal(res.purchasePrice, null);
  assert.equal(res.offeredPrice, null);
  assert.equal(res.remarks, null);
});

test('2. Multi-product HTML table preserves separate rows even when product name repeats', () => {
  const html = `
    <p>Permintaan Penawaran Harga:</p>
    <table>
      <tr><th>NAMA</th><th>QTY</th><th>SATUAN</th><th>ORIGIN</th><th>TGL DATANG</th></tr>
      <tr><td>Sodium Diclofenac</td><td>1000</td><td>KG</td><td>India</td><td>04/12/2026</td></tr>
      <tr><td></td><td>2000</td><td>KG</td><td>India</td><td>15/01/2027</td></tr>
      <tr><td>Ranitidine HCl</td><td>300</td><td>KG</td><td>China</td><td>20/02/2027</td></tr>
    </table>
    <p>Regards,<br/>Budi<br/>PT Kalbe Farma</p>
  `;

  const res = extractor.extractInquiryFromEmail({
    emailSubject: 'Permintaan Penawaran Harga',
    emailBody: '',
    emailBodyHtml: html,
    fromEmail: 'budi@kalbe.co.id',
    fromName: 'Budi',
    receivedDate: '2026-11-27',
  });

  assert.equal(res.products.length, 3);
  assert.equal(res.products[0].productName, 'Sodium Diclofenac');
  assert.equal(res.products[0].quantity, '1000 KG');
  assert.equal(res.products[0].deliveryDate, '2026-12-04');
  assert.equal(res.products[1].productName, 'Sodium Diclofenac');
  assert.equal(res.products[1].quantity, '2000 KG');
  assert.equal(res.products[1].deliveryDate, '2027-01-15');
  assert.equal(res.products[2].productName, 'Ranitidine HCl');
  assert.equal(res.products[2].supplierCountry, 'China');
  assert.equal(res.companyName, 'PT Kalbe Farma');
});

test('3. Plain-text email without HTML tables + attachments extracts cleanly without body in Remarks', () => {
  const body = [
    'Dear Sales,',
    'Product: Paracetamol BP',
    'Quantity: 500 KG',
    'Factory: Farmson Pharmaceutical',
    'Origin: India',
    'Packaging: 25kg fiber drum',
    'Please share price and MSDS.',
    'Thanks,',
    'Andi',
    'PT Dexa Medica',
  ].join('\n');

  const res = extractor.extractInquiryFromEmail({
    emailSubject: 'RFQ Paracetamol BP',
    emailBody: body,
    fromEmail: 'andi@dexa-medica.com',
    fromName: 'Andi',
    receivedDate: '2026-11-27',
    attachments: [{ filename: 'Paracetamol_Spec.pdf' }],
  });

  assert.equal(res.productName, 'Paracetamol BP');
  assert.equal(res.quantity, '500 KG');
  assert.equal(res.supplierName, 'Farmson Pharmaceutical');
  assert.equal(res.supplierCountry, 'India');
  assert.equal(res.msdsRequested, true);
  assert.equal(res.deliveryDateExpected, null); // never invents a date
  assert.match(res.remarks || '', /Packaging: 25kg fiber drum/);
  assert.match(res.remarks || '', /Attachments: Paracetamol_Spec\.pdf/);
  assert.doesNotMatch(res.remarks || '', /Dear Sales/);
});

test('4. Quoted historical correspondence and missing customer name / Email Sender handling', () => {
  const body = `
    Product: Cefixime Trihydrate
    Quantity: 25 KG
    Please quote price.

    On Mon, Nov 10, 2025 at 10:00 AM Someone wrote:
    > Product: Old Amoxicillin
    > Quantity: 999 KG
    > Requested Arrival: 01 January 2026
  `;

  const res = extractor.extractInquiryFromEmail({
    emailSubject: 'Cefixime Trihydrate',
    emailBody: body,
    fromEmail: 'buyer@pharmaco.co.id',
    fromName: 'Email Sender',
    receivedDate: '2026-11-27',
  });

  assert.equal(res.productName, 'Cefixime Trihydrate');
  assert.equal(res.quantity, '25 KG');
  assert.equal(res.deliveryDateExpected, null); // ignores quoted 2026-01-01
  assert.notEqual(res.companyName, 'Email Sender');
  assert.equal(res.companyName, 'PHARMACO'); // inferred from domain, never 'Email Sender'
  assert.equal(res.remarks, null);
});

test('5. UI & Edge Function regression guards: no body-to-Remarks fallback, no Email Sender, HTML preserved', () => {
  const crmSrc = readFileSync(new URL('../src/pages/CRM.tsx', import.meta.url), 'utf8');
  const inboxSrc = readFileSync(
    new URL('../src/components/crm/inbox/CrmOmnichannelInbox.tsx', import.meta.url),
    'utf8'
  );
  const formSrc = readFileSync(
    new URL('../src/components/crm/CompactInquiryForm.tsx', import.meta.url),
    'utf8'
  );
  const fnSrc = readFileSync(
    new URL('../supabase/functions/parse-pharma-email/index.ts', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(crmSrc, /msg\.body\?\.slice\(0,\s*500\)/);
  assert.match(crmSrc, /delivery_date:\s*parsed\?\.deliveryDateExpected/);
  assert.doesNotMatch(inboxSrc, /\|\|\s*'Email Sender'/);
  assert.match(inboxSrc, /emailBodyHtml/);
  assert.match(inboxSrc, /source_email_id/);
  assert.match(formSrc, /AI Extraction Review/);
  assert.match(fnSrc, /htmlToStructuredEmailText/);
});

test('6. Multi-product save spreads shared customer metadata and edge fallback never emits Unknown Company', () => {
  const crmSrc = readFileSync(new URL('../src/pages/CRM.tsx', import.meta.url), 'utf8');
  const fnSrc = readFileSync(
    new URL('../supabase/functions/parse-pharma-email/index.ts', import.meta.url),
    'utf8'
  );

  assert.match(
    crmSrc,
    /const\s*\{\s*items,\s*products,\s*is_multi_product,\s*\.\.\.restFormData\s*\}\s*=\s*formData;/
  );
  assert.match(crmSrc, /inquiriesToInsert\s*=\s*multiProducts\.map\([\s\S]*?\.\.\.restFormData,/);
  assert.doesNotMatch(fnSrc, /'Unknown Company'/);
  assert.match(fnSrc, /fallbackData:\s*\{[\s\S]*remarks:\s*null,/);
});
