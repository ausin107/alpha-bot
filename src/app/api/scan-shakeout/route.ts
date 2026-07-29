import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { type DailyCandle } from '@/lib/pump-score';
import { detectShakeoutStructure, type ShakeoutStructure } from '@/lib/shakeout-detector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALPHA_API = 'https://www.binance.com/bapi/defi/v1/public';
const SPOT_API = 'https://api.binance.com/api/v3';
const KLINE_LIMIT = 200;
const SCORE_THRESHOLD = 60;
const CACHE_VERSION = 3;
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
  alphaId?: string;
  tokenId?: string;
  name?: string;
  iconUrl?: string;
  /** Asset name used to match a Binance Futures baseAsset. */
  futuresAsset: string;
  futuresMarkets?: FuturesMarket[];
}

interface ShakeoutResult extends Candidate {
  latestOpenTime: number;
  structure: ShakeoutStructure;
}

interface CachedScan {
  version: number;
  generatedAt: string;
  market: ScanMarket;
  totalCandidates: number;
  futuresFilteredOutCandidates: number;
  scannedCandidates: number;
  failedCandidates: number;
  results: ShakeoutResult[];
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeAsset(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function addFuturesAssets(payload: unknown, market: FuturesMarket, assets: Map<string, Set<FuturesMarket>>) {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { symbols?: unknown }).symbols)) return;
  for (const item of (payload as { symbols: unknown[] }).symbols) {
    if (!item || typeof item !== 'object') continue;
    const contract = item as Record<string, unknown>;
    const active = market === 'USDT_M' ? contract.status === 'TRADING' : contract.contractStatus === 'TRADING';
    if (!active) continue;
    const asset = normalizeAsset(contract.baseAsset);
    if (!asset) continue;
    const markets = assets.get(asset) ?? new Set<FuturesMarket>();
    markets.add(market);
    assets.set(asset, markets);
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

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!response.ok) throw new Error(`Binance responded ${response.status} for ${url}`);
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

function cachePath(market: ScanMarket) {
  return join(process.cwd(), 'data', `shakeout-${market}-cache.json`);
}

async function readCache(market: ScanMarket) {
  try {
    const cache = JSON.parse(await readFile(cachePath(market), 'utf8')) as CachedScan;
    return cache.version === CACHE_VERSION && cache.market === market && Array.isArray(cache.results) ? cache : null;
  } catch {
    return null;
  }
}

async function saveCache(cache: CachedScan) {
  await mkdir(join(process.cwd(), 'data'), { recursive: true });
  const destination = cachePath(cache.market);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

async function alphaCandidates() {
  const payload = await fetchJson(`${ALPHA_API}/wallet-direct/buw/wallet/cex/alpha/all/token/list`);
  const tokens = payload.data ?? payload;
  if (!Array.isArray(tokens)) throw new Error('Invalid Binance Alpha token list format');
  return tokens
    .filter((token: Record<string, unknown>) =>
      Boolean(token.alphaId) && String(token.chainId) === '56' && !token.offline && !token.fullyDelisted && !String(token.symbol ?? '').endsWith('on')
    )
    .map((token: Record<string, unknown>) => {
      const alphaId = String(token.alphaId);
      return {
        source: 'alpha' as const,
        symbol: alphaId.startsWith('ALPHA_') ? `${alphaId}USDT` : `ALPHA_${alphaId}USDT`,
        baseAsset: String(token.symbol ?? alphaId),
        quoteAsset: 'USDT',
        alphaId,
        tokenId: String(token.tokenId ?? ''),
        name: String(token.name ?? token.symbol ?? alphaId),
        iconUrl: typeof token.iconUrl === 'string' ? token.iconUrl : undefined,
        // Alpha's cexCoinName is Binance's canonical CEX/Futures ticker when available.
        futuresAsset: String(token.cexCoinName || token.symbol || alphaId),
      } satisfies Candidate;
    });
}

async function spotCandidates() {
  const payload = await fetchJson(`${SPOT_API}/exchangeInfo`);
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { symbols?: unknown }).symbols)) {
    throw new Error('Invalid Binance Spot exchangeInfo format');
  }
  return (payload as { symbols: unknown[] }).symbols
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((pair) => pair.status === 'TRADING' && pair.isSpotTradingAllowed === true && pair.quoteAsset === 'USDT')
    .map((pair) => ({
      source: 'spot' as const,
      symbol: String(pair.symbol),
      baseAsset: String(pair.baseAsset),
      quoteAsset: String(pair.quoteAsset),
      name: String(pair.baseAsset),
      futuresAsset: String(pair.baseAsset),
    } satisfies Candidate));
}

async function scanCandidate(candidate: Candidate) {
  try {
    const url = candidate.source === 'spot'
      ? `${SPOT_API}/klines?symbol=${encodeURIComponent(candidate.symbol)}&interval=1d&limit=${KLINE_LIMIT}`
      : `${ALPHA_API}/alpha-trade/klines?symbol=${encodeURIComponent(candidate.symbol)}&interval=1d&limit=${KLINE_LIMIT}`;
    const payload = await fetchJson(url);
    const rows = candidate.source === 'spot' ? payload : payload.data ?? payload;
    if (!Array.isArray(rows)) return null;
    const candles = rows
      .filter((row: unknown): row is unknown[] => Array.isArray(row))
      .map(parseCandle)
      .filter((candle): candle is DailyCandle => candle !== null)
      .sort((left, right) => left.openTime - right.openTime);
    const structure = detectShakeoutStructure(candles);
    if (!structure || structure.score < SCORE_THRESHOLD) return null;
    return { ...candidate, latestOpenTime: candles.at(-1)!.openTime, structure } satisfies ShakeoutResult;
  } catch (error) {
    console.warn(`Shakeout scan skipped ${candidate.symbol}:`, error);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const marketParam = request.nextUrl.searchParams.get('market');
  const market: ScanMarket = marketParam === 'spot' ? 'spot' : 'alpha';
  const force = request.nextUrl.searchParams.get('force') === '1';
  const requestedSymbol = request.nextUrl.searchParams.get('symbol')?.toUpperCase();
  if (!requestedSymbol) {
    const cached = await readCache(market);
    if (cached && !force) return NextResponse.json({ success: true, cached: true, ...cached });
  }

  try {
    const allCandidates = market === 'spot' ? await spotCandidates() : await alphaCandidates();
    const requestedCandidates = requestedSymbol
      ? allCandidates.filter((candidate) => candidate.symbol === requestedSymbol || candidate.baseAsset === requestedSymbol)
      : allCandidates;
    if (requestedSymbol && requestedCandidates.length === 0) {
      return NextResponse.json({ error: `No ${market} candidate found for ${requestedSymbol}` }, { status: 404 });
    }
    const [usdtFutures, coinFutures] = await Promise.all([
      fetchJson('https://fapi.binance.com/fapi/v1/exchangeInfo'),
      fetchJson('https://dapi.binance.com/dapi/v1/exchangeInfo'),
    ]);
    const futuresAssets = new Map<string, Set<FuturesMarket>>();
    addFuturesAssets(usdtFutures, 'USDT_M', futuresAssets);
    addFuturesAssets(coinFutures, 'COIN_M', futuresAssets);
    const candidates = requestedCandidates
      .map((candidate) => ({ ...candidate, futuresMarkets: futuresMarketsFor(candidate, futuresAssets) }))
      .filter((candidate) => candidate.futuresMarkets.length > 0);
    if (requestedSymbol && candidates.length === 0) {
      return NextResponse.json({ error: `${requestedSymbol} has no active Binance Futures listing` }, { status: 404 });
    }
    const scanned = await mapConcurrent(candidates, 8, scanCandidate);
    const detected = scanned.filter((result): result is ShakeoutResult => result !== null);
    // The main table is deliberately actionable: partial structures are useful
    // research notes but too noisy to mix with armed/confirmed setups.
    const results = detected
      .filter((result) => result.structure.phase === 'ARMED_FOR_BREAKOUT' || result.structure.phase === 'BREAKOUT_CONFIRMED')
      .sort((left, right) => right.structure.score - left.structure.score);
    const cache: CachedScan = {
      version: CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      market,
      totalCandidates: allCandidates.length,
      futuresFilteredOutCandidates: requestedCandidates.length - candidates.length,
      scannedCandidates: candidates.length,
      failedCandidates: candidates.length - results.length,
      results,
    };
    if (!requestedSymbol) await saveCache(cache);
    return NextResponse.json({ success: true, cached: false, ...cache });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
