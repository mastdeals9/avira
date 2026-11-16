import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import createJiti from 'jiti';

const jiti = createJiti(import.meta.url);

const { getCategoryFieldRules } = jiti('../src/components/finance/categoryFieldRules.ts');
const {
  DOCUMENT_TYPE_GROUPS,
  getDocTypeForCategory,
  EXPENSE_CATEGORY_LABELS,
} = jiti('../src/utils/taxCalculations.ts');
const {
  moduleExpenseCategories,
  getExpenseCategoryDef,
} = jiti('../src/components/finance/expenseCategories.ts');

const connectionString = 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

test('Prompt 8 — Expense Category Vocabulary Consistency & Flow', async (t) => {
  let client;

  t.before(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  t.after(async () => {
    if (client) await client.end();
  });

  await t.test('1. CategoryFieldRules: utility rules apply to newer categories and historical utilities', () => {
    const newerCats = ['electricity', 'water', 'internet_phone', 'utilities'];
    for (const cat of newerCats) {
      const rules = getCategoryFieldRules(cat);
      assert.equal(rules.utility, 'show', `${cat} must show Utility Master picker`);
      assert.equal(rules.billingMonth, 'show', `${cat} must show Billing Month`);
      assert.equal(rules.supplier, 'hide', `${cat} must hide general Supplier picker`);
    }

    // Facility maintenance (Cleaning & Maintenance) uses default operational supplier rules
    const maintRules = getCategoryFieldRules('facility_maintenance');
    assert.equal(maintRules.supplier, 'show', 'facility_maintenance must show Supplier picker');
    assert.equal(maintRules.utility, 'hide', 'facility_maintenance must hide Utility picker');
  });

  await t.test('2. TaxCalculations: document type groupings and category labels', () => {
    // Utility doc type mapping
    assert.ok(DOCUMENT_TYPE_GROUPS['Utility'].includes('electricity'), 'Utility must include electricity');
    assert.ok(DOCUMENT_TYPE_GROUPS['Utility'].includes('water'), 'Utility must include water');
    assert.ok(DOCUMENT_TYPE_GROUPS['Utility'].includes('internet_phone'), 'Utility must include internet_phone');
    assert.ok(DOCUMENT_TYPE_GROUPS['Utility'].includes('utilities'), 'Utility must include utilities');

    assert.equal(getDocTypeForCategory('electricity'), 'Utility');
    assert.equal(getDocTypeForCategory('water'), 'Utility');
    assert.equal(getDocTypeForCategory('internet_phone'), 'Utility');
    assert.equal(getDocTypeForCategory('utilities'), 'Utility');

    // Facility maintenance mapping
    assert.ok(DOCUMENT_TYPE_GROUPS['Operating Expense'].includes('facility_maintenance'), 'Operating Expense must include facility_maintenance');
    assert.equal(getDocTypeForCategory('facility_maintenance'), 'Operating Expense');

    // Labels
    assert.ok(EXPENSE_CATEGORY_LABELS.electricity, 'Label must exist for electricity');
    assert.ok(EXPENSE_CATEGORY_LABELS.water, 'Label must exist for water');
    assert.ok(EXPENSE_CATEGORY_LABELS.internet_phone, 'Label must exist for internet_phone');
    assert.ok(EXPENSE_CATEGORY_LABELS.facility_maintenance, 'Label must exist for facility_maintenance');
    assert.ok(EXPENSE_CATEGORY_LABELS.utilities, 'Label must exist for utilities');
  });

  await t.test('3. ModuleExpenseCategories: contains newer categories and historical utilities', () => {
    const expected = ['electricity', 'water', 'internet_phone', 'facility_maintenance', 'utilities'];
    for (const cat of expected) {
      const def = getExpenseCategoryDef(cat);
      assert.ok(def, `Category definition must exist for ${cat}`);
      assert.equal(def.value, cat);
      assert.equal(def.type, 'operations');
      assert.equal(def.requiresContainer, false);
    }
  });

  await t.test('4. Database: Utility Master active records verification', async () => {
    const res = await client.query(`
      SELECT id, provider_name, utility_type, default_gl_code, status
      FROM public.finance_utility_master
      ORDER BY utility_type;
    `);
    assert.ok(res.rows.length >= 4, 'Must have at least 4 active utility master records');
    const types = res.rows.map(r => r.utility_type);
    assert.ok(types.includes('electricity'), 'Must have PLN electricity utility');
    assert.ok(types.includes('water'), 'Must have PAM JAYA water utility');
    assert.ok(types.includes('phone') || types.includes('internet'), 'Must have Telkom phone/internet utility');
  });

  await t.test('5. Database: expense creation, updating, and constraint compliance in isolated transaction', async () => {
    await client.query('BEGIN;');
    try {
      const bankRes = await client.query("SELECT id FROM public.bank_accounts WHERE is_active = true LIMIT 1;");
      const bankId = bankRes.rows[0].id;

      // 5a. Create and save expenses for newer categories
      const categoriesToTest = [
        { cat: 'electricity', coaCode: '6310' },
        { cat: 'water', coaCode: '6320' },
        { cat: 'internet_phone', coaCode: '6330' },
        { cat: 'facility_maintenance', coaCode: '6350' },
      ];

      for (const { cat, coaCode } of categoriesToTest) {
        await client.query('SAVEPOINT sp_cat_test;');

        // Insert pending expense
        const insRes = await client.query(`
          INSERT INTO public.finance_expenses (
            expense_category, expense_type, amount, expense_date, description, payment_method, bank_account_id, approval_status
          ) VALUES (
            $1, 'general', 175000, CURRENT_DATE, 'Automated category consistency test for ' || $1, 'bank_transfer', $2, 'pending_approval'
          ) RETURNING id, expense_category, expense_type, voucher_number, approval_status;
        `, [cat, bankId]);

        const expId = insRes.rows[0].id;
        assert.equal(insRes.rows[0].expense_category, cat);
        assert.equal(insRes.rows[0].expense_type, 'general');

        // Edit and update description and amount
        const updRes = await client.query(`
          UPDATE public.finance_expenses
          SET amount = 180000, description = description || ' (edited)'
          WHERE id = $1
          RETURNING id, amount, description;
        `, [expId]);
        assert.equal(Number(updRes.rows[0].amount), 180000);
        assert.match(updRes.rows[0].description, /\(edited\)/);

        // Approve and verify auto-post accounting journals
        await client.query(`
          UPDATE public.finance_expenses
          SET approval_status = 'approved'
          WHERE id = $1;
        `, [expId]);

        const journalRes = await client.query(`
          SELECT jel.account_id, coa.code, coa.name, jel.debit, jel.credit
          FROM public.journal_entries je
          JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN chart_of_accounts coa ON coa.id = jel.account_id
          WHERE je.reference_id = $1
          ORDER BY jel.line_number;
        `, [expId]);

        assert.ok(journalRes.rows.length >= 2, `Approved ${cat} must create journal lines`);
        assert.equal(journalRes.rows[0].code, coaCode, `Debit line must post to ${coaCode}`);
        assert.equal(Number(journalRes.rows[0].debit), 180000, 'Debit amount must match expense amount');
        assert.equal(Number(journalRes.rows[1].credit), 180000, 'Credit amount must match expense amount');

        await client.query('ROLLBACK TO SAVEPOINT sp_cat_test;');
      }

      // 5b. Verify new expense with inactive grouping 'utilities' is blocked
      await client.query('SAVEPOINT sp_new_legacy_util;');
      try {
        await client.query(`
          INSERT INTO public.finance_expenses (
            expense_category, expense_type, amount, expense_date, description
          ) VALUES (
            'utilities', 'general', 100000, CURRENT_DATE, 'Should fail'
          );
        `);
        assert.fail('Inserting a new expense with grouping category "utilities" must be rejected');
      } catch (err) {
        assert.match(err.message, /Expense category "Utilities" is inactive/);
        await client.query('ROLLBACK TO SAVEPOINT sp_new_legacy_util;');
      }

      // 5c. Verify existing historical petty cash 'utilities' records can be edited safely
      const histPc = await client.query(`
        SELECT id, expense_category, description
        FROM public.petty_cash_transactions
        WHERE expense_category = 'utilities'
        LIMIT 1;
      `);
      if (histPc.rows.length > 0) {
        await client.query('SAVEPOINT sp_hist_pc;');
        const pcUpd = await client.query(`
          UPDATE public.petty_cash_transactions
          SET description = description || ' [regression test]'
          WHERE id = $1
          RETURNING id, expense_category, description;
        `, [histPc.rows[0].id]);
        assert.match(pcUpd.rows[0].description, /\[regression test\]/);
        await client.query('ROLLBACK TO SAVEPOINT sp_hist_pc;');
      }
    } finally {
      await client.query('ROLLBACK;');
    }
  });
});
