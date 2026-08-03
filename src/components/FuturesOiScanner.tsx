'use client';

import { useState } from 'react';
import type { FuturesOiScanResult, OiComparison, OiTier, OiTimeframe } from '@/lib/futures-oi-score';

interface ScanInfo {
  cached: boolean;
  generatedAt: string;
  durationMs: number;
  minQuoteVolume24h: number;
  minMarketCap: number;
  maxMarketCap: number;
  thresholds: number[];
  universeSymbols: number;
  volumeEligibleSymbols: number;
  scannedSymbols: number;
  marketCapEligibleSymbols: number;
  marketCapFilteredSymbols: number;
  failedSymbols: number;
  anomalySymbols: number;
}

const TIMEFRAMES: OiTimeframe[] = ['1d', '3d', '5d', '7d'];

function compactUsd(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

function tierColor(tier: OiTier) {
  if (tier === 'X2') return '#ff5f7a';
  if (tier === 'X1_75') return '#ffb800';
  if (tier === 'X1_5') return '#00e676';
  return 'var(--text-secondary)';
}

function levelLabel(level: FuturesOiScanResult['level']) {
  if (level === 'EXTREME') return 'CỰC MẠNH';
  if (level === 'HIGH') return 'CAO';
  return 'THEO DÕI';
}

function RatioCell({ comparison }: { comparison: OiComparison }) {
  if (comparison.ratio === null) {
    return <span className="oi-ratio-empty">Thiếu dữ liệu</span>;
  }

  return (
    <div className="oi-ratio-cell">
      <span className="oi-ratio-value" style={{ color: tierColor(comparison.tier) }}>
        {comparison.ratio.toFixed(2)}x
      </span>
      <span className="oi-ratio-change" style={{ color: comparison.changePercent! >= 0 ? 'var(--trend-up)' : 'var(--trend-down)' }}>
        {comparison.changePercent! >= 0 ? '+' : ''}{comparison.changePercent!.toFixed(1)}%
      </span>
    </div>
  );
}

export default function FuturesOiScanner() {
  const [isScanning, setIsScanning] = useState(false);
  const [results, setResults] = useState<FuturesOiScanResult[] | null>(null);
  const [scanInfo, setScanInfo] = useState<ScanInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setIsScanning(true);
    setError(null);
    try {
      const response = await fetch('/api/scan-futures-oi');
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Không thể quét Binance Futures OI');
      }
      setResults(payload.results);
      setScanInfo({
        cached: payload.cached,
        generatedAt: payload.generatedAt,
        durationMs: payload.durationMs,
        minQuoteVolume24h: payload.minQuoteVolume24h,
        minMarketCap: payload.minMarketCap,
        maxMarketCap: payload.maxMarketCap,
        thresholds: payload.thresholds,
        universeSymbols: payload.universeSymbols,
        volumeEligibleSymbols: payload.volumeEligibleSymbols,
        scannedSymbols: payload.scannedSymbols,
        marketCapEligibleSymbols: payload.marketCapEligibleSymbols,
        marketCapFilteredSymbols: payload.marketCapFilteredSymbols,
        failedSymbols: payload.failedSymbols,
        anomalySymbols: payload.anomalySymbols,
      });
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Lỗi hệ thống khi quét Futures OI');
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <section className="glass-panel futures-oi-panel">
      <div className="futures-oi-header">
        <div>
          <div className="futures-oi-title-row">
            <span className="futures-oi-icon">OI</span>
            <div>
              <h2>Futures Open Interest Radar</h2>
              <p>Phát hiện OI tăng bất thường trên toàn bộ hợp đồng USDⓈ-M perpetual.</p>
            </div>
          </div>
          <div className="futures-oi-rules">
            <span>Volume 24h &gt; $3M</span>
            <span>Market Cap $5M–$200M</span>
            <span>So sánh 1d · 3d · 5d · 7d</span>
            <span>Ngưỡng 1.5x · 1.75x · 2x</span>
            <span>Cache 5 phút</span>
          </div>
        </div>
        <button className="action-btn futures-oi-scan-btn" onClick={() => void scan()} disabled={isScanning}>
          <span className={isScanning ? 'spin' : ''}>↻</span>
          {isScanning ? 'Đang quét Futures...' : results ? 'Quét lại Futures OI' : 'Quét Futures OI'}
        </button>
      </div>

      <div className="futures-oi-score-guide">
        <strong>Cách tính điểm:</strong>
        <span>1d: 35đ</span>
        <span>3d: 30đ</span>
        <span>5d: 20đ</span>
        <span>7d: 15đ</span>
        <span className="oi-tier tier-15">≥1.5x nhận 60%</span>
        <span className="oi-tier tier-175">≥1.75x nhận 80%</span>
        <span className="oi-tier tier-2">≥2x nhận 100%</span>
        <span className="oi-tier tier-mc">OI/MC ≥5%: +5 · ≥10%: +10 · ≥20%: +15</span>
      </div>

      {error && <div className="futures-oi-error">⚠ {error}</div>}

      {isScanning ? (
        <div className="futures-oi-loading">
          <div className="pulse-animation">◉</div>
          <strong>Đang lọc volume và tải lịch sử OI từng symbol...</strong>
          <span>Lần quét đầu có thể mất vài chục giây. Kết quả được xếp hạng tự động.</span>
        </div>
      ) : scanInfo ? (
        <>
          <div className="futures-oi-stats">
            <div><span>USDT perpetual</span><strong>{scanInfo.universeSymbols}</strong></div>
            <div><span>Volume &gt; $3M</span><strong>{scanInfo.volumeEligibleSymbols}</strong></div>
            <div><span>MC $5M–$200M</span><strong>{scanInfo.marketCapEligibleSymbols}</strong></div>
            <div><span>OI bất thường</span><strong>{scanInfo.anomalySymbols}</strong></div>
          </div>

          <div className="futures-oi-meta">
            {scanInfo.cached ? 'Kết quả cache' : `Quét mới trong ${(scanInfo.durationMs / 1000).toFixed(1)} giây`}
            {' · '}cập nhật {new Date(scanInfo.generatedAt).toLocaleString('vi-VN')}
            {` · đã quét ${scanInfo.scannedSymbols} · loại ${scanInfo.marketCapFilteredSymbols} ngoài vùng market cap/thiếu supply`}
            {scanInfo.failedSymbols > 0 && ` · ${scanInfo.failedSymbols} symbol lỗi/thiếu dữ liệu`}
          </div>

          {results && results.length > 0 ? (
            <div className="futures-oi-table-wrap">
              <table className="futures-oi-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Symbol</th>
                    <th>Điểm</th>
                    <th>OI hiện tại</th>
                    <th>Market Cap</th>
                    <th>OI / MC</th>
                    {TIMEFRAMES.map((timeframe) => <th key={timeframe}>vs {timeframe}</th>)}
                    <th>Volume 24h</th>
                    <th>Giá 24h</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => {
                    const levelColor = result.level === 'EXTREME'
                      ? '#ff5f7a'
                      : result.level === 'HIGH' ? '#ffb800' : '#00e676';
                    return (
                      <tr key={result.symbol}>
                        <td className="oi-rank">{result.rank}</td>
                        <td>
                          <strong>{result.baseAsset}</strong>
                          <span className="oi-symbol-pair">{result.symbol}</span>
                        </td>
                        <td>
                          <div className="oi-score" style={{ color: levelColor }}>{result.score}/115</div>
                          <span className="oi-level" style={{ color: levelColor }}>{levelLabel(result.level)}</span>
                          <span className="oi-score-detail">OI {result.oiScore} · MC +{result.marketCapBonus}</span>
                        </td>
                        <td>
                          <strong>{compactUsd(result.currentOpenInterestValue)}</strong>
                          <span className="oi-timestamp">mốc {new Date(result.latestTimestamp).toLocaleDateString('vi-VN', { timeZone: 'UTC' })} UTC</span>
                        </td>
                        <td><strong>{compactUsd(result.marketCap)}</strong></td>
                        <td>
                          <strong className="oi-market-cap-ratio">{result.oiToMarketCapPercent.toFixed(2)}%</strong>
                          <span className="oi-score-detail">+{result.marketCapBonus} điểm</span>
                        </td>
                        {TIMEFRAMES.map((timeframe) => (
                          <td key={timeframe}><RatioCell comparison={result.comparisons[timeframe]} /></td>
                        ))}
                        <td>{compactUsd(result.quoteVolume24h)}</td>
                        <td>
                          <span style={{ color: result.priceChangePercent24h >= 0 ? 'var(--trend-up)' : 'var(--trend-down)', fontWeight: 700 }}>
                            {result.priceChangePercent24h >= 0 ? '+' : ''}{result.priceChangePercent24h.toFixed(2)}%
                          </span>
                        </td>
                        <td>
                          <a
                            href={`https://www.binance.com/en/futures/${result.symbol}`}
                            target="_blank"
                            rel="noreferrer"
                            className="action-btn oi-open-link"
                          >
                            Mở Futures ↗
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="futures-oi-empty">Không có symbol nào đạt ngưỡng tăng OI từ 1.5x ở các mốc đang xét.</div>
          )}
        </>
      ) : (
        <div className="futures-oi-empty">
          Nhấn “Quét Futures OI” để lọc các cặp có volume 24h trên $3M và lập bảng xếp hạng.
        </div>
      )}
    </section>
  );
}
