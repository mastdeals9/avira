import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const CONNECTION_STRING =
  'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';

const root = process.cwd();

test('SAPJ ERP — Final FX Reporting Reconciliation (Live Read-Only DB + Code Contract)', async (t) => {
  const client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();

  try {
    await t.test('1. Posted GL Accounts 7300 & 4930 reconcile to exact A..G figures', async () => {
      const res = await client.query(`
        SELECT
          je.id AS journal_entry_id,
          je.entry_number,
          je.entry_date::text,
          je.reference_number,
          coa.code AS account_code,
          jel.debit::numeric,
          jel.credit::numeric,
          (rev.id IS NOT NULL AND rev.status = 'posted') AS is_revaluation
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        LEFT JOIN fx_revaluations rev ON rev.journal_entry_id = je.id
        WHERE coa.code IN ('7300', '4930')
          AND je.is_posted = true
          AND COALESCE(je.is_reversed, false) = false
          AND COALESCE(je.is_cancelled, false) = false
        ORDER BY je.entry_date, je.entry_number
      `);

      const entryNumbers = new Set(res.rows.map((r) => r.entry_number));
      for (const expectedJe of ['JE2609-0054', 'JE2611-0312', 'JE2611-0313', 'JE2611-0314', 'JE2611-0456']) {
        assert.ok(entryNumbers.has(expectedJe), `Expected posted GL entry ${expectedJe}`);
      }

      let realGain = 0, realLoss = 0, unrealGain = 0, unrealLoss = 0;
      for (const r of res.rows) {
        const dr = Number(r.debit || 0);
        const cr = Number(r.credit || 0);
        if (r.is_revaluation) {
          if (r.account_code === '4930') unrealGain += cr - dr;
          if (r.account_code === '7300') unrealLoss += dr - cr;
        } else {
          if (r.account_code === '4930') realGain += cr - dr;
          if (r.account_code === '7300') realLoss += dr - cr;
        }
      }

      const netRealized = Math.round((realGain - realLoss) * 100) / 100;
      const netUnrealized = Math.round((unrealGain - unrealLoss) * 100) / 100;
      const totalNet = Math.round((netRealized + netUnrealized) * 100) / 100;

      assert.equal(Math.round(Math.abs(netRealized)), 137341497);
      assert.equal(Math.round(Math.abs(netUnrealized)), 106796488);
      assert.equal(Math.round(Math.abs(totalNet)), 244137985);
    });

    await t.test('2. PV/26-26/005, 010, 015, 034 Settlement Bridge recognizes Oct 2026 revaluation before Nov settlement', async () => {
      const pvRes = await client.query(`
        SELECT
          pv.voucher_number, pv.voucher_date::date::text AS pv_date, pv.exchange_rate::numeric AS pv_rate,
          va.allocated_amount::numeric AS usd_settled,
          pi.id AS pi_id, pi.invoice_number, pi.exchange_rate::numeric AS pi_rate
        FROM payment_vouchers pv
        JOIN voucher_allocations va ON va.payment_voucher_id = pv.id
        JOIN purchase_invoices pi ON pi.id = va.purchase_invoice_id
        WHERE pv.voucher_number IN ('PV/26-26/005', 'PV/26-26/010', 'PV/26-26/015', 'PV/26-26/034')
          AND pv.is_posted = true
        ORDER BY pv.voucher_number, pi.invoice_number
      `);
      assert.equal(pvRes.rows.length, 9);

      const pv34Rows = pvRes.rows.filter((r) => r.voucher_number === 'PV/26-26/034');
      assert.equal(pv34Rows.length, 2);

      const piIds = pv34Rows.map((r) => r.pi_id);
      const revRes = await client.query(
        `
        SELECT rl.purchase_invoice_id, rev.revaluation_date::date::text AS rev_date,
               rl.carrying_rate::numeric, rl.revalued_rate::numeric
        FROM fx_revaluation_lines rl
        JOIN fx_revaluations rev ON rev.id = rl.revaluation_id
        WHERE rl.purchase_invoice_id = ANY($1)
          AND rev.status = 'posted'
        `,
        [piIds]
      );
      assert.equal(revRes.rows.length, 2, 'Both PIs on PV/26-26/034 have Oct 2026 revaluation lines');

      let pv34RealizedGain = 0;
      for (const row of pv34Rows) {
        const usd = Number(row.usd_settled);
        const origRate = Number(row.pi_rate);
        const settleRate = Number(row.pv_rate);
        const reval = revRes.rows.find((r) => r.purchase_invoice_id === row.pi_id && r.rev_date < row.pv_date);
        assert.ok(reval, `Expected prior revaluation for ${row.invoice_number}`);

        const priorRevalFx = usd * (Number(reval.revalued_rate) - Number(reval.carrying_rate));
        const preSettleCarrying = usd * origRate + priorRevalFx;
        const actualSettle = usd * settleRate;
        const realizedFx = actualSettle - preSettleCarrying; // negative = gain
        pv34RealizedGain += -realizedFx;
      }

      // Reconciles within Rp 1 rounding to JE2611-0456 (Rp 111,705.20)
      assert.ok(Math.abs(pv34RealizedGain - 111705.2) < 1, `Expected ~111,705.20, got ${pv34RealizedGain}`);
    });

    await t.test('3. FXReport and FXBusinessDashboard enforce GL truth, no hardcoded fallbacks, and VA deduplication', () => {
      const fxReport = readFileSync(resolve(root, 'src/components/finance/FXReport.tsx'), 'utf8');
      const fxBiz = readFileSync(resolve(root, 'src/components/finance/FXBusinessDashboard.tsx'), 'utf8');

      assert.doesNotMatch(fxReport, /41184641\.50/, 'Hardcoded JE2609-0054 amount must be removed');
      assert.doesNotMatch(fxReport, /useState<number>\(17800\)/, 'Hardcoded 17800 market rate must be removed');
      assert.match(fxReport, /summarizePostedGlFx/);
      assert.match(fxReport, /computeSupplierSettlementBridge/);
      assert.match(fxReport, /\.eq\('is_posted', true\)/);
      assert.match(fxReport, /\.eq\('is_reversed', false\)/);
      assert.match(fxReport, /\.eq\('is_cancelled', false\)/);

      assert.match(fxBiz, /seenVaIds/);
      assert.match(fxBiz, /seenPiIds/);
      assert.match(fxBiz, /allocation_share_ratio/);
    });
  } finally {
    await client.end();
  }
});
