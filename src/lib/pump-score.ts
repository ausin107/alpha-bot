export const PUMP_SCORE_VERSION = 8;
export const MINIMUM_HISTORY_DAYS = 22;
export const FULL_HISTORY_DAYS = 200;
const CYCLE_WINDOW_DAYS = 90;
const CONTEXT_WINDOW_DAYS = 180;

export interface DailyCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
  tradeCount: number;
}

export type HistoryConfidence = 'FULL' | 'PARTIAL' | 'SHORT';
export type PumpPhase = 'ACCELERATION_READY' | 'EARLY_CYCLE' | 'TRIGGER_ONLY' | 'NO_CLEAR_SETUP';

interface SetupStats {
  volumeRatio: number;
  tradeRatio: number;
  setupVolume: number;
  setupTrades: number;
  averageDailyRange: number;
  averageLowerWick: number;
  averageUpperWick: number;
}

export interface PumpScore {
  score: number;
  triggerScore: number;
  cycleScore: number;
  level: 'HIGH' | 'WATCH' | 'LOW';
  phase: PumpPhase;
  confidence: HistoryConfidence;
  breakdown: {
    trigger: Record<string, number>;
    cycle: Record<string, number>;
  };
  metrics: {
    historyDays: number;
    contextWindowDays: number;
    volumeRatio: number;
    tradeRatio: number;
    volumePercentile180d: number | null;
    tradePercentile180d: number | null;
    rangePercentile180d: number | null;
    lowerWickPercentile180d: number | null;
    upperWickPercentile180d: number | null;
    averageLowerWick: number;
    averageUpperWick: number;
    averageDailyRange: number;
    return3d: number;
    cycleAgeDays: number | null;
    pricePosition90d: number | null;
    return30d: number | null;
    return90d: number | null;
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentileRank(values: number[], target: number) {
  if (values.length === 0) return null;
  return values.filter((value) => value <= target).length / values.length;
}

function tier(value: number, thresholds: [number, number, number], points: [number, number, number]) {
  if (value >= thresholds[2]) return points[2];
  if (value >= thresholds[1]) return points[1];
  if (value >= thresholds[0]) return points[0];
  return 0;
}

function confidenceFor(historyDays: number): HistoryConfidence {
  if (historyDays >= FULL_HISTORY_DAYS) return 'FULL';
  if (historyDays >= CYCLE_WINDOW_DAYS) return 'PARTIAL';
  return 'SHORT';
}

function setupStats(candles: DailyCandle[], endIndex: number): SetupStats {
  const setupWindow = candles.slice(endIndex - 7, endIndex);
  const referenceWindow = candles.slice(endIndex - 21, endIndex - 7);
  const setupVolume = median(setupWindow.map((candle) => candle.quoteVolume));
  const setupTrades = median(setupWindow.map((candle) => candle.tradeCount));
  return {
    volumeRatio: setupVolume / Math.max(median(referenceWindow.map((candle) => candle.quoteVolume)), Number.EPSILON),
    tradeRatio: setupTrades / Math.max(median(referenceWindow.map((candle) => candle.tradeCount)), Number.EPSILON),
    setupVolume,
    setupTrades,
    averageDailyRange: average(setupWindow.map((candle) => (candle.high - candle.low) / Math.max(candle.open, Number.EPSILON))),
    averageLowerWick: average(setupWindow.map((candle) =>
      (Math.min(candle.open, candle.close) - candle.low) / Math.max(candle.open, Number.EPSILON)
    )),
    averageUpperWick: average(setupWindow.map((candle) =>
      (candle.high - Math.max(candle.open, candle.close)) / Math.max(candle.open, Number.EPSILON)
    )),
  };
}

function percentilePoints(value: number | null, medium: number, high: number, topPoints: number) {
  if (value === null) return 0;
  if (value >= high) return topPoints;
  if (value >= medium) return Math.round(topPoints / 2);
  return 0;
}

/**
 * Returns a 0–100 watchlist rank. It uses only candles available at the time
 * of the latest candle: a 65 point short-term trigger and 35 point cycle layer.
 *
 * The trigger thresholds and percentile comparisons were calibrated against the
 * locally supplied Alpha pump history. A 200-day fetch supplies 180 days of
 * comparable historical 7-day windows; 60–199 day tokens retain a fallback
 * rank but are marked with lower confidence rather than being discarded.
 */
export function calculatePumpScore(candles: DailyCandle[]): PumpScore | null {
  if (candles.length < MINIMUM_HISTORY_DAYS) return null;

  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex];
  const current = setupStats(candles, latestIndex);
  const return3d = latest.close / Math.max(candles[latestIndex - 3].close, Number.EPSILON) - 1;

  // Build the long context from historical *7-day setups*, never from isolated daily candles.
  const firstContextEnd = Math.max(21, latestIndex - CONTEXT_WINDOW_DAYS);
  const historical = Array.from({ length: Math.max(0, latestIndex - firstContextEnd) }, (_, offset) =>
    setupStats(candles, firstContextEnd + offset)
  );
  const volumePercentile180d = percentileRank(historical.map((stats) => stats.setupVolume), current.setupVolume);
  const tradePercentile180d = percentileRank(historical.map((stats) => stats.setupTrades), current.setupTrades);
  const rangePercentile180d = percentileRank(historical.map((stats) => stats.averageDailyRange), current.averageDailyRange);
  const lowerWickPercentile180d = percentileRank(historical.map((stats) => stats.averageLowerWick), current.averageLowerWick);
  const upperWickPercentile180d = percentileRank(historical.map((stats) => stats.averageUpperWick), current.averageUpperWick);

  const priorCandles = candles.slice(0, -1);
  const hasCycleContext = priorCandles.length >= CYCLE_WINDOW_DAYS;
  const cycleWindow = priorCandles.slice(-CYCLE_WINDOW_DAYS);
  const cycleLowIndex = cycleWindow.reduce(
    (lowestIndex, candle, index) => candle.low < cycleWindow[lowestIndex].low ? index : lowestIndex,
    0
  );
  const cycleLow = cycleWindow[cycleLowIndex].low;
  const cycleHigh = Math.max(...cycleWindow.map((candle) => candle.high));
  const cycleAgeDays = hasCycleContext ? cycleWindow.length - 1 - cycleLowIndex : null;
  const pricePosition90d = hasCycleContext
    ? (latest.close - cycleLow) / Math.max(cycleHigh - cycleLow, Number.EPSILON)
    : null;
  const return30d = latestIndex >= 30
    ? latest.close / Math.max(candles[latestIndex - 30].close, Number.EPSILON) - 1
    : null;
  const return90d = latestIndex >= 90
    ? latest.close / Math.max(candles[latestIndex - 90].close, Number.EPSILON) - 1
    : null;

  const trigger = {
    volumeRatio: tier(current.volumeRatio, [1.15, 1.5, 2.5], [3, 6, 8]),
    tradeRatio: tier(current.tradeRatio, [1.15, 1.5, 2.5], [2, 4, 6]),
    volumePercentile: percentilePoints(volumePercentile180d, 0.7, 0.9, 10),
    tradePercentile: percentilePoints(tradePercentile180d, 0.7, 0.9, 8),
    rangePercentile: percentilePoints(rangePercentile180d, 0.7, 0.9, 12),
    unusualWicks: percentilePoints(Math.max(lowerWickPercentile180d ?? 0, upperWickPercentile180d ?? 0), 0.75, 0.9, 7),
    twoSidedWicks: (lowerWickPercentile180d ?? 0) >= 0.75 && (upperWickPercentile180d ?? 0) >= 0.75 ? 4 : 0,
    velocity: return3d > 0 && return3d <= 0.25 ? 5 : return3d <= 0 ? 1 : return3d <= 0.5 ? 2 : 0,
    liquidityConfluence: current.volumeRatio >= 1.5 && current.tradeRatio >= 1.5 &&
      (volumePercentile180d ?? 0) >= 0.8 && (tradePercentile180d ?? 0) >= 0.8 ? 5 : 0,
  };

  const cycle = {
    pricePosition: !hasCycleContext || pricePosition90d === null ? 0
      : pricePosition90d >= 0.55 && pricePosition90d <= 0.9 ? 12
        : pricePosition90d >= 0.35 && pricePosition90d <= 0.9 ? 7
          : pricePosition90d >= 0.15 && pricePosition90d < 0.35 ? 3 : 0,
    maturity: cycleAgeDays === null ? 0 : cycleAgeDays >= 60 && cycleAgeDays <= 89 ? 10
      : cycleAgeDays >= 30 && cycleAgeDays <= 59 ? 5 : 0,
    return30d: return30d === null ? 0 : return30d >= 0.1 && return30d <= 2 ? 8
      : return30d >= 0 && return30d < 0.1 ? 3 : return30d > 2 ? 2 : 0,
    return90d: return90d === null ? 0 : return90d >= 0 && return90d <= 3 ? 5 : return90d > 3 ? 3 : 0,
  };

  const triggerScore = Object.values(trigger).reduce((total, value) => total + value, 0);
  const cycleScore = Object.values(cycle).reduce((total, value) => total + value, 0);
  const blowOffPenalty = pricePosition90d !== null && pricePosition90d >= 0.95 && return3d > 0.5 ? 5 : 0;
  const score = Math.max(0, triggerScore + cycleScore - blowOffPenalty);
  const confidence = confidenceFor(candles.length);
  const phase: PumpPhase = cycleScore >= 20 && triggerScore >= 35
    ? 'ACCELERATION_READY'
    : cycleScore >= 20 ? 'EARLY_CYCLE'
      : triggerScore >= 35 ? 'TRIGGER_ONLY' : 'NO_CLEAR_SETUP';
  const level = score >= 72 && triggerScore >= 35 && confidence !== 'SHORT'
    ? 'HIGH' : score >= 45 ? 'WATCH' : 'LOW';

  return {
    score,
    triggerScore,
    cycleScore,
    level,
    phase,
    confidence,
    breakdown: { trigger, cycle: { ...cycle, blowOffPenalty: -blowOffPenalty } },
    metrics: {
      historyDays: candles.length,
      contextWindowDays: historical.length,
      volumeRatio: current.volumeRatio,
      tradeRatio: current.tradeRatio,
      volumePercentile180d,
      tradePercentile180d,
      rangePercentile180d,
      lowerWickPercentile180d,
      upperWickPercentile180d,
      averageLowerWick: current.averageLowerWick,
      averageUpperWick: current.averageUpperWick,
      averageDailyRange: current.averageDailyRange,
      return3d,
      cycleAgeDays,
      pricePosition90d,
      return30d,
      return90d,
    },
  };
}
