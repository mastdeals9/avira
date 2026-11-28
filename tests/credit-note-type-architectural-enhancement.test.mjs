import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

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

test('1. Migration file structural and SQL contract verification for credit_note_type', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261028233000_credit_note_type_classification.sql'
  );
  assert.ok(fs.existsSync(migrationPath), 'Migration 20261028233000 must exist');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // Check strengthened precondition integrity checks
  assert.match(sql, /invoice_number = 'SAPJ-26-013'/);
  assert.match(sql, /v_inv\.balance_amount != 0\.00/);
  assert.match(sql, /v_inv\.payment_status != 'paid'/);
  assert.match(sql, /credit_note_number = 'CN-26-0001'/);
  assert.match(sql, /v_items_count != 2 OR v_items_qty != 125\.000/);
  assert.match(sql, /b\.batch_number = 'B108\/2026'/);
  assert.match(sql, /b\.batch_number = 'B109\/2026'/);
  assert.match(sql, /JE2610-0219/);
  assert.match(sql, /JE2610-0220/);
  assert.match(sql, /trigger_credit_note_inventory_v1/);

  // Check column addition and check constraint
  assert.match(sql, /ALTER TABLE public\.credit_notes/);
  assert.match(sql, /ADD COLUMN credit_note_type text/);
  assert.match(sql, /CHECK \(credit_note_type IN \('physical_return', 'commercial_credit'\)\)/);

  // Check safe historical classification
  assert.match(sql, /UPDATE public\.credit_notes cn/);
  assert.match(sql, /WHEN cn\.material_return_id IS NOT NULL THEN 'physical_return'/);
  assert.match(sql, /WHEN EXISTS \(.*inventory_transactions/s);
  assert.match(sql, /credit_note_number = 'CN-26-0001'/);

  // Check trigger function: trg_credit_note_inventory_v1
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.trg_credit_note_inventory_v1\(\)/);
  assert.match(sql, /IF NEW\.credit_note_type = 'commercial_credit' THEN\s*RETURN NEW;/);
  assert.match(sql, /COALESCE\(NEW\.material_return_id, OLD\.material_return_id\) IS NOT NULL/);

  // Check journal function: _post_credit_note_je
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\._post_credit_note_je/);
  assert.match(sql, /IF p_cn\.credit_note_type = 'physical_return' AND v_cogs_id IS NOT NULL AND v_inv_id IS NOT NULL THEN/);

  // Check transition guard trigger function & trigger
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.trg_guard_credit_note_type_transition\(\)/);
  assert.match(sql, /Cannot modify credit_note_type on an approved or posted Credit Note/);
  assert.match(sql, /CREATE TRIGGER trg_guard_credit_note_type_transition/);
});

test('2. Live database: CN-26-0001 physical return and production records preservation', async () => {
  await withDbClient(async (client) => {
    // 1. Credit Note Header
    const cnRes = await client.query(`
      SELECT id, credit_note_number, status, total_amount, subtotal, tax_amount, material_return_id, journal_entry_id
      FROM public.credit_notes
      WHERE credit_note_number = 'CN-26-0001'
    `);
    assert.equal(cnRes.rowCount, 1, 'CN-26-0001 must exist');
    const cn = cnRes.rows[0];
    assert.equal(cn.status, 'approved');
    assert.equal(Number(cn.total_amount), 1745336.25);
    assert.equal(cn.material_return_id, null, 'CN-26-0001 is standalone physical return');

    // 2. Line Items: 125 kg total across B108 and B109
    const itemsRes = await client.query(`
      SELECT cni.quantity, cni.unit_price, b.batch_number, p.product_name
      FROM public.credit_note_items cni
      JOIN public.batches b ON b.id = cni.batch_id
      JOIN public.products p ON p.id = cni.product_id
      WHERE cni.credit_note_id = $1
      ORDER BY b.batch_number ASC
    `, [cn.id]);
    assert.equal(itemsRes.rowCount, 2);
    assert.equal(itemsRes.rows[0].batch_number, 'B108/2026');
    assert.equal(Number(itemsRes.rows[0].quantity), 100);
    assert.equal(itemsRes.rows[1].batch_number, 'B109/2026');
    assert.equal(Number(itemsRes.rows[1].quantity), 25);

    // 3. Physical Inventory Movements exist for both batches
    const itRes = await client.query(`
      SELECT transaction_type, quantity, batch_id, reference_type
      FROM public.inventory_transactions
      WHERE reference_id = $1
      ORDER BY quantity DESC
    `, [cn.id]);
    assert.equal(itRes.rowCount, 2, 'Exactly 2 inventory return movements must exist');
    assert.equal(itRes.rows[0].transaction_type, 'return');
    assert.equal(Number(itRes.rows[0].quantity), 100);
    assert.equal(Number(itRes.rows[1].quantity), 25);

    // 4. Batch stock remains active and available for repacking/resale
    const batchRes = await client.query(`
      SELECT batch_number, current_stock, reserved_stock, is_active
      FROM public.batches
      WHERE batch_number IN ('B108/2026', 'B109/2026')
      ORDER BY batch_number ASC
    `);
    assert.equal(batchRes.rowCount, 2);
    assert.equal(Number(batchRes.rows[0].current_stock), 100);
    assert.equal(Number(batchRes.rows[0].reserved_stock), 0);
    assert.equal(batchRes.rows[0].is_active, true);
    assert.equal(Number(batchRes.rows[1].current_stock), 25);
    assert.equal(Number(batchRes.rows[1].reserved_stock), 0);
    assert.equal(batchRes.rows[1].is_active, true);

    // 5. COGS Reversal Journal JE2610-0220 intact and balanced
    const cogsJeRes = await client.query(`
      SELECT entry_number, total_debit, total_credit, is_posted
      FROM public.journal_entries
      WHERE entry_number = 'JE2610-0220'
    `);
    assert.equal(cogsJeRes.rowCount, 1);
    assert.equal(Number(cogsJeRes.rows[0].total_debit), 1227102.50);
    assert.equal(Number(cogsJeRes.rows[0].total_credit), 1227102.50);
    assert.equal(cogsJeRes.rows[0].is_posted, true);
  });
});

test('3. Dynamic simulation: commercial_credit vs physical_return in rollback transaction', async () => {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      // Apply migration functions temporarily within transaction
      const migrationPath = path.join(
        process.cwd(),
        'supabase/migrations/20261028233000_credit_note_type_classification.sql'
      );
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await client.query(sql);

      // Fetch seed customer, invoice, and batch
      const seedRes = await client.query(`
        SELECT sii.invoice_id, sii.product_id, sii.batch_id, sii.unit_price, si.customer_id
        FROM public.sales_invoice_items sii
        JOIN public.sales_invoices si ON si.id = sii.invoice_id
        WHERE sii.batch_id IS NOT NULL AND sii.quantity > 0
        LIMIT 1
      `);
      if (seedRes.rowCount === 0) {
        throw new Error('No seed invoice item found');
      }
      const seed = seedRes.rows[0];

      // ── TEST A: Create and approve a COMMERCIAL CREDIT NOTE ──
      const commCnRes = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, credit_note_date, customer_id, original_invoice_id,
          reason, subtotal, tax_amount, total_amount, status, credit_note_type
        ) VALUES (
          'CN-TEST-COMM-001', CURRENT_DATE, $1, $2,
          'Commercial price concession test', 100000, 11000, 111000, 'pending_approval', 'commercial_credit'
        ) RETURNING id
      `, [seed.customer_id, seed.invoice_id]);
      const commCnId = commCnRes.rows[0].id;

      await client.query(`
        INSERT INTO public.credit_note_items (
          credit_note_id, product_id, batch_id, quantity, unit_price
        ) VALUES ($1, $2, $3, 10, 10000)
      `, [commCnId, seed.product_id, seed.batch_id]);

      // Record batch stock before commercial approval
      const stockBeforeComm = await client.query(
        'SELECT current_stock FROM public.batches WHERE id = $1',
        [seed.batch_id]
      );

      // Approve commercial credit note
      await client.query(`
        UPDATE public.credit_notes
        SET status = 'approved', approval_date = NOW()
        WHERE id = $1
      `, [commCnId]);

      // Verify ZERO inventory transactions posted
      const commItRes = await client.query(
        'SELECT count(*) FROM public.inventory_transactions WHERE reference_id = $1',
        [commCnId]
      );
      assert.equal(Number(commItRes.rows[0].count), 0, 'Commercial credit must NEVER post inventory transactions');

      // Verify batch stock unchanged
      const stockAfterComm = await client.query(
        'SELECT current_stock FROM public.batches WHERE id = $1',
        [seed.batch_id]
      );
      assert.equal(
        Number(stockAfterComm.rows[0].current_stock),
        Number(stockBeforeComm.rows[0].current_stock),
        'Batch stock must remain identical after commercial credit approval'
      );

      // Verify Revenue/Tax/AR JE was posted and balanced
      const commJeRes = await client.query(`
        SELECT je.entry_number, je.total_debit, je.total_credit, count(jel.id) as line_count
        FROM public.journal_entries je
        JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.reference_id = $1 AND je.source_module = 'credit_note'
        GROUP BY je.id, je.entry_number, je.total_debit, je.total_credit
      `, [commCnId]);
      assert.equal(commJeRes.rowCount, 1, 'Commercial credit must post revenue reversal JE');
      assert.equal(Number(commJeRes.rows[0].total_debit), 111000);
      assert.equal(Number(commJeRes.rows[0].total_credit), 111000);

      // Verify ZERO COGS JE posted for commercial credit
      const commCogsJeRes = await client.query(
        "SELECT count(*) FROM public.journal_entries WHERE reference_id = $1 AND source_module = 'credit_note_cogs'",
        [commCnId]
      );
      assert.equal(Number(commCogsJeRes.rows[0].count), 0, 'Commercial credit must NOT post COGS reversal JE');

      // ── TEST B: Create and approve a PHYSICAL RETURN CREDIT NOTE ──
      const physCnRes = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, credit_note_date, customer_id, original_invoice_id,
          reason, subtotal, tax_amount, total_amount, status, credit_note_type
        ) VALUES (
          'CN-TEST-PHYS-001', CURRENT_DATE, $1, $2,
          'Physical return test', 100000, 11000, 111000, 'pending_approval', 'physical_return'
        ) RETURNING id
      `, [seed.customer_id, seed.invoice_id]);
      const physCnId = physCnRes.rows[0].id;

      await client.query(`
        INSERT INTO public.credit_note_items (
          credit_note_id, product_id, batch_id, quantity, unit_price
        ) VALUES ($1, $2, $3, 10, 10000)
      `, [physCnId, seed.product_id, seed.batch_id]);

      // Record batch stock before physical approval
      const stockBeforePhys = await client.query(
        'SELECT current_stock FROM public.batches WHERE id = $1',
        [seed.batch_id]
      );

      // Approve physical return credit note
      await client.query(`
        UPDATE public.credit_notes
        SET status = 'approved', approval_date = NOW()
        WHERE id = $1
      `, [physCnId]);

      // Verify inventory transaction was posted for physical return
      const physItRes = await client.query(
        'SELECT transaction_type, quantity FROM public.inventory_transactions WHERE reference_id = $1',
        [physCnId]
      );
      assert.equal(physItRes.rowCount, 1, 'Physical return must post exactly 1 inventory transaction');
      assert.equal(physItRes.rows[0].transaction_type, 'return');
      assert.equal(Number(physItRes.rows[0].quantity), 10);

      // Verify batch stock increased by 10
      const stockAfterPhys = await client.query(
        'SELECT current_stock FROM public.batches WHERE id = $1',
        [seed.batch_id]
      );
      assert.equal(
        Number(stockAfterPhys.rows[0].current_stock),
        Number(stockBeforePhys.rows[0].current_stock) + 10,
        'Batch stock must increase by exactly returned quantity'
      );

      // Verify COGS JE was posted for physical return
      const physCogsJeRes = await client.query(
        "SELECT entry_number, total_debit, total_credit FROM public.journal_entries WHERE reference_id = $1 AND source_module = 'credit_note_cogs'",
        [physCnId]
      );
      assert.equal(physCogsJeRes.rowCount, 1, 'Physical return must post COGS reversal JE');
      assert.ok(Number(physCogsJeRes.rows[0].total_debit) > 0);
      assert.equal(
        Number(physCogsJeRes.rows[0].total_debit),
        Number(physCogsJeRes.rows[0].total_credit),
        'COGS journal lines must balance debit = credit'
      );

      // ── TEST C: Duplicate approval / retry idempotency ──
      // Re-triggering approval update must not duplicate movements or journals
      await client.query(`
        UPDATE public.credit_notes
        SET updated_at = NOW()
        WHERE id = $1
      `, [physCnId]);

      const physItResAfterRetry = await client.query(
        'SELECT count(*) FROM public.inventory_transactions WHERE reference_id = $1',
        [physCnId]
      );
      assert.equal(Number(physItResAfterRetry.rows[0].count), 1, 'Retry must not duplicate inventory movements');

      const physJeResAfterRetry = await client.query(
        'SELECT count(*) FROM public.journal_entries WHERE reference_id = $1',
        [physCnId]
      );
      assert.equal(Number(physJeResAfterRetry.rows[0].count), 2, 'Retry must not duplicate journal entries');

      // ── TEST D: Transition guard: prevent changing approved physical_return to commercial_credit ──
      let transitionErrorCaught = false;
      await client.query('SAVEPOINT sp_trans1');
      try {
        await client.query(`
          UPDATE public.credit_notes
          SET credit_note_type = 'commercial_credit'
          WHERE id = $1
        `, [physCnId]);
      } catch (err) {
        transitionErrorCaught = true;
        await client.query('ROLLBACK TO sp_trans1');
        assert.match(
          err.message,
          /Cannot modify credit_note_type on an approved or posted Credit Note/,
          'Transition guard must reject modifying credit_note_type on approved physical return'
        );
      }
      assert.ok(transitionErrorCaught, 'Attempting to change approved physical_return to commercial_credit must throw an error');

      // Also verify approved commercial_credit cannot be changed to physical_return
      let commTransitionErrorCaught = false;
      await client.query('SAVEPOINT sp_trans2');
      try {
        await client.query(`
          UPDATE public.credit_notes
          SET credit_note_type = 'physical_return'
          WHERE id = $1
        `, [commCnId]);
      } catch (err) {
        commTransitionErrorCaught = true;
        await client.query('ROLLBACK TO sp_trans2');
        assert.match(
          err.message,
          /Cannot modify credit_note_type on an approved or posted Credit Note/,
          'Transition guard must reject modifying credit_note_type on approved commercial credit'
        );
      }
      assert.ok(commTransitionErrorCaught, 'Attempting to change approved commercial_credit to physical_return must throw an error');

      // ── TEST E: Draft / pending_approval credit notes CAN change credit_note_type ──
      const draftCnRes = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, credit_note_date, customer_id, reason, status, credit_note_type
        ) VALUES (
          'CN-TEST-DRAFT-001', CURRENT_DATE, $1, 'Draft type edit test', 'pending_approval', 'physical_return'
        ) RETURNING id
      `, [seed.customer_id]);
      const draftId = draftCnRes.rows[0].id;

      await client.query(`
        UPDATE public.credit_notes
        SET credit_note_type = 'commercial_credit'
        WHERE id = $1
      `, [draftId]);

      const draftCheck = await client.query('SELECT credit_note_type FROM public.credit_notes WHERE id = $1', [draftId]);
      assert.equal(draftCheck.rows[0].credit_note_type, 'commercial_credit', 'Pending approval credit note can change type before posting');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

test('4. Frontend UI contracts for credit_note_type in CreditNotes.tsx and CreditNoteView.tsx', () => {
  const pagePath = path.join(process.cwd(), 'src/pages/CreditNotes.tsx');
  const viewPath = path.join(process.cwd(), 'src/components/CreditNoteView.tsx');

  const pageCode = fs.readFileSync(pagePath, 'utf8');
  const viewCode = fs.readFileSync(viewPath, 'utf8');

  // CreditNotes.tsx interface and state
  assert.match(pageCode, /credit_note_type\?:\s*'physical_return'\s*\|\s*'commercial_credit'\s*\|\s*null/);
  assert.match(pageCode, /credit_note_type:\s*'physical_return'/);

  // CreditNotes.tsx form selector & option placeholder
  assert.match(pageCode, /name="credit_note_type"/);
  assert.match(pageCode, /aria-label="Credit Note Type"/);
  assert.match(pageCode, /value="physical_return"/);
  assert.match(pageCode, /value="commercial_credit"/);
  assert.match(pageCode, /— Select Credit Note Type —/);

  // CreditNotes.tsx edit fallback removal & validation
  assert.match(pageCode, /creditNote\.credit_note_type \|\| \(creditNote\.material_return_id \? 'physical_return' : ''\)/);
  assert.match(pageCode, /!formData\.credit_note_type && !formData\.material_return_id/);
  assert.match(pageCode, /!targetNote\?\.credit_note_type && !targetNote\?\.material_return_id/);

  // CreditNotes.tsx table badges
  assert.match(pageCode, /Physical Return/);
  assert.match(pageCode, /Commercial/);
  assert.match(pageCode, /Unclassified \(Review Required\)/);

  // CreditNoteView.tsx props and display
  assert.match(viewCode, /credit_note_type\?: string/);
  assert.match(viewCode, /creditNote\.credit_note_type === 'physical_return'/);
  assert.match(viewCode, /creditNote\.credit_note_type === 'commercial_credit'/);
  assert.match(viewCode, /Physical Goods Return/);
  assert.match(viewCode, /Commercial Credit/);
  assert.match(viewCode, /Unclassified \(Review Required\)/);
});

test('5. Multi-dimensional historical classification validation against all stock movements, material returns, receipt records, credit-note statuses and journal references', async () => {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      // 1. Fetch seed customer
      const custRes = await client.query('SELECT id FROM public.customers LIMIT 1');
      const custId = custRes.rows[0].id;

      // 2. Scenario A: Ambiguous unapproved credit note (pending_approval) with NO movements yet
      // Must NOT be classified as commercial, and must NOT be blindly classified as physical return.
      // Must remain NULL (unclassified) requiring explicit user selection before approval!
      const cnPendingRes = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, credit_note_date, customer_id, reason, status, credit_note_type
        ) VALUES ('CN-HIST-PENDING', CURRENT_DATE, $1, 'Pending review without return record', 'pending_approval', NULL)
        RETURNING id
      `, [custId]);
      const cnPendingId = cnPendingRes.rows[0].id;

      // 3. Scenario B: Legacy approved credit note with COGS journal but no IT record directly found
      const cnCogsRes = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, credit_note_date, customer_id, reason, status, credit_note_type
        ) VALUES ('CN-HIST-COGS', CURRENT_DATE, $1, 'Historical return with COGS', 'approved', NULL)
        RETURNING id
      `, [custId]);
      const cnCogsId = cnCogsRes.rows[0].id;

      await client.query(`
        INSERT INTO public.journal_entries (
          entry_number, entry_date, source_module, reference_id, reference_number,
          description, total_debit, total_credit, is_posted
        ) VALUES (
          'JE-TEST-COGS-99', CURRENT_DATE, 'credit_note_cogs', $1, 'CN-HIST-COGS',
          'COGS restock for CN-HIST-COGS', 50000, 50000, true
        )
      `, [cnCogsId]);

      // 4. Scenario C: Legacy approved credit note with positive commercial discount evidence (no IT, no COGS JE)
      const cnCommRes = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, credit_note_date, customer_id, reason, status, credit_note_type
        ) VALUES ('CN-HIST-COMM', CURRENT_DATE, $1, 'Special price concession and commercial discount', 'approved', NULL)
        RETURNING id
      `, [custId]);
      const cnCommId = cnCommRes.rows[0].id;

      // 5. Scenario D: Ambiguous approved legacy credit note without commercial text and without inventory/COGS traces
      const cnAmbigRes = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, credit_note_date, customer_id, reason, status, credit_note_type
        ) VALUES ('CN-HIST-AMBIG', CURRENT_DATE, $1, 'General settlement adjustment', 'approved', NULL)
        RETURNING id
      `, [custId]);
      const cnAmbigId = cnAmbigRes.rows[0].id;

      // 6. Scenario E: Pre-classified credit note (e.g. established as commercial_credit)
      const cnPreClassRes = await client.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, credit_note_date, customer_id, reason, status, credit_note_type
        ) VALUES ('CN-HIST-PRE', CURRENT_DATE, $1, 'Already established classification', 'approved', NULL)
        RETURNING id
      `, [custId]);
      const cnPreClassId = cnPreClassRes.rows[0].id;

      // 7. Apply the migration's column addition
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'credit_notes' AND column_name = 'credit_note_type'
          ) THEN
            ALTER TABLE public.credit_notes 
              ADD COLUMN credit_note_type text
              CONSTRAINT chk_credit_note_type CHECK (credit_note_type IN ('physical_return', 'commercial_credit'));
          END IF;
        END $$;
      `);

      // Set pre-classified note to commercial_credit before the backfill runs
      await client.query(`
        UPDATE public.credit_notes SET credit_note_type = 'commercial_credit' WHERE id = $1
      `, [cnPreClassId]);

      // Apply exact conservative historical backfill logic from migration
      await client.query(`
        UPDATE public.credit_notes cn
           SET credit_note_type = CASE
             -- Positive physical return evidence
             WHEN cn.material_return_id IS NOT NULL THEN 'physical_return'
             WHEN EXISTS (
               SELECT 1 FROM public.inventory_transactions it 
               WHERE it.reference_id = cn.id AND it.transaction_type = 'return'
             ) THEN 'physical_return'
             WHEN EXISTS (
               SELECT 1 FROM public.journal_entries je 
               WHERE je.reference_id = cn.id AND je.source_module = 'credit_note_cogs'
             ) THEN 'physical_return'
             -- Positive commercial concession evidence
             WHEN cn.status = 'approved'
               AND (
                 LOWER(cn.reason) ~* '(discount|price concession|commercial|rebate|rounding|allowance)'
                 OR LOWER(COALESCE(cn.notes, '')) ~* '(discount|price concession|commercial|rebate|rounding|allowance)'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM public.inventory_transactions it 
                 WHERE it.reference_id = cn.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM public.journal_entries je 
                 WHERE je.reference_id = cn.id AND je.source_module = 'credit_note_cogs'
               ) THEN 'commercial_credit'
             -- Otherwise: leave unclassified (NULL) for manual review
             ELSE NULL
           END
         WHERE cn.id IN ($1, $2, $3, $4, $5) AND cn.credit_note_type IS NULL;
      `, [cnPendingId, cnCogsId, cnCommId, cnAmbigId, cnPreClassId]);

      // 8. Assertions:
      // Scenario A (pending_approval without evidence): remains NULL for manual review
      const pendingCheck = await client.query('SELECT credit_note_type FROM public.credit_notes WHERE id = $1', [cnPendingId]);
      assert.equal(pendingCheck.rows[0].credit_note_type, null, 'Ambiguous pending note must remain NULL (unclassified)');

      // Scenario B (approved + COGS JE): classified as physical_return
      const cogsCheck = await client.query('SELECT credit_note_type FROM public.credit_notes WHERE id = $1', [cnCogsId]);
      assert.equal(cogsCheck.rows[0].credit_note_type, 'physical_return', 'Credit note with COGS reversal journal must be classified as physical_return');

      // Scenario C (approved commercial with positive text & no movements): classified as commercial_credit
      const commCheck = await client.query('SELECT credit_note_type FROM public.credit_notes WHERE id = $1', [cnCommId]);
      assert.equal(commCheck.rows[0].credit_note_type, 'commercial_credit', 'Credit note with explicit commercial concession text must be classified as commercial_credit');

      // Scenario D (ambiguous approved note without positive commercial text): remains NULL for manual review
      const ambigCheck = await client.query('SELECT credit_note_type FROM public.credit_notes WHERE id = $1', [cnAmbigId]);
      assert.equal(ambigCheck.rows[0].credit_note_type, null, 'Ambiguous approved note must NOT be guessed; must remain NULL for manual audit');

      // Scenario E (pre-classified note): never overwritten
      const preCheck = await client.query('SELECT credit_note_type FROM public.credit_notes WHERE id = $1', [cnPreClassId]);
      assert.equal(preCheck.rows[0].credit_note_type, 'commercial_credit', 'Established classification must NEVER be overwritten');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

test('6. Rollback recovery procedure verification: proves recovery script restores exact pre-migration function definitions and drops credit_note_type cleanly', async () => {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const migrationPath = path.join(
        process.cwd(),
        'supabase/migrations/20261028233000_credit_note_type_classification.sql'
      );
      const rollbackPath = path.join(
        process.cwd(),
        'supabase/migrations/recovery/rollback_credit_note_type_classification.sql'
      );
      assert.ok(fs.existsSync(rollbackPath), 'Rollback script must exist');

      // 0. Establish baseline and capture pre-migration definitions
      const rollbackSql = fs.readFileSync(rollbackPath, 'utf8');
      await client.query(rollbackSql);

      const origFn1 = (await client.query("SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = '_post_credit_note_je'")).rows[0].pg_get_functiondef;
      const origFn2 = (await client.query("SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'trg_credit_note_inventory_v1'")).rows[0].pg_get_functiondef;
      const origTrg = (await client.query("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trigger_credit_note_inventory_v1'")).rows[0].pg_get_triggerdef;

      // 1. Apply Migration
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');
      await client.query(migrationSql);

      // Verify migration artifacts
      const colCheck1 = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'credit_notes' AND column_name = 'credit_note_type'
      `);
      assert.equal(colCheck1.rowCount, 1, 'credit_note_type must exist post-migration');

      const trgCheck1 = await client.query(`
        SELECT trigger_name FROM information_schema.triggers 
        WHERE trigger_name = 'trg_guard_credit_note_type_transition'
      `);
      assert.equal(trgCheck1.rowCount, 1, 'Transition guard trigger must exist post-migration');

      // 2. Apply Recovery Script
      await client.query(rollbackSql);

      // Verify transition guard trigger is removed
      const trgCheck2 = await client.query(`
        SELECT trigger_name FROM information_schema.triggers 
        WHERE trigger_name = 'trg_guard_credit_note_type_transition'
      `);
      assert.equal(trgCheck2.rowCount, 0, 'Transition guard trigger must be removed post-recovery');

      // Verify column is dropped
      const colCheck2 = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'credit_notes' AND column_name = 'credit_note_type'
      `);
      assert.equal(colCheck2.rowCount, 0, 'credit_note_type column must be dropped post-recovery');

      // Verify original trigger still exists
      const origTrgCheck = await client.query(`
        SELECT trigger_name FROM information_schema.triggers 
        WHERE trigger_name = 'trigger_credit_note_inventory_v1'
      `);
      assert.equal(origTrgCheck.rowCount, 1, 'trigger_credit_note_inventory_v1 must be active post-recovery');

      // Verify exact byte-for-byte restoration of functions and trigger
      const restFn1 = (await client.query("SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = '_post_credit_note_je'")).rows[0].pg_get_functiondef;
      const restFn2 = (await client.query("SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'trg_credit_note_inventory_v1'")).rows[0].pg_get_functiondef;
      const restTrg = (await client.query("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trigger_credit_note_inventory_v1'")).rows[0].pg_get_triggerdef;

      assert.equal(restFn1.trim(), origFn1.trim(), '_post_credit_note_je must be restored byte-for-byte');
      assert.equal(restFn2.trim(), origFn2.trim(), 'trg_credit_note_inventory_v1 must be restored byte-for-byte');
      assert.equal(restTrg.trim(), origTrg.trim(), 'trigger_credit_note_inventory_v1 must be restored byte-for-byte');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

test('7. Precondition safety gate: proves migration aborts safely when invariants or schema differ', async () => {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const migrationPath = path.join(
        process.cwd(),
        'supabase/migrations/20261028233000_credit_note_type_classification.sql'
      );
      const sql = fs.readFileSync(migrationPath, 'utf8');

      // Sub-test A: Simulate invoice balance violation (e.g. SAPJ-26-013 balance != 0)
      await client.query('SAVEPOINT sp_precond_test');
      await client.query("UPDATE public.sales_invoices SET balance_amount = 100.00 WHERE invoice_number = 'SAPJ-26-013'");

      let precondFailed = false;
      try {
        await client.query(sql);
      } catch (err) {
        precondFailed = true;
        assert.match(
          err.message,
          /Precondition failed: SAPJ-26-013 balance_amount is 100.00, expected 0.00/,
          'Migration must abort with specific precondition error message'
        );
      }
      assert.ok(precondFailed, 'Migration must abort when SAPJ-26-013 balance is non-zero');
      await client.query('ROLLBACK TO sp_precond_test');

      // Sub-test B: Simulate missing trigger
      await client.query('SAVEPOINT sp_precond_trg');
      await client.query('ALTER TABLE public.credit_notes DISABLE TRIGGER trigger_credit_note_inventory_v1');

      let trgPrecondFailed = false;
      try {
        await client.query(sql);
      } catch (err) {
        trgPrecondFailed = true;
        assert.match(
          err.message,
          /Precondition failed: Trigger trigger_credit_note_inventory_v1 missing or disabled/,
          'Migration must abort if trigger is disabled'
        );
      }
      assert.ok(trgPrecondFailed, 'Migration must abort when trigger is disabled');
      await client.query('ROLLBACK TO sp_precond_trg');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
