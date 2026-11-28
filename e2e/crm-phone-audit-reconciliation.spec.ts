import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

test.describe('Anzen CRM Phone Audit Numerical Reconciliation & Acceptance', () => {
  let anonKey = '';
  let realContacts: any[] = [];
  const artifactDir = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2';
  const DB_URL =
    process.env.READONLY_AUDIT_DB_URL ||
    (process.env.READONLY_AUDIT_DB_URL || '');

  test.beforeAll(async () => {
    const envFile = fs.readFileSync('.env', 'utf8');
    const anonKeyMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
    anonKey = anonKeyMatch ? anonKeyMatch[1].trim() : '';

    const fixturePath = path.resolve('tests/fixtures/crm_contacts_468.json');
    if (fs.existsSync(fixturePath)) {
      realContacts = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    } else {
      const client = new pg.Client({ connectionString: DB_URL });
      await client.connect();
      const res = await client.query(
        'SELECT id, company_name, contact_person, designation, email, phone, mobile, landline, country, city, customer_type, notes, is_active FROM crm_contacts WHERE is_active = true ORDER BY company_name'
      );
      realContacts = res.rows;
      await client.end();
    }
  });

  const setupAuthAndMocks = async (page: any) => {
    const mockUser = {
      id: '1075a773-bb55-4296-bc71-af2eab9a0780',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'kunal@sapharmajaya.co.id',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { full_name: 'Kunal Lunkad' },
      created_at: '2025-10-31T12:00:00.000Z',
      updated_at: '2025-10-31T12:00:00.000Z',
    };

    const mockSession = {
      access_token: anonKey,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      refresh_token: 'dummy-refresh-token',
      user: mockUser,
    };

    await page.route('**/rest/v1/rpc/lookup_login_email*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'kunal@sapharmajaya.co.id', is_active: true }),
      });
    });

    await page.route('**/auth/v1/token?grant_type=password*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockSession),
      });
    });

    await page.route('**/auth/v1/user*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockUser),
      });
    });

    await page.route('**/rest/v1/user_profiles*', async (route: any) => {
      const accept = route.request().headers()['accept'] || '';
      const profile = {
        id: mockUser.id,
        role: 'admin',
        full_name: 'Kunal Lunkad',
        is_active: true,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(accept.includes('vnd.pgrst.object+json') ? profile : [profile]),
      });
    });

    await page.route('**/rest/v1/user_permissions*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ module: 'crm', can_access: true }]),
      });
    });

    await page.route('**/rest/v1/crm_contacts*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(realContacts),
      });
    });

    await page.route('**/api/whatsapp/api/status*', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'connected',
          session: 'sapj-business-whatsapp',
          businessPhone: '+6285888600999',
          lastSeen: new Date().toISOString(),
          webhookConfigured: true,
        }),
      });
    });
  };

  const loginDirectly = async (page: any) => {
    await setupAuthAndMocks(page);
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });
  };

  test('Canonical CRM Phone Audit End-to-End Browser Reconciliation & Visual Acceptance', async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginDirectly(page);

    // 1. Navigate to Campaigns -> WhatsApp subtab
    await page.goto('/crm/campaigns?subtab=whatsapp');

    // Verify header strip and WhatsApp campaign workspace
    await expect(page.getByText('Contact Phone Verification & WhatsApp Audit')).toBeVisible({ timeout: 15000 });

    // 2. Main Campaign screen KPI cards assertions
    // Button: Audit Centre (468)
    const auditCentreBtn = page.getByRole('button', { name: /Audit Centre \(468\)/i });
    await expect(auditCentreBtn).toBeVisible({ timeout: 15000 });

    // Verify all 6 KPI cards show the canonical counts
    const totalCard = page.locator('button:has-text("TOTAL DIRECTORY")');
    await expect(totalCard).toContainText('468');
    await expect(totalCard).toContainText('677 phone records');

    const waCandidatesCard = page.locator('button:has-text("WA CANDIDATES")');
    await expect(waCandidatesCard).toContainText('96');
    await expect(waCandidatesCard).toContainText('Eligible campaign candidates');

    const landlinesCard = page.locator('button:has-text("LANDLINES")');
    await expect(landlinesCard).toContainText('545');
    await expect(landlinesCard).toContainText('Excluded (No WA)');

    const missingCard = page.locator('button:has-text("MISSING NUMBER")');
    await expect(missingCard).toContainText('17');
    await expect(missingCard).toContainText('Email only');

    const invalidCard = page.locator('button:has-text("INVALID FORMATS")');
    await expect(invalidCard).toContainText('36');
    await expect(invalidCard).toContainText('Bad digits/length');

    const duplicatesCard = page.locator('button:has-text("DUPLICATES")');
    await expect(duplicatesCard).toContainText('141');
    await expect(duplicatesCard).toContainText('Flagged shared');

    // Screenshot a: Main Campaign screen showing the corrected, consistent counts
    await page.screenshot({
      path: path.join(artifactDir, 'whatsapp-campaigns-reconciled-kpi-1440x900.png'),
    });
    console.log('[E2E] Captured whatsapp-campaigns-reconciled-kpi-1440x900.png');

    // 3. Open Contact Phone Audit & Correction Centre modal
    await auditCentreBtn.click();
    const modal = page.locator('div.fixed.inset-0').first();
    await expect(modal.getByText('Contact Phone Audit & Correction Centre')).toBeVisible({ timeout: 8000 });

    // Verify modal header badge shows unified counts
    await expect(modal.getByText('468 Companies • 694 Phone Records')).toBeVisible();

    // Verify modal category tabs show identical totals
    const totalTab = modal.getByRole('button', { name: /Total Directory/i });
    await expect(totalTab).toContainText('694');

    const eligibleTab = modal.getByRole('button', { name: /WhatsApp Eligible/i });
    await expect(eligibleTab).toContainText('96');

    const landlinesTab = modal.getByRole('button', { name: /Landlines/i });
    await expect(landlinesTab).toContainText('545');

    const missingTab = modal.getByRole('button', { name: /Missing Number/i });
    await expect(missingTab).toContainText('17');

    const invalidTab = modal.getByRole('button', { name: /Invalid Formats/i });
    await expect(invalidTab).toContainText('36');

    const duplicatesTab = modal.getByRole('button', { name: /Duplicates/i });
    await expect(duplicatesTab).toContainText('141');

    // Screenshot b: Contact Phone Audit Centre showing identical totals
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-centre-directory-totals-1440x900.png'),
    });
    console.log('[E2E] Captured phone-audit-centre-directory-totals-1440x900.png');

    // 4. Click "WhatsApp Eligible" tab: must NOT be empty
    await eligibleTab.click();
    await expect(modal.getByText('No contact records found matching the current category and filters')).toBeHidden();
    // Verify rows are visible in the table
    const eligibleRows = modal.locator('table tbody tr');
    const eligibleRowCount = await eligibleRows.count();
    expect(eligibleRowCount).toBeGreaterThan(0);
    console.log(`[E2E] WhatsApp Eligible tab rendered ${eligibleRowCount} visible rows.`);

    // Screenshot c: WhatsApp Eligible tab with non-empty records
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-centre-eligible-tab-1440x900.png'),
    });
    console.log('[E2E] Captured phone-audit-centre-eligible-tab-1440x900.png');

    // 5. Click "Invalid Formats" tab: must NOT be empty
    await invalidTab.click();
    await expect(modal.getByText('No contact records found matching the current category and filters')).toBeHidden();
    const invalidRows = modal.locator('table tbody tr');
    const invalidRowCount = await invalidRows.count();
    expect(invalidRowCount).toBeGreaterThan(0);
    console.log(`[E2E] Invalid Formats tab rendered ${invalidRowCount} visible rows.`);

    // Screenshot d: Invalid Formats tab with non-empty records
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-centre-invalid-tab-1440x900.png'),
    });
    console.log('[E2E] Captured phone-audit-centre-invalid-tab-1440x900.png');

    // 6. Click "Duplicates" tab: check grouped view
    await duplicatesTab.click();
    await expect(modal.getByText('Duplicate Phone Group Analysis')).toBeVisible({ timeout: 5000 });
    // Verify duplicate groups are rendered
    const duplicateGroupBadges = modal.locator('text=Contacts Sharing Number');
    const groupCount = await duplicateGroupBadges.count();
    expect(groupCount).toBeGreaterThan(0);
    console.log(`[E2E] Duplicates tab rendered ${groupCount} duplicate groups.`);

    // Screenshot e: Duplicate tab showing grouped duplicate analysis
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-centre-duplicates-grouped-1440x900.png'),
    });
    console.log('[E2E] Captured phone-audit-centre-duplicates-grouped-1440x900.png');

    // 7. Click "Flat Table" view for Duplicates
    const flatTableBtn = modal.getByRole('button', { name: /Flat Table/i });
    await flatTableBtn.click();
    await expect(modal.getByText('No contact records found matching the current category and filters')).toBeHidden();
    const dupFlatRows = modal.locator('table tbody tr');
    const dupFlatRowCount = await dupFlatRows.count();
    expect(dupFlatRowCount).toBeGreaterThan(0);
    console.log(`[E2E] Duplicates Flat Table view rendered ${dupFlatRowCount} rows.`);

    // Screenshot f: Duplicate tab flat table view
    await page.screenshot({
      path: path.join(artifactDir, 'phone-audit-centre-duplicates-flat-1440x900.png'),
    });
    console.log('[E2E] Captured phone-audit-centre-duplicates-flat-1440x900.png');

    // 8. Close modal using header close button
    await modal.locator('button[title="Close Audit Centre"]').click();
    await expect(modal).toBeHidden({ timeout: 5000 });
  });
});

