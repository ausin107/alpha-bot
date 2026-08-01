import { NextRequest } from 'next/server';
import { GET as runPumpScan } from '@/app/api/scan-pump/route';
import { escapeTelegramHtml, sendTelegramMessage } from '@/lib/telegram';
import { redisCommand } from '@/lib/upstash';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BINANCE_ALPHA_URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };

type AlphaToken = {
  alphaId?: string;
  symbol?: string;
  name?: string;
  price?: string | number;
  percentChange24h?: string | number;
  volume24h?: string | number;
  offline?: boolean;
  fullyDelisted?: boolean;
};

type PumpResult = { symbol: string; name: string; price: number; percentChange24h: number; volume24h: number; score: { score: number; phase: string } };

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compact(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function sign(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function cronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get('authorization') === `Bearer ${secret}`);
}

async function getAlphaLeaders() {
  const response = await fetch(BINANCE_ALPHA_URL, { headers: HEADERS, cache: 'no-store' });
  if (!response.ok) throw new Error(`Binance Alpha request failed (${response.status}).`);
  const payload = (await response.json()) as { data?: AlphaToken[] } | AlphaToken[];
  const tokens = Array.isArray(payload) ? payload : payload.data ?? [];
  return tokens
    .filter((token) => token.alphaId && !token.offline && !token.fullyDelisted)
    .sort((left, right) => number(right.volume24h) - number(left.volume24h))
    .slice(0, 5);
}

async function getPumpSignals(market: 'alpha' | 'spot') {
  // Do not fetch our own public route: Deployment Protection can return an HTML
  // login page to server-to-server requests. Invoking the handler directly keeps
  // the daily scan inside this protected cron Function.
  const response = await runPumpScan(new NextRequest(`https://internal.alpha-bot/api/scan-pump?market=${market}&force=1`));
  const payload = (await response.json()) as { success?: boolean; results?: PumpResult[]; error?: string };
  if (!response.ok || !payload.success) throw new Error(payload.error ?? `Pump scan request failed (${response.status}).`);
  return (payload.results ?? []).slice(0, 5);
}

function pumpPhaseLabel(phase: string) {
  if (phase === 'ACCELERATION_READY') return 'Sẵn sàng tăng tốc';
  if (phase === 'EARLY_CYCLE') return 'Chu kỳ đang hình thành';
  if (phase === 'TRIGGER_ONLY') return 'Tín hiệu ngắn hạn';
  return 'Chưa có cấu trúc rõ ràng';
}

function appendPumpSection(lines: string[], title: string, signals: PumpResult[], unavailable: boolean) {
  lines.push('', `<b>${title}</b>`);
  if (unavailable) {
    lines.push('⚠️ Bộ quét tạm thời không phản hồi.');
    return;
  }
  if (signals.length === 0) {
    lines.push('Chưa có tín hiệu Pump vượt ngưỡng hôm nay.');
    return;
  }
  lines.push(...signals.map((signal, index) =>
    `${index + 1}. <b>${escapeTelegramHtml(signal.symbol)}</b> · điểm <b>${signal.score.score}</b> · ${escapeTelegramHtml(pumpPhaseLabel(signal.score.phase))} · ${sign(signal.percentChange24h)}`
  ));
}

function formatDailyDigest(
  alphaLeaders: AlphaToken[],
  alphaPumpSignals: PumpResult[],
  spotPumpSignals: PumpResult[],
  appUrl: string,
  alphaPumpUnavailable: boolean,
  spotPumpUnavailable: boolean
) {
  const date = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'full', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const lines = [`<b>⚡ Alpha Bot · Tổng hợp hằng ngày</b>`, `<i>${date}</i>`, '', '<b>🔥 Top Binance Alpha theo volume 24h</b>'];
  lines.push(...alphaLeaders.map((token, index) => `${index + 1}. <b>${escapeTelegramHtml(token.symbol ?? '—')}</b> · ${sign(number(token.percentChange24h))} · volume $${compact(number(token.volume24h))}`));
  appendPumpSection(lines, '🚀 Tín hiệu Pump Binance Alpha', alphaPumpSignals, alphaPumpUnavailable);
  appendPumpSection(lines, '⚡ Tín hiệu Pump Binance Spot / USDT', spotPumpSignals, spotPumpUnavailable);
  lines.push('', `<a href="${escapeTelegramHtml(appUrl)}">Mở Alpha Bot ↗</a>`);
  return lines.join('\n');
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return Response.json({ success: false, error: 'Unauthorized.' }, { status: 401 });

  const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const lockKey = `telegram-digest:${reportDate}`;
  const locked = await redisCommand<string | null>('SET', lockKey, 'sending', 'NX', 'EX', '900');
  if (locked !== 'OK') return Response.json({ success: true, skipped: true, reason: 'Daily digest was already sent or is running.' });

  try {
    const [alphaResult, alphaPumpResult, spotPumpResult] = await Promise.allSettled([
      getAlphaLeaders(),
      getPumpSignals('alpha'),
      getPumpSignals('spot'),
    ]);
    if (alphaResult.status === 'rejected') throw new Error(`Alpha source: ${alphaResult.reason instanceof Error ? alphaResult.reason.message : 'unknown error'}`);
    const alphaLeaders = alphaResult.value;
    const alphaPumpUnavailable = alphaPumpResult.status === 'rejected';
    const spotPumpUnavailable = spotPumpResult.status === 'rejected';
    if (alphaPumpUnavailable) console.error('Daily Telegram Alpha pump scan failed:', alphaPumpResult.reason instanceof Error ? alphaPumpResult.reason.message : 'unknown error');
    if (spotPumpUnavailable) console.error('Daily Telegram Spot pump scan failed:', spotPumpResult.reason instanceof Error ? spotPumpResult.reason.message : 'unknown error');
    const alphaPumpSignals = alphaPumpUnavailable ? [] : alphaPumpResult.value;
    const spotPumpSignals = spotPumpUnavailable ? [] : spotPumpResult.value;
    const appUrl = process.env.APP_URL ?? new URL(request.url).origin;
    await sendTelegramMessage(formatDailyDigest(alphaLeaders, alphaPumpSignals, spotPumpSignals, appUrl, alphaPumpUnavailable, spotPumpUnavailable));
    await redisCommand('SET', lockKey, 'sent', 'EX', String(14 * 24 * 60 * 60));
    return Response.json({ success: true, alphaTokens: alphaLeaders.length, alphaPumpSignals: alphaPumpSignals.length, spotPumpSignals: spotPumpSignals.length, alphaPumpUnavailable, spotPumpUnavailable });
  } catch (error) {
    await redisCommand('DEL', lockKey).catch(() => undefined);
    const message = error instanceof Error ? error.message : 'Unable to send daily digest.';
    console.error('Daily Telegram cron failed:', message);
    return Response.json({ success: false, error: message }, { status: 502 });
  }
}
