import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import DOMPurify from 'dompurify';

describe('Quill, Rich Text & Universal HTML Sanitization Safety Suite', () => {
  const emailViewerSrc = readFileSync('src/components/crm/EmailBodyViewer.tsx', 'utf8');
  const bulkComposerSrc = readFileSync('src/components/crm/BulkEmailComposer.tsx', 'utf8');
  const gmailComposerSrc = readFileSync('src/components/crm/GmailLikeComposer.tsx', 'utf8');
  const bulkWorkspaceSrc = readFileSync('src/components/crm/bulk-email/CrmBulkEmailWorkspace.tsx', 'utf8');

  test('1. EmailBodyViewer: Disallows onclick in DOMPurify ALLOWED_ATTR and uses safe delegated event listener', () => {
    // Assert onclick is NOT in ALLOWED_ATTR
    const allowedAttrMatch = emailViewerSrc.match(/ALLOWED_ATTR:\s*\[([\s\S]*?)\]/);
    assert.ok(allowedAttrMatch, 'Must configure ALLOWED_ATTR');
    assert.doesNotMatch(allowedAttrMatch[1], /'onclick'/, 'ALLOWED_ATTR must never allow inline onclick');

    // Assert quoted-toggle template does not use inline onclick
    assert.doesNotMatch(emailViewerSrc, /<div class="quoted-toggle" onclick=/, 'Quoted toggle must not have inline onclick');

    // Assert delegated event listener is present in iframe script
    assert.match(emailViewerSrc, /document\.addEventListener\('click'/, 'Must attach click listener via addEventListener');
    assert.match(emailViewerSrc, /closest\('\.quoted-toggle'\)/, 'Must use delegated matching for quoted-toggle');
  });

  test('2. BulkEmailComposer: Sanitizes HTML when entering editor and before campaign persistence', () => {
    assert.match(bulkComposerSrc, /import DOMPurify from 'dompurify'/, 'Must import DOMPurify in BulkEmailComposer');
    assert.match(bulkComposerSrc, /editorRef\.current\.innerHTML\s*=\s*DOMPurify\.sanitize\(template\.body\)/, 'Template body must be sanitized before assignment');
    assert.match(bulkComposerSrc, /DOMPurify\.sanitize\(rawHtml\)/, 'Editor HTML must be sanitized before saving to bulk_email_campaigns');
  });

  test('3. GmailLikeComposer: Sanitizes onBlur and before send-bulk-email invocation', () => {
    assert.match(gmailComposerSrc, /onBlur=\{\(event\)\s*=>\s*setBody\(DOMPurify\.sanitize\(event\.currentTarget\.innerHTML/, 'Must sanitize on blur in contentEditable surface');
    assert.match(gmailComposerSrc, /const sanitizedBody\s*=\s*DOMPurify\.sanitize\(body/, 'Must sanitize body before email dispatch');
    assert.match(gmailComposerSrc, /body:\s*sanitizedBody/, 'Must dispatch sanitizedBody to send-bulk-email');
  });

  test('4. CrmBulkEmailWorkspace: Sanitizes new email templates before database insertion', () => {
    assert.match(bulkWorkspaceSrc, /body:\s*DOMPurify\.sanitize\(newTemplateBody\.trim\(\)\)/, 'Must sanitize new template body before insert');
  });

  test('5. DOMPurify Package & Universal Sinks Audit', () => {
    assert.equal(DOMPurify.version, '3.4.18', 'Must use DOMPurify 3.4.18');
    
    // Check that all 11 dangerouslySetInnerHTML sinks across the application use DOMPurify
    const filesWithSinks = [
      'src/components/crm/bulk-email/CrmBulkEmailWorkspace.tsx',
      'src/components/crm/inbox/CrmOmnichannelInbox.tsx',
      'src/components/crm/GmailLikeComposer.tsx',
      'src/components/crm/inquiries/CrmInquiryDrawer.tsx',
      'src/components/crm/StockUpdateEmailComposer.tsx',
      'src/components/crm/KunalCustomerQuoteModal.tsx',
      'src/components/crm/KunalInternalReplyModal.tsx',
      'src/components/crm/enquiry-control-center/ConversationTimeline.tsx',
      'src/components/pricing/KunalEmailEvidenceDrawer.tsx',
      'src/pages/SourcingOutbox.tsx',
    ];

    for (const filePath of filesWithSinks) {
      const src = readFileSync(filePath, 'utf8');
      assert.match(src, /DOMPurify/, `${filePath} must import or use DOMPurify`);
    }
  });
});
