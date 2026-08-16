import { NextResponse } from 'next/server';

const ALPHA_TOKENS_URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
const USDT_M_FUTURES_EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const COIN_M_FUTURES_EXCHANGE_INFO_URL = 'https://dapi.binance.com/dapi/v1/exchangeInfo';
const SPOT_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

function normalizeAsset(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function addTradingFuturesAssets(payload: unknown, statusField: 'status' | 'contractStatus', assets: Set<string>) {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { symbols?: unknown }).symbols)) return;

  for (const contract of (payload as { symbols: unknown[] }).symbols) {
    if (!contract || typeof contract !== 'object') continue;
    const item = contract as Record<string, unknown>;
    if (item[statusField] !== 'TRADING') continue;

    const baseAsset = normalizeAsset(item.baseAsset);
    if (baseAsset) assets.add(baseAsset);
  }
}

function addTradingSpotUsdtAssets(payload: unknown, assets: Set<string>) {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { symbols?: unknown }).symbols)) return;

  for (const pair of (payload as { symbols: unknown[] }).symbols) {
    if (!pair || typeof pair !== 'object') continue;
    const item = pair as Record<string, unknown>;
    if (item.status !== 'TRADING' || item.quoteAsset !== 'USDT' || item.isSpotTradingAllowed !== true) continue;

    const baseAsset = normalizeAsset(item.baseAsset);
    if (baseAsset) assets.add(baseAsset);
  }
}

export async function GET() {
  try {
    const [alphaResponse, usdtFuturesResponse, coinFuturesResponse, spotResponse] = await Promise.all([
      fetch(ALPHA_TOKENS_URL, { headers: HEADERS, next: { revalidate: 10 } }),
      fetch(USDT_M_FUTURES_EXCHANGE_INFO_URL, { headers: HEADERS, next: { revalidate: 10 } }),
      fetch(COIN_M_FUTURES_EXCHANGE_INFO_URL, { headers: HEADERS, next: { revalidate: 10 } }),
      fetch(SPOT_EXCHANGE_INFO_URL, { headers: HEADERS, next: { revalidate: 10 } }),
    ]);

    if (!alphaResponse.ok) {
      return NextResponse.json(
        { error: `Failed to fetch Alpha tokens from Binance: ${alphaResponse.status} ${alphaResponse.statusText}` },
        { status: alphaResponse.status }
      );
    }

    if (!usdtFuturesResponse.ok || !coinFuturesResponse.ok) {
      const failedResponse = !usdtFuturesResponse.ok ? usdtFuturesResponse : coinFuturesResponse;
      return NextResponse.json(
        { error: `Failed to fetch Binance Futures exchange info: ${failedResponse.status} ${failedResponse.statusText}` },
        { status: failedResponse.status }
      );
    }

    if (!spotResponse.ok) {
      return NextResponse.json(
        { error: `Failed to fetch Binance Spot exchange info: ${spotResponse.status} ${spotResponse.statusText}` },
        { status: spotResponse.status }
      );
    }

    const [data, usdtFutures, coinFutures, spot] = await Promise.all([
      alphaResponse.json(),
      usdtFuturesResponse.json(),
      coinFuturesResponse.json(),
      spotResponse.json(),
    ]);

    if (data && Array.isArray(data.data)) {
      const futuresAssets = new Set<string>();
      addTradingFuturesAssets(usdtFutures, 'status', futuresAssets);
      addTradingFuturesAssets(coinFutures, 'contractStatus', futuresAssets);
      const spotUsdtAssets = new Set<string>();
      addTradingSpotUsdtAssets(spot, spotUsdtAssets);

      data.data = data.data.flatMap((token: Record<string, unknown>) => {
        const alphaSymbol = String(token.symbol ?? '');
        const futuresAsset = normalizeAsset(token.cexCoinName || token.symbol || token.alphaId);
        if (alphaSymbol.endsWith('on') || !futuresAsset || !futuresAssets.has(futuresAsset)) return [];
        return [{ ...token, hasBinanceSpotUsdt: spotUsdtAssets.has(futuresAsset) }];
      });
    }
    return NextResponse.json(data);
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
