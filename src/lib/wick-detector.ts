import { type DailyCandle } from '@/lib/pump-score';

export type WickCandleType =
  | 'BULLISH_PINBAR'    // Nến búa xanh rút chân mạnh (Close > Open, râu dưới dài)
  | 'BEARISH_PINBAR'    // Nến búa đỏ rút chân (Close < Open nhưng bật mạnh từ đáy Low)
  | 'DOJI_HAMMER'       // Thân nến mỏng, râu dưới chiếm ưu thế lớn
  | 'STRONG_REBOUND';   // Nến bật tăng mạnh từ đáy Low

export interface WickEvent {
  candleIndex: number;          // Vị trí nến trong mảng
  offsetDays: number;           // 0: Hôm nay, 1: Hôm qua, 2: 2 ngày trước...
  openTime: number;
  dateStr: string;              // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
  reboundFromLow: number;       // % Hồi từ đáy: ((Close - Low) / Low) * 100
  lowerWickPercent: number;     // % Râu dưới: ((min(Open, Close) - Low) / min(Open, Close)) * 100
  lowerWickRatio: number;       // Tỷ lệ râu dưới trên toàn bộ nến: (lowerWick / (High - Low)) * 100
  upperWickRatio: number;       // Tỷ lệ râu trên trên toàn bộ nến
  bodyRatio: number;            // Tỷ lệ thân nến trên toàn bộ nến
  candleType: WickCandleType;
  isBullish: boolean;
}

export interface WickAnalysisResult {
  hasWick30d: boolean;
  latestWickEvent: WickEvent | null;
  wickEvents30d: WickEvent[];
  maxRebound30d: number;
  totalWickCount30d: number;
  hasTodayWick: boolean;
  hasYesterdayWick: boolean;
  hasPast7dWick: boolean;
  metrics: {
    historyDays: number;
    currentPrice: number;
    currentLow: number;
    currentHigh: number;
    todayRebound: number;
    todayLowerWickRatio: number;
  };
}

export interface WickDetectorOptions {
  minWickPercent?: number;       // Ngưỡng rút râu tối thiểu (%) - mặc định 20
  lookbackDays?: number;         // Số cây nến nhìn lại - mặc định 30
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function classifyCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  lowerWickRatio: number,
  reboundFromLow: number
): WickCandleType {
  const isBullish = close >= open;
  const body = Math.abs(close - open);
  const totalRange = high - low;
  const bodyRatio = totalRange > 0 ? body / totalRange : 0;

  if (bodyRatio <= 0.15 && lowerWickRatio >= 45) {
    return 'DOJI_HAMMER';
  }
  if (isBullish && lowerWickRatio >= 35) {
    return 'BULLISH_PINBAR';
  }
  if (!isBullish && lowerWickRatio >= 35) {
    return 'BEARISH_PINBAR';
  }
  if (reboundFromLow >= 25) {
    return 'STRONG_REBOUND';
  }
  return isBullish ? 'BULLISH_PINBAR' : 'BEARISH_PINBAR';
}

/**
 * Phân tích chuỗi nến ngày (1D) để phát hiện các tín hiệu rút râu trong 30 cây nến gần nhất.
 */
export function analyzeWickRejections(
  candles: DailyCandle[],
  options?: WickDetectorOptions
): WickAnalysisResult | null {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const minWick = options?.minWickPercent ?? 20;
  const lookback = Math.min(options?.lookbackDays ?? 30, candles.length);

  const totalCandles = candles.length;
  const startIndex = Math.max(0, totalCandles - lookback);
  const targetCandles = candles.slice(startIndex);

  const wickEvents: WickEvent[] = [];
  const latestIndex = targetCandles.length - 1;
  const latestCandle = targetCandles[latestIndex];

  for (let i = 0; i < targetCandles.length; i++) {
    const candle = targetCandles[i];
    const offsetDays = latestIndex - i; // 0 = Hôm nay, 1 = Hôm qua...
    const { open, high, low, close, openTime, quoteVolume } = candle;
    if (low <= 0 || open <= 0) continue;

    const lowerWick = Math.min(open, close) - low;
    const lowerWickPercent = low > 0 ? (lowerWick / low) * 100 : 0;
    const reboundFromLow = low > 0 ? ((close - low) / low) * 100 : 0;

    const totalRange = Math.max(high - low, Number.EPSILON);
    const lowerWickRatio = (lowerWick / totalRange) * 100;
    const upperWick = high - Math.max(open, close);
    const upperWickRatio = (upperWick / totalRange) * 100;
    const bodyRatio = (Math.abs(close - open) / totalRange) * 100;

    // Điều kiện rút râu CHUẨN:
    // Râu dưới LowerWick = min(Open, Close) - Low phải đạt >= minWick% và chiếm ít nhất 20% tổng chiều dài nến
    if (lowerWickPercent >= minWick && lowerWickRatio >= 20) {
      const candleType = classifyCandle(open, high, low, close, lowerWickRatio, reboundFromLow);
      const isBullish = close >= open;

      wickEvents.push({
        candleIndex: startIndex + i,
        offsetDays,
        openTime,
        dateStr: formatDate(openTime),
        open,
        high,
        low,
        close,
        quoteVolume,
        reboundFromLow,
        lowerWickPercent,
        lowerWickRatio,
        upperWickRatio,
        bodyRatio,
        candleType,
        isBullish,
      });
    }
  }

  // Sắp xếp các event gần nhất lên đầu (offsetDays tăng dần)
  wickEvents.sort((a, b) => a.offsetDays - b.offsetDays);

  const latestWickEvent = wickEvents.length > 0 ? wickEvents[0] : null;
  const maxRebound30d = wickEvents.reduce((max, e) => Math.max(max, e.reboundFromLow), 0);

  const hasTodayWick = wickEvents.some((e) => e.offsetDays === 0);
  const hasYesterdayWick = wickEvents.some((e) => e.offsetDays === 1);
  const hasPast7dWick = wickEvents.some((e) => e.offsetDays <= 7);

  const todayRebound = latestCandle.low > 0 ? ((latestCandle.close - latestCandle.low) / latestCandle.low) * 100 : 0;
  const todayLowerWick = Math.min(latestCandle.open, latestCandle.close) - latestCandle.low;
  const todayRange = Math.max(latestCandle.high - latestCandle.low, Number.EPSILON);
  const todayLowerWickRatio = (todayLowerWick / todayRange) * 100;

  return {
    hasWick30d: wickEvents.length > 0,
    latestWickEvent,
    wickEvents30d: wickEvents,
    maxRebound30d,
    totalWickCount30d: wickEvents.length,
    hasTodayWick,
    hasYesterdayWick,
    hasPast7dWick,
    metrics: {
      historyDays: totalCandles,
      currentPrice: latestCandle.close,
      currentLow: latestCandle.low,
      currentHigh: latestCandle.high,
      todayRebound,
      todayLowerWickRatio,
    },
  };
}
