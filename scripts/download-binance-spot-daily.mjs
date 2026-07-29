import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SPOT_API = 'https://api.binance.com/api/v3';
const OUTPUT_DIR = join(process.cwd(), 'data', 'binance-spot-daily');
const [requestedSymbol = 'BANKUSDT', startDate = '2026-03-30', endDate = '2026-07-14'] = process.argv.slice(2);
const symbol = requestedSymbol.toUpperCase();

function startOfUtcDay(date) {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) throw new Error(`Invalid date: ${date}. Use YYYY-MM-DD.`);
  return timestamp;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${response.statusText}`);
  return response.json();
}

function toCandle(row) {
  return {
    openTime: row[0],
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
    closeTime: row[6],
    quoteVolume: row[7],
    tradeCount: row[8],
    takerBuyBaseVolume: row[9],
    takerBuyQuoteVolume: row[10],
    ignore: row[11],
  };
}

const exchangeInfo = await getJson(`${SPOT_API}/exchangeInfo?symbol=${encodeURIComponent(symbol)}`);
const market = exchangeInfo.symbols?.[0];
if (!market || market.symbol !== symbol) throw new Error(`${symbol} was not found on Binance Spot.`);
if (market.status !== 'TRADING' || !market.isSpotTradingAllowed) {
  throw new Error(`${symbol} is not currently tradable on Binance Spot.`);
}
if (market.quoteAsset !== 'USDT') {
  throw new Error(`${symbol} is not a USDT-quoted pair (quote asset: ${market.quoteAsset}).`);
}

const startTime = startOfUtcDay(startDate);
const endExclusiveTime = startOfUtcDay(endDate) + 24 * 60 * 60 * 1000;
if (endExclusiveTime <= startTime) throw new Error('End date must be on or after start date.');

const klines = await getJson(
  `${SPOT_API}/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&startTime=${startTime}&endTime=${endExclusiveTime - 1}&limit=1000`
);
if (!Array.isArray(klines)) throw new Error(`Unexpected kline response for ${symbol}.`);

const output = {
  source: `${SPOT_API}/klines`,
  exchangeInfoSource: `${SPOT_API}/exchangeInfo`,
  fetchedAt: new Date().toISOString(),
  market: 'spot',
  symbol,
  baseAsset: market.baseAsset,
  quoteAsset: market.quoteAsset,
  interval: '1d',
  range: {
    startInclusive: startDate,
    endInclusive: endDate,
    timezone: 'UTC',
  },
  returnedCount: klines.length,
  candles: klines.map(toCandle),
};

await mkdir(OUTPUT_DIR, { recursive: true });
const outputName = `${symbol.toLowerCase()}.json`;
await writeFile(join(OUTPUT_DIR, outputName), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`${symbol}: ${output.returnedCount} daily candles saved to data/binance-spot-daily/${outputName}`);
