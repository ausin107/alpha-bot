export const FUTURES_OI_MIN_QUOTE_VOLUME = 3_000_000;
export const FUTURES_OI_MIN_MARKET_CAP = 5_000_000;
export const FUTURES_OI_MAX_MARKET_CAP = 200_000_000;
export const FUTURES_OI_THRESHOLDS = [1.5, 1.75, 2] as const;
export const FUTURES_OI_MARKET_CAP_BONUS_MAX = 15;

export type OiTimeframe = '1d' | '3d' | '5d' | '7d';
export type OiTier = 'NORMAL' | 'X1_5' | 'X1_75' | 'X2';
export type OiSignalLevel = 'WATCH' | 'HIGH' | 'EXTREME';

export interface OpenInterestPoint {
  value: number;
  timestamp: number;
}

export interface OiComparison {
  timeframe: OiTimeframe;
  days: number;
  previousValue: number | null;
  ratio: number | null;
  changePercent: number | null;
  tier: OiTier;
  score: number;
}

export interface FuturesOiScanResult {
  rank: number;
  symbol: string;
  baseAsset: string;
  price: number;
  priceChangePercent24h: number;
  quoteVolume24h: number;
  currentOpenInterestValue: number;
  marketCap: number;
  oiToMarketCapPercent: number;
  oiScore: number;
  marketCapBonus: number;
  latestTimestamp: number;
  score: number;
  level: OiSignalLevel;
  strongestRatio: number;
  comparisons: Record<OiTimeframe, OiComparison>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TARGET_DISTANCE_MS = 18 * 60 * 60 * 1000;

const TIMEFRAMES: ReadonlyArray<{ timeframe: OiTimeframe; days: number; weight: number }> = [
  { timeframe: '1d', days: 1, weight: 35 },
  { timeframe: '3d', days: 3, weight: 30 },
  { timeframe: '5d', days: 5, weight: 20 },
  { timeframe: '7d', days: 7, weight: 15 },
];

function tierFor(ratio: number | null): OiTier {
  if (ratio === null) return 'NORMAL';
  if (ratio >= 2) return 'X2';
  if (ratio >= 1.75) return 'X1_75';
  if (ratio >= 1.5) return 'X1_5';
  return 'NORMAL';
}

function tierFactor(tier: OiTier) {
  if (tier === 'X2') return 1;
  if (tier === 'X1_75') return 0.8;
  if (tier === 'X1_5') return 0.6;
  return 0;
}

function closestPoint(points: OpenInterestPoint[], targetTimestamp: number) {
  let closest: OpenInterestPoint | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const point of points) {
    const distance = Math.abs(point.timestamp - targetTimestamp);
    if (distance < closestDistance) {
      closest = point;
      closestDistance = distance;
    }
  }

  return closest && closestDistance <= MAX_TARGET_DISTANCE_MS ? closest : null;
}

export function calculateFuturesOiScore(inputPoints: OpenInterestPoint[]) {
  const points = inputPoints
    .filter((point) => Number.isFinite(point.value) && point.value > 0 && Number.isFinite(point.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  const latest = points.at(-1);
  if (!latest) return null;

  const comparisons = {} as Record<OiTimeframe, OiComparison>;

  for (const config of TIMEFRAMES) {
    const previous = closestPoint(points.slice(0, -1), latest.timestamp - config.days * DAY_MS);
    const ratio = previous ? latest.value / previous.value : null;
    const tier = tierFor(ratio);
    comparisons[config.timeframe] = {
      timeframe: config.timeframe,
      days: config.days,
      previousValue: previous?.value ?? null,
      ratio,
      changePercent: ratio === null ? null : (ratio - 1) * 100,
      tier,
      score: Math.round(config.weight * tierFactor(tier)),
    };
  }

  const values = Object.values(comparisons);
  const score = values.reduce((total, comparison) => total + comparison.score, 0);
  const strongestRatio = Math.max(0, ...values.map((comparison) => comparison.ratio ?? 0));
  const level: OiSignalLevel = score >= 70 || strongestRatio >= 2
    ? 'EXTREME'
    : score >= 45 || strongestRatio >= 1.75
      ? 'HIGH'
      : 'WATCH';

  return {
    latest,
    comparisons,
    score,
    strongestRatio,
    level,
    isAbnormal: values.some((comparison) => comparison.tier !== 'NORMAL'),
  };
}

export function calculateOiMarketCapBonus(oiToMarketCapPercent: number) {
  if (oiToMarketCapPercent >= 20) return 15;
  if (oiToMarketCapPercent >= 10) return 10;
  if (oiToMarketCapPercent >= 5) return 5;
  return 0;
}
