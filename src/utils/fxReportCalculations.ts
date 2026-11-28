// Pure, deterministic FX calculation & reconciliation helpers shared by
// FXReport.tsx (Accounting FX), FXBusinessDashboard.tsx (Commercial FX), and tests.

export interface PostedGlFxLineInput {
  id: string;
  journal_entry_id: string;
  entry_number: string;
  entry_date: string;
  reference_number: string | null;
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  description: string;
  is_revaluation?: boolean;
}

export interface GlFxBreakdown {
  realizedGain: number; // A: Cr 4930 (non-revaluation)
  realizedLoss: number; // B: Dr 7300 (non-revaluation)
  netRealized: number;  // C: A - B
  unrealizedGain: number; // D: Cr 4930 (revaluation JEs)
  unrealizedLoss: number; // E: Dr 7300 (revaluation JEs)
  netUnrealized: number;  // F: D - E
  totalNetAccountingFx: number; // G: C + F
}

export function summarizePostedGlFx(
  glLines: PostedGlFxLineInput[],
  revaluationJeIds: Set<string>
): GlFxBreakdown {
  let realizedGain = 0;
  let realizedLoss = 0;
  let unrealizedGain = 0;
  let unrealizedLoss = 0;

  for (const gl of glLines) {
    const dr = Number(gl.debit || 0);
    const cr = Number(gl.credit || 0);
    const isUnrealized = gl.is_revaluation ?? revaluationJeIds.has(gl.journal_entry_id);

    if (isUnrealized) {
      if (gl.account_code === '4930') unrealizedGain += cr - dr;
      else if (gl.account_code === '7300') unrealizedLoss += dr - cr;
    } else {
      if (gl.account_code === '4930') realizedGain += cr - dr;
      else if (gl.account_code === '7300') realizedLoss += dr - cr;
    }
  }

  realizedGain = Math.round(realizedGain * 100) / 100;
  realizedLoss = Math.round(realizedLoss * 100) / 100;
  unrealizedGain = Math.round(unrealizedGain * 100) / 100;
  unrealizedLoss = Math.round(unrealizedLoss * 100) / 100;

  const netRealized = Math.round((realizedGain - realizedLoss) * 100) / 100;
  const netUnrealized = Math.round((unrealizedGain - unrealizedLoss) * 100) / 100;
  const totalNetAccountingFx = Math.round((netRealized + netUnrealized) * 100) / 100;

  return {
    realizedGain,
    realizedLoss,
    netRealized,
    unrealizedGain,
    unrealizedLoss,
    netUnrealized,
    totalNetAccountingFx,
  };
}

export interface RevaluationLineRef {
  revaluation_date: string;
  status: string;
  purchase_invoice_id?: string | null;
  line_type?: string;
  foreign_amount: number;
  carrying_rate: number;
  revalued_rate: number;
  fx_difference: number;
  gain_loss_type?: string;
}

export interface SupplierSettlementBridgeResult {
  original_idr_carrying_settled: number;
  prior_revaluation_fx: number; // + = prior unrealized loss (increased liability), - = prior unrealized gain
  carrying_before_settlement_idr: number;
  actual_settlement_idr: number;
  realized_fx_on_settlement: number; // + = loss, - = gain
  cumulative_historical_rate_variance: number; // actual_settlement_idr - original_idr_carrying_settled
  effective_carrying_rate_before_settlement: number;
}

/**
 * Computes the accounting settlement bridge for a supplier USD invoice allocation:
 * Original Carrying -> Prior Month-End Revaluations -> Carrying Before Settlement -> Actual Settlement -> Realized FX.
 * Prevents double-counting prior month-end revaluations (e.g. Oct 2026 revaluation on PV/26-26/034).
 */
export function computeSupplierSettlementBridge(params: {
  usdSettled: number;
  originalPiRate: number;
  settlementRate: number;
  settlementDate: string;
  isUsdBankSettlement: boolean;
  priorRevalLines: RevaluationLineRef[];
}): SupplierSettlementBridgeResult {
  const {
    usdSettled,
    originalPiRate,
    settlementRate,
    settlementDate,
    isUsdBankSettlement,
    priorRevalLines,
  } = params;

  const originalCarrying = Math.round(usdSettled * originalPiRate * 100) / 100;

  // Sum prior posted revaluations strictly before settlement date (in date order)
  const applicableRevals = priorRevalLines
    .filter(
      (rl) =>
        rl.status === 'posted' &&
        rl.revaluation_date &&
        rl.revaluation_date.slice(0, 10) < settlementDate.slice(0, 10)
    )
    .sort((a, b) => a.revaluation_date.localeCompare(b.revaluation_date));

  let priorRevalFx = 0;
  let effectiveCarryingRate = originalPiRate;

  for (const rl of applicableRevals) {
    // Rate delta on payable: revalued_rate - carrying_rate (>0 means liability increased -> unrealized loss)
    const rateDelta = Number(rl.revalued_rate || 0) - Number(rl.carrying_rate || 0);
    priorRevalFx += usdSettled * rateDelta;
    if (Number(rl.revalued_rate || 0) > 0) {
      effectiveCarryingRate = Number(rl.revalued_rate);
    }
  }

  priorRevalFx = Math.round(priorRevalFx * 100) / 100;
  const carryingBeforeSettlement = Math.round((originalCarrying + priorRevalFx) * 100) / 100;

  // For USD-bank settlements where pvRate == 1, functional IDR outflow is at carrying rate unless explicit FX rate > 1
  const effectiveSettleRate = isUsdBankSettlement && settlementRate <= 1 ? effectiveCarryingRate : settlementRate;
  const actualSettlementIdr = Math.round(usdSettled * effectiveSettleRate * 100) / 100;
  const realizedFx = Math.round((actualSettlementIdr - carryingBeforeSettlement) * 100) / 100;
  const cumulativeVariance = Math.round((actualSettlementIdr - originalCarrying) * 100) / 100;

  return {
    original_idr_carrying_settled: originalCarrying,
    prior_revaluation_fx: priorRevalFx,
    carrying_before_settlement_idr: carryingBeforeSettlement,
    actual_settlement_idr: actualSettlementIdr,
    realized_fx_on_settlement: realizedFx,
    cumulative_historical_rate_variance: cumulativeVariance,
    effective_carrying_rate_before_settlement: effectiveCarryingRate,
  };
}
