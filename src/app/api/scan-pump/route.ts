import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { calculatePumpScore, PUMP_SCORE_VERSION, type DailyCandle, type PumpScore } from '@/lib/pump-score';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = 'https://www.binance.com/bapi/defi/v1/public';
const CACHE_VERSION = PUMP_SCORE_VERSION;
const KLINE_LIMIT = 200;
const MIN_MARKET_CAP = 2_000_000;
const MAX_MARKET_CAP = 200_000_000;
const MIN_VOLUME_24H = 100_000;
const MIN_PUMP_SCORE = 50;
const BSC_CHAIN_ID = '56';
type FuturesMarket = 'USDT_M' | 'COIN_M';
const CACHE_PATH = join(process.cwd(), 'data', 'pump-score-cache.json');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  Accept: 'application/json',
};

interface ScanResult {
  alphaId: string;
  tokenId: string;
  contractAddress: string;
  chainId: string;
  symbol: string;
  name: string;
  iconUrl: string | undefined;
  price: number;
  percentChange24h: number;
  volume24h: number;
  marketCap: number;
  futuresMarkets: FuturesMarket[];
  latestOpenTime: number;
  score: PumpScore;
}

interface CachedScan {
  version: number;
  generatedAt: string;
  candleLimit: number;
  results: ScanResult[];
  totalActiveTokens: number;
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

function addFuturesAssets(
  payload: unknown,
  market: FuturesMarket,
  assets: Map<string, Set<FuturesMarket>>
) {
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

function futuresMarketsForToken(token: Record<string, unknown>, assets: Map<string, Set<FuturesMarket>>) {
  const names = [normalizeAsset(token.cexCoinName), normalizeAsset(token.symbol)].filter(Boolean);
  const matches = new Set<FuturesMarket>();
  for (const name of names) {
    for (const market of assets.get(name) ?? []) matches.add(market);
  }
  return [...matches].sort() as FuturesMarket[];
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

async function readCache() {
  try {
    const cache = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as CachedScan;
    return cache.version === CACHE_VERSION && cache.candleLimit === KLINE_LIMIT && Array.isArray(cache.results) ? cache : null;
  } catch {
    return null;
  }
}

async function saveCache(cache: CachedScan) {
  // Vercel Functions do not have a persistent writable project filesystem.
  // The cron forces a fresh scan there; local development keeps the existing file cache.
  if (process.env.VERCEL) return;
  await mkdir(join(process.cwd(), 'data'), { recursive: true });
  const temporaryPath = `${CACHE_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, CACHE_PATH);
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

export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get('force') === '1';
  const cached = await readCache();
  if (cached && !force) {
    return NextResponse.json({ success: true, cached: true, ...cached });
  }

  try {
    const tokenPayload = await fetchJson(`${API_BASE}/wallet-direct/buw/wallet/cex/alpha/all/token/list`);
    const tokenList = tokenPayload.data ?? tokenPayload;
    if (!Array.isArray(tokenList)) throw new Error('Invalid Binance token list format');
    const [usdtFuturesPayload, coinFuturesPayload] = await Promise.all([
      fetchJson('https://fapi.binance.com/fapi/v1/exchangeInfo'),
      fetchJson('https://dapi.binance.com/dapi/v1/exchangeInfo'),
    ]);
    const futuresAssets = new Map<string, Set<FuturesMarket>>();
    addFuturesAssets(usdtFuturesPayload, 'USDT_M', futuresAssets);
    addFuturesAssets(coinFuturesPayload, 'COIN_M', futuresAssets);

    const activeTokens = tokenList.filter((token: Record<string, unknown>) => {
      const symbol = String(token.symbol ?? '');
      return Boolean(token.alphaId) && !token.offline && !token.fullyDelisted && !symbol.endsWith('on');
    });
    const bscTokens = activeTokens.filter((token: Record<string, unknown>) => String(token.chainId) === BSC_CHAIN_ID);
    const marketEligibleTokens = bscTokens.filter((token: Record<string, unknown>) => {
      const marketCap = asNumber(token.marketCap);
      const volume24h = asNumber(token.volume24h);
      return marketCap > MIN_MARKET_CAP && marketCap < MAX_MARKET_CAP && volume24h > MIN_VOLUME_24H;
    });
    const eligibleTokens = marketEligibleTokens.filter((token: Record<string, unknown>) =>
      futuresMarketsForToken(token, futuresAssets).length > 0
    );

    const scanned = await mapConcurrent(eligibleTokens, 6, async (token: Record<string, unknown>) => {
      try {
        const alphaId = String(token.alphaId);
        const symbol = alphaId.startsWith('ALPHA_') ? `${alphaId}USDT` : `ALPHA_${alphaId}USDT`;
        const klinePayload = await fetchJson(
          `${API_BASE}/alpha-trade/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${KLINE_LIMIT}`
        );
        const rows = klinePayload.data ?? klinePayload;
        if (!Array.isArray(rows)) return null;
        const candles = rows
          .filter((row: unknown): row is unknown[] => Array.isArray(row))
          .map(parseCandle)
          .filter((candle): candle is DailyCandle => candle !== null)
          .sort((a, b) => a.openTime - b.openTime);
        const score = calculatePumpScore(candles);
        if (!score) return null;

        return {
          alphaId,
          tokenId: String(token.tokenId ?? ''),
          contractAddress: String(token.contractAddress ?? ''),
          chainId: String(token.chainId ?? BSC_CHAIN_ID),
          symbol: String(token.symbol ?? alphaId),
          name: String(token.name ?? token.symbol ?? alphaId),
          iconUrl: typeof token.iconUrl === 'string' ? token.iconUrl : undefined,
          price: asNumber(token.price),
          percentChange24h: asNumber(token.percentChange24h),
          volume24h: asNumber(token.volume24h),
          marketCap: asNumber(token.marketCap),
          futuresMarkets: futuresMarketsForToken(token, futuresAssets),
          latestOpenTime: candles.at(-1)!.openTime,
          score,
        } satisfies ScanResult;
      } catch (error) {
        console.warn(`Pump scan skipped ${String(token.symbol ?? token.alphaId)}:`, error);
        return null;
      }
    });

    const scoredResults = scanned
      .filter((result): result is ScanResult => result !== null);
    const results = scoredResults
      .filter((result) => result.score.score > MIN_PUMP_SCORE)
      .sort((left, right) => right.score.score - left.score.score || right.volume24h - left.volume24h);
    const cache: CachedScan = {
      version: CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      candleLimit: KLINE_LIMIT,
      results,
      totalActiveTokens: activeTokens.length,
      chainFilteredOutTokens: activeTokens.length - bscTokens.length,
      futuresFilteredOutTokens: marketEligibleTokens.length - eligibleTokens.length,
      scannedTokens: eligibleTokens.length,
      filteredOutTokens: bscTokens.length - marketEligibleTokens.length,
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
