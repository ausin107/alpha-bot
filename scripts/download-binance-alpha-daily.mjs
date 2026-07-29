import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API_BASE = 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines';
const OUTPUT_DIR = join(process.cwd(), 'data', 'binance-alpha-daily');
const REQUESTED_LIMIT = 1500;

const tokens = [
  ['tradoor', 'ALPHA_356'], ['siren', 'ALPHA_102'], ['river', 'ALPHA_381'],
  ['m', 'ALPHA_257'], ['beat', 'ALPHA_451'], ['aia', 'ALPHA_496'],
  ['coai', 'ALPHA_391'], ['myx', 'ALPHA_171'], ['pippin', 'ALPHA_64'],
  ['rave', 'ALPHA_497'], ['aria', 'ALPHA_332'], ['lab', 'ALPHA_428'],
  ['velvet', 'ALPHA_267'], ['ub', 'ALPHA_370'], ['sto', 'ALPHA_138'],
  ['ake', 'ALPHA_331'], ['tag', 'ALPHA_233'], ['bsb', 'ALPHA_790'],
];

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  Accept: 'application/json',
};

function toCandle(row) {
  return {
    openTime: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5],
    closeTime: row[6], quoteVolume: row[7], tradeCount: row[8],
    takerBuyBaseVolume: row[9], takerBuyQuoteVolume: row[10], ignore: row[11],
  };
}

await mkdir(OUTPUT_DIR, { recursive: true });

for (const [token, alphaId] of tokens) {
  const symbol = `${alphaId}USDT`;
  const url = new URL(API_BASE);
  url.search = new URLSearchParams({ symbol, interval: '1d', limit: String(REQUESTED_LIMIT) });

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${token}: HTTP ${response.status} ${response.statusText}`);

  const payload = await response.json();
  if (!payload.success || !Array.isArray(payload.data)) {
    throw new Error(`${token}: invalid Binance Alpha response: ${JSON.stringify(payload)}`);
  }

  const output = {
    source: API_BASE,
    fetchedAt: new Date().toISOString(),
    token,
    alphaId,
    symbol,
    interval: '1d',
    requestedLimit: REQUESTED_LIMIT,
    returnedCount: payload.data.length,
    candles: payload.data.map(toCandle),
  };

  await writeFile(join(OUTPUT_DIR, `${token}.json`), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`${token}: ${output.returnedCount} candles`);
}
