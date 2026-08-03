import { NextResponse } from 'next/server';
import {
  calculateFuturesOiScore,
  calculateOiMarketCapBonus,
  FUTURES_OI_MAX_MARKET_CAP,
  FUTURES_OI_MIN_MARKET_CAP,
  FUTURES_OI_MIN_QUOTE_VOLUME,
  FUTURES_OI_THRESHOLDS,
  type FuturesOiScanResult,
  type OpenInterestPoint,
} from '@/lib/futures-oi-score';

export const maxDuration = 60;

const FUTURES_API = 'https://fapi.binance.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_CONCURRENCY = 8;
const HEADERS = { 'User-Agent': 'alpha-bot-futures-oi-scanner/1.0' };

interface FuturesSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  contractType: string;
}

interface FuturesTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

interface OpenInterestResponse {
  sumOpenInterestValue: string;
  CMCCirculatingSupply: string;
  timestamp: number;
}

type ScanOutcome =
  | { status: 'FAILED' }
  | { status: 'MARKET_CAP_FILTERED' }
  | { status: 'NORMAL' }
  | { status: 'RESULT'; result: FuturesOiScanResult };

interface ScanPayload {
  generatedAt: string;
  durationMs: number;
  minQuoteVolume24h: number;
  minMarketCap: number;
  maxMarketCap: number;
  thresholds: readonly number[];
  universeSymbols: number;
  volumeEligibleSymbols: number;
  scannedSymbols: number;
  marketCapEligibleSymbols: number;
  marketCapFilteredSymbols: number;
  failedSymbols: number;
  anomalySymbols: number;
  results: FuturesOiScanResult[];
}

let cachedScan: { expiresAt: number; payload: ScanPayload } | null = null;
let inFlightScan: Promise<ScanPayload> | null = null;

function asNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchJson<T>(url: string, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: HEADERS,
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) return response.json() as Promise<T>;

      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Binance responded ${response.status}`);
      }
      lastError = new Error(`Binance responded ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }

  throw lastError instanceof Error ? lastError : new Error('Không thể tải dữ liệu Binance Futures');
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>) {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function scanSymbol(symbol: FuturesSymbol, ticker: FuturesTicker) {
  try {
    const rows = await fetchJson<OpenInterestResponse[]>(
      `${FUTURES_API}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol.symbol)}&period=1d&limit=8`
    );
    if (!Array.isArray(rows)) return { status: 'FAILED' } satisfies ScanOutcome;

    const points: OpenInterestPoint[] = rows.map((row) => ({
      value: asNumber(row.sumOpenInterestValue),
      timestamp: asNumber(row.timestamp),
    }));
    const analysis = calculateFuturesOiScore(points);
    if (!analysis) return { status: 'FAILED' } satisfies ScanOutcome;

    const latestRow = rows
      .filter((row) => asNumber(row.timestamp) === analysis.latest.timestamp)
      .at(-1);
    const circulatingSupply = asNumber(latestRow?.CMCCirculatingSupply);
    const price = asNumber(ticker.lastPrice);
    // Binance normalizes CMC supply to the contract unit for multiplier symbols
    // such as 1000PEPE, so price × supplied units already yields market cap.
    const marketCap = price * circulatingSupply;
    if (marketCap <= FUTURES_OI_MIN_MARKET_CAP || marketCap >= FUTURES_OI_MAX_MARKET_CAP) {
      return { status: 'MARKET_CAP_FILTERED' } satisfies ScanOutcome;
    }
    if (!analysis.isAbnormal) return { status: 'NORMAL' } satisfies ScanOutcome;

    const oiToMarketCapPercent = analysis.latest.value / marketCap * 100;
    const marketCapBonus = calculateOiMarketCapBonus(oiToMarketCapPercent);
    const score = analysis.score + marketCapBonus;
    const level: FuturesOiScanResult['level'] = score >= 80 || analysis.strongestRatio >= 2
      ? 'EXTREME'
      : score >= 50 || analysis.strongestRatio >= 1.75
        ? 'HIGH'
        : 'WATCH';

    return {
      status: 'RESULT',
      result: {
        rank: 0,
        symbol: symbol.symbol,
        baseAsset: symbol.baseAsset,
        price,
        priceChangePercent24h: asNumber(ticker.priceChangePercent),
        quoteVolume24h: asNumber(ticker.quoteVolume),
        currentOpenInterestValue: analysis.latest.value,
        marketCap,
        oiToMarketCapPercent,
        oiScore: analysis.score,
        marketCapBonus,
        latestTimestamp: analysis.latest.timestamp,
        score,
        level,
        strongestRatio: analysis.strongestRatio,
        comparisons: analysis.comparisons,
      } satisfies FuturesOiScanResult,
    } satisfies ScanOutcome;
  } catch (error) {
    console.warn(`Futures OI scan skipped ${symbol.symbol}:`, error);
    return { status: 'FAILED' } satisfies ScanOutcome;
  }
}

async function runScan(): Promise<ScanPayload> {
  const startedAt = Date.now();
  const [exchangeInfo, tickers] = await Promise.all([
    fetchJson<{ symbols: FuturesSymbol[] }>(`${FUTURES_API}/fapi/v1/exchangeInfo`),
    fetchJson<FuturesTicker[]>(`${FUTURES_API}/fapi/v1/ticker/24hr`),
  ]);

  if (!Array.isArray(exchangeInfo.symbols) || !Array.isArray(tickers)) {
    throw new Error('Dữ liệu Binance Futures không đúng định dạng');
  }

  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  const universe = exchangeInfo.symbols.filter((symbol) =>
    symbol.status === 'TRADING' &&
    symbol.contractType === 'PERPETUAL' &&
    symbol.quoteAsset === 'USDT'
  );
  const candidates = universe
    .map((symbol) => ({ symbol, ticker: tickerBySymbol.get(symbol.symbol) }))
    .filter((item): item is { symbol: FuturesSymbol; ticker: FuturesTicker } =>
      Boolean(item.ticker) && asNumber(item.ticker?.quoteVolume) > FUTURES_OI_MIN_QUOTE_VOLUME
    );

  const scanned = await mapConcurrent(candidates, REQUEST_CONCURRENCY, ({ symbol, ticker }) =>
    scanSymbol(symbol, ticker)
  );
  const failedSymbols = scanned.filter((outcome) => outcome.status === 'FAILED').length;
  const marketCapFilteredSymbols = scanned.filter((outcome) => outcome.status === 'MARKET_CAP_FILTERED').length;
  const marketCapEligibleSymbols = scanned.length - failedSymbols - marketCapFilteredSymbols;
  const results = scanned
    .filter((outcome): outcome is Extract<ScanOutcome, { status: 'RESULT' }> => outcome.status === 'RESULT')
    .map((outcome) => outcome.result)
    .sort((left, right) =>
      right.score - left.score ||
      right.strongestRatio - left.strongestRatio ||
      right.currentOpenInterestValue - left.currentOpenInterestValue
    )
    .map((result, index) => ({ ...result, rank: index + 1 }));

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    minQuoteVolume24h: FUTURES_OI_MIN_QUOTE_VOLUME,
    minMarketCap: FUTURES_OI_MIN_MARKET_CAP,
    maxMarketCap: FUTURES_OI_MAX_MARKET_CAP,
    thresholds: FUTURES_OI_THRESHOLDS,
    universeSymbols: universe.length,
    volumeEligibleSymbols: candidates.length,
    scannedSymbols: candidates.length - failedSymbols,
    marketCapEligibleSymbols,
    marketCapFilteredSymbols,
    failedSymbols,
    anomalySymbols: results.length,
    results,
  };
}

export async function GET() {
  try {
    const now = Date.now();
    if (cachedScan && cachedScan.expiresAt > now) {
      return NextResponse.json({ success: true, cached: true, ...cachedScan.payload });
    }

    inFlightScan ??= runScan().finally(() => {
      inFlightScan = null;
    });
    const payload = await inFlightScan;
    cachedScan = { expiresAt: Date.now() + CACHE_TTL_MS, payload };
    return NextResponse.json({ success: true, cached: false, ...payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lỗi hệ thống khi quét Futures OI';
    console.error('Futures OI scan failed:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
