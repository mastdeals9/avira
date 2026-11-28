import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL || (process.env.READONLY_AUDIT_DB_URL || '');

async function withDbClient(callback) {
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

test('BPJS Final Database & Payroll Reconciliation Suite', async (t) => {

  await t.test('1. Static Trigger and Frontend Code Verification', async () => {
    await withDbClient(async (client) => {
      // Verify live trigger definition includes bpjs_employee_deduction
      const trigRes = await client.query(`
        SELECT pg_get_triggerdef(oid, true) as def
        FROM pg_trigger
        WHERE tgname = 'trigger_auto_post_expense_accounting_update'
      `);
      assert.ok(trigRes.rows.length > 0, 'Trigger must exist');
      assert.match(
        trigRes.rows[0].def,
        /bpjs_employee_deduction/,
        'trigger_auto_post_expense_accounting_update must include bpjs_employee_deduction in WHEN condition'
      );
    });

    const bpjsRegisterSrc = readFileSync(
      new URL('../src/components/finance/BpjsRegisterManager.tsx', import.meta.url),
      'utf8'
    );
    assert.match(bpjsRegisterSrc, /reopen_bpjs_monthly_register/, 'BpjsRegisterManager must support reopen_bpjs_monthly_register');
    assert.match(bpjsRegisterSrc, /Reopen Draft/, 'BpjsRegisterManager must render Reopen Draft action');
    assert.match(bpjsRegisterSrc, /register\.status === 'posted' && register\.journal_entry_id/, 'Payment link requires posted status with journal');
  });

  await t.test('2. New Salary Creation with BPJS Deduction creates 2134 BPJS Payable line', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
      try {
        const staffRes = await client.query(`
          SELECT id FROM public.finance_staff_master WHERE status = 'active' LIMIT 1
        `);
        const staffId = staffRes.rows[0].id;

        // Insert new approved salary expense
        const expRes = await client.query(`
          INSERT INTO public.finance_expenses (
            voucher_number, expense_date, expense_category, amount,
            bpjs_employee_deduction, payment_method, approval_status,
            staff_id, description, currency_code, transaction_currency, functional_currency, exchange_rate
          ) VALUES (
            'EXP/TEST/BPJS01', '2026-11-20', 'salary', 5000000.00,
            100000.00, 'bank_transfer', 'approved',
            $1, 'Test Salary with BPJS', 'IDR', 'IDR', 'IDR', 1.0
          ) RETURNING id
        `, [staffId]);
        const expId = expRes.rows[0].id;

        // Verify journal entry generated
        const jeRes = await client.query(`
          SELECT je.id, je.total_debit, je.total_credit,
                 jel.line_number, coa.code, jel.debit, jel.credit
          FROM public.journal_entries je
          JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
          WHERE je.reference_id = $1
          ORDER BY jel.line_number
        `, [expId]);

        assert.ok(jeRes.rows.length >= 2, 'Journal entry lines must be created');
        const bpjsLine = jeRes.rows.find(l => l.code === '2134');
        assert.ok(bpjsLine, 'Must contain credit to 2134 BPJS Payable');
        assert.equal(Number(bpjsLine.credit), 100000.00, 'Credit to 2134 must equal BPJS deduction Rp 100,000');

        const apLine = jeRes.rows.find(l => l.code === '2110');
        assert.ok(apLine, 'Must contain credit to 2110 Accounts Payable');
        assert.equal(Number(apLine.credit), 4900000.00, 'Credit to 2110 must be net payable (5M - 100k = 4.9M)');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('3. Updating BPJS Deduction on Approved Salary regenerates Journal without duplicate lines', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
      try {
        const staffRes = await client.query(`
          SELECT id FROM public.finance_staff_master WHERE status = 'active' LIMIT 1
        `);
        const staffId = staffRes.rows[0].id;

        // Create salary with 0 BPJS deduction
        const expRes = await client.query(`
          INSERT INTO public.finance_expenses (
            voucher_number, expense_date, expense_category, amount,
            bpjs_employee_deduction, payment_method, approval_status,
            staff_id, description, currency_code, transaction_currency, functional_currency, exchange_rate
          ) VALUES (
            'EXP/TEST/BPJS02', '2026-11-20', 'salary', 6000000.00,
            0.00, 'bank_transfer', 'approved',
            $1, 'Test Salary Update BPJS', 'IDR', 'IDR', 'IDR', 1.0
          ) RETURNING id
        `, [staffId]);
        const expId = expRes.rows[0].id;

        // 1. Initial state: no 2134 line
        let jeRes = await client.query(`
          SELECT jel.line_number, coa.code, jel.debit, jel.credit
          FROM public.journal_entries je
          JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
          WHERE je.reference_id = $1
          ORDER BY jel.line_number
        `, [expId]);
        assert.equal(jeRes.rows.some(l => l.code === '2134'), false, 'Initial journal must not have 2134');

        // 2. Update BPJS from 0 to 120,000 -> trigger must fire!
        await client.query(`
          UPDATE public.finance_expenses
             SET bpjs_employee_deduction = 120000.00
           WHERE id = $1
        `, [expId]);

        jeRes = await client.query(`
          SELECT jel.line_number, coa.code, jel.debit, jel.credit
          FROM public.journal_entries je
          JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
          WHERE je.reference_id = $1
          ORDER BY jel.line_number
        `, [expId]);

        let bpjsLines = jeRes.rows.filter(l => l.code === '2134');
        assert.equal(bpjsLines.length, 1, 'Exactly one line for 2134 BPJS Payable');
        assert.equal(Number(bpjsLines[0].credit), 120000.00, 'Credit must be 120,000');

        // 3. Update BPJS again from 120,000 to 180,000 -> updates in place, NO duplicates!
        await client.query(`
          UPDATE public.finance_expenses
             SET bpjs_employee_deduction = 180000.00
           WHERE id = $1
        `, [expId]);

        jeRes = await client.query(`
          SELECT jel.line_number, coa.code, jel.debit, jel.credit
          FROM public.journal_entries je
          JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
          JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
          WHERE je.reference_id = $1
          ORDER BY jel.line_number
        `, [expId]);

        bpjsLines = jeRes.rows.filter(l => l.code === '2134');
        assert.equal(bpjsLines.length, 1, 'Must STILL have exactly one line for 2134 (no duplicate lines!)');
        assert.equal(Number(bpjsLines[0].credit), 180000.00, 'Credit must now be updated to 180,000');

        const apLine = jeRes.rows.find(l => l.code === '2110');
        assert.equal(Number(apLine.credit), 5820000.00, 'AP must be 6,000,000 - 180,000 = 5,820,000');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('4. Approved BPJS Register Protection and Explicit Reopen Workflow', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
      try {
        // Generate draft register for future month 2027-01
        await client.query(`
          SELECT public.generate_bpjs_monthly_register(2027, 1, NULL)
        `);

        const regRes = await client.query(`
          SELECT id, status FROM public.bpjs_monthly_registers WHERE period_year = 2027 AND period_month = 1
        `);
        assert.equal(regRes.rows[0].status, 'draft');
        const regId = regRes.rows[0].id;

        // Approve register
        await client.query(`
          UPDATE public.bpjs_monthly_registers SET status = 'approved', approved_at = now() WHERE id = $1
        `, [regId]);

        // Attempting to recalculate an approved register must fail!
        await client.query('SAVEPOINT sp_recalc');
        try {
          await assert.rejects(
            async () => {
              await client.query(`
                SELECT public.generate_bpjs_monthly_register(2027, 1, NULL)
              `);
            },
            /only draft registers can be recalculated/i,
            'Recalculating an approved register must be rejected'
          );
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT sp_recalc');
        }

        // Reopen to draft
        const reopenRes = await client.query(`
          SELECT public.reopen_bpjs_monthly_register($1, 'Test revision') as result
        `, [regId]);
        assert.equal(reopenRes.rows[0].result.status, 'draft');

        // Now recalculate succeeds!
        const regenRes = await client.query(`
          SELECT public.generate_bpjs_monthly_register(2027, 1, NULL) as result
        `);
        assert.ok(regenRes.rows[0].result.register_id);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('5. Accrual-Before-Payment Enforcement in reconcile_bpjs_register_payment', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
      try {
        // Create a test draft register
        const genRes = await client.query(`
          SELECT public.generate_bpjs_monthly_register(2027, 2, NULL) as result
        `);
        const regId = genRes.rows[0].result.register_id;

        // Get any valid bank statement line
        const bslRes = await client.query(`
          SELECT id FROM public.bank_statement_lines LIMIT 1
        `);
        const bslId = bslRes.rows[0].id;

        // 1. Attempt reconciliation on draft -> Must fail!
        await client.query('SAVEPOINT sp_recon1');
        try {
          await assert.rejects(
            async () => {
              await client.query(`
                SELECT public.reconcile_bpjs_register_payment($1, $2, 'Test')
              `, [regId, bslId]);
            },
            /must be approved and posted to the general ledger/i,
            'Reconciliation on draft must fail'
          );
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT sp_recon1');
        }

        // 2. Approve register without posting -> Must fail!
        await client.query(`
          UPDATE public.bpjs_monthly_registers SET status = 'approved' WHERE id = $1
        `, [regId]);

        await client.query('SAVEPOINT sp_recon2');
        try {
          await assert.rejects(
            async () => {
              await client.query(`
                SELECT public.reconcile_bpjs_register_payment($1, $2, 'Test')
              `, [regId, bslId]);
            },
            /accrual journal has not been posted yet/i,
            'Reconciliation on approved without accrual posting must fail'
          );
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT sp_recon2');
        }
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('6. Production October 2026 BPJS Data Invariance', async () => {
    await withDbClient(async (client) => {
      const regRes = await client.query(`
        SELECT * FROM public.bpjs_monthly_registers WHERE period_year = 2026 AND period_month = 10
      `);
      assert.equal(regRes.rows.length, 1);
      const reg = regRes.rows[0];
      assert.equal(Number(reg.total_reported_wages), 12300000);
      assert.equal(Number(reg.total_employee_deductions), 246000);
      assert.equal(Number(reg.total_employer_expenses), 521520);
      assert.equal(Number(reg.total_contribution_payable), 767520);

      const expRes = await client.query(`
        SELECT voucher_number, amount, paid_amount, bpjs_employee_deduction
        FROM public.finance_expenses
        WHERE voucher_number IN ('EXP/26/363', 'EXP/26/366')
        ORDER BY voucher_number
      `);
      assert.equal(expRes.rows.length, 2);
      const [nia, chintia] = expRes.rows;
      assert.equal(Number(nia.amount), 8500000);
      assert.equal(Number(nia.bpjs_employee_deduction), 170000);
      assert.equal(Number(nia.paid_amount), 8330000);

      assert.equal(Number(chintia.amount), 3800000);
      assert.equal(Number(chintia.bpjs_employee_deduction), 76000);
      assert.equal(Number(chintia.paid_amount), 3724000);
    });
  });

  await t.test('7. September 2026 Bank Line & Payment Journal Invariance', async () => {
    await withDbClient(async (client) => {
      const bslRes = await client.query(`
        SELECT debit_amount, matched_entry_id, reconciliation_status
        FROM public.bank_statement_lines
        WHERE id = '3c399d54-8f0b-4e24-985c-e76d86cc1b32'
      `);
      assert.equal(bslRes.rows.length, 1);
      assert.equal(Number(bslRes.rows[0].debit_amount), 767520);
      assert.equal(bslRes.rows[0].matched_entry_id, 'b7c563eb-257a-4182-b8ad-6e2241bf5967');
      assert.equal(bslRes.rows[0].reconciliation_status, 'matched');

      const jeRes = await client.query(`
        SELECT entry_number, total_debit, total_credit, is_posted
        FROM public.journal_entries
        WHERE id = 'b7c563eb-257a-4182-b8ad-6e2241bf5967'
      `);
      assert.equal(jeRes.rows[0].entry_number, 'JE2610-0181');
      assert.equal(Number(jeRes.rows[0].total_debit), 767520);
      assert.equal(jeRes.rows[0].is_posted, true);
    });
  });

  await t.test('8. September 2026 BPJS Adjusting Journal & Register Linkage Closure', async () => {
    await withDbClient(async (client) => {
      // 1. Adjustment journal
      const adjRes = await client.query(`
        SELECT id, entry_number, entry_date, total_debit, total_credit, is_posted, reference_number
        FROM public.journal_entries
        WHERE reference_number = 'BPJS-2026-09-ADJ'
      `);
      assert.equal(adjRes.rows.length, 1, 'Exactly one adjusting journal must exist');
      const adj = adjRes.rows[0];
      assert.equal(Number(adj.total_debit), 767520.00);
      assert.equal(Number(adj.total_credit), 767520.00);
      assert.equal(adj.is_posted, true);

      // 2. Lines breakdown
      const linesRes = await client.query(`
        SELECT jel.line_number, coa.code, jel.debit, jel.credit
        FROM public.journal_entry_lines jel
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE jel.journal_entry_id = $1
        ORDER BY jel.line_number
      `, [adj.id]);
      assert.equal(linesRes.rows.length, 3);
      assert.equal(linesRes.rows[0].code, '6115');
      assert.equal(Number(linesRes.rows[0].debit), 521520.00);
      assert.equal(linesRes.rows[1].code, '6110');
      assert.equal(Number(linesRes.rows[1].debit), 246000.00);
      assert.equal(linesRes.rows[2].code, '2134');
      assert.equal(Number(linesRes.rows[2].credit), 767520.00);

      // 3. September register linkage
      const regRes = await client.query(`
        SELECT id, status, payment_status, journal_entry_id, payment_journal_entry_id, bank_statement_line_id
        FROM public.bpjs_monthly_registers
        WHERE period_year = 2026 AND period_month = 9
      `);
      const reg = regRes.rows[0];
      assert.equal(reg.journal_entry_id, adj.id, 'September register must link to adjusting journal');
      assert.equal(reg.payment_journal_entry_id, 'b7c563eb-257a-4182-b8ad-6e2241bf5967', 'Payment journal untouched');
      assert.equal(reg.status, 'reconciled');
      assert.equal(reg.payment_status, 'paid');
    });
  });

});
