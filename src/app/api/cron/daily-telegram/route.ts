import { NextRequest } from 'next/server';
import { GET as runPumpScan } from '@/app/api/scan-pump/route';
import { GET as runWickScan, type WickScanResultItem } from '@/app/api/scan-wick/route';
import { escapeTelegramHtml, sendTelegramMessage } from '@/lib/telegram';
import { redisCommand } from '@/lib/upstash';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PUMP_TOP_LIMIT = 5;
const WICK_MAX_DAYS = 10;
const WICK_SIGNAL_LIMIT = 20;

type PumpResult = {
  symbol: string;
  name: string;
  price: number;
  percentChange24h: number;
  volume24h: number;
  marketCap?: number;
  score: { score: number; phase: string };
};

function compact(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function sign(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function displaySymbol(symbol: string) {
  return symbol.replace(/USDT$/i, '');
}

function cronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get('authorization') === `Bearer ${secret}`);
}

async function getAlphaPumpSignals(): Promise<PumpResult[]> {
  const response = await runPumpScan(new NextRequest('https://internal.alpha-bot/api/scan-pump?market=alpha&force=1'));
  const payload = (await response.json()) as { success?: boolean; results?: PumpResult[]; error?: string };
  if (!response.ok || !payload.success) throw new Error(payload.error ?? `Pump scan request failed (${response.status}).`);
  return payload.results ?? [];
}

async function getWickSignals(): Promise<WickScanResultItem[]> {
  const response = await runWickScan(new NextRequest('https://internal.alpha-bot/api/scan-wick?market=all&minWick=20&force=1'));
  const payload = (await response.json()) as { success?: boolean; results?: WickScanResultItem[]; error?: string };
  if (!response.ok || !payload.success) throw new Error(payload.error ?? `Wick scan request failed (${response.status}).`);
  return payload.results ?? [];
}

function pumpPhaseLabel(phase: string) {
  if (phase === 'ACCELERATION_READY') return 'Sẵn sàng tăng tốc';
  if (phase === 'EARLY_CYCLE') return 'Chu kỳ đang hình thành';
  if (phase === 'TRIGGER_ONLY') return 'Tín hiệu ngắn hạn';
  return 'Chưa có cấu trúc rõ ràng';
}

function formatDailyDigest(
  topPumpSignals: PumpResult[],
  wickSignals: WickScanResultItem[],
  appUrl: string,
  pumpUnavailable: boolean,
  wickUnavailable: boolean
) {
  const date = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'full', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const lines = [
    `<b>⚡ Alpha Bot · Tổng hợp hằng ngày</b>`,
    `<i>${date}</i>`,
    '',
    `<b>🚀 Top 5 Token Binance Alpha Pump Mạnh Nhất</b>`,
  ];

  if (pumpUnavailable) {
    lines.push('⚠️ Bộ quét Pump Alpha tạm thời không phản hồi.');
  } else if (topPumpSignals.length === 0) {
    lines.push('Chưa có tín hiệu Binance Alpha Pump vượt ngưỡng hôm nay.');
  } else {
    lines.push(
      ...topPumpSignals.map((signal, index) => {
        const mcText = signal.marketCap && signal.marketCap > 0 ? ` · MC $${compact(signal.marketCap)}` : '';
        return `${index + 1}. <b>${escapeTelegramHtml(displaySymbol(signal.symbol))}</b> · điểm <b>${signal.score.score}</b> · ${escapeTelegramHtml(pumpPhaseLabel(signal.score.phase))} · ${sign(signal.percentChange24h)}${mcText}`;
      })
    );
  }

  lines.push('', `<b>🎯 Quét Rút Râu 30D (Gần nhất ≤ 10 ngày)</b>`);
  if (wickUnavailable) {
    lines.push('⚠️ Bộ quét Rút râu tạm thời không phản hồi.');
  } else if (wickSignals.length === 0) {
    lines.push('Chưa có token rút râu trong 10 ngày gần đây.');
  } else {
    lines.push(
      ...wickSignals.map((item, index) => {
        const latest = item.analysis.latestWickEvent!;
        const timeLabel = latest.offsetDays === 0 ? 'Hôm nay' : latest.offsetDays === 1 ? 'Hôm qua' : `${latest.offsetDays} ngày trước`;
        const mcText = item.marketCap && item.marketCap > 0 ? `$${compact(item.marketCap)}` : '—';
        const reboundText = `+${latest.reboundFromLow.toFixed(1)}%`;
        return `${index + 1}. <b>${escapeTelegramHtml(displaySymbol(item.symbol))}</b> · MC <b>${mcText}</b> · rút râu <b>${reboundText}</b> (${timeLabel})`;
      })
    );
  }

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
    const [alphaPumpResult, wickResult] = await Promise.allSettled([
      getAlphaPumpSignals(),
      getWickSignals(),
    ]);

    const alphaPumpUnavailable = alphaPumpResult.status === 'rejected';
    const wickUnavailable = wickResult.status === 'rejected';

    if (alphaPumpUnavailable) console.error('Daily Telegram Alpha pump scan failed:', alphaPumpResult.reason instanceof Error ? alphaPumpResult.reason.message : 'unknown error');
    if (wickUnavailable) console.error('Daily Telegram Wick scan failed:', wickResult.reason instanceof Error ? wickResult.reason.message : 'unknown error');

    const alphaPumpSignals = alphaPumpUnavailable ? [] : alphaPumpResult.value;
    const allPumpSignals = alphaPumpSignals
      .sort((a, b) => b.score.score - a.score.score || b.percentChange24h - a.percentChange24h)
      .slice(0, PUMP_TOP_LIMIT);

    const rawWickSignals = wickUnavailable ? [] : wickResult.value;
    const recentWickSignals = rawWickSignals
      .filter((item) => {
        const latest = item.analysis?.latestWickEvent;
        return latest && latest.offsetDays <= WICK_MAX_DAYS;
      })
      .sort((a, b) => {
        const aLatest = a.analysis.latestWickEvent!;
        const bLatest = b.analysis.latestWickEvent!;
        if (aLatest.offsetDays !== bLatest.offsetDays) {
          return aLatest.offsetDays - bLatest.offsetDays;
        }
        return bLatest.reboundFromLow - aLatest.reboundFromLow;
      })
      .slice(0, WICK_SIGNAL_LIMIT);

    const appUrl = process.env.APP_URL ?? new URL(request.url).origin;
    await sendTelegramMessage(formatDailyDigest(allPumpSignals, recentWickSignals, appUrl, alphaPumpUnavailable, wickUnavailable));
    await redisCommand('SET', lockKey, 'sent', 'EX', String(14 * 24 * 60 * 60));
    return Response.json({
      success: true,
      topPumpSignals: allPumpSignals.length,
      recentWickSignals: recentWickSignals.length,
      alphaPumpUnavailable,
      wickUnavailable,
    });
  } catch (error) {
    await redisCommand('DEL', lockKey).catch(() => undefined);
    const message = error instanceof Error ? error.message : 'Unable to send daily digest.';
    console.error('Daily Telegram cron failed:', message);
    return Response.json({ success: false, error: message }, { status: 502 });
  }
}
