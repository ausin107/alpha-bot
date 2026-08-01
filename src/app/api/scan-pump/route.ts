import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { calculatePumpScore, PUMP_SCORE_VERSION, type DailyCandle, type PumpScore } from '@/lib/pump-score';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALPHA_API = 'https://www.binance.com/bapi/defi/v1/public';
const SPOT_API = 'https://api.binance.com/api/v3';
const CACHE_VERSION = PUMP_SCORE_VERSION;
const KLINE_LIMIT = 200;
const MIN_MARKET_CAP = 2_000_000;
const MAX_MARKET_CAP = 200_000_000;
const MIN_VOLUME_24H = 100_000;
const MIN_SPOT_VOLUME_24H = 5_000_000;
const MIN_PUMP_SCORE = 50;
const BSC_CHAIN_ID = '56';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  Accept: 'application/json',
};

type ScanMarket = 'alpha' | 'spot';
type FuturesMarket = 'USDT_M' | 'COIN_M';

interface Candidate {
  source: ScanMarket;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  price: number;
  percentChange24h: number;
  volume24h: number;
  marketCap: number;
  alphaId?: string;
  tokenId?: string;
  contractAddress?: string;
  chainId?: string;
  name: string;
  iconUrl?: string;
  futuresAsset: string;
}

interface ScanResult extends Candidate {
  futuresMarkets: FuturesMarket[];
  latestOpenTime: number;
  score: PumpScore;
}

interface CachedScan {
  version: number;
  generatedAt: string;
  market: ScanMarket;
  candleLimit: number;
  results: ScanResult[];
  totalCandidates: number;
  chainFilteredOutTokens: number;
  futuresFilteredOutTokens: number;
  scannedTokens: number;
  filteredOutTokens: number;
  failedTokens: number;
  scoreFilteredOutTokens: number;
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeAsset(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function addFuturesAssets(payload: unknown, market: FuturesMarket, assets: Map<string, Set<FuturesMarket>>) {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { symbols?: unknown }).symbols)) return;
  for (const contract of (payload as { symbols: unknown[] }).symbols) {
    if (!contract || typeof contract !== 'object') continue;
    const item = contract as Record<string, unknown>;
    const status = market === 'USDT_M' ? item.status : item.contractStatus;
    if (status !== 'TRADING') continue;
    const baseAsset = normalizeAsset(item.baseAsset);
    if (!baseAsset) continue;
    const markets = assets.get(baseAsset) ?? new Set<FuturesMarket>();
    markets.add(market);
    assets.set(baseAsset, markets);
  }
}

function futuresMarketsFor(candidate: Candidate, assets: Map<string, Set<FuturesMarket>>) {
  return [...(assets.get(normalizeAsset(candidate.futuresAsset)) ?? new Set<FuturesMarket>())]
    .sort() as FuturesMarket[];
}

function parseCandle(row: unknown[]): DailyCandle | null {
  if (row.length < 9) return null;
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

function cachePath(market: ScanMarket) {
  return join(process.cwd(), 'data', `pump-score-${market}-cache.json`);
}

async function readCache(market: ScanMarket) {
  try {
    const cache = JSON.parse(await readFile(cachePath(market), 'utf8')) as CachedScan;
    return cache.version === CACHE_VERSION && cache.market === market && cache.candleLimit === KLINE_LIMIT && Array.isArray(cache.results) ? cache : null;
  } catch {
    return null;
  }
}

async function saveCache(cache: CachedScan) {
  // Vercel Functions do not have a persistent writable project filesystem.
  // The cron forces a fresh Alpha scan there; local development keeps the existing file cache.
  if (process.env.VERCEL) return;
  await mkdir(join(process.cwd(), 'data'), { recursive: true });
  const destination = cachePath(cache.market);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!response.ok) throw new Error(`Binance responded ${response.status}`);
  return response.json();
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>) {
  const results: R[] = [];
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

async function alphaCandidates() {
  const tokenPayload = await fetchJson(`${ALPHA_API}/wallet-direct/buw/wallet/cex/alpha/all/token/list`);
  const tokenList = tokenPayload.data ?? tokenPayload;
  if (!Array.isArray(tokenList)) throw new Error('Invalid Binance Alpha token list format');
  const activeTokens = tokenList.filter((token: Record<string, unknown>) => {
    const symbol = String(token.symbol ?? '');
    return Boolean(token.alphaId) && !token.offline && !token.fullyDelisted && !symbol.endsWith('on');
  });
  const bscTokens = activeTokens.filter((token: Record<string, unknown>) => String(token.chainId) === BSC_CHAIN_ID);
  const marketEligibleTokens = bscTokens.filter((token: Record<string, unknown>) => {
    const marketCap = asNumber(token.marketCap);
    return marketCap > MIN_MARKET_CAP && marketCap < MAX_MARKET_CAP && asNumber(token.volume24h) > MIN_VOLUME_24H;
  });
  return {
    totalCandidates: activeTokens.length,
    chainFilteredOutTokens: activeTokens.length - bscTokens.length,
    filteredOutTokens: bscTokens.length - marketEligibleTokens.length,
    candidates: marketEligibleTokens.map((token: Record<string, unknown>) => ({
      source: 'alpha' as const,
      symbol: String(token.symbol ?? token.alphaId),
      baseAsset: String(token.symbol ?? token.alphaId),
      quoteAsset: 'USDT',
      price: asNumber(token.price),
      percentChange24h: asNumber(token.percentChange24h),
      volume24h: asNumber(token.volume24h),
      marketCap: asNumber(token.marketCap),
      alphaId: String(token.alphaId),
      tokenId: String(token.tokenId ?? ''),
      contractAddress: String(token.contractAddress ?? ''),
      chainId: String(token.chainId ?? BSC_CHAIN_ID),
      name: String(token.name ?? token.symbol ?? token.alphaId),
      iconUrl: typeof token.iconUrl === 'string' ? token.iconUrl : undefined,
      futuresAsset: String(token.cexCoinName || token.symbol || token.alphaId),
    } satisfies Candidate)),
  };
}

async function spotCandidates() {
  const [exchangeInfo, tickers] = await Promise.all([
    fetchJson(`${SPOT_API}/exchangeInfo`),
    fetchJson(`${SPOT_API}/ticker/24hr`),
  ]);
  if (!exchangeInfo || typeof exchangeInfo !== 'object' || !Array.isArray((exchangeInfo as { symbols?: unknown }).symbols)) {
    throw new Error('Invalid Binance Spot exchangeInfo format');
  }
  const tickerBySymbol = new Map(
    Array.isArray(tickers)
      ? tickers.filter((ticker): ticker is Record<string, unknown> => Boolean(ticker) && typeof ticker === 'object')
        .map((ticker) => [String(ticker.symbol), ticker])
      : []
  );
  const allPairs = (exchangeInfo as { symbols: unknown[] }).symbols
    .filter((pair): pair is Record<string, unknown> => Boolean(pair) && typeof pair === 'object')
    .filter((pair) => pair.status === 'TRADING' && pair.isSpotTradingAllowed === true && pair.quoteAsset === 'USDT');
  const liquidPairs = allPairs.filter((pair) => asNumber(tickerBySymbol.get(String(pair.symbol))?.quoteVolume) > MIN_SPOT_VOLUME_24H);
  return {
    totalCandidates: allPairs.length,
    chainFilteredOutTokens: 0,
    filteredOutTokens: allPairs.length - liquidPairs.length,
    candidates: liquidPairs.map((pair) => {
      const ticker = tickerBySymbol.get(String(pair.symbol));
      return {
        source: 'spot' as const,
        symbol: String(pair.symbol),
        baseAsset: String(pair.baseAsset),
        quoteAsset: 'USDT',
        price: asNumber(ticker?.lastPrice),
        percentChange24h: asNumber(ticker?.priceChangePercent),
        volume24h: asNumber(ticker?.quoteVolume),
        marketCap: 0,
        name: String(pair.baseAsset),
        futuresAsset: String(pair.baseAsset),
      } satisfies Candidate;
    }),
  };
}

async function scanCandidate(candidate: Candidate, futuresMarkets: FuturesMarket[]) {
  try {
    const url = candidate.source === 'spot'
      ? `${SPOT_API}/klines?symbol=${encodeURIComponent(candidate.symbol)}&interval=1d&limit=${KLINE_LIMIT}`
      : `${ALPHA_API}/alpha-trade/klines?symbol=${encodeURIComponent(candidate.alphaId!.startsWith('ALPHA_') ? `${candidate.alphaId}USDT` : `ALPHA_${candidate.alphaId}USDT`)}&interval=1d&limit=${KLINE_LIMIT}`;
    const payload = await fetchJson(url);
    const rows = candidate.source === 'spot' ? payload : payload.data ?? payload;
    if (!Array.isArray(rows)) return null;
    const candles = rows
      .filter((row: unknown): row is unknown[] => Array.isArray(row))
      .map(parseCandle)
      .filter((candle): candle is DailyCandle => candle !== null)
      .sort((left, right) => left.openTime - right.openTime);
    const score = calculatePumpScore(candles);
    if (!score) return null;
    return { ...candidate, futuresMarkets, latestOpenTime: candles.at(-1)!.openTime, score } satisfies ScanResult;
  } catch (error) {
    console.warn(`Pump scan skipped ${candidate.symbol}:`, error);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const market: ScanMarket = request.nextUrl.searchParams.get('market') === 'spot' ? 'spot' : 'alpha';
  const force = request.nextUrl.searchParams.get('force') === '1';
  const cached = await readCache(market);
  if (cached && !force) return NextResponse.json({ success: true, cached: true, ...cached });

  try {
    const source = market === 'spot' ? await spotCandidates() : await alphaCandidates();
    const [usdtFuturesPayload, coinFuturesPayload] = await Promise.all([
      fetchJson('https://fapi.binance.com/fapi/v1/exchangeInfo'),
      fetchJson('https://dapi.binance.com/dapi/v1/exchangeInfo'),
    ]);
    const futuresAssets = new Map<string, Set<FuturesMarket>>();
    addFuturesAssets(usdtFuturesPayload, 'USDT_M', futuresAssets);
    addFuturesAssets(coinFuturesPayload, 'COIN_M', futuresAssets);
    const eligibleTokens = source.candidates
      .map((candidate) => ({ candidate, futuresMarkets: futuresMarketsFor(candidate, futuresAssets) }))
      .filter(({ futuresMarkets }) => futuresMarkets.length > 0);
    const scanned = await mapConcurrent(eligibleTokens, 6, ({ candidate, futuresMarkets }) => scanCandidate(candidate, futuresMarkets));
    const scoredResults = scanned.filter((result): result is ScanResult => result !== null);
    const results = scoredResults
      .filter((result) => result.score.score > MIN_PUMP_SCORE)
      .sort((left, right) => right.score.score - left.score.score || right.volume24h - left.volume24h);
    const cache: CachedScan = {
      version: CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      market,
      candleLimit: KLINE_LIMIT,
      results,
      totalCandidates: source.totalCandidates,
      chainFilteredOutTokens: source.chainFilteredOutTokens,
      futuresFilteredOutTokens: source.candidates.length - eligibleTokens.length,
      scannedTokens: eligibleTokens.length,
      filteredOutTokens: source.filteredOutTokens,
      failedTokens: eligibleTokens.length - scoredResults.length,
      scoreFilteredOutTokens: scoredResults.length - results.length,
    };
    await saveCache(cache);
    return NextResponse.json({ success: true, cached: false, ...cache });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    console.error('Pump scan failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
