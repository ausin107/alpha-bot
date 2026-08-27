'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Image from 'next/image';
import { type WickScanResultItem, type ScanMarketType } from '@/app/api/scan-wick/route';
import { type Token } from './TokenList';

interface WickScannerViewProps {
  onSelectToken?: (token: Token) => void;
  isEmbeddedModal?: boolean;
  onCloseModal?: () => void;
}

type TimeFilter = 'all' | 'today' | 'yesterday' | '7d' | '30d';

export default function WickScannerView({
  onSelectToken,
  isEmbeddedModal = false,
  onCloseModal,
}: WickScannerViewProps) {
  const [marketFilter, setMarketFilter] = useState<ScanMarketType>('all');
  const [minWickThreshold, setMinWickThreshold] = useState<number>(20);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<'rebound' | 'offset' | 'volume' | 'count'>('offset');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<WickScanResultItem[]>([]);
  const [scanInfo, setScanInfo] = useState<{
    cached: boolean;
    generatedAt: string;
    totalAlphaCandidates: number;
    totalSpotCandidates: number;
    scannedCandidates: number;
    failedCandidates: number;
    todayWickCount: number;
    yesterdayWickCount: number;
    past7dWickCount: number;
  } | null>(null);

  // Manual reload function (forces fresh fetch)
  const handleForceReload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan-wick?market=all&minWick=${minWickThreshold}&force=1`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Không thể tải dữ liệu quét rút râu');
      }

      setResults(json.results || []);
      setScanInfo({
        cached: json.cached,
        generatedAt: json.generatedAt,
        totalAlphaCandidates: json.totalAlphaCandidates,
        totalSpotCandidates: json.totalSpotCandidates,
        scannedCandidates: json.scannedCandidates,
        failedCandidates: json.failedCandidates,
        todayWickCount: json.todayWickCount,
        yesterdayWickCount: json.yesterdayWickCount,
        past7dWickCount: json.past7dWickCount,
      });
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Lỗi hệ thống khi quét rút râu');
    } finally {
      setIsLoading(false);
    }
  }, [minWickThreshold]);

  // Initial load
  useEffect(() => {
    let ignore = false;

    async function fetchData() {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/scan-wick?market=all&minWick=${minWickThreshold}`);
        const json = await res.json();
        if (ignore) return;
        if (!res.ok || !json.success) {
          throw new Error(json.error || 'Không thể tải dữ liệu quét rút râu');
        }
        setResults(json.results || []);
        setScanInfo({
          cached: json.cached,
          generatedAt: json.generatedAt,
          totalAlphaCandidates: json.totalAlphaCandidates,
          totalSpotCandidates: json.totalSpotCandidates,
          scannedCandidates: json.scannedCandidates,
          failedCandidates: json.failedCandidates,
          todayWickCount: json.todayWickCount,
          yesterdayWickCount: json.yesterdayWickCount,
          past7dWickCount: json.past7dWickCount,
        });
      } catch (err: unknown) {
        if (ignore) return;
        console.error(err);
        setError(err instanceof Error ? err.message : 'Lỗi hệ thống khi quét rút râu');
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }

    void fetchData();

    return () => {
      ignore = true;
    };
  }, [minWickThreshold]);

  // Filter & sort logic
  const filteredResults = useMemo(() => {
    return results
      .filter((item) => {
        // Market filter
        if (marketFilter === 'alpha' && item.source !== 'alpha') return false;
        if (marketFilter === 'spot' && item.source !== 'spot') return false;

        // Search query
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          const matchesSymbol = item.symbol.toLowerCase().includes(q);
          const matchesName = item.name.toLowerCase().includes(q);
          const matchesBase = item.baseAsset.toLowerCase().includes(q);
          if (!matchesSymbol && !matchesName && !matchesBase) return false;
        }

        // Time filter
        const latest = item.analysis.latestWickEvent;
        if (!latest) return false;

        if (timeFilter === 'today' && latest.offsetDays !== 0) return false;
        if (timeFilter === 'yesterday' && latest.offsetDays !== 1) return false;
        if (timeFilter === '7d' && latest.offsetDays > 7) return false;
        if (timeFilter === '30d' && latest.offsetDays > 30) return false;

        // Threshold filter
        if (latest.reboundFromLow < minWickThreshold && latest.lowerWickPercent < minWickThreshold) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        const aLatest = a.analysis.latestWickEvent;
        const bLatest = b.analysis.latestWickEvent;

        if (sortBy === 'offset') {
          const aOffset = aLatest?.offsetDays ?? 999;
          const bOffset = bLatest?.offsetDays ?? 999;
          if (aOffset !== bOffset) {
            return sortOrder === 'asc' ? aOffset - bOffset : bOffset - aOffset;
          }
          return (bLatest?.reboundFromLow ?? 0) - (aLatest?.reboundFromLow ?? 0);
        }

        if (sortBy === 'rebound') {
          const aRebound = aLatest?.reboundFromLow ?? 0;
          const bRebound = bLatest?.reboundFromLow ?? 0;
          return sortOrder === 'asc' ? aRebound - bRebound : bRebound - aRebound;
        }

        if (sortBy === 'volume') {
          return sortOrder === 'asc' ? a.volume24h - b.volume24h : b.volume24h - a.volume24h;
        }

        if (sortBy === 'count') {
          const aCount = a.analysis.totalWickCount30d;
          const bCount = b.analysis.totalWickCount30d;
          return sortOrder === 'asc' ? aCount - bCount : bCount - aCount;
        }

        return 0;
      });
  }, [results, marketFilter, searchQuery, timeFilter, minWickThreshold, sortBy, sortOrder]);

  const formatPrice = (val: number) => {
    if (!Number.isFinite(val)) return '$0.00';
    if (val < 0.0001) return `$${val.toFixed(8)}`;
    if (val < 0.01) return `$${val.toFixed(6)}`;
    if (val < 1) return `$${val.toFixed(4)}`;
    return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatVolume = (val: number) => {
    if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${val.toFixed(0)}`;
  };

  const getOffsetBadge = (offsetDays: number, dateStr: string) => {
    if (offsetDays === 0) {
      return (
        <span
          style={{
            background: 'rgba(0, 242, 254, 0.15)',
            border: '1px solid var(--primary-cyan)',
            color: 'var(--primary-cyan)',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '0.72rem',
            fontWeight: 700,
          }}
        >
          ⚡ Hôm nay (Live)
        </span>
      );
    }
    if (offsetDays === 1) {
      return (
        <span
          style={{
            background: 'rgba(0, 230, 118, 0.15)',
            border: '1px solid var(--trend-up)',
            color: 'var(--trend-up)',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '0.72rem',
            fontWeight: 700,
          }}
        >
          📅 Hôm qua
        </span>
      );
    }
    if (offsetDays <= 7) {
      return (
        <span
          style={{
            background: 'rgba(255, 209, 102, 0.15)',
            border: '1px solid #ffd166',
            color: '#ffd166',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '0.72rem',
            fontWeight: 600,
          }}
        >
          {offsetDays} ngày trước ({dateStr})
        </span>
      );
    }
    return (
      <span
        style={{
          background: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-secondary)',
          padding: '2px 8px',
          borderRadius: '4px',
          fontSize: '0.72rem',
        }}
      >
        {offsetDays} ngày trước ({dateStr})
      </span>
    );
  };

  const getCandleTypeBadge = (type: string) => {
    switch (type) {
      case 'BULLISH_PINBAR':
        return <span style={{ color: 'var(--trend-up)', fontSize: '0.7rem' }}>🔨 Búa xanh rút chân</span>;
      case 'BEARISH_PINBAR':
        return <span style={{ color: '#ffd166', fontSize: '0.7rem' }}>🔻 Búa đỏ hồi từ đáy</span>;
      case 'DOJI_HAMMER':
        return <span style={{ color: 'var(--primary-cyan)', fontSize: '0.7rem' }}>➕ Doji chân dài</span>;
      default:
        return <span style={{ color: '#d4c2ff', fontSize: '0.7rem' }}>🚀 Bật đáy mạnh</span>;
    }
  };

  const handleOpenChart = (item: WickScanResultItem) => {
    if (item.source === 'alpha' && onSelectToken) {
      const fallbackToken: Token = {
        alphaId: item.alphaId || item.symbol,
        symbol: item.symbol,
        name: item.name,
        iconUrl: item.iconUrl,
        price: item.price,
        percentChange24h: item.percentChange24h,
        volume24h: item.volume24h,
        chainId: item.chainId || '56',
        chainIconUrl: '',
        chainName: 'BSC',
        contractAddress: item.contractAddress || '0x0000000000000000000000000000000000000000',
        marketCap: 0,
        fdv: 0,
        liquidity: 0,
        totalSupply: 0,
        circulatingSupply: 0,
        holders: 0,
      };
      onSelectToken(fallbackToken);
    } else {
      const spotUrl = `https://www.binance.com/en/trade/${item.baseAsset}_${item.quoteAsset}?type=spot`;
      window.open(spotUrl, '_blank', 'noopener,noreferrer');
    }
  };

  // Metrics for overview cards
  const topReboundCoin = useMemo(() => {
    if (results.length === 0) return null;
    return [...results].sort((a, b) => (b.analysis.latestWickEvent?.reboundFromLow ?? 0) - (a.analysis.latestWickEvent?.reboundFromLow ?? 0))[0];
  }, [results]);

  return (
    <section className="glass-panel" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.2rem', width: '100%' }}>
      {/* Header Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>🎯</span> Quét Tín Hiệu Rút Râu Khung Ngày (1D Wick Rejection)
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '4px', maxWidth: '780px' }}>
            Tự động phân tích <strong>30 cây nến ngày (30D)</strong> gần nhất của toàn bộ token <strong>Binance Alpha</strong> (có Binance Futures) và <strong>Binance Spot / USDT</strong> để tìm các pha rút chân / hồi phục từ đáy (Low → Close) từ <strong>{minWickThreshold}% trở lên</strong>.
          </p>
        </div>

        {/* 1-Click Unified Scan Button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <button
            className="action-btn"
            onClick={() => void handleForceReload()}
            disabled={isLoading}
            style={{
              background: 'linear-gradient(135deg, rgba(0, 242, 254, 0.2) 0%, rgba(79, 172, 254, 0.15) 100%)',
              borderColor: 'var(--primary-cyan)',
              color: 'var(--primary-cyan)',
              fontWeight: 700,
              padding: '0.55rem 1.1rem',
              fontSize: '0.9rem',
            }}
          >
            <span className={`refresh-icon-text ${isLoading ? 'spin' : ''}`}>🚀</span>
            {isLoading ? 'Đang quét toàn bộ 30D...' : 'Quét Toàn Bộ 30D (Alpha + Spot)'}
          </button>
          {isEmbeddedModal && onCloseModal && (
            <button className="action-btn" onClick={onCloseModal}>
              ✕ Đóng
            </button>
          )}
        </div>
      </div>

      {/* Info Status Bar */}
      {scanInfo && (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
          <span>
            {scanInfo.cached ? '⚡ Dữ liệu từ cache' : '🔄 Dữ liệu vừa quét mới'} · Đã quét <strong>{scanInfo.scannedCandidates}</strong> cặp ({scanInfo.totalAlphaCandidates} Alpha + {scanInfo.totalSpotCandidates} Spot) · Cập nhật {new Date(scanInfo.generatedAt).toLocaleString('vi-VN')}
          </span>
        </div>
      )}

      {/* Stats Highlight Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.8rem' }}>
        <div className="glass-panel stat-card" style={{ padding: '0.9rem 1.1rem' }}>
          <div className="stat-icon" style={{ fontSize: '1.4rem' }}>🎯</div>
          <div className="stat-info">
            <span className="stat-label">Tổng Coin Rút Râu 30D</span>
            <span className="stat-value" style={{ fontSize: '1.3rem', color: 'var(--primary-cyan)' }}>
              {isLoading ? '...' : results.length}
            </span>
            <span className="stat-desc">Đạt ngưỡng ≥ {minWickThreshold}%</span>
          </div>
        </div>

        <div className="glass-panel stat-card" style={{ padding: '0.9rem 1.1rem' }}>
          <div className="stat-icon" style={{ fontSize: '1.4rem' }}>⚡</div>
          <div className="stat-info">
            <span className="stat-label">Rút Râu Hôm Nay (Live)</span>
            <span className="stat-value" style={{ fontSize: '1.3rem', color: 'var(--trend-up)' }}>
              {isLoading ? '...' : scanInfo?.todayWickCount ?? 0}
            </span>
            <span className="stat-desc">Nến ngày đang chạy</span>
          </div>
        </div>

        <div className="glass-panel stat-card" style={{ padding: '0.9rem 1.1rem' }}>
          <div className="stat-icon" style={{ fontSize: '1.4rem' }}>📅</div>
          <div className="stat-info">
            <span className="stat-label">Rút Râu Hôm Qua</span>
            <span className="stat-value" style={{ fontSize: '1.3rem', color: '#ffd166' }}>
              {isLoading ? '...' : scanInfo?.yesterdayWickCount ?? 0}
            </span>
            <span className="stat-desc">Nến ngày vừa đóng</span>
          </div>
        </div>

        <div className="glass-panel stat-card" style={{ padding: '0.9rem 1.1rem' }}>
          <div className="stat-icon" style={{ fontSize: '1.4rem' }}>🔥</div>
          <div className="stat-info">
            <span className="stat-label">Rút Râu Khủng Nhất</span>
            <span className="stat-value" style={{ fontSize: '1.3rem', color: 'var(--trend-up)' }}>
              {isLoading || !topReboundCoin ? '...' : `+${(topReboundCoin.analysis.latestWickEvent?.reboundFromLow ?? 0).toFixed(1)}%`}
            </span>
            <span className="stat-desc">{topReboundCoin?.symbol ?? '—'}</span>
          </div>
        </div>
      </div>

      {/* Control Filter Bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', background: 'rgba(0,0,0,0.15)', padding: '0.9rem', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
        {/* Row 1: Market Tabs & Search */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.8rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Thị trường:</span>
            <button
              className="action-btn"
              onClick={() => setMarketFilter('all')}
              style={{
                fontSize: '0.78rem',
                padding: '0.3rem 0.7rem',
                borderColor: marketFilter === 'all' ? 'var(--primary-cyan)' : 'var(--border-color)',
                color: marketFilter === 'all' ? 'var(--primary-cyan)' : 'var(--text-secondary)',
                background: marketFilter === 'all' ? 'rgba(0, 242, 254, 0.1)' : 'transparent',
              }}
            >
              ⚡ Tất Cả ({results.length})
            </button>
            <button
              className="action-btn"
              onClick={() => setMarketFilter('alpha')}
              style={{
                fontSize: '0.78rem',
                padding: '0.3rem 0.7rem',
                borderColor: marketFilter === 'alpha' ? 'var(--primary-cyan)' : 'var(--border-color)',
                color: marketFilter === 'alpha' ? 'var(--primary-cyan)' : 'var(--text-secondary)',
                background: marketFilter === 'alpha' ? 'rgba(0, 242, 254, 0.1)' : 'transparent',
              }}
            >
              🪙 Binance Alpha ({results.filter((r) => r.source === 'alpha').length})
            </button>
            <button
              className="action-btn"
              onClick={() => setMarketFilter('spot')}
              style={{
                fontSize: '0.78rem',
                padding: '0.3rem 0.7rem',
                borderColor: marketFilter === 'spot' ? '#d4c2ff' : 'var(--border-color)',
                color: marketFilter === 'spot' ? '#d4c2ff' : 'var(--text-secondary)',
                background: marketFilter === 'spot' ? 'rgba(155, 89, 182, 0.15)' : 'transparent',
              }}
            >
              💎 Binance Spot ({results.filter((r) => r.source === 'spot').length})
            </button>
          </div>

          {/* Search box */}
          <div className="search-wrapper" style={{ minWidth: '220px', maxWidth: '320px' }}>
            <input
              type="text"
              placeholder="Tìm theo symbol hoặc tên..."
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ padding: '0.45rem 2rem 0.45rem 0.8rem', fontSize: '0.82rem' }}
            />
            <span className="search-icon">🔍</span>
          </div>
        </div>

        {/* Row 2: Time Filter & Threshold Filter */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.8rem' }}>
          {/* Time Filter */}
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Nến gần nhất:</span>
            {[
              { key: 'all', label: 'Tất cả 30 ngày' },
              { key: 'today', label: '⚡ Hôm nay' },
              { key: 'yesterday', label: '📅 Hôm qua' },
              { key: '7d', label: '⏱️ 7 ngày qua' },
            ].map((t) => (
              <button
                key={t.key}
                className="action-btn"
                onClick={() => setTimeFilter(t.key as TimeFilter)}
                style={{
                  fontSize: '0.74rem',
                  padding: '0.25rem 0.6rem',
                  borderColor: timeFilter === t.key ? '#ffd166' : 'var(--border-color)',
                  color: timeFilter === t.key ? '#ffd166' : 'var(--text-secondary)',
                  background: timeFilter === t.key ? 'rgba(255, 209, 102, 0.12)' : 'transparent',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Threshold Filter */}
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Ngưỡng rút râu:</span>
            {[15, 20, 30, 50].map((th) => (
              <button
                key={th}
                className="action-btn"
                onClick={() => setMinWickThreshold(th)}
                style={{
                  fontSize: '0.74rem',
                  padding: '0.25rem 0.6rem',
                  borderColor: minWickThreshold === th ? 'var(--trend-up)' : 'var(--border-color)',
                  color: minWickThreshold === th ? 'var(--trend-up)' : 'var(--text-secondary)',
                  background: minWickThreshold === th ? 'rgba(0, 230, 118, 0.12)' : 'transparent',
                  fontWeight: minWickThreshold === th ? 700 : 400,
                }}
              >
                ≥ {th}%
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Error alert */}
      {error && (
        <div
          className="glass-panel"
          style={{
            padding: '1rem',
            background: 'rgba(255, 56, 96, 0.08)',
            borderColor: 'var(--trend-down)',
            color: 'var(--trend-down)',
            borderRadius: '8px',
            fontSize: '0.88rem',
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Main Results Table */}
      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 1rem', gap: '1rem' }}>
          <div className="pulse-animation" style={{ fontSize: '3rem' }}>🎯</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: 'var(--primary-cyan)' }}>Đang quét và tính toán nến rút râu 30 ngày trên toàn thị trường...</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', textAlign: 'center', maxWidth: '480px' }}>
            Hệ thống đang tải nến 1D của tất cả token Binance Alpha (có Futures) và Binance Spot, tính toán độ lệch Low-Close và phân loại nến pinbar.
          </div>
        </div>
      ) : filteredResults.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3.5rem 1rem', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🔍</div>
          <div>Không tìm thấy đồng coin nào thỏa mãn bộ lọc hiện tại.</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>Hãy thử giảm ngưỡng rút râu hoặc chọn mốc thời gian khác.</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.1)' }}>
          <table style={{ width: '100%', minWidth: '1080px', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'left' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: '#121923', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', zIndex: 10 }}>
                <th style={{ padding: '0.75rem 1rem' }}>#</th>
                <th style={{ padding: '0.75rem 1rem' }}>Coin / Cặp</th>
                <th style={{ padding: '0.75rem 1rem' }}>Giá & Biến động</th>
                <th
                  style={{ padding: '0.75rem 1rem', cursor: 'pointer' }}
                  onClick={() => {
                    setSortBy('offset');
                    setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
                  }}
                >
                  Nến rút râu gần nhất {sortBy === 'offset' ? (sortOrder === 'asc' ? '🔼' : '🔽') : '↕️'}
                </th>
                <th
                  style={{ padding: '0.75rem 1rem', cursor: 'pointer' }}
                  onClick={() => {
                    setSortBy('rebound');
                    setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
                  }}
                >
                  % Rút râu dưới (Lower Wick) {sortBy === 'rebound' ? (sortOrder === 'asc' ? '🔼' : '🔽') : '↕️'}
                </th>
                <th style={{ padding: '0.75rem 1rem' }}>Chi tiết giá nến (O / H / L / C)</th>
                <th
                  style={{ padding: '0.75rem 1rem', cursor: 'pointer' }}
                  onClick={() => {
                    setSortBy('count');
                    setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
                  }}
                >
                  Thống kê 30D {sortBy === 'count' ? (sortOrder === 'asc' ? '🔼' : '🔽') : '↕️'}
                </th>
                <th
                  style={{ padding: '0.75rem 1rem', cursor: 'pointer' }}
                  onClick={() => {
                    setSortBy('volume');
                    setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
                  }}
                >
                  Volume 24h {sortBy === 'volume' ? (sortOrder === 'asc' ? '🔼' : '🔽') : '↕️'}
                </th>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.map((item, index) => {
                const latest = item.analysis.latestWickEvent;
                if (!latest) return null;

                const isAlpha = item.source === 'alpha';
                const percentChange = item.percentChange24h;
                const isPriceUp = percentChange >= 0;

                return (
                  <tr
                    key={`${item.source}-${item.symbol}`}
                    className="scan-row-hover"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: isAlpha ? 'pointer' : 'default' }}
                    onClick={() => handleOpenChart(item)}
                  >
                    {/* Index */}
                    <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontWeight: 'bold' }}>
                      #{index + 1}
                    </td>

                    {/* Token Info */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div className="token-avatar" style={{ width: '28px', height: '28px', fontSize: '0.75rem', position: 'relative', overflow: 'hidden', padding: 0 }}>
                          {item.iconUrl ? (
                            <Image
                              src={item.iconUrl}
                              alt={item.symbol}
                              fill
                              sizes="28px"
                              style={{ borderRadius: '50%', objectFit: 'cover' }}
                            />
                          ) : (
                            <span>{item.symbol.slice(0, 2)}</span>
                          )}
                        </div>
                        <div>
                          <div style={{ fontWeight: 'bold', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span>{item.symbol}</span>
                            <span
                              style={{
                                fontSize: '0.65rem',
                                padding: '1px 5px',
                                borderRadius: '3px',
                                background: isAlpha ? 'rgba(0, 242, 254, 0.12)' : 'rgba(155, 89, 182, 0.15)',
                                color: isAlpha ? 'var(--primary-cyan)' : '#d4c2ff',
                                border: `1px solid ${isAlpha ? 'var(--primary-cyan)' : '#b18cff'}`,
                              }}
                            >
                              {isAlpha ? 'Alpha' : 'Spot'}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                            {item.name} · Futures {item.futuresMarkets.join('+')}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Price & 24h Change */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ fontWeight: 600 }}>{formatPrice(item.price)}</div>
                      <div style={{ fontSize: '0.72rem', color: isPriceUp ? 'var(--trend-up)' : 'var(--trend-down)' }}>
                        {isPriceUp ? '+' : ''}{percentChange.toFixed(2)}%
                      </div>
                    </td>

                    {/* Latest Wick Event Date */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div>{getOffsetBadge(latest.offsetDays, latest.dateStr)}</div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                        {getCandleTypeBadge(latest.candleType)}
                      </div>
                    </td>

                    {/* Rebound & Lower Wick Percent */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div
                        style={{
                          fontSize: '1.05rem',
                          fontWeight: 800,
                          color: latest.lowerWickPercent >= 30 ? 'var(--trend-up)' : '#ffd166',
                        }}
                      >
                        +{latest.lowerWickPercent.toFixed(2)}%
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                        Râu chiếm {latest.lowerWickRatio.toFixed(1)}% nến · Hồi {latest.reboundFromLow.toFixed(1)}%
                      </div>
                    </td>

                    {/* Candle Low / High Details */}
                    <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontSize: '0.76rem' }}>
                      <div>Low: <span style={{ color: 'var(--trend-down)' }}>{formatPrice(latest.low)}</span> | Open: {formatPrice(latest.open)}</div>
                      <div>Close: <span style={{ color: 'var(--text-primary)' }}>{formatPrice(latest.close)}</span> | High: {formatPrice(latest.high)}</div>
                    </td>

                    {/* 30D Stats */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ fontWeight: 600 }}>{item.analysis.totalWickCount30d} lần rút râu</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                        Max 30D: <span style={{ color: 'var(--trend-up)', fontWeight: 700 }}>+{item.analysis.maxRebound30d.toFixed(1)}%</span>
                      </div>
                    </td>

                    {/* 24h Volume */}
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--text-secondary)' }}>
                      {formatVolume(item.volume24h)}
                    </td>

                    {/* Actions */}
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.4rem' }}>
                        {isAlpha ? (
                          <button
                            className="action-btn"
                            style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenChart(item);
                            }}
                          >
                            Xem Chart 📈
                          </button>
                        ) : (
                          <a
                            href={`https://www.binance.com/en/trade/${item.baseAsset}_${item.quoteAsset}?type=spot`}
                            target="_blank"
                            rel="noreferrer"
                            className="action-btn"
                            style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', textDecoration: 'none' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            Mở Spot ↗
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
