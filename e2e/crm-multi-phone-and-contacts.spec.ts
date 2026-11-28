import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

test.describe('SAPJ CRM Multi-Phone per Company & Contact E2E Suite', () => {
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

    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const res = await client.query(
      'SELECT id, company_name, contact_person, designation, email, phone, mobile, landline, country, city, customer_type, is_active FROM crm_contacts WHERE is_active = true ORDER BY company_name'
    );
    realContacts = res.rows;
    await client.end();
  });

  const setupAuth = async (page: any) => {
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

  test('Multi-Phone Table, Department Segregation & Recipient Directory', async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupAuth(page);

    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });

    // 1. Navigate to Campaigns -> WhatsApp
    await page.goto('/crm/campaigns?subtab=whatsapp');
    await expect(page.getByText('Contact Phone Verification & WhatsApp Audit')).toBeVisible({ timeout: 15000 });

    // Verify 6 Cards
    await expect(page.getByText('phone numbers')).toBeVisible();
    await expect(page.getByText('WA Eligible')).toBeVisible();
    await expect(page.getByText('Landlines')).toBeVisible();

    // Capture Campaigns workspace
    await page.screenshot({
      path: path.join(artifactDir, 'crm-campaigns-multi-phone-cards.png'),
    });
    console.log('[E2E] Captured crm-campaigns-multi-phone-cards.png');

    // 2. Open Audit Centre Modal
    const auditBtn = page.getByRole('button', { name: /Audit Centre \(521\)/i });
    await auditBtn.click();
    await expect(page.getByText('Contact Phone Audit & Correction Centre')).toBeVisible({ timeout: 5000 });
    const modal = page.locator('div.fixed.inset-0').first();

    // Verify Multi-phone search: PT ISA MEDIKA PERSADA
    const searchInput = modal.getByPlaceholder(/Search company, contact person/i);
    await searchInput.fill('ISA MEDIKA');
    await page.waitForTimeout(600);

    // Verify both numbers appear: 082225541227 and 082124423008
    await expect(modal.getByText('082225541227')).toBeVisible();
    await expect(modal.getByText('082124423008')).toBeVisible();

    // Capture screenshot of PT ISA MEDIKA PERSADA multi-phone rows
    await page.screenshot({
      path: path.join(artifactDir, 'crm-multi-phone-isa-medika.png'),
    });
    console.log('[E2E] Captured crm-multi-phone-isa-medika.png');

    // 3. Clear search and test Add Phone Modal
    await searchInput.fill('');
    const addPhoneBtn = modal.getByRole('button', { name: /Add Phone Number/i });
    await addPhoneBtn.click();

    const addModal = page.locator('div.fixed.inset-0.z-60');
    await expect(addModal.getByText('Add Company Phone Number')).toBeVisible({ timeout: 5000 });
    await page.screenshot({
      path: path.join(artifactDir, 'crm-add-phone-modal.png'),
    });
    console.log('[E2E] Captured crm-add-phone-modal.png');
    await addModal.getByRole('button', { name: 'Cancel' }).click();

    // Close audit modal
    await modal.getByRole('button', { name: /Done \/ Close/i }).click();

    // 4. Open WhatsApp Recipient Directory and verify Department Filter
    const filterDirBtn = page.getByRole('button', { name: /Filter Directory/i });
    await filterDirBtn.click();
    const recipientModal = page.locator('div.fixed.inset-0.z-50');
    await expect(recipientModal.getByText('WhatsApp Recipient Directory & Eligibility Audit')).toBeVisible({ timeout: 5000 });

    // Capture Recipient Selector
    await page.screenshot({
      path: path.join(artifactDir, 'crm-wa-recipient-selector-departments.png'),
    });
    console.log('[E2E] Captured crm-wa-recipient-selector-departments.png');

    await recipientModal.getByRole('button', { name: /Done Selecting/i }).click();
    console.log('[E2E] Multi-phone E2E suite completed successfully!');
  });
});
