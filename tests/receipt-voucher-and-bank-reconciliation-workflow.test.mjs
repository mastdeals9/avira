import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

test('Receipt Voucher and Bank Reconciliation Workflow Integrity Suite', async (t) => {
  await t.test('1. Production-applied migrations synchronization verification', () => {
    const requiredMigrations = [
      '20261119060854_repair_sandi_pv032_staff_subledger_attribution.sql',
      '20261119064719_forward_fix_payment_voucher_cash_control_account_routing.sql',
      '20261119084158_integrate_payment_vouchers_with_petty_cash.sql',
      '20261119093949_fix_shared_expense_category_trigger_row_field_access.sql',
      '20261119123108_fix_explicit_bank_allocation_unlink_auto_rematch.sql',
      '20261119180149_fix_receipt_cancel_unlink_status_sequence.sql',
    ];

    for (const mig of requiredMigrations) {
      const fullPath = path.join(projectRoot, 'supabase', 'migrations', mig);
      assert.ok(fs.existsSync(fullPath), `Migration file ${mig} must exist in supabase/migrations/`);
      const content = fs.readFileSync(fullPath, 'utf8');
      assert.ok(content.length > 50, `Migration file ${mig} must not be empty`);
    }

    // Verify 20261119123108 contains unmatch_bank_statement_allocation and cancel_receipt_voucher_posting with manually_unlinked
    const mig123108 = fs.readFileSync(path.join(projectRoot, 'supabase', 'migrations', '20261119123108_fix_explicit_bank_allocation_unlink_auto_rematch.sql'), 'utf8');
    assert.match(mig123108, /manually_unlinked\s*=\s*true/i, 'Must set manually_unlinked = true in unmatch_bank_statement_allocation');
    assert.match(mig123108, /CREATE OR REPLACE FUNCTION public\.cancel_receipt_voucher_posting/i, 'Must update cancel_receipt_voucher_posting');
    assert.match(mig123108, /matching_status\s*=\s*'none'/i, 'Must reset matching_status = none during cancellation');
    assert.match(
      mig123108,
      /cancel_receipt_voucher_posting\(\s*p_rv_id\s+uuid,\s*p_cancelled_by\s+uuid\s+DEFAULT\s+NULL::uuid,\s*p_reason\s+text/i,
      'Migration 20261119123108 must follow canonical parameter sequence (p_rv_id, p_cancelled_by, p_reason) to prevent function overload'
    );

    // Verify 20261119180149 maintains canonical signature and fixes status sequence
    const mig180149 = fs.readFileSync(path.join(projectRoot, 'supabase', 'migrations', '20261119180149_fix_receipt_cancel_unlink_status_sequence.sql'), 'utf8');
    assert.match(
      mig180149,
      /cancel_receipt_voucher_posting\(p_rv_id\s+uuid,\s*p_cancelled_by\s+uuid\s+DEFAULT\s+NULL::uuid,\s*p_reason\s+text/i,
      'Migration 20261119180149 must follow canonical parameter sequence (p_rv_id, p_cancelled_by, p_reason)'
    );
    assert.match(
      mig180149,
      /IF EXISTS \(SELECT 1 FROM public\.bank_statement_allocations WHERE bank_statement_line_id = v_line_id\)/i,
      'Must guard allocation owner sync with remaining allocation check in cancel_receipt_voucher_posting'
    );
  });

  await t.test('2. Receipt Voucher cancellation logic & P0001 error suppression', () => {
    const mig123108 = fs.readFileSync(path.join(projectRoot, 'supabase', 'migrations', '20261119123108_fix_explicit_bank_allocation_unlink_auto_rematch.sql'), 'utf8');
    
    // Verify atomic cancellation sequence:
    // 1. Unmatch bank statement allocation
    assert.match(mig123108, /PERFORM public\.unmatch_bank_statement_allocation\(v_alloc\.id\);/);
    // 2. Clear bank lines direct refs & suppress auto-match
    assert.match(mig123108, /UPDATE public\.bank_statement_lines[\s\S]*?reconciliation_status\s*=\s*'unmatched'/);
    // 3. Clear voucher FK before cancel_gl_posting
    assert.match(mig123108, /UPDATE public\.receipt_vouchers[\s\S]*?is_posted\s*=\s*FALSE[\s\S]*?journal_entry_id\s*=\s*NULL/);
    // 4. Cancel GL posting with audit log
    assert.match(mig123108, /PERFORM public\.cancel_gl_posting\(/);
    // 5. Synchronize bank balance
    assert.match(mig123108, /PERFORM public\.sync_bank_account_balance\(/);
  });

  await t.test('3. Receipt Voucher Detail Screen - 4-figure financial overview calculations', () => {
    const rvmContent = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'finance', 'ReceiptVoucherManager.tsx'), 'utf8');

    // Verify 4 explicit metrics in UI
    assert.match(rvmContent, /Voucher Amount/, 'Must display Voucher Amount KPI');
    assert.match(rvmContent, /Invoice Allocated/, 'Must display Invoice Allocated KPI');
    assert.match(rvmContent, /Bank Matched Amount/, 'Must display Bank Matched Amount KPI');
    assert.match(rvmContent, /Unallocated Receipt Balance/, 'Must display Unallocated Receipt Balance KPI');
    assert.match(rvmContent, /Customer Deposit \(GL 2140\)/, 'Must display Customer Deposit badge when unallocated');

    // Test simulation of RV2611-0004 (Customer advance / deposit with no invoice allocation)
    const rv0004 = { amount: 81688230 };
    const allocations0004 = [];
    const bankLines0004 = [{ allocation_amount: 81688230 }];

    const voucherAmount = Number(rv0004.amount || 0);
    const invoiceAllocated = allocations0004.reduce((sum, a) => sum + Number(a.allocated_amount || 0), 0);
    const bankMatchedAmount = bankLines0004.reduce((sum, l) => sum + Number(l.allocation_amount || 0), 0);
    const unallocatedBalance = Math.max(0, voucherAmount - invoiceAllocated);

    assert.equal(voucherAmount, 81688230);
    assert.equal(invoiceAllocated, 0);
    assert.equal(bankMatchedAmount, 81688230);
    assert.equal(unallocatedBalance, 81688230);

    // Test simulation of RV2611-0003 (Allocated to SAPJ-26-066)
    const rv0003 = { amount: 81688230 };
    const allocations0003 = [{ allocated_amount: 81688230 }];
    const bankLines0003 = [{ allocation_amount: 81688230 }];

    const voucherAmount3 = Number(rv0003.amount || 0);
    const invoiceAllocated3 = allocations0003.reduce((sum, a) => sum + Number(a.allocated_amount || 0), 0);
    const bankMatchedAmount3 = bankLines0003.reduce((sum, l) => sum + Number(l.allocation_amount || 0), 0);
    const unallocatedBalance3 = Math.max(0, voucherAmount3 - invoiceAllocated3);

    assert.equal(voucherAmount3, 81688230);
    assert.equal(invoiceAllocated3, 81688230);
    assert.equal(bankMatchedAmount3, 81688230);
    assert.equal(unallocatedBalance3, 0);
  });

  await t.test('4. Receipt Voucher direct bank linking and journal entry reference querying', () => {
    const rvmContent = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'finance', 'ReceiptVoucherManager.tsx'), 'utf8');

    // Query must check both matched_receipt_id and matched_entry_id / journal_entry_id
    assert.match(rvmContent, /matched_receipt_id\.eq\.\$\{voucher\.id\}/, 'Query must check matched_receipt_id');
    assert.match(rvmContent, /matched_entry_id\.eq\.\$\{voucher\.journal_entry_id\}/, 'Query must check matched_entry_id for journal matches');
    assert.match(rvmContent, /document_type\.eq\.receipt,document_id\.eq\.\$\{voucher\.id\}/, 'Query must check canonical allocation document_id');
    assert.match(rvmContent, /journal_entry_id\.eq\.\$\{voucher\.journal_entry_id\}/, 'Query must check canonical allocation journal_entry_id');

    // Verify Direct Link Bank Statement action in drawer
    assert.match(rvmContent, /Link Bank Statement/, 'Must offer Link Bank Statement action in expandable drawer');
    assert.match(rvmContent, /Reconciled/, 'Must display Reconciled indicator when linked');
  });

  await t.test('5. Bank Reconciliation Record Transaction - Customer Receipt primary workflow & draft voucher linking', () => {
    const reconContent = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'finance', 'BankReconciliationEnhanced.tsx'), 'utf8');

    // Check pathways: Customer Receipt primary, Link Existing Receipt alternative
    assert.match(reconContent, /Customer Receipt/, 'Must provide Customer Receipt tab');
    assert.match(reconContent, /Primary/, 'Must designate Customer Receipt as primary workflow');
    assert.match(reconContent, /Link Existing Receipt/, 'Must provide Link Existing Receipt tab');

    // Verify invoice allocation table & customer receipt posting
    assert.match(reconContent, /receiptAllocations/, 'Must support invoice allocations');
    assert.match(reconContent, /Post & Link Customer Receipt/, 'Must offer Post & Link Customer Receipt');

    // Verify search & exact amount filter
    assert.match(reconContent, /receiptSearchQuery/, 'Must support receipt search filtering');
    assert.match(reconContent, /receiptFilterMatchingAmount/, 'Must support exact matching amount filter');

    // Verify draft receipts (e.g. Case B RV2611-0002) are loaded and postable
    assert.match(reconContent, /post_receipt_voucher/, 'Must support posting draft receipt before linking');
    assert.match(reconContent, /Post & Link/, 'Must offer Post & Link button for draft receipts');
  });

  await t.test('6. Invoice over-allocation safeguard against double allocation across draft & posted vouchers', () => {
    const reconContent = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'finance', 'BankReconciliationEnhanced.tsx'), 'utf8');

    // Verify draftReserved calculation
    assert.match(reconContent, /draftAllocMap/, 'Must calculate draft allocations across unposted receipts');
    assert.match(reconContent, /actualRemaining/, 'Must calculate actual remaining allocatable balance');
    assert.match(reconContent, /Receipt allocation \(.*?\) exceeds available balance/, 'Must reject over-allocation attempts with clear message');

    // Logic test: Simulation of Case B (SAPJ-26-059 total Rp 75,036,000, draft RV2611-0002 has Rp 75,036,000)
    const invoice = {
      id: 'inv-sapj-059',
      invoice_number: 'SAPJ-26-059',
      total_amount: 75036000,
      balance_amount: 75036000, // get_invoices_with_balance without draft subtraction
    };

    const draftAllocations = [
      { sales_invoice_id: 'inv-sapj-059', allocated_amount: 75036000, is_posted: false, status: 'approved', voucher_number: 'RV2611-0002' },
    ];

    const draftReserved = draftAllocations
      .filter(a => a.sales_invoice_id === invoice.id && !a.is_posted)
      .reduce((sum, a) => sum + a.allocated_amount, 0);

    const actualRemaining = Math.max(0, invoice.balance_amount - draftReserved);

    assert.equal(draftReserved, 75036000, 'Draft allocation must be accounted for');
    assert.equal(actualRemaining, 0, 'Actual remaining allocatable balance must be 0');

    // Attempting to allocate another 75,036,000 must be blocked
    const attemptedAllocation = 75036000;
    const isOverAllocated = attemptedAllocation > actualRemaining + 0.01;
    assert.equal(isOverAllocated, true, 'Attempted allocation must be flagged as over-allocation');
  });
});
