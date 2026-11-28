import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

test.describe('SAPJ CRM Interactive Contact Phone Audit & Correction Centre E2E Suite', () => {
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
      'SELECT id, company_name, contact_person, email, phone, mobile, city, customer_type, is_active FROM crm_contacts WHERE is_active = true ORDER BY company_name'
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

  const loginDirectly = async (page: any) => {
    await setupAuth(page);
    await page.goto('/');
    await page.locator('#username').fill('kunal');
    await page.locator('#password').fill('secret');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });
  };

  test('Interactive Contact Phone Audit & Correction Centre UI Flow & Screenshots', async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginDirectly(page);

    // 1. Navigate to Campaigns -> WhatsApp
    await page.goto('/crm/campaigns?subtab=whatsapp');

    // 2. Verify header strip and interactive KPI cards are present
    await expect(page.getByText('Contact Phone Verification & WhatsApp Audit')).toBeVisible({ timeout: 15000 });

    // Wait for contacts directory to finish loading (521 records)
    const auditBtn = page.getByRole('button', { name: /Audit Centre \(521\)/i });
    await expect(auditBtn).toBeVisible({ timeout: 20000 });

    await expect(page.getByText('WA Eligible')).toBeVisible();
    await expect(page.getByText('Landlines')).toBeVisible();
    await expect(page.getByText('Missing')).toBeVisible();
    await expect(page.getByText('Invalid')).toBeVisible();
    await expect(page.getByText('Duplicates')).toBeVisible();

    // Capture screenshot of Campaigns view showing clickable cards
    await page.screenshot({
      path: path.join(artifactDir, 'crm-campaigns-phone-cards.png'),
    });
    console.log('[E2E] Captured crm-campaigns-phone-cards.png');

    // 3. Click "Audit Centre" button to open the modal
    await auditBtn.click();
    await expect(page.getByText('Contact Phone Audit & Correction Centre')).toBeVisible({ timeout: 5000 });
    const modal = page.locator('div.fixed.inset-0').first();

    // Verify table header columns
    await expect(modal.getByRole('columnheader', { name: /Company/i })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: /Contact Person/i })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: /Current Mobile \/ Phone/i })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: /Country/i })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: /Validation Result/i })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: /Reason & Diagnostics/i })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: /Corrected Mobile/i })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: /Action/i })).toBeVisible();

    // Capture screenshot of Directory view
    await page.screenshot({
      path: path.join(artifactDir, 'crm-phone-audit-modal-directory.png'),
    });
    console.log('[E2E] Captured crm-phone-audit-modal-directory.png');

    // 4. Click "Duplicates" category pill inside modal
    const duplicatesTab = modal.getByRole('button', { name: /Duplicates/i });
    await duplicatesTab.click();

    // Verify duplicates grouped table is displayed
    await expect(modal.getByText(/Duplicate Phone Group Analysis/i)).toBeVisible({ timeout: 5000 });
    await expect(modal.getByText(/Same-Group \/ Sister Companies/i).first()).toBeVisible();

    // Capture screenshot of Duplicates view
    await page.screenshot({
      path: path.join(artifactDir, 'crm-phone-audit-modal-duplicates.png'),
    });
    console.log('[E2E] Captured crm-phone-audit-modal-duplicates.png');

    // 5. Click "Bulk Normalization" button to preview safe bulk normalization
    const bulkNormBtn = modal.getByRole('button', { name: /Bulk Normalization/i });
    await bulkNormBtn.click();

    // Verify Safe Bulk Normalization preview modal is open
    const previewModal = page.locator('div.fixed.inset-0.z-60');
    await expect(previewModal.getByText('Safe Bulk Mobile Normalization Preview')).toBeVisible({ timeout: 5000 });
    await expect(previewModal.getByText(/Staff approval required/i)).toBeVisible();
    await expect(previewModal.getByRole('button', { name: /Confirm & Apply/i })).toBeVisible();

    // Capture screenshot of Bulk Preview modal
    await page.screenshot({
      path: path.join(artifactDir, 'crm-phone-audit-modal-bulk-preview.png'),
    });
    console.log('[E2E] Captured crm-phone-audit-modal-bulk-preview.png');

    // Close preview modal
    await previewModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(previewModal).toBeHidden();

    // Close main audit modal
    await modal.getByRole('button', { name: /Done \/ Close/i }).click();
    await expect(page.getByText('Contact Phone Audit & Correction Centre')).toBeHidden();

    console.log('[E2E] All interactive audit modal assertions and screenshots completed successfully!');
  });
});
