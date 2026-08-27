import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { type DailyCandle } from '@/lib/pump-score';
import { analyzeWickRejections, type WickAnalysisResult } from '@/lib/wick-detector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALPHA_API = 'https://www.binance.com/bapi/defi/v1/public';
const SPOT_API = 'https://api.binance.com/api/v3';
const KLINE_LIMIT = 35;
const DEFAULT_MIN_WICK = 20;
const CACHE_VERSION = 1;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

export type ScanMarketType = 'all' | 'alpha' | 'spot';
export type FuturesMarketType = 'USDT_M' | 'COIN_M';

export interface WickCandidate {
  source: 'alpha' | 'spot';
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name: string;
  price: number;
  percentChange24h: number;
  volume24h: number;
  marketCap?: number;
  alphaId?: string;
  tokenId?: string;
  contractAddress?: string;
  chainId?: string;
  iconUrl?: string;
  futuresAsset: string;
  futuresMarkets: FuturesMarketType[];
}

export interface WickScanResultItem extends WickCandidate {
  latestOpenTime: number;
  analysis: WickAnalysisResult;
}

export interface CachedWickScan {
  version: number;
  generatedAt: string;
  market: ScanMarketType;
  minWickPercent: number;
  totalAlphaCandidates: number;
  totalSpotCandidates: number;
  scannedCandidates: number;
  failedCandidates: number;
  todayWickCount: number;
  yesterdayWickCount: number;
  past7dWickCount: number;
  results: WickScanResultItem[];
}

function asNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeAsset(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function addFuturesAssets(payload: unknown, market: FuturesMarketType, assets: Map<string, Set<FuturesMarketType>>) {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { symbols?: unknown }).symbols)) return;
  for (const contract of (payload as { symbols: unknown[] }).symbols) {
    if (!contract || typeof contract !== 'object') continue;
    const item = contract as Record<string, unknown>;
    const status = market === 'USDT_M' ? item.status : item.contractStatus;
    if (status !== 'TRADING') continue;
    const baseAsset = normalizeAsset(item.baseAsset);
    if (!baseAsset) continue;
    const markets = assets.get(baseAsset) ?? new Set<FuturesMarketType>();
    markets.add(market);
    assets.set(baseAsset, markets);
  }
}

function futuresMarketsFor(candidate: { futuresAsset: string }, assets: Map<string, Set<FuturesMarketType>>): FuturesMarketType[] {
  return [...(assets.get(normalizeAsset(candidate.futuresAsset)) ?? new Set<FuturesMarketType>())].sort() as FuturesMarketType[];
}

function parseCandle(row: unknown[]): DailyCandle | null {
  if (!Array.isArray(row) || row.length < 9) return null;
  const candle: DailyCandle = {
    openTime: asNumber(row[0]),
    open: asNumber(row[1]),
    high: asNumber(row[2]),
    low: asNumber(row[3]),
    close: asNumber(row[4]),
    quoteVolume: asNumber(row[7]),
    tradeCount: asNumber(row[8]),
  };
  return candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 ? candle : null;
}

async function fetchJson(url: string, timeoutMs = 12000) {
  const response = await fetch(url, {
    headers: HEADERS,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Binance HTTP ${response.status} for ${url}`);
  return response.json();
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function cachePath() {
  return join(process.cwd(), 'data', 'wick-scan-cache.json');
}

async function readCache(): Promise<CachedWickScan | null> {
  try {
    const cache = JSON.parse(await readFile(cachePath(), 'utf8')) as CachedWickScan;
    if (cache.version === CACHE_VERSION && Array.isArray(cache.results)) {
      return cache;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveCache(cache: CachedWickScan) {
  if (process.env.VERCEL) return;
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    const destination = cachePath();
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
  } catch (err) {
    console.warn('Could not save wick cache file:', err);
  }
}

async function getAlphaCandidates(futuresAssets: Map<string, Set<FuturesMarketType>>): Promise<WickCandidate[]> {
  const payload = await fetchJson(`${ALPHA_API}/wallet-direct/buw/wallet/cex/alpha/all/token/list`);
  const tokenList = payload.data ?? payload;
  if (!Array.isArray(tokenList)) throw new Error('Invalid Binance Alpha token list format');

  return tokenList
    .filter((token: Record<string, unknown>) => {
      const symbol = String(token.symbol ?? '');
      return Boolean(token.alphaId) && !token.offline && !token.fullyDelisted && !symbol.endsWith('on');
    })
    .map((token: Record<string, unknown>) => {
      const alphaId = String(token.alphaId);
      const futuresAsset = String(token.cexCoinName || token.symbol || alphaId);
      const futuresMarkets = futuresMarketsFor({ futuresAsset }, futuresAssets);
      return {
        source: 'alpha' as const,
        symbol: String(token.symbol ?? alphaId),
        baseAsset: String(token.symbol ?? alphaId),
        quoteAsset: 'USDT',
        name: String(token.name ?? token.symbol ?? alphaId),
        price: asNumber(token.price),
        percentChange24h: asNumber(token.percentChange24h),
        volume24h: asNumber(token.volume24h),
        marketCap: asNumber(token.marketCap),
        alphaId,
        tokenId: String(token.tokenId ?? ''),
        contractAddress: String(token.contractAddress ?? ''),
        chainId: String(token.chainId ?? '56'),
        iconUrl: typeof token.iconUrl === 'string' ? token.iconUrl : undefined,
        futuresAsset,
        futuresMarkets,
      } satisfies WickCandidate;
    })
    .filter((c) => c.futuresMarkets.length > 0); // Chỉ lấy token Alpha CÓ Binance Futures
}

async function getSpotCandidates(futuresAssets: Map<string, Set<FuturesMarketType>>): Promise<WickCandidate[]> {
  const [exchangeInfo, tickers] = await Promise.all([
    fetchJson(`${SPOT_API}/exchangeInfo`),
    fetchJson(`${SPOT_API}/ticker/24hr`),
  ]);

  if (!exchangeInfo || typeof exchangeInfo !== 'object' || !Array.isArray((exchangeInfo as { symbols?: unknown }).symbols)) {
    throw new Error('Invalid Binance Spot exchangeInfo format');
  }

  const tickerBySymbol = new Map(
    Array.isArray(tickers)
      ? tickers.filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
        .map((t) => [String(t.symbol), t])
      : []
  );

  return (exchangeInfo as { symbols: unknown[] }).symbols
    .filter((pair): pair is Record<string, unknown> => Boolean(pair) && typeof pair === 'object')
    .filter((pair) => pair.status === 'TRADING' && pair.isSpotTradingAllowed === true && pair.quoteAsset === 'USDT')
    .map((pair) => {
      const symbol = String(pair.symbol);
      const baseAsset = String(pair.baseAsset);
      const ticker = tickerBySymbol.get(symbol);
      const futuresMarkets = futuresMarketsFor({ futuresAsset: baseAsset }, futuresAssets);
      return {
        source: 'spot' as const,
        symbol,
        baseAsset,
        quoteAsset: 'USDT',
        name: baseAsset,
        price: asNumber(ticker?.lastPrice),
        percentChange24h: asNumber(ticker?.priceChangePercent),
        volume24h: asNumber(ticker?.quoteVolume),
        marketCap: 0,
        futuresAsset: baseAsset,
        futuresMarkets,
      } satisfies WickCandidate;
    });
}

async function scanCandidateWick(candidate: WickCandidate, minWick: number): Promise<WickScanResultItem | null> {
  try {
    const symbolParam = candidate.source === 'spot'
      ? candidate.symbol
      : (candidate.alphaId?.startsWith('ALPHA_') ? `${candidate.alphaId}USDT` : `ALPHA_${candidate.alphaId}USDT`);

    const url = candidate.source === 'spot'
      ? `${SPOT_API}/klines?symbol=${encodeURIComponent(symbolParam)}&interval=1d&limit=${KLINE_LIMIT}`
      : `${ALPHA_API}/alpha-trade/klines?symbol=${encodeURIComponent(symbolParam)}&interval=1d&limit=${KLINE_LIMIT}`;

    const payload = await fetchJson(url, 10000);
    const rows = candidate.source === 'spot' ? payload : payload.data ?? payload;
    if (!Array.isArray(rows)) return null;

    const candles = rows
      .filter((row: unknown): row is unknown[] => Array.isArray(row))
      .map(parseCandle)
      .filter((candle): candle is DailyCandle => candle !== null)
      .sort((left, right) => left.openTime - right.openTime);

    if (candles.length === 0) return null;

    const analysis = analyzeWickRejections(candles, { minWickPercent: minWick, lookbackDays: 30 });
    if (!analysis || !analysis.hasWick30d) return null;

    const latestOpenTime = candles.at(-1)!.openTime;
    return {
      ...candidate,
      latestOpenTime,
      analysis,
    };
  } catch (error) {
    console.warn(`Wick scan skipped for ${candidate.symbol}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get('force') === '1';
  const marketParam = (request.nextUrl.searchParams.get('market') || 'all') as ScanMarketType;
  const minWick = asNumber(request.nextUrl.searchParams.get('minWick')) || DEFAULT_MIN_WICK;

  // Đọc từ cache nếu có và không force
  if (!force) {
    const cached = await readCache();
    if (cached) {
      let filteredResults = cached.results;
      if (marketParam === 'alpha') {
        filteredResults = filteredResults.filter((r) => r.source === 'alpha');
      } else if (marketParam === 'spot') {
        filteredResults = filteredResults.filter((r) => r.source === 'spot');
      }

      return NextResponse.json({
        success: true,
        cached: true,
        generatedAt: cached.generatedAt,
        market: marketParam,
        minWickPercent: cached.minWickPercent,
        totalAlphaCandidates: cached.totalAlphaCandidates,
        totalSpotCandidates: cached.totalSpotCandidates,
        scannedCandidates: cached.scannedCandidates,
        failedCandidates: cached.failedCandidates,
        todayWickCount: filteredResults.filter((r) => r.analysis.hasTodayWick).length,
        yesterdayWickCount: filteredResults.filter((r) => r.analysis.hasYesterdayWick).length,
        past7dWickCount: filteredResults.filter((r) => r.analysis.hasPast7dWick).length,
        results: filteredResults,
      });
    }
  }

  try {
    // 1. Tải thông tin Futures để filter Alpha và phân loại Spot
    const [usdtFuturesPayload, coinFuturesPayload] = await Promise.all([
      fetchJson('https://fapi.binance.com/fapi/v1/exchangeInfo'),
      fetchJson('https://dapi.binance.com/dapi/v1/exchangeInfo'),
    ]);

    const futuresAssets = new Map<string, Set<FuturesMarketType>>();
    addFuturesAssets(usdtFuturesPayload, 'USDT_M', futuresAssets);
    addFuturesAssets(coinFuturesPayload, 'COIN_M', futuresAssets);

    // 2. Lấy danh sách ứng viên (Alpha có Futures và toàn bộ Spot USDT)
    const [alphaCandidates, spotCandidates] = await Promise.all([
      getAlphaCandidates(futuresAssets),
      getSpotCandidates(futuresAssets),
    ]);

    const allCandidates = [...alphaCandidates, ...spotCandidates];

    // 3. Quét nến 1D đồng thời với concurrency = 8
    const scanned = await mapConcurrent(allCandidates, 8, (candidate) =>
      scanCandidateWick(candidate, minWick)
    );

    const validResults = scanned.filter((r): r is WickScanResultItem => r !== null);

    // 4. Sắp xếp:
    // - Nến hôm nay rút râu lên trước
    // - Nến hôm qua rút râu
    // - Theo số ngày gần nhất (offsetDays tăng dần)
    // - Theo mức % rút râu cao nhất giảm dần
    const sortedResults = validResults.sort((a, b) => {
      const aOffset = a.analysis.latestWickEvent?.offsetDays ?? 999;
      const bOffset = b.analysis.latestWickEvent?.offsetDays ?? 999;
      if (aOffset !== bOffset) return aOffset - bOffset;

      const aMax = a.analysis.maxRebound30d;
      const bMax = b.analysis.maxRebound30d;
      return bMax - aMax || b.volume24h - a.volume24h;
    });

    const cache: CachedWickScan = {
      version: CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      market: 'all',
      minWickPercent: minWick,
      totalAlphaCandidates: alphaCandidates.length,
      totalSpotCandidates: spotCandidates.length,
      scannedCandidates: allCandidates.length,
      failedCandidates: allCandidates.length - validResults.length,
      todayWickCount: sortedResults.filter((r) => r.analysis.hasTodayWick).length,
      yesterdayWickCount: sortedResults.filter((r) => r.analysis.hasYesterdayWick).length,
      past7dWickCount: sortedResults.filter((r) => r.analysis.hasPast7dWick).length,
      results: sortedResults,
    };

    await saveCache(cache);

    let responseResults = sortedResults;
    if (marketParam === 'alpha') {
      responseResults = responseResults.filter((r) => r.source === 'alpha');
    } else if (marketParam === 'spot') {
      responseResults = responseResults.filter((r) => r.source === 'spot');
    }

    return NextResponse.json({
      success: true,
      cached: false,
      generatedAt: cache.generatedAt,
      market: marketParam,
      minWickPercent: minWick,
      totalAlphaCandidates: cache.totalAlphaCandidates,
      totalSpotCandidates: cache.totalSpotCandidates,
      scannedCandidates: cache.scannedCandidates,
      failedCandidates: cache.failedCandidates,
      todayWickCount: responseResults.filter((r) => r.analysis.hasTodayWick).length,
      yesterdayWickCount: responseResults.filter((r) => r.analysis.hasYesterdayWick).length,
      past7dWickCount: responseResults.filter((r) => r.analysis.hasPast7dWick).length,
      results: responseResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    console.error('Wick scan failed:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
