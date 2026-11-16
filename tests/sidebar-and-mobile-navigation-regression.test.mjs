import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Sidebar and Mobile Navigation Cleanup Verification', async (t) => {
  const layoutPath = path.resolve('src/components/Layout.tsx');
  assert.ok(fs.existsSync(layoutPath), 'Layout.tsx must exist');
  const layoutContent = fs.readFileSync(layoutPath, 'utf8');

  await t.test('1. Global sidebar removes Purchase Invoices and Tax Compliance from sidebar groups', () => {
    // Finance group must strictly contain only finance and price-calculator
    assert.match(
      layoutContent,
      /{\s*label:\s*t\('nav\.groupFinance',\s*'Finance'\),\s*items:\s*allItems\.filter\(i\s*=>\s*\['finance',\s*'price-calculator'\]\.includes\(i\.id\)\)\s*}/
    );

    // Purchase Invoices and Tax Compliance must not be separate global sidebar items
    assert.doesNotMatch(layoutContent, /'purchase-invoices',\s*'tax-compliance',\s*'price-calculator'/);
  });

  await t.test('2. Global sidebar retains only module-level navigation groups', () => {
    // MAIN: dashboard, crm, customers, document-bank
    assert.match(layoutContent, /\['dashboard',\s*'crm',\s*'customers'(?:,\s*'document-bank')?\]/);

    // SALES: sales-orders, delivery-challan, sales
    assert.match(layoutContent, /\['sales-orders',\s*'delivery-challan',\s*'sales'\]/);

    // STOCK: products, batches, stock
    assert.match(layoutContent, /\['products',\s*'batches',\s*'stock'\]/);

    // PURCHASES: purchase-orders, import-requirements, import-containers
    assert.match(layoutContent, /\['purchase-orders',\s*'import-requirements',\s*'import-containers'\]/);

    // FINANCE: finance, price-calculator
    assert.match(layoutContent, /\['finance',\s*'price-calculator'\]/);

    // PRICING: pricing-dashboard
    assert.match(layoutContent, /\['pricing-dashboard'\]/);

    // REPORTS: reports
    assert.match(layoutContent, /\['reports'\]/);

    // SYSTEM: tasks, command-center, settings
    assert.match(layoutContent, /\['tasks',\s*'command-center',\s*'settings'\]/);
  });

  await t.test('3. Semantic Lucide icon system is properly utilized', () => {
    // Verify required semantic icons are used in allItems
    assert.match(layoutContent, /{\s*id:\s*'dashboard',\s*label:\s*t\('nav\.dashboard'\),\s*icon:\s*LayoutDashboard\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'crm',\s*label:\s*t\('nav\.crm'\),\s*icon:\s*UsersRound\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'customers',\s*label:\s*t\('nav\.customers'\),\s*icon:\s*UserRound\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'sales-orders',\s*label:\s*t\('nav\.salesOrders'\),\s*icon:\s*ClipboardCheck\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'delivery-challan',\s*label:\s*t\('nav\.deliveryChallan'\),\s*icon:\s*Truck\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'sales',\s*label:\s*t\('nav\.sales'\),\s*icon:\s*ReceiptText\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'products',\s*label:\s*t\('nav\.products'\),\s*icon:\s*Package\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'batches',\s*label:\s*t\('nav\.batches'\),\s*icon:\s*Boxes\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'stock',\s*label:\s*t\('nav\.stock'\),\s*icon:\s*Warehouse\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'purchase-orders',\s*label:\s*t\('nav\.purchaseOrders'\),\s*icon:\s*ClipboardList\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'import-requirements',\s*label:\s*t\('nav\.importRequirements'\),\s*icon:\s*FileInput\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'import-containers',\s*label:\s*t\('nav\.importContainers'\),\s*icon:\s*Container\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'finance',\s*label:\s*t\('nav\.finance'\),\s*icon:\s*Landmark\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'price-calculator',\s*label:\s*t\('nav\.priceCalculator',\s*'Price Calculator'\),\s*icon:\s*Calculator\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'pricing-dashboard',\s*label:\s*t\('nav\.pricingOverview',\s*'Pricing Overview'\),\s*icon:\s*BadgeDollarSign\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'reports',\s*label:\s*t\('nav\.reports',\s*'Reports'\),\s*icon:\s*BarChart3\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'tasks',\s*label:\s*t\('nav\.tasks'\),\s*icon:\s*ListChecks\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'command-center',\s*label:\s*t\('nav\.commandCenter'\),\s*icon:\s*Zap\s*}/);
    assert.match(layoutContent, /{\s*id:\s*'settings',\s*label:\s*t\('nav\.settings'\),\s*icon:\s*Settings\s*}/);
  });

  await t.test('4. Permission integration surfaces Finance if user has granular purchase-invoices or tax-compliance permissions', () => {
    assert.match(layoutContent, /isItemAccessible\s*=\s*\(itemId:\s*string\)\s*=>/);
    assert.match(layoutContent, /accessibleModules\.has\('finance'\)\s*\|\|\s*accessibleModules\.has\('purchase-invoices'\)\s*\|\|\s*accessibleModules\.has\('tax-compliance'\)/);

    // Verify Finance.tsx preserves internal tab access and permissions
    const financePath = path.resolve('src/pages/Finance.tsx');
    assert.ok(fs.existsSync(financePath), 'Finance.tsx must exist');
    const financeContent = fs.readFileSync(financePath, 'utf8');
    assert.match(financeContent, /accessibleModules\.has\('purchase-invoices'\)/);
    assert.match(financeContent, /accessibleModules\.has\('tax-compliance'\)/);
    assert.match(financeContent, /if \(hasPurchaseInvoices\) tabs\.add\('purchase'\)/);
    assert.match(financeContent, /if \(hasTaxCompliance\) tabs\.add\('tax'\)/);
  });

  await t.test('5. Mobile slide-over drawer is implemented with proper responsive styling', () => {
    // Slide-over drawer with w-72 max-w-[85vw]
    assert.match(layoutContent, /w-72 max-w-\[85vw\] bg-white flex flex-col shadow-2xl/);
    assert.match(layoutContent, /lg:hidden/);
    assert.match(layoutContent, /min-h-\[44px\]/);
    assert.match(layoutContent, /backdrop-blur/);
  });

  await t.test('6. Mobile bottom navigation shortcut layer is present with 5 shortcuts', () => {
    assert.match(layoutContent, /aria-label="Mobile Navigation"/);
    // 5 shortcuts: Home, CRM, Sales, Stock, More
    assert.match(layoutContent, /navigate\('dashboard'\)/);
    assert.match(layoutContent, /navigate\('crm'\)/);
    assert.match(layoutContent, /navigate\('sales'\)/);
    assert.match(layoutContent, /navigate\('stock'\)/);
    assert.match(layoutContent, /setSidebarOpen\(true\)/);
  });

  await t.test('7. Desktop compact sidebar behavior is preserved', () => {
    assert.match(layoutContent, /hidden lg:flex fixed top-0 left-0 z-30 h-full bg-white border-r border-gray-200 flex-col/);
    assert.match(layoutContent, /isCollapsed \? 'w-16' : 'w-\[200px\]'/);
  });
});
