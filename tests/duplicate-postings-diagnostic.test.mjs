import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString =
  process.env.SUPABASE_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

function getDbClient() {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}

test('Duplicate Postings Diagnostic View (Revised) — Rollback-Only Production, Role RLS & Fixture Verification', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  const migrationSql = readFileSync(
    new URL('../supabase/migrations/20261127193000_fix_duplicate_postings_diagnostic_view.sql', import.meta.url),
    'utf8'
  );

  await t.test('1. Live production data produces 0 false positives and preserves all accounting balances', async () => {
    const beforeBal = await db.query(`
      SELECT COUNT(*)::int AS active_jes,
             COALESCE(SUM(jel.debit), 0) AS total_debit,
             COALESCE(SUM(jel.credit), 0) AS total_credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false AND COALESCE(je.is_cancelled, false) = false
    `);

    await db.query('BEGIN');
    await db.query(migrationSql);
    const { rows: flagged } = await db.query('SELECT * FROM public.duplicate_postings');
    const afterBal = await db.query(`
      SELECT COUNT(*)::int AS active_jes,
             COALESCE(SUM(jel.debit), 0) AS total_debit,
             COALESCE(SUM(jel.credit), 0) AS total_credit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false AND COALESCE(je.is_cancelled, false) = false
    `);
    await db.query('ROLLBACK');

    assert.equal(flagged.length, 0, `Expected 0 false positives on live production, found ${flagged.length}`);
    assert.deepEqual(afterBal.rows[0], beforeBal.rows[0]);

    // Verify SAPJ-26-038 sequence (JE2611-0100, JE2611-0110, JE2611-0150, JE2611-0210, JE2611-0240, JE2611-0270) exists and is not flagged
    const { rows: sapj38 } = await db.query(
      `SELECT entry_number FROM public.journal_entries
       WHERE entry_number IN ('JE2611-0100', 'JE2611-0110', 'JE2611-0150', 'JE2611-0210', 'JE2611-0240', 'JE2611-0270')
       ORDER BY entry_number`
    );
    assert.equal(sapj38.length, 6, 'All 6 SAPJ-26-038 sequence entries must exist');
  });

  await t.test('2. security_invoker=true works under admin, accounts, and auditor_ca roles', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);
    for (const role of ['admin', 'accounts', 'auditor_ca']) {
      const { rows: users } = await db.query(
        `SELECT id FROM public.user_profiles WHERE role = $1 AND COALESCE(is_active, true) = true LIMIT 1`,
        [role]
      );
      if (users.length === 0) continue;
      await db.query('SAVEPOINT role_check');
      await db.query('SET LOCAL ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [users[0].id]);
      await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");
      const { rows } = await db.query('SELECT COUNT(*)::int AS cnt FROM public.duplicate_postings');
      await db.query('ROLLBACK TO SAVEPOINT role_check');
      assert.equal(rows[0].cnt, 0, `Role ${role} must be able to query duplicate_postings with security_invoker=true`);
    }
    await db.query('ROLLBACK');
  });

  await t.test('3. Controlled rollback-only fixtures validate all required duplicate, provenance, item-id, reversal, and unlinked opposite-direction scenarios', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows: accts } = await db.query(
      `SELECT id FROM public.chart_of_accounts WHERE code IN ('5100', '1130') ORDER BY code`
    );
    const [acct1130, acct5100] = [accts[0].id, accts[1].id];
    const { rows: batches } = await db.query(`SELECT id FROM public.batches ORDER BY created_at LIMIT 2`);
    const [batchA, batchB] = [batches[0].id, batches[1].id];
    const { rows: custs } = await db.query(`SELECT id FROM public.customers ORDER BY created_at LIMIT 1`);
    const custA = custs[0].id;
    const { rows: siItems } = await db.query(`SELECT id FROM public.sales_invoice_items ORDER BY created_at LIMIT 2`);
    const [siItemA, siItemB] = [siItems[0].id, siItems[1].id];
    const { rows: baRows } = await db.query(
      `SELECT bsl.bank_account_id AS id, bsl.upload_id, ba.currency, ba.coa_id
       FROM public.bank_statement_lines bsl
       JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
       WHERE ba.is_active = true AND ba.coa_id IS NOT NULL AND ba.currency = 'IDR'
       LIMIT 1`
    );
    const ba = baRows[0];

    const insertJe = async ({
      entryNumber,
      sourceModule,
      refId,
      refNumber,
      date = '2026-11-27',
      isReversed = false,
      isCancelled = false,
      reversedById = null,
      replacementJournalId = null,
      cancellationGroupId = null,
      lines,
    }) => {
      const jeId = randomUUID();
      const total = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
      await db.query(
        `INSERT INTO public.journal_entries (id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, is_cancelled, reversed_by_id, replacement_journal_id, cancellation_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, true, $9, $10, $11, $12, $13)`,
        [jeId, entryNumber, date, sourceModule, refId, refNumber, `Test ${entryNumber}`, total, isReversed, isCancelled, reversedById, replacementJournalId, cancellationGroupId]
      );
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await db.query(
          `INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, batch_id, sales_invoice_item_id, debit, credit)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [jeId, i + 1, l.accountId, l.batchId || null, l.salesInvoiceItemId || null, l.debit || 0, l.credit || 0]
        );
      }
      return jeId;
    };

    // A. Genuine duplicate posting -> FLAGGED
    const dupRef = randomUUID();
    await insertJe({
      entryNumber: 'TST-DUP-1', sourceModule: 'sales_invoice', refId: dupRef, refNumber: 'SI-DUP-1',
      lines: [{ accountId: acct5100, debit: 1000, credit: 0 }, { accountId: acct1130, debit: 0, credit: 1000 }],
    });
    await insertJe({
      entryNumber: 'TST-DUP-2', sourceModule: 'sales_invoice', refId: dupRef, refNumber: 'SI-DUP-2',
      lines: [{ accountId: acct5100, debit: 1000, credit: 0 }, { accountId: acct1130, debit: 0, credit: 1000 }],
    });

    // B. Valid reversal and replacement sequence (with reversed_by_id & replacement_journal_id) -> NOT FLAGGED
    const revRef = randomUUID();
    const cancelGrp = randomUUID();
    const origId = await insertJe({
      entryNumber: 'TST-REV-ORIG', sourceModule: 'sales_invoice', refId: revRef, refNumber: 'SI-REV-1',
      isReversed: true, cancellationGroupId: cancelGrp,
      lines: [{ accountId: acct5100, debit: 1500, credit: 0 }, { accountId: acct1130, debit: 0, credit: 1500 }],
    });
    const revId = await insertJe({
      entryNumber: 'TST-REV-REVERSAL', sourceModule: 'sales_invoice', refId: revRef, refNumber: 'SI-REV-2',
      isReversed: true, cancellationGroupId: cancelGrp,
      lines: [{ accountId: acct1130, debit: 1500, credit: 0 }, { accountId: acct5100, debit: 0, credit: 1500 }],
    });
    const replId = await insertJe({
      entryNumber: 'TST-REV-REPL', sourceModule: 'sales_invoice', refId: revRef, refNumber: 'SI-REV-3',
      cancellationGroupId: cancelGrp,
      lines: [{ accountId: acct5100, debit: 1500, credit: 0 }, { accountId: acct1130, debit: 0, credit: 1500 }],
    });
    await db.query(`UPDATE public.journal_entries SET reversed_by_id = $1, replacement_journal_id = $2 WHERE id = $3`, [revId, replId, origId]);

    // C. COGS-specific duplicate: two identical same-direction postings + one unrelated, unlinked opposite-direction posting -> TST-COGS-DUP-1 & TST-COGS-DUP-2 FLAGGED
    const cogsDupRef = randomUUID();
    await insertJe({
      entryNumber: 'TST-COGS-DUP-1', sourceModule: 'sales_invoice_cogs_adjustment', refId: cogsDupRef, refNumber: 'COGS-MANUAL-1',
      lines: [{ accountId: acct5100, batchId: batchA, debit: 900, credit: 0 }, { accountId: acct1130, batchId: batchA, debit: 0, credit: 900 }],
    });
    await insertJe({
      entryNumber: 'TST-COGS-DUP-2', sourceModule: 'sales_invoice_cogs_adjustment', refId: cogsDupRef, refNumber: 'COGS-MANUAL-2',
      lines: [{ accountId: acct5100, batchId: batchA, debit: 900, credit: 0 }, { accountId: acct1130, batchId: batchA, debit: 0, credit: 900 }],
    });
    await insertJe({
      entryNumber: 'TST-COGS-UNLINKED-OPP', sourceModule: 'sales_invoice_cogs_adjustment', refId: cogsDupRef, refNumber: 'COGS-MANUAL-OPP',
      lines: [{ accountId: acct1130, batchId: batchA, debit: 900, credit: 0 }, { accountId: acct5100, batchId: batchA, debit: 0, credit: 900 }],
    });

    // C2. Properly identified FIFO-ADJ correction/reposting chain -> NOT FLAGGED
    const fifoChainRef = randomUUID();
    await db.query(
      `INSERT INTO public.journal_entries (id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, is_cancelled)
       VALUES
         ($1, 'TST-FIFO-SEQ-1', '2026-11-27', 'sales_invoice_cogs_adjustment', $4, 'SAPJ-TEST-FIFO-ADJ-2', 'FIFO COGS True-Up: SAPJ-TEST (Batch A)', 1200, 1200, true, false, false),
         ($2, 'TST-FIFO-SEQ-2', '2026-11-27', 'sales_invoice_cogs_adjustment', $4, 'SAPJ-TEST-FIFO-ADJ-3', 'FIFO COGS True-Up: SAPJ-TEST (Batch A)', 1200, 1200, true, false, false),
         ($3, 'TST-FIFO-SEQ-3', '2026-11-27', 'sales_invoice_cogs_adjustment', $4, 'SAPJ-TEST-FIFO-ADJ-4', 'FIFO COGS True-Up: SAPJ-TEST (Batch A)', 1200, 1200, true, false, false)`,
      [randomUUID(), randomUUID(), randomUUID(), fifoChainRef]
    );
    const { rows: fifoSeqJes } = await db.query(
      `SELECT id, entry_number FROM public.journal_entries WHERE reference_id = $1 ORDER BY entry_number`,
      [fifoChainRef]
    );
    await db.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, batch_id, customer_id, debit, credit) VALUES
       ($1, 1, $4, $6, $7, 1200, 0), ($1, 2, $5, $6, $7, 0, 1200),
       ($2, 1, $5, $6, $7, 1200, 0), ($2, 2, $4, $6, $7, 0, 1200),
       ($3, 1, $4, $6, $7, 1200, 0), ($3, 2, $5, $6, $7, 0, 1200)`,
      [fifoSeqJes[0].id, fifoSeqJes[1].id, fifoSeqJes[2].id, acct5100, acct1130, batchA, custA]
    );

    // D. Two legitimate SAME-DATE, SAME-AMOUNT instalments on one expense with distinct bank_statement_allocations provenance -> NOT FLAGGED
    const sameDayExpRef = randomUUID();
    const inst1Id = await insertJe({
      entryNumber: 'TST-INST-SAME-1', sourceModule: 'expense_payment', refId: sameDayExpRef, refNumber: 'EXP-PAY-SAME-1', date: '2026-11-27',
      lines: [{ accountId: acct5100, debit: 2500, credit: 0 }, { accountId: ba.coa_id, debit: 0, credit: 2500 }],
    });
    const inst2Id = await insertJe({
      entryNumber: 'TST-INST-SAME-2', sourceModule: 'expense_payment', refId: sameDayExpRef, refNumber: 'EXP-PAY-SAME-2', date: '2026-11-27',
      lines: [{ accountId: acct5100, debit: 2500, credit: 0 }, { accountId: ba.coa_id, debit: 0, credit: 2500 }],
    });
    const bsl1Id = randomUUID();
    const bsl2Id = randomUUID();
    await db.query(
      `INSERT INTO public.bank_statement_lines (id, upload_id, bank_account_id, currency, transaction_date, description, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4, '2026-11-27', 'Test Same-Day Instalment 1', 2500, 0),
              ($5, $2, $3, $4, '2026-11-27', 'Test Same-Day Instalment 2', 2500, 0)`,
      [bsl1Id, ba.upload_id, ba.id, ba.currency, bsl2Id]
    );
    await db.query(
      `INSERT INTO public.bank_statement_allocations (bank_statement_line_id, document_type, document_id, allocation_amount, journal_entry_id)
       VALUES ($1, 'expense', $2, 2500, $3), ($4, 'expense', $2, 2500, $5)`,
      [bsl1Id, sameDayExpRef, inst1Id, bsl2Id, inst2Id]
    );

    // E. Different sales_invoice_item_id values remain distinguishable -> NOT FLAGGED
    const itemRef = randomUUID();
    await insertJe({
      entryNumber: 'TST-ITEM-A', sourceModule: 'sales_invoice_cogs_adjustment', refId: itemRef, refNumber: 'ITEM-A',
      lines: [{ accountId: acct5100, batchId: batchA, salesInvoiceItemId: siItemA, debit: 500, credit: 0 }, { accountId: acct1130, batchId: batchA, salesInvoiceItemId: siItemA, debit: 0, credit: 500 }],
    });
    await insertJe({
      entryNumber: 'TST-ITEM-B', sourceModule: 'sales_invoice_cogs_adjustment', refId: itemRef, refNumber: 'ITEM-B',
      lines: [{ accountId: acct5100, batchId: batchA, salesInvoiceItemId: siItemB, debit: 500, credit: 0 }, { accountId: acct1130, batchId: batchA, salesInvoiceItemId: siItemB, debit: 0, credit: 500 }],
    });

    // F. Multiple journals for one single-document reference with different posting purposes (batch A vs batch B / different amounts) -> NOT FLAGGED
    const multiPurposeRef = randomUUID();
    await insertJe({
      entryNumber: 'TST-MP-1', sourceModule: 'sales_invoice', refId: multiPurposeRef, refNumber: 'MP-1',
      lines: [{ accountId: acct5100, batchId: batchA, debit: 1200, credit: 0 }, { accountId: acct1130, batchId: batchA, debit: 0, credit: 1200 }],
    });
    await insertJe({
      entryNumber: 'TST-MP-2', sourceModule: 'sales_invoice', refId: multiPurposeRef, refNumber: 'MP-2',
      lines: [{ accountId: acct5100, batchId: batchB, debit: 800, credit: 0 }, { accountId: acct1130, batchId: batchB, debit: 0, credit: 800 }],
    });

    const { rows: flagged } = await db.query('SELECT entry_number, duplicate_count FROM public.duplicate_postings ORDER BY entry_number');
    await db.query('ROLLBACK');

    assert.deepEqual(
      flagged.map((r) => r.entry_number),
      ['TST-COGS-DUP-1', 'TST-COGS-DUP-2', 'TST-DUP-1', 'TST-DUP-2'],
      'Only genuine duplicates (including COGS duplicate with unlinked opposite-direction posting) must be flagged'
    );
  });
});
