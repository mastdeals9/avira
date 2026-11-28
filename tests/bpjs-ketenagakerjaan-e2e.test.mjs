import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

async function withDbClient(callback) {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database test: DATABASE_URL environment variable is not set.');
    return;
  }
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function setAuthenticatedUser(client, userId) {
  await client.query('SET ROLE authenticated');
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
}

test('BPJS Ketenagakerjaan End-to-End Test Suite', async (t) => {
  let adminId;

  await withDbClient(async (client) => {
    const adminRes = await client.query(`SELECT id FROM user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1`);
    assert.ok(adminRes.rows.length > 0, 'Must have at least one active admin user');
    adminId = adminRes.rows[0].id;
  });

  await t.test('1. Static File & Frontend Architecture Verification', () => {
    const staffMasterSrc = readFileSync(
      new URL('../src/components/finance/StaffMasterManager.tsx', import.meta.url),
      'utf8'
    );
    assert.match(staffMasterSrc, /bpjs_applicable/, 'StaffMasterManager must include bpjs_applicable');
    assert.match(staffMasterSrc, /bpjs_kpj_number/, 'StaffMasterManager must include bpjs_kpj_number');
    assert.match(staffMasterSrc, /bpjs_wage_basis/, 'StaffMasterManager must include bpjs_wage_basis');
    assert.match(staffMasterSrc, /Employee 2% JHT Deduction/, 'StaffMasterManager must display prominent 2% JHT deduction');
    assert.match(staffMasterSrc, /Wage Discrepancy/, 'StaffMasterManager must flag wage discrepancy');

    const financeSrc = readFileSync(
      new URL('../src/pages/Finance.tsx', import.meta.url),
      'utf8'
    );
    assert.match(financeSrc, /bpjs_register/, 'Finance.tsx must include bpjs_register tab');
    assert.match(financeSrc, /BpjsRegisterManager/, 'Finance.tsx must lazy-load BpjsRegisterManager');

    const bpjsRegisterSrc = readFileSync(
      new URL('../src/components/finance/BpjsRegisterManager.tsx', import.meta.url),
      'utf8'
    );
    assert.match(bpjsRegisterSrc, /generate_bpjs_monthly_register/, 'BpjsRegisterManager must call generate RPC');
    assert.match(bpjsRegisterSrc, /post_bpjs_monthly_register/, 'BpjsRegisterManager must call posting RPC');
    assert.match(bpjsRegisterSrc, /reconcile_bpjs_register_payment/, 'BpjsRegisterManager must call reconciliation RPC');
    assert.match(bpjsRegisterSrc, /reverse_bpjs_monthly_register/, 'BpjsRegisterManager must call reversal RPC');
  });

  await t.test('2. Chart of Accounts Configuration', async () => {
    await withDbClient(async (client) => {
      const coaRes = await client.query(
        `SELECT code, name, account_type FROM chart_of_accounts WHERE code IN ('2134', '6115')`
      );
      const coaMap = Object.fromEntries(coaRes.rows.map(r => [r.code, r]));

      assert.ok(coaMap['2134'], 'COA 2134 (BPJS Ketenagakerjaan Payable) must exist');
      assert.equal(coaMap['2134'].account_type, 'liability', 'COA 2134 must be a liability account');

      assert.ok(coaMap['6115'], 'COA 6115 (BPJS Ketenagakerjaan Expense) must exist');
      assert.equal(coaMap['6115'].account_type, 'expense', 'COA 6115 must be an expense account');
    });
  });

  await t.test('3. Staff Master Configuration & Wage Discrepancy Flagging', async () => {
    await withDbClient(async (client) => {
      const staffRes = await client.query(`
        SELECT employee_code, full_name, monthly_salary, bpjs_applicable, bpjs_kpj_number, bpjs_wage_basis
          FROM finance_staff_master
         WHERE employee_code IN ('APF-001', 'APF-002')
         ORDER BY employee_code
      `);

      assert.equal(staffRes.rows.length, 2, 'Both Nia and Chintia must be present');
      const [nia, chintia] = staffRes.rows;

      // Nia
      assert.equal(nia.employee_code, 'APF-001');
      assert.equal(nia.full_name, 'Nia Delisma Nasution');
      assert.equal(Number(nia.bpjs_wage_basis), 8500000, 'Nia BPJS wage basis is Rp 8,500,000');
      assert.equal(nia.bpjs_applicable, true, 'Nia must have BPJS applicable');
      assert.equal(nia.bpjs_kpj_number, '26010001');

      // Chintia
      assert.equal(chintia.employee_code, 'APF-002');
      assert.equal(chintia.full_name, 'Chintia Benazir Widjaya');
      assert.equal(Number(chintia.monthly_salary), 3800000, 'Chintia monthly salary is Rp 3,800,000');
      assert.equal(Number(chintia.bpjs_wage_basis), 3800000, 'Chintia BPJS wage basis matches salary');
      assert.equal(chintia.bpjs_applicable, true, 'Chintia must have BPJS applicable');
      assert.equal(chintia.bpjs_kpj_number, '26010002');
    });
  });

  await t.test('4. Server-Side BPJS Calculation Engine (Single Source of Truth)', async () => {
    await withDbClient(async (client) => {
      await setAuthenticatedUser(client, adminId);
      // Calculate Nia
      const niaCalcRes = await client.query(`
        SELECT calculate_staff_bpjs(id) as calc
          FROM finance_staff_master
         WHERE employee_code = 'APF-001'
      `);
      const nia = niaCalcRes.rows[0].calc;
      assert.equal(nia.applicable, true);
      assert.equal(Number(nia.wage_basis), 8500000);
      assert.equal(Number(nia.employee_jht_amount), 170000, 'Nia Employee JHT 2% must be Rp 170,000');
      assert.equal(Number(nia.employer_jht_amount), 314500, 'Nia Employer JHT 3.7% must be Rp 314,500');
      assert.equal(Number(nia.employer_jkk_amount), 20400, 'Nia Employer JKK 0.24% must be Rp 20,400');
      assert.equal(Number(nia.employer_jkm_amount), 25500, 'Nia Employer JKM 0.30% must be Rp 25,500');
      assert.equal(Number(nia.total_employee_deduction), 170000);
      assert.equal(Number(nia.total_employer_expense), 360400);
      assert.equal(Number(nia.total_payable), 530400, 'Nia combined total must be Rp 530,400');

      // Calculate Chintia
      const chintiaCalcRes = await client.query(`
        SELECT calculate_staff_bpjs(id) as calc
          FROM finance_staff_master
         WHERE employee_code = 'APF-002'
      `);
      const chintia = chintiaCalcRes.rows[0].calc;
      assert.equal(chintia.applicable, true);
      assert.equal(Number(chintia.wage_basis), 3800000);
      assert.equal(chintia.is_wage_discrepant, false);
      assert.equal(Number(chintia.employee_jht_amount), 76000, 'Chintia Employee JHT 2% must be Rp 76,000');
      assert.equal(Number(chintia.employer_jht_amount), 140600, 'Chintia Employer JHT 3.7% must be Rp 140,600');
      assert.equal(Number(chintia.employer_jkk_amount), 9120, 'Chintia Employer JKK 0.24% must be Rp 9,120');
      assert.equal(Number(chintia.employer_jkm_amount), 11400, 'Chintia Employer JKM 0.30% must be Rp 11,400');
      assert.equal(Number(chintia.total_employee_deduction), 76000);
      assert.equal(Number(chintia.total_employer_expense), 161120);
      assert.equal(Number(chintia.total_payable), 237120, 'Chintia combined total must be Rp 237,120');

      // Combined Totals Check
      const combinedEmpDeductions = Number(nia.total_employee_deduction) + Number(chintia.total_employee_deduction);
      const combinedErExpenses = Number(nia.total_employer_expense) + Number(chintia.total_employer_expense);
      const combinedPayable = Number(nia.total_payable) + Number(chintia.total_payable);

      assert.equal(combinedEmpDeductions, 246000, 'Combined employee deductions must equal Rp 246,000');
      assert.equal(combinedErExpenses, 521520, 'Combined employer expenses must equal Rp 521,520');
      assert.equal(combinedPayable, 767520, 'Combined total payable must equal Rp 767,520');
    });
  });

  await t.test('5. Salary Integration: Employee JHT Deduction & Non-deduction of Employer Costs', async () => {
    await withDbClient(async (client) => {
      await setAuthenticatedUser(client, adminId);

      // Nia Salary Calculation
      const niaSalRes = await client.query(`
        SELECT calculate_staff_salary(id) as calc
          FROM finance_staff_master
         WHERE employee_code = 'APF-001'
      `);
      const nia = niaSalRes.rows[0].calc;

      assert.equal(Number(nia.bpjs_amount), 170000, 'Nia BPJS deduction must be Rp 170,000 (2% of 8.5M wage basis)');
      assert.equal(
        Number(nia.net_salary_payable),
        Number(nia.gross_salary) - Number(nia.bpjs_amount) - Number(nia.pph21_amount),
        'Net salary payable must reduce by employee deduction and PPh21 only, excluding employer costs'
      );

      // Chintia Salary Calculation
      const chintiaSalRes = await client.query(`
        SELECT calculate_staff_salary(id) as calc
          FROM finance_staff_master
         WHERE employee_code = 'APF-002'
      `);
      const chintia = chintiaSalRes.rows[0].calc;

      assert.equal(Number(chintia.gross_salary), 3800000);
      assert.equal(Number(chintia.bpjs_amount), 76000, 'Chintia BPJS deduction must be Rp 76,000 (2% of 3.8M wage basis)');
      // Net salary = 3,800,000 - 76,000 - pph21 = net_salary_payable
      assert.equal(
        Number(chintia.net_salary_payable),
        Number(chintia.gross_salary) - Number(chintia.bpjs_amount) - Number(chintia.pph21_amount),
        'Net salary payable must reduce by employee deduction and PPh21 only, excluding employer costs'
      );
    });
  });

  await t.test('6. Monthly Register Generation, Recalculation & Idempotency', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setAuthenticatedUser(client, adminId);

        // Generate Register in isolated transaction
        const genRes = await client.query(`SELECT generate_bpjs_monthly_register(2099, 12, 767520) as reg`);
        const reg = genRes.rows[0].reg;

        assert.equal(reg.period_year, 2099);
        assert.equal(reg.period_month, 12);
        assert.equal(Number(reg.total_reported_wages), 12300000);
        assert.equal(Number(reg.total_employee_deductions), 246000);
        assert.equal(Number(reg.total_employer_expenses), 521520);
        assert.equal(Number(reg.total_contribution_payable), 767520);

        // Verify items count
        const itemsCountRes = await client.query(
          `SELECT count(*) FROM bpjs_monthly_register_items WHERE register_id = $1`,
          [reg.register_id]
        );
        assert.equal(Number(itemsCountRes.rows[0].count), 2);

        // Idempotent Recalculation
        const regenRes = await client.query(`SELECT generate_bpjs_monthly_register(2099, 12, 767520) as reg`);
        assert.equal(regenRes.rows[0].reg.register_id, reg.register_id, 'Same register ID must be reused');

        const itemsCountAfterRes = await client.query(
          `SELECT count(*) FROM bpjs_monthly_register_items WHERE register_id = $1`,
          [reg.register_id]
        );
        assert.equal(Number(itemsCountAfterRes.rows[0].count), 2, 'Recalculation must NOT create duplicate items');
      } finally {
        await client.query('ROLLBACK');
      }

      // Also verify production September 2026 register read-only state
      const sepRegRes = await client.query(`
        SELECT period_year, period_month, total_reported_wages, total_employee_deductions,
               total_employer_expenses, total_contribution_payable, status, payment_status
          FROM bpjs_monthly_registers
         WHERE period_year = 2026 AND period_month = 9
      `);
      assert.ok(sepRegRes.rows.length > 0, 'Production September 2026 register must exist');
      const sepReg = sepRegRes.rows[0];
      assert.equal(Number(sepReg.total_reported_wages), 12300000);
      assert.equal(Number(sepReg.total_employee_deductions), 246000);
      assert.equal(Number(sepReg.total_employer_expenses), 521520);
      assert.equal(Number(sepReg.total_contribution_payable), 767520);
      assert.equal(sepReg.status, 'reconciled');
      assert.equal(sepReg.payment_status, 'paid');
    });
  });

  await t.test('7. Accounting Journal Posting (GL 6115 Expense & GL 2134 Payable)', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setAuthenticatedUser(client, adminId);

        const genRes = await client.query(`SELECT generate_bpjs_monthly_register(2099, 12, 767520) as reg`);
        const regId = genRes.rows[0].reg.register_id;

        const postRes = await client.query(`SELECT post_bpjs_monthly_register($1::uuid) as post`, [regId]);
        const post = postRes.rows[0].post;

        assert.ok(post.journal_entry_id);
        assert.equal(Number(post.total_posted), 521520, 'Posted amount must equal employer expense Rp 521,520');

        // Verify Journal Entry Lines
        const linesRes = await client.query(`
          SELECT jel.line_number, jel.debit, jel.credit, coa.code, coa.name
            FROM journal_entry_lines jel
            JOIN chart_of_accounts coa ON jel.account_id = coa.id
           WHERE jel.journal_entry_id = $1::uuid
           ORDER BY jel.line_number
        `, [post.journal_entry_id]);

        assert.equal(linesRes.rows.length, 2);
        // Line 1: Debit 6115 BPJS Expense Rp 521,520
        assert.equal(linesRes.rows[0].code, '6115');
        assert.equal(Number(linesRes.rows[0].debit), 521520);
        assert.equal(Number(linesRes.rows[0].credit), 0);

        // Line 2: Credit 2134 BPJS Payable Rp 521,520
        assert.equal(linesRes.rows[1].code, '2134');
        assert.equal(Number(linesRes.rows[1].debit), 0);
        assert.equal(Number(linesRes.rows[1].credit), 521520);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('8. Bank Statement Reconciliation & Settlement (NPP 26719331 Rp 767,520)', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setAuthenticatedUser(client, adminId);

        const genRes = await client.query(`SELECT generate_bpjs_monthly_register(2099, 12, 767520) as reg`);
        const regId = genRes.rows[0].reg.register_id;

        // Post register
        await client.query(`SELECT post_bpjs_monthly_register($1::uuid)`, [regId]);

        // Create temporary bank statement line for testing
        const bsl = await client.query(`
          INSERT INTO bank_statement_lines (
            upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, running_balance, currency, reconciliation_status, matching_status
          ) VALUES (
            (SELECT upload_id FROM bank_statement_lines WHERE upload_id IS NOT NULL LIMIT 1),
            (SELECT bank_account_id FROM bank_statement_lines WHERE bank_account_id IS NOT NULL LIMIT 1),
            '2099-12-01',
            'TRSF E-BANKING DB 0110/FTFVA/WS95051 89000/BPJS TK - - 426719331000',
            767520,
            0,
            1000000,
            'IDR',
            'unmatched',
            'none'
          ) RETURNING id
        `);
        const bankLineId = bsl.rows[0].id;

        // Reconcile with Bank Statement Line
        const recRes = await client.query(
          `SELECT reconcile_bpjs_register_payment($1::uuid, $2::uuid, $3) as rec`,
          [regId, bankLineId, 'TRSF E-BANKING DB 0110/FTFVA/WS95051 89000/BPJS TK - - 426719331000']
        );
        const rec = recRes.rows[0].rec;

        assert.equal(Number(rec.actual_paid_amount), 767520);
        assert.equal(Number(rec.difference), 0, 'Variance must be exactly zero');
        assert.equal(rec.reconciliation_status, 'reconciled');

        // Verify Payment Journal: Debit 2134 BPJS Payable Rp 767,520, Credit 111101 Bank BCA Rp 767,520
        const payLinesRes = await client.query(`
          SELECT jel.line_number, jel.debit, jel.credit, coa.code, coa.name
            FROM journal_entry_lines jel
            JOIN chart_of_accounts coa ON jel.account_id = coa.id
           WHERE jel.journal_entry_id = $1::uuid
           ORDER BY jel.line_number
        `, [rec.payment_journal_entry_id]);

        assert.equal(payLinesRes.rows.length, 2);
        assert.equal(payLinesRes.rows[0].code, '2134');
        assert.equal(Number(payLinesRes.rows[0].debit), 767520);

        assert.equal(payLinesRes.rows[1].code, '111101');
        assert.equal(Number(payLinesRes.rows[1].credit), 767520);

        // Verify Bank Statement Line Status
        const bslRes = await client.query(`
          SELECT matched_entry_id, reconciliation_status, matching_status
            FROM bank_statement_lines
           WHERE id = $1::uuid
        `, [bankLineId]);

        assert.equal(bslRes.rows[0].matched_entry_id, rec.payment_journal_entry_id);
        assert.equal(bslRes.rows[0].reconciliation_status, 'matched');
        assert.equal(bslRes.rows[0].matching_status, 'confirmed');

        // Verify Controlled Reversal
        const revRes = await client.query(`SELECT reverse_bpjs_monthly_register($1::uuid, 'Test Reversal') as rev`, [regId]);
        assert.equal(revRes.rows[0].rev.success, true);

        // Verify Bank Line is cleanly unlinked
        const bslAfterRes = await client.query(`
          SELECT matched_entry_id, reconciliation_status, matching_status
            FROM bank_statement_lines
           WHERE id = $1::uuid
        `, [bankLineId]);

        assert.equal(bslAfterRes.rows[0].matched_entry_id, null);
        assert.equal(bslAfterRes.rows[0].reconciliation_status, 'unmatched');
        assert.equal(bslAfterRes.rows[0].matching_status, 'none');
      } finally {
        await client.query('ROLLBACK');
      }

      // In addition, verify live September 2026 settled payment journal and bank line read-only state
      const liveBankLineId = '3c399d54-8f0b-4e24-985c-e76d86cc1b32';
      const liveBsl = await client.query(`
        SELECT matched_entry_id, reconciliation_status, matching_status
          FROM bank_statement_lines
         WHERE id = $1::uuid
      `, [liveBankLineId]);
      assert.equal(liveBsl.rows[0].reconciliation_status, 'matched');
      assert.equal(liveBsl.rows[0].matching_status, 'confirmed');
      assert.equal(liveBsl.rows[0].matched_entry_id, 'b7c563eb-257a-4182-b8ad-6e2241bf5967');

      const livePayLines = await client.query(`
        SELECT jel.line_number, jel.debit, jel.credit, coa.code
          FROM journal_entry_lines jel
          JOIN chart_of_accounts coa ON jel.account_id = coa.id
         WHERE jel.journal_entry_id = 'b7c563eb-257a-4182-b8ad-6e2241bf5967'::uuid
         ORDER BY jel.line_number
      `);
      assert.equal(livePayLines.rows.length, 2);
      assert.equal(livePayLines.rows[0].code, '2134');
      assert.equal(Number(livePayLines.rows[0].debit), 767520);
      assert.equal(livePayLines.rows[1].code, '111101');
      assert.equal(Number(livePayLines.rows[1].credit), 767520);
    });
  });
});
