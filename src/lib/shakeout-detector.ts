import type { DailyCandle } from '@/lib/pump-score';

export type ShakeoutPhase = 'BREAKOUT_CONFIRMED' | 'ARMED_FOR_BREAKOUT' | 'STRUCTURE_FORMING' | 'NO_STRUCTURE';

export interface ShakeoutStructure {
  score: number;
  phase: ShakeoutPhase;
  breakdown: {
    accumulationRange: number;
    failedTestPump: number;
    bearTrap: number;
    returnedToRange: number;
    supplyDrying: number;
    breakout: number;
  };
  metrics: {
    support: number;
    resistance: number;
    rangeWidth: number;
    rangeWindowDays: number;
    testPumpOffsetDays: number | null;
    bearTrapOffsetDays: number | null;
    drySupplyRatio: number | null;
    closeVsResistance: number;
    breakoutVolumeRatio: number;
  };
}

const RANGE_DAYS = 30;
const ASSESSMENT_DAYS = 7;
const LOOKBACK_DAYS = 60;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function quantile(values: number[], percentile: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

function lowerWick(candle: DailyCandle) {
  return (Math.min(candle.open, candle.close) - candle.low) / Math.max(candle.open, Number.EPSILON);
}

function isInsideRange(close: number, support: number, resistance: number) {
  return close >= support * 0.97 && close <= resistance * 1.03;
}

/**
 * Detects the multi-stage shakeout structure observed in BANK:
 * failed upside test → downside liquidity sweep → re-acceptance in range →
 * low-supply consolidation → closing-price breakout.
 *
 * It intentionally scores components separately: a long wick or one volume
 * spike alone cannot produce an armed/confirmed result.
 */
export function detectShakeoutStructure(candles: DailyCandle[]): ShakeoutStructure | null {
  if (candles.length < RANGE_DAYS + ASSESSMENT_DAYS + 7) return null;

  const latestIndex = candles.length - 1;
  const rangeEnd = latestIndex - ASSESSMENT_DAYS + 1;
  const rangeStart = Math.max(0, rangeEnd - RANGE_DAYS);
  const range = candles.slice(rangeStart, rangeEnd);
  const assessment = candles.slice(rangeEnd);
  const latest = candles[latestIndex];
  const support = quantile(range.map((candle) => candle.low), 0.15);
  const resistance = quantile(range.map((candle) => candle.high), 0.85);
  const rangeWidth = (resistance - support) / Math.max(support, Number.EPSILON);
  const rangeMedianVolume = median(range.map((candle) => candle.quoteVolume));
  const validRange = rangeWidth >= 0.06 && rangeWidth <= 0.55;
  const closesInsideRange = range.filter((candle) => isInsideRange(candle.close, support, resistance)).length / range.length;

  const eventStart = Math.max(0, rangeStart - LOOKBACK_DAYS);
  const eventCandles = candles.slice(eventStart, rangeEnd);
  let testPumpIndex: number | null = null;
  let bearTrapIndex: number | null = null;

  for (let offset = 0; offset < eventCandles.length; offset++) {
    const candle = eventCandles[offset];
    const absoluteIndex = eventStart + offset;
    const following = candles.slice(absoluteIndex + 1, Math.min(rangeEnd, absoluteIndex + 6));
    const returnedAfterTest = following.some((next) => isInsideRange(next.close, support, resistance));
    if (candle.high >= resistance * 1.03 && candle.close <= resistance * 1.02 && returnedAfterTest) {
      testPumpIndex = absoluteIndex;
    }

    const recoveredSameDay = candle.close >= support;
    const recoveredSoon = following.slice(0, 2).some((next) => next.close >= support);
    const hasVolumeResponse = candle.quoteVolume >= rangeMedianVolume * 1.8;
    if (candle.low <= support * 0.97 && lowerWick(candle) >= 0.05 && hasVolumeResponse && (recoveredSameDay || recoveredSoon)) {
      bearTrapIndex = absoluteIndex;
    }
  }

  const lastEventIndex = Math.max(testPumpIndex ?? -1, bearTrapIndex ?? -1);
  const postEventCandles = lastEventIndex >= 0 ? candles.slice(lastEventIndex + 1, rangeEnd) : [];
  const returnedToRange = postEventCandles.length >= 5 &&
    postEventCandles.filter((candle) => isInsideRange(candle.close, support, resistance)).length / postEventCandles.length >= 0.7;

  // Search for a seven-day low-supply block after the structure began. A dry
  // block is more robust than comparing only the current day, which may already
  // contain the breakout's volume expansion.
  const drySearchStart = testPumpIndex ?? rangeStart;
  const drySearchEnd = Math.max(drySearchStart, rangeEnd - 6);
  let drySupplyRatio: number | null = null;
  for (let index = drySearchStart; index <= drySearchEnd; index++) {
    const window = candles.slice(index, index + 7);
    if (window.length < 7) continue;
    const ratio = median(window.map((candle) => candle.quoteVolume)) / Math.max(rangeMedianVolume, Number.EPSILON);
    if (drySupplyRatio === null || ratio < drySupplyRatio) drySupplyRatio = ratio;
  }
  const supplyDrying = drySupplyRatio !== null && drySupplyRatio <= 0.75;

  const assessmentInside = assessment.filter((candle) => isInsideRange(candle.close, support, resistance)).length / assessment.length;
  const closeVsResistance = latest.close / Math.max(resistance, Number.EPSILON);
  const breakoutVolumeRatio = latest.quoteVolume / Math.max(rangeMedianVolume, Number.EPSILON);
  // A detector must not keep signalling an old breakout after price has already
  // travelled multiples above the original range. The close has to be near the
  // range boundary when the signal is emitted.
  const breakoutConfirmed = latest.close > resistance * 1.01 && closeVsResistance <= 1.35 && breakoutVolumeRatio >= 2;
  const breakoutArmed = !breakoutConfirmed && closeVsResistance >= 0.985 && closeVsResistance <= 1.05 && assessmentInside >= 0.55;

  const breakdown = {
    accumulationRange: validRange && closesInsideRange >= 0.65 ? 15 : validRange ? 7 : 0,
    failedTestPump: testPumpIndex !== null ? 20 : 0,
    bearTrap: bearTrapIndex !== null ? 20 : 0,
    returnedToRange: returnedToRange ? 15 : 0,
    supplyDrying: supplyDrying ? 15 : 0,
    breakout: breakoutConfirmed ? 15 : breakoutArmed ? 10 : 0,
  };
  const score = Object.values(breakdown).reduce((total, value) => total + value, 0);
  const phase: ShakeoutPhase = breakoutConfirmed && score >= 65
    ? 'BREAKOUT_CONFIRMED'
    : breakoutArmed && score >= 60
      ? 'ARMED_FOR_BREAKOUT'
      : score >= 45 ? 'STRUCTURE_FORMING' : 'NO_STRUCTURE';

  return {
    score,
    phase,
    breakdown,
    metrics: {
      support,
      resistance,
      rangeWidth,
      rangeWindowDays: range.length,
      testPumpOffsetDays: testPumpIndex === null ? null : latestIndex - testPumpIndex,
      bearTrapOffsetDays: bearTrapIndex === null ? null : latestIndex - bearTrapIndex,
      drySupplyRatio,
      closeVsResistance,
      breakoutVolumeRatio,
    },
  };
}
